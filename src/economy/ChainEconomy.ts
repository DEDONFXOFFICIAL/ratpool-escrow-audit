import { PublicKey, Transaction, type Connection } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import type { MatchResult, PriceTier, RankedPlayer } from "@/state/types";
import { setPlatformFee } from "@/state/types";
import {
  USDC,
  SERVER_URL,
  fromBaseUnits,
  toBaseUnits,
} from "@/chain/config";
import { configPda, escrowProgram, matchPda, enumKey, type PlayerStatus, type Signer } from "@/chain/escrow";
import { purchaseMemo, STORE_PRICES } from "./prices";
import { checkEscrowTx, checkReferralTx, checkTransferTx, TxRefused } from "./txCheck";
import { buyDetail, leaveDetail, proveWalletRequest, sendDetail, type WalletAction, type WalletProof } from "@/chain/walletRequest";
import type { EconomyService, EscrowReceipt, SettleOptions } from "./EconomyService";

/**
 * The money, on chain.
 *
 * The player's wallet signs exactly two things here: `join` (an approval that
 * lets the match take one entry if the room fills) and `leave` (revoking it).
 * Both arrive from the server already built and co-signed, with the platform
 * as fee payer — a player needs test USDC and nothing else, no SOL. Everything
 * that moves money — collecting the stakes, paying the podium — is signed by
 * the settle authority on the server, which is the only key the program lets
 * do it, and the program itself bounds what that key can do: see
 * program/README.md.
 *
 * A pool is played in a room on the game server among players who all
 * staked (bots are Free Play only); the game server ranks the match and
 * signs the finishing order, and the escrow pays only what it signed.
 *
 * The store still routes `deposit` and `withdraw` here. Both are mock-era
 * ideas — a house balance you top up — and throw, because on chain the
 * player's USDC stays in the player's wallet.
 */

/** Fired on window when a store payment becomes a purchase record: the store re-reads what the wallet owns. */
export const PURCHASE_RECORDED = "ratpool:purchase-recorded";

/** A store payment sent but not yet recorded; lvbh is the block height after which it can no longer land. */
interface PendingPurchase {
  from: string;
  item: string;
  signature: string;
  at?: number;
  lvbh?: number;
}

/**
 * A send whose outcome is not known yet: kept from just before it goes out
 * until it has landed, failed or can no longer land, so pressing Send again
 * (or reopening the app) cannot send the same money twice (review 2026-10-08).
 */
interface PendingSend {
  from: string;
  to: string;
  amount: number;
  signature: string;
  lvbh: number;
  at: number;
}

/** Deliberately its own type so a screen can catch it and explain, not crash. */
export class NotOnChainYet extends Error {
  constructor(what: string) {
    super(what + " is not part of the on-chain economy.");
    this.name = "NotOnChainYet";
  }
}

/** The server said no, and said why. */
export class ServerError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ServerError";
  }
}

interface OpenReply {
  id: string;
  entry: number;
}
interface CollectReply {
  started: boolean;
  collected: number;
  dropped: number;
  pool: number;
  reason?: string;
}
/** A transaction the platform built and co-signed; the wallet adds the player. */
interface SponsoredTx {
  tx: string;
  blockhash: string;
  lastValidBlockHeight: number;
}
interface SettleReply {
  pool: number;
  fee: number;
  /** wallet → base units paid */
  amounts: Record<string, number>;
  signature: string;
}

/** Every message an error carries, wrapped causes and RPC logs included (wallet adapters wrap the RPC's own error). */
function messagesOf(e: unknown): string {
  const out: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur; i++) {
    const c = cur as { message?: unknown; error?: unknown; cause?: unknown; logs?: unknown };
    if (typeof c.message === "string") out.push(c.message);
    if (Array.isArray(c.logs)) out.push(c.logs.join(" "));
    cur = c.error ?? c.cause;
  }
  return out.join(" | ") || String(e);
}

/** Refused by the player, or by the network before it went out (its dry run failed): nothing was sent. */
// "cancel" only as the player's: a request cancelled on the network side may
// have gone out first, and is looked up instead.
const NOT_SENT = /reject|declin|denied|user cancel|cancelled by|canceled by|simulat|preflight|reverted|insufficient|custom program error|blockhash not found/i;

/** An error after which nothing can have been taken: the transaction never went out, or can no longer land. */
function notSent(e: Error): Error {
  return Object.assign(e, { notSent: true });
}

/**
 * What to say when the wallet would not, or could not, send.
 *
 * Sign-in is Google only, a Privy wallet already on the right network, so
 * the old advice to switch a wallet off mainnet was wrong and hid the real
 * cause (2026-10-05). A refusal is a refusal; anything else the wallet
 * reports goes to the console and the player gets one line.
 */
function explainWalletError(e: unknown): Error {
  const name = (e as { name?: string })?.name ?? "";
  const message = (e as { message?: string })?.message ?? String(e);
  if (/reject|declin|cancel/i.test(message)) {
    return new Error("You cancelled it. Nothing was taken.");
  }
  if (/^Wallet(Send|Sign)Transaction/.test(name)) {
    console.warn(e);
    return new Error("The network didn't take it. Nothing was taken. Try again.");
  }
  return e instanceof Error ? e : new Error(message);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(SERVER_URL + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON — the message below carries the raw text */
  }
  if (!res.ok) {
    const msg =
      (data as { error?: string } | null)?.error ?? (text || `${res.status} from the server`);
    throw new ServerError(msg, res.status);
  }
  return data as T;
}

export class ChainEconomy implements EconomyService {
  /** The seat we hold while a lobby fills: the on-chain match and its tier. */
  private pending: { id: bigint; tier: PriceTier } | null = null;

  constructor(
    private readonly connection: Connection,
    private readonly wallet: Signer & { signMessage?: (message: Uint8Array) => Promise<Uint8Array> },
  ) {
    // Payments made earlier whose purchase never got recorded (the app closed,
    // the network dropped): finished now, quietly.
    window.setTimeout(() => void this.resumePurchases(), 3000);
    // The lobby's prizes follow the escrow's own fee setting, so the cards
    // show what the program will pay (PLATFORM_FEE in state/types.ts). Read
    // again every two minutes, so an app left open follows a change; one
    // timer however many times the economy is rebuilt.
    const readFee = () =>
      void escrowProgram(this.connection, this.wallet)
        .account.config.fetch(configPda())
        .then((c) => setPlatformFee(c.feeBps))
        .catch(() => undefined);
    readFee();
    ChainEconomy.readFee = readFee;
    window.clearInterval(ChainEconomy.feeTimer);
    ChainEconomy.feeTimer = window.setInterval(readFee, 120_000);
  }
  private static feeTimer: number | undefined;
  private static readFee: (() => void) | undefined;
  /** Read the escrow's fee setting now (the pools screen, when it opens). */
  static refreshFee(): void {
    ChainEconomy.readFee?.();
  }

  /**
   * Purchases paid on chain but not yet recorded, kept on the device until
   * they are (review 2026-10-06, DB-04). Before, five failed confirmations
   * left a player who had paid with a weapon the rooms would not let in.
   */
  private static readonly PENDING_KEY = "ratpool.pendingPurchases";
  private static readonly PENDING_SEND_KEY = "ratpool.pendingSend";
  /** Per wallet: two accounts on one phone keep their own. */
  private get pendingSendKey() {
    return `${ChainEconomy.PENDING_SEND_KEY}:${this.owner.toBase58()}`;
  }
  /**
   * Where storage could not be written, the record is held here instead, so
   * a send is never left unguarded (review 2026-10-08). Storage stays the
   * truth wherever it works: it is shared with the player's other tabs.
   */
  private static pendingSends = new Map<string, PendingSend | null>();
  private pendingSend(): PendingSend | null {
    // Storage first: it is shared with the player's other tabs.
    try {
      const p = JSON.parse(localStorage.getItem(this.pendingSendKey) ?? "null");
      if (p && typeof p.signature === "string" && p.from === this.owner.toBase58()) return p as PendingSend;
    } catch {
      /* unreadable: the copy below */
    }
    return ChainEconomy.pendingSends.get(this.pendingSendKey) ?? null;
  }
  private savePendingSend(p: PendingSend): void {
    try {
      localStorage.setItem(this.pendingSendKey, JSON.stringify(p));
    } catch {
      ChainEconomy.pendingSends.set(this.pendingSendKey, p);
    }
  }
  /** That send is settled: its record goes, and only its (another tab's newer one stays). */
  private clearPendingSend(signature: string): void {
    try {
      const p = JSON.parse(localStorage.getItem(this.pendingSendKey) ?? "null");
      if (p?.signature === signature) localStorage.removeItem(this.pendingSendKey);
    } catch {
      /* storage unavailable */
    }
    if (ChainEconomy.pendingSends.get(this.pendingSendKey)?.signature === signature) ChainEconomy.pendingSends.delete(this.pendingSendKey);
  }

  /**
   * What became of the last send, before another goes out. Landed: the same
   * send again is refused (it went through); failed, or past its last block
   * and not there: cleared. Not known yet: nothing new is sent.
   */
  private async settlePendingSend(to: string, amount: number): Promise<void> {
    const p = this.pendingSend();
    if (!p) return;
    const until = Date.now() + 10_000;
    const ask = <T,>(q: Promise<T>) =>
      Promise.race([q, new Promise<never>((_, no) => setTimeout(() => no(new Error("timeout")), Math.max(1, until - Date.now())))]);
    const status = async () => (await ask(this.connection.getSignatureStatuses([p.signature], { searchTransactionHistory: true }))).value[0];
    const settled = (st: { confirmationStatus?: string | null } | null | undefined) =>
      !!st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized");
    let outcome: "landed" | "failed" | "gone" | "unknown" = "unknown";
    try {
      const st = await status();
      if (settled(st)) outcome = st!.err ? "failed" : "landed";
      else if (!st && (await ask(this.connection.getBlockHeight("confirmed"))) > p.lvbh) {
        // Past its last block, then looked for again: it could have landed in
        // that last block between the two questions.
        const again = await status();
        if (settled(again)) outcome = again!.err ? "failed" : "landed";
        else if (!again) outcome = "gone";
      }
    } catch {
      /* the network did not answer: not known */
    }
    if (outcome === "unknown") throw new Error("Your last send is still on its way. Try again in a minute.");
    this.clearPendingSend(p.signature);
    if (outcome === "landed" && p.to === to && p.amount === amount) {
      throw new Error("Your last send went through. Check History.");
    }
  }
  private pendingPurchases(): PendingPurchase[] {
    try {
      const all = JSON.parse(localStorage.getItem(ChainEconomy.PENDING_KEY) ?? "[]");
      return Array.isArray(all) ? all : [];
    } catch {
      return [];
    }
  }
  private savePendingPurchases(list: PendingPurchase[]): void {
    try {
      localStorage.setItem(ChainEconomy.PENDING_KEY, JSON.stringify(list));
    } catch {
      /* storage unavailable: the retries in purchase() still run */
    }
  }
  private async resumePurchases(): Promise<void> {
    const mine = this.owner.toBase58();
    for (const p of this.pendingPurchases().filter((x) => x.from === mine)) {
      try {
        await post("/api/store/buy", { from: p.from, item: p.item, confirm: p.signature });
        this.savePendingPurchases(this.pendingPurchases().filter((x) => x.signature !== p.signature));
        // The item is the player's now: the store unlocks it (store.tsx).
        window.dispatchEvent(new Event(PURCHASE_RECORDED));
      } catch (e) {
        // Dropped only when it took nothing: the chain says it failed, or it
        // is not there and can no longer get there. Age alone never drops a
        // payment that may have landed (review 2026-10-07); anything else is
        // tried again on the next start.
        const failed = e instanceof ServerError && e.status === 400 && /failed/i.test(e.message);
        const notYet = e instanceof ServerError && e.status === 404;
        if (failed || (notYet && (await this.neverLanded(p)))) {
          this.savePendingPurchases(this.pendingPurchases().filter((x) => x.signature !== p.signature));
        }
      }
    }
  }

  private get owner(): PublicKey {
    return this.wallet.publicKey;
  }

  private get mint(): PublicKey {
    if (!USDC) throw new Error("This build has no USDC mint configured");
    return new PublicKey(USDC);
  }

  /** The player's token account for the mint. Created by the faucet or by
   *  whoever first sent them USDC; never by us. */
  private ata(): PublicKey {
    return getAssociatedTokenAddressSync(this.mint, this.owner, false, TOKEN_PROGRAM_ID);
  }

  /**
   * One of the player's two transactions: the server builds it with the
   * platform as fee payer and signs its half; the wallet signs the other
   * half and sends. The wallet cannot change what it was handed without
   * voiding the server's signature, and the server signs nothing it did not
   * build — see api/match/sponsor.ts.
   */
  private async sponsored(
    action: "join" | "leave",
    id: bigint,
    admit?: { exp: number; sig: string } | null,
    tier?: PriceTier,
  ): Promise<string> {
    const r = await post<SponsoredTx>("/api/match/sponsor", {
      id: id.toString(),
      player: this.owner.toBase58(),
      action,
      // The room's ticket for this seat: the sponsor co-signs a join only with it.
      ...(admit ? { admitExp: admit.exp, admitSig: admit.sig } : {}),
      // A leave is signed by the wallet itself (walletRequest.ts).
      ...(action === "leave" ? { proof: await this.prove("leave", leaveDetail(id)) } : {}),
    });
    const tx = Transaction.from(Uint8Array.from(atob(r.tx), (c) => c.charCodeAt(0)));
    checkEscrowTx(tx, { action, id, owner: this.owner, ownerAta: this.ata() });
    // A join approves whatever entry the match holds when it lands, and names
    // only the match: read again now, after the server answered, so a match
    // replaced under the same id while the request was out is refused here
    // (outside review, 2026-10-14). The escrow upgrade before mainnet puts
    // the entry in the join itself.
    if (action === "join" && tier) await this.requireEntry(id, tier);
    return this.send(tx, r);
  }

  /** This request, signed by the wallet it names (no prompt): see walletRequest.ts. */
  private prove(action: WalletAction, detail: string): Promise<WalletProof> {
    const sign = this.wallet.signMessage;
    if (!sign) throw new Error("This wallet cannot sign. Sign in again.");
    return proveWalletRequest(this.owner.toBase58(), action, detail, sign);
  }

  /**
   * Who invited this player, recorded on chain, once (set_referrer): built
   * and paid for by the platform, checked here, signed silently. It moves
   * no money; the escrow pays referrals only to recorded referrers.
   */
  async recordReferral(record: { tx: string; referrer: string; blockhash: string; lastValidBlockHeight: number }): Promise<string> {
    const tx = Transaction.from(Uint8Array.from(atob(record.tx), (c) => c.charCodeAt(0)));
    checkReferralTx(tx, { owner: this.owner, referrer: new PublicKey(record.referrer) });
    return this.send(tx, record);
  }

  /**
   * USDC out, to an address the player typed. The server builds the
   * transfer with itself as fee payer (api/wallet/transfer.ts); the wallet
   * signs and sends. Returns the signature.
   */
  /**
   * One send at a time per wallet, in this tab and, where the browser offers
   * locks, across tabs: two sends started together could each have found no
   * earlier send pending (review 2026-10-08).
   */
  private static sending = new Map<string, Promise<unknown>>();
  async transfer(to: PublicKey, amount: number): Promise<string> {
    const name = `ratpool-send:${this.owner.toBase58()}`;
    const locks = (navigator as Navigator & { locks?: { request: <T>(n: string, f: () => Promise<T>) => Promise<T> } }).locks;
    if (locks) return locks.request(name, () => this.transferNow(to, amount));
    const before = ChainEconomy.sending.get(name) ?? Promise.resolve();
    const run = before.catch(() => {}).then(() => this.transferNow(to, amount));
    ChainEconomy.sending.set(name, run);
    return run;
  }

  private async transferNow(to: PublicKey, amount: number): Promise<string> {
    await this.settlePendingSend(to.toBase58(), amount);
    const r = await post<SponsoredTx>("/api/wallet/transfer", {
      from: this.owner.toBase58(),
      to: to.toBase58(),
      amount,
      proof: await this.prove("send", sendDetail(to.toBase58(), amount)),
    });
    const tx = Transaction.from(Uint8Array.from(atob(r.tx), (c) => c.charCodeAt(0)));
    checkTransferTx(tx, {
      owner: this.owner,
      source: this.ata(),
      destination: getAssociatedTokenAddressSync(this.mint, to, true, TOKEN_PROGRAM_ID),
      mint: this.mint,
      units: toBaseUnits(amount),
    });
    // Remembered before it goes out, by its id (the platform's signature,
    // already on it as fee payer).
    const first = tx.signatures[0]?.signature;
    const pending: PendingSend | null = first
      ? { from: this.owner.toBase58(), to: to.toBase58(), amount, signature: bs58.encode(first), lvbh: r.lastValidBlockHeight, at: Date.now() }
      : null;
    if (pending) this.savePendingSend(pending);
    try {
      const signature = await this.send(tx, r);
      if (pending) this.clearPendingSend(pending.signature);
      return signature;
    } catch (e) {
      // Refused, failed or expired: nothing went out. Anything else stays
      // remembered until the next send finds out what became of it.
      if (pending && (e as { notSent?: boolean }).notSent) this.clearPendingSend(pending.signature);
      throw e;
    }
  }

  /**
   * Send one of the player's transactions and wait for it to land.
   *
   * Through the wallet's own `sendTransaction` when it has one, because that
   * is the only path that tells the wallet which cluster the transaction is
   * for (see `Signer`). Anchor's `.rpc()` would go through a bare
   * `signTransaction`, which carries no chain, and the first real tester
   * met exactly that: a wallet on mainnet, a preview against mainnet, and
   * "reverted during simulation" for a program that only exists on devnet.
   */
  private async send(
    tx: Transaction,
    { blockhash, lastValidBlockHeight }: { blockhash: string; lastValidBlockHeight: number },
    onSent?: (signature: string) => void,
  ): Promise<string> {
    let signature: string;
    // The transaction's id before it is sent: the platform signed first, as
    // fee payer, and the first signature is the id.
    const first = tx.signatures[0]?.signature;
    const id0 = first ? bs58.encode(first) : null;
    try {
      if (this.wallet.sendTransaction) {
        signature = await this.wallet.sendTransaction(tx, this.connection);
      } else {
        const signed = await this.wallet.signTransaction(tx);
        signature = await this.connection.sendRawTransaction(signed.serialize());
      }
    } catch (e) {
      // Refused by the player, or by the network before it went out (its
      // dry run failed): nothing was sent. Anything else may have gone out
      // with the answer lost, and is looked up (review 2026-10-07).
      if (!id0 || NOT_SENT.test(messagesOf(e))) throw notSent(explainWalletError(e));
      const outcome = await this.outcomeOf(id0, lastValidBlockHeight);
      if (outcome === "landed") {
        onSent?.(id0);
        return id0;
      }
      if (outcome === "failed") throw notSent(new Error("The transaction landed but failed."));
      if (outcome === "expired") throw notSent(explainWalletError(e));
      throw new Error("Couldn't confirm it. Check History before trying again.");
    }
    onSent?.(signature);

    let res;
    // Never waited on for more than ninety seconds: the confirmation can poll
    // for ever when the network stops answering (review 2026-10-07).
    const abort = new AbortController();
    const stop = setTimeout(() => abort.abort(), 90_000);
    try {
      res = await this.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight, abortSignal: abort.signal },
        "confirmed",
      );
    } catch {
      // No answer is not a failure. A payment that landed while its answer
      // was lost used to be reported as failed, and sent again on the retry
      // (review 2026-10-07: duplicate charges). It is looked up until it has
      // either landed or can no longer land.
      const outcome = await this.outcomeOf(signature, lastValidBlockHeight);
      if (outcome === "landed") return signature;
      if (outcome === "failed") throw notSent(new Error("The transaction landed but failed."));
      if (outcome === "expired") throw notSent(new Error("Not sent, nothing was taken. Try again."));
      throw new Error("Couldn't confirm it. Check History before trying again.");
    } finally {
      clearTimeout(stop);
    }
    if (res.value.err) {
      throw notSent(new Error("The transaction landed but failed: " + JSON.stringify(res.value.err)));
    }
    return signature;
  }

  /**
   * What became of a sent transaction whose confirmation never came: landed,
   * landed and failed, expired (its blockhash is past, so it can never land),
   * or unknown (the network could not be asked for two minutes).
   */
  private async outcomeOf(signature: string, lastValidBlockHeight: number): Promise<"landed" | "failed" | "expired" | "unknown"> {
    const until = Date.now() + 120_000;
    // Every question to the network ends with the two minutes, answered or not.
    const ask = <T,>(p: Promise<T>) =>
      Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error("timeout")), Math.max(1, until - Date.now())))]);
    const settled = (st: { confirmationStatus?: string | null } | null | undefined) =>
      !!st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized");
    while (Date.now() < until) {
      try {
        const st = (await ask(this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true }))).value[0];
        if (settled(st)) return st!.err ? "failed" : "landed";
        if (!st && (await ask(this.connection.getBlockHeight("confirmed"))) > lastValidBlockHeight) {
          // Past its last valid block and not found: one more look, in case it
          // landed in the last block before the answer was read. Only a
          // confirmed answer counts; a processed one can still fall away.
          const again = (await ask(this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true }))).value[0];
          if (settled(again)) return again!.err ? "failed" : "landed";
          if (!again) return "expired";
        }
      } catch {
        /* the network did not answer this time: ask again */
      }
      if (Date.now() + 2000 >= until) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    return "unknown";
  }

  /**
   * The player's USDC, read from their own associated token account.
   *
   * A wallet that has never held USDC has no token account at all, and asking
   * for one returns an error rather than a zero. That is not a failure — it is
   * the correct answer, spelled inconveniently — so it is reported as 0. Any
   * other failure (a rate-limited RPC, an endpoint that is down) is NOT
   * reported as 0, because "your balance is zero" and "we could not reach the
   * network" are different sentences and showing the first when the second is
   * true is how a player concludes their money is gone.
   */
  async getBalance(): Promise<number> {
    const info = await this.connection.getAccountInfo(this.ata());
    if (info === null) return 0;
    const bal = await this.connection.getTokenAccountBalance(this.ata());
    return fromBaseUnits(BigInt(bal.value.amount));
  }

  async deposit(): Promise<number> {
    throw new NotOnChainYet("Depositing");
  }

  async withdraw(): Promise<number> {
    throw new NotOnChainYet("Withdrawing");
  }

  /**
   * Buy a store item: USDC out of the player's account to the store treasury,
   * the platform paying the fee (api/store/buy.ts), the same sponsored shape
   * as a transfer. Returns the balance after it lands.
   */
  async purchase(amount: number, _memo: string, itemId?: string): Promise<number> {
    // Priced by the server when the item is named; the old amount form is
    // kept for callers without an item.
    const from = this.owner.toBase58();
    const item = itemId || undefined;
    // An earlier payment for this item whose outcome is not known yet is
    // settled first: paid already means paid, never twice (review 2026-10-07).
    const earlier = item ? this.pendingPurchases().find((p) => p.from === from && p.item === item) : undefined;
    if (earlier && item) {
      try {
        await post("/api/store/buy", { from, item, confirm: earlier.signature });
        this.savePendingPurchases(this.pendingPurchases().filter((x) => x.signature !== earlier.signature));
        window.dispatchEvent(new Event(PURCHASE_RECORDED));
        return this.balanceAfter();
      } catch (e) {
        // Only a payment that failed on chain, or one that can no longer land
        // and is not there, makes a new one safe. A payment the site cannot
        // record (a changed treasury) was still paid: kept, not
        // charged again (review 2026-10-07).
        const failed = e instanceof ServerError && e.status === 400 && /failed/i.test(e.message);
        const notYet = e instanceof ServerError && e.status === 404;
        if (failed || (notYet && (await this.neverLanded(earlier)))) {
          this.savePendingPurchases(this.pendingPurchases().filter((x) => x.signature !== earlier.signature));
        } else if (notYet) {
          throw new Error("Your last payment for this is still on its way. Try again in a minute.");
        } else if (e instanceof ServerError && e.status === 400) {
          throw new Error("Your last payment for this couldn't be recorded.");
        } else {
          throw new Error("Couldn't check your last payment. Try again in a minute.");
        }
      }
    }
    const proof = await this.prove("buy", buyDetail(item, amount));
    const r = await post<SponsoredTx & { owned?: boolean }>("/api/store/buy", item ? { from, item, proof } : { from, amount, proof });
    // Already paid for, on this phone or another: nothing to charge.
    if (r.owned) {
      window.dispatchEvent(new Event(PURCHASE_RECORDED));
      return this.balanceAfter();
    }
    const tx = Transaction.from(Uint8Array.from(atob(r.tx), (c) => c.charCodeAt(0)));
    // The store's treasury as the program's config names it, the price the
    // app shows, and the memo naming the item.
    const treasury = (await escrowProgram(this.connection, this.wallet).account.config.fetch(configPda())).feeWallet;
    checkTransferTx(tx, {
      owner: this.owner,
      source: this.ata(),
      destination: getAssociatedTokenAddressSync(this.mint, treasury, false, TOKEN_PROGRAM_ID),
      mint: this.mint,
      units: toBaseUnits(itemId ? (STORE_PRICES[itemId] ?? amount) : amount),
      memo: itemId ? purchaseMemo(itemId) : undefined,
    });
    // Queued before it is sent: the platform signed first, as fee payer, and
    // the first signature is the transaction's id, so a payment that lands
    // while the answer to the send is lost is still finished later.
    const id0 = tx.signatures[0]?.signature;
    const queued = itemId && id0 ? bs58.encode(id0) : null;
    if (itemId && queued) {
      this.savePendingPurchases([...this.pendingPurchases(), { from, item: itemId, signature: queued, at: Date.now(), lvbh: r.lastValidBlockHeight }]);
    }
    let signature: string;
    try {
      signature = await this.send(tx, r);
    } catch (e) {
      // Refused, failed on its dry run, or expired: nothing was taken, and the
      // queued entry must not hold the next try back (review 2026-10-07).
      if (queued && (e as { notSent?: boolean }).notSent) {
        this.savePendingPurchases(this.pendingPurchases().filter((x) => x.signature !== queued));
      }
      throw e;
    }
    // The purchase becomes a record once the server has read it back from the
    // chain; it is what a room checks before letting the weapon in. Retried a
    // few times, because devnet can take a moment to show a transaction.
    if (itemId) {
      let last: unknown = null;
      for (let i = 0; i < 5; i++) {
        try {
          await post("/api/store/buy", { from, item: itemId, confirm: signature });
          this.savePendingPurchases(this.pendingPurchases().filter((x) => x.signature !== signature));
          window.dispatchEvent(new Event(PURCHASE_RECORDED));
          last = null;
          break;
        } catch (e) {
          last = e;
          await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
        }
      }
      if (last) console.warn("[store] purchase not recorded yet:", (last as Error).message);
    }
    // Paid either way: a balance that cannot be read now is NaN, not an error,
    // so it never stands between the player and the item (store.tsx).
    return this.balanceAfter();
  }

  /** The balance after a payment, or NaN when it cannot be read within a few seconds. */
  private balanceAfter(): Promise<number> {
    return Promise.race([this.getBalance(), new Promise<number>((r) => setTimeout(() => r(NaN), 6000))]).catch(() => NaN);
  }

  /** A queued payment that is not on chain and can no longer get there. */
  private async neverLanded(p: PendingPurchase): Promise<boolean> {
    // Ten seconds for the whole question, or the answer is "not proven".
    const until = Date.now() + 10_000;
    const ask = <T,>(q: Promise<T>) =>
      Promise.race([q, new Promise<never>((_, no) => setTimeout(() => no(new Error("timeout")), Math.max(1, until - Date.now())))]);
    const absent = async () => !(await ask(this.connection.getSignatureStatuses([p.signature], { searchTransactionHistory: true }))).value[0];
    try {
      // Past its last block first, then not there: read the other way round,
      // it could land in its last block between the two (review 2026-10-07).
      // Queued by an older build, which did not keep its last block: only a
      // day on, far past any transaction's life of a minute or two and any
      // clock error short of a day, and never without its time.
      const expired = p.lvbh
        ? (await ask(this.connection.getBlockHeight("confirmed"))) > p.lvbh
        : !!p.at && Date.now() - p.at > 24 * 3600_000;
      return expired && (await absent());
    } catch {
      return false;
    }
  }

  /**
   * Take a seat: the server opens a match for the tier, the wallet approves
   * one entry to it. The approval is the wallet prompt; nothing moves.
   */
  async enterLobby(tier: PriceTier): Promise<void> {
    if (this.pending) await this.leaveLobby();

    const ata = this.ata();
    if ((await this.connection.getAccountInfo(ata)) === null) {
      throw new Error("You have no USDC in this wallet yet — claim some from the faucet first.");
    }

    const opened = await post<OpenReply>("/api/match/open", { tier: tier.id });
    const id = BigInt(opened.id);
    if (BigInt(opened.entry) !== toBaseUnits(tier.entry)) {
      throw new Error("The server opened a match at a different entry than this tier");
    }

    // The entry on chain, not the reply's figure, before signing (outside
    // review, 2026-10-14), as stakeInto does.
    await this.sponsored("join", id, null, tier);
    this.pending = { id, tier };
  }

  /** The match exists and its entry is the tier's; a new match may take a moment to show. */
  private async requireEntry(id: bigint, tier: PriceTier): Promise<void> {
    const program = escrowProgram(this.connection, this.wallet);
    for (let i = 0; i < 4; i++) {
      const m = await program.account.match.fetchNullable(matchPda(id)).catch(() => null);
      if (m) {
        if (BigInt(m.entry.toString()) !== toBaseUnits(tier.entry)) throw new TxRefused("the match's entry is not the pool's");
        return;
      }
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
    throw new TxRefused("the match could not be read");
  }

  /** This wallet's standing in a match, as the chain has it. */
  /** See EconomyService.stakeStatus: null when the match is gone or unreadable. */
  async stakeStatus(matchId: string): Promise<string | null> {
    try {
      const match = await escrowProgram(this.connection, this.wallet).account.match.fetchNullable(matchPda(BigInt(matchId)));
      if (!match) return null;
      const player = match.players.find((p) => p.key.equals(this.owner));
      return player ? enumKey<PlayerStatus>(player.status) : "none";
    } catch {
      return null;
    }
  }

  private async statusIn(id: bigint): Promise<PlayerStatus | "none"> {
    const match = await escrowProgram(this.connection, this.wallet).account.match.fetchNullable(matchPda(id));
    const player = match?.players.find((p) => p.key.equals(this.owner));
    return player ? enumKey<PlayerStatus>(player.status) : "none";
  }

  /**
   * Approve one entry to a match the room server opened. The room tells the
   * player the match id; the player's wallet signs the approval (sponsored,
   * as ever); the room then checks the chain before it counts the seat.
   */
  async stakeInto(matchId: string, tier: PriceTier, admit?: { exp: number; sig: string } | null): Promise<void> {
    const id = BigInt(matchId);
    if (this.pending && this.pending.id !== id) await this.leaveLobby();
    // A remembered approval is not trusted on its own: a revoke that failed
    // and an eviction since can leave it pointing at a seat that is gone.
    const ata = this.ata();
    if ((await this.connection.getAccountInfo(ata)) === null) {
      throw new Error("You have no USDC in this wallet yet — claim some from the faucet first.");
    }
    // Approved already (a reload, a reconnect, or a send whose confirmation
    // was lost): the seat is held, and joining again would be refused.
    const status = await this.statusIn(id).catch(() => "none" as const);
    if (status === "joined" || status === "collected") {
      this.pending = { id, tier };
      return;
    }
    // The approval is for whatever the match's entry is: the room must not
    // be able to point a cheap pool's player at a dearer match (review R10).
    await this.requireEntry(id, tier);
    try {
      await this.sponsored("join", id, admit, tier);
    } catch (e) {
      if ((await this.statusIn(id).catch(() => null)) !== "joined") throw e;
    }
    this.pending = { id, tier };
  }

  /** The approval back, before the room collected. */
  async unstake(matchId?: string): Promise<void> {
    // The match named first: a leave revoked in the background (LobbySelect)
    // can run after the player has staked in another pool, and taking the
    // stake in progress first revoked that one (review, 2026-10-12).
    const id = matchId !== undefined ? BigInt(matchId) : this.pending?.id;
    if (id === undefined) return;
    // Nothing approved on chain is nothing to revoke. Unreadable: try anyway.
    if ((await this.statusIn(id).catch(() => "joined" as const)) !== "joined") {
      if (this.pending?.id === id) this.pending = null;
      return;
    }
    try {
      await this.sponsored("leave", id);
    } catch (e) {
      // Landed after all, or gone already: either way it is off.
      if ((await this.statusIn(id).catch(() => "joined" as const)) === "joined") throw e;
    }
    // Keep the approval available to retry until the chain says it is gone.
    if (this.pending?.id === id) this.pending = null;
  }

  /** The room collected the stake: the seat is spent, nothing to revoke. */
  markCollected(): void {
    this.pending = null;
  }

  /** Give the seat back: revoke the approval, and let the server close the
   *  room if nobody else is in it. Free, by design. */
  async leaveLobby(): Promise<void> {
    const p = this.pending;
    this.pending = null;
    if (!p) return;
    try {
      await this.sponsored("leave", p.id);
    } finally {
      // Whether or not the revoke went through, the server should reclaim the
      // room's rent; it checks the chain itself before doing anything.
      void post("/api/match/abandon", { id: p.id.toString() }).catch(() => {});
    }
  }

  /**
   * The room is full: the server collects every approved stake and locks the
   * match. The receipt records what the vault actually holds.
   */
  async joinMatch(tier: PriceTier, roster: number): Promise<EscrowReceipt> {
    const p = this.pending;
    if (!p || p.tier.id !== tier.id) {
      throw new Error("No seat is held in this lobby — pick the pool again");
    }
    const r = await post<CollectReply>("/api/match/collect", { id: p.id.toString() });
    if (!r.started) {
      this.pending = null;
      throw new Error(
        r.reason === "TooFewPlayers"
          ? "Not enough stakes were collected to start — nothing was charged"
          : (r.reason ?? "The pool could not be collected"),
      );
    }
    this.pending = null;
    return {
      matchId: p.id.toString(),
      tier,
      held: tier.entry,
      roster,
      stakers: r.collected,
    };
  }

  /** A stalled lobby: nothing was collected, so there is nothing to refund
   *  beyond letting the server close the room. */
  async refund(receipt: EscrowReceipt): Promise<number> {
    await post("/api/match/abandon", { id: receipt.matchId }).catch(() => {});
    return this.getBalance();
  }

  /**
   * Settle: the ranking of stakers goes to the server, the program pays the
   * podium, and the board comes back costed from what actually moved.
   *
   * A flagged match (`credit: false`) is not settled. The stake stays in the
   * vault and comes back through the refund deadline — the program has no
   * way to pay nobody, and paying the fee wallet the whole pool would be a
   * power the authority must not have.
   */
  async settleMatch(
    receipt: EscrowReceipt,
    ranked: RankedPlayer[],
    opts: SettleOptions = {},
  ): Promise<MatchResult> {
    const self = ranked.find((p) => p.isSelf);
    if (!self) throw new Error("This board has no result for you — nothing settled");
    const me = this.owner.toBase58();

    if (opts.credit === false) {
      await post("/api/match/flag", { id: receipt.matchId }).catch(() => {});
      const players = ranked.map((p) => ({ ...p, payout: 0 }));
      return {
        tier: receipt.tier,
        players,
        self: players.find((p) => p.isSelf)!,
        pool: receipt.tier.entry * receipt.stakers,
        fee: 0,
      };
    }

    // Stakers only, best first. Bots have no wallet and cannot be paid.
    const ranking = ranked
      .filter((p) => p.wallet || p.isSelf)
      .map((p) => p.wallet ?? me);

    const r = await post<SettleReply>("/api/match/settle", {
      id: receipt.matchId,
      ranking,
    });

    const players = ranked.map((p) => {
      const w = p.wallet ?? (p.isSelf ? me : null);
      const paid = w ? (r.amounts[w] ?? 0) : 0;
      return { ...p, payout: fromBaseUnits(paid) };
    });
    return {
      tier: receipt.tier,
      players,
      self: players.find((p) => p.isSelf)!,
      pool: fromBaseUnits(r.pool),
      fee: fromBaseUnits(r.fee),
    };
  }
}
