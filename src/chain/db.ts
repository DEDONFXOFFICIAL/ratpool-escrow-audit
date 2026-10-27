import type { PublicKey } from "@solana/web3.js";
import type { Character, CharacterTraits } from "@/state/types";
import type { Board, BoardRow } from "@/state/leaderboard";
import { BOARD_SIZE } from "@/state/leaderboard";
import { CHAIN_ENABLED, CLUSTER, SERVER_URL } from "./config";
import { signedForLines } from "./walletRequest";

/**
 * The database, from the browser's side: reads only.
 *
 * Supabase over its REST endpoint with the anon key, which the row-level
 * policies (supabase/) let read the public records (profiles, the boards,
 * purchases) and write nothing; private tables are the server's alone. The
 * one write a player makes — their rat — goes to /api/profile with a
 * signature from their wallet, and the server does the writing.
 *
 * Only on the chain build. The demo has a made-up wallet and keeps its
 * made-up ladder; a database of demo rats would be mock information with
 * extra steps.
 */

const env = import.meta.env as unknown as Record<string, string | undefined>;
const DB_URL = env.VITE_SUPABASE_URL || null;
const ANON = env.VITE_SUPABASE_ANON_KEY || null;

export const DB_ENABLED = CHAIN_ENABLED && DB_URL !== null && ANON !== null;

/**
 * A deadline for a request: an answer that has not come by then is treated
 * as none (the callers already handle a failed read). A stalled read held up
 * sign-in's account sync, and with it every save, for as long as it hung
 * (review, 2026-10-12). Six seconds for the database, as the server allows
 * itself (api/_db.ts); longer for the site's functions, which can start cold.
 */
function deadline(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

async function select<T>(path: string): Promise<T | null> {
  if (!DB_ENABLED) return null;
  try {
    const res = await fetch(`${DB_URL}/rest/v1/${path}`, {
      headers: { apikey: ANON!, authorization: `Bearer ${ANON}` },
      signal: deadline(6_000),
    });
    if (!res.ok) {
      console.warn(`[db] ${path} → ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    console.warn(`[db] ${path} failed:`, (e as Error).message);
    return null;
  }
}

/** How many rows match, without fetching them. */
async function count(path: string): Promise<number | null> {
  if (!DB_ENABLED) return null;
  try {
    const res = await fetch(`${DB_URL}/rest/v1/${path}`, {
      method: "HEAD",
      headers: { apikey: ANON!, authorization: `Bearer ${ANON}`, prefer: "count=exact" },
      signal: deadline(6_000),
    });
    const range = res.headers.get("content-range") ?? "";
    const n = Number(range.split("/")[1]);
    return res.ok && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- profile

interface DbProfile {
  wallet: string;
  name: string;
  traits: CharacterTraits;
  updated_at: string;
}

/**
 * The rat this wallet registered, from any device — null if none yet, and
 * undefined if the database could not be asked (never read that as "none").
 */
export async function fetchProfile(wallet: string): Promise<Character | null | undefined> {
  const rows = await select<DbProfile[]>(
    `profiles?wallet=eq.${encodeURIComponent(wallet)}&select=wallet,name,traits,updated_at&limit=1`,
  );
  if (!rows) return undefined;
  const p = rows[0];
  if (!p || typeof p.name !== "string" || typeof p.traits !== "object") return null;
  return { displayName: p.name, traits: p.traits, lockedAt: Date.parse(p.updated_at) || Date.now() };
}

/** The text the wallet signs. Line for line what api/profile.ts expects. */
export function profileMessage(wallet: string, c: Character): string {
  return [
    "RatPool profile",
    ...signedForLines(CLUSTER),
    `wallet: ${wallet}`,
    `name: ${c.displayName}`,
    `traits: ${JSON.stringify(c.traits)}`,
    `issued: ${new Date().toISOString()}`,
  ].join("\n");
}

export type SignMessage = (message: Uint8Array) => Promise<Uint8Array>;

/**
 * Register the rat under the wallet. One message signature — no transaction,
 * no fee — at the moment the rat is locked in, and never again unless it
 * changes. Throws if the wallet declines or the server refuses; the caller
 * decides what that means (the local copy is already saved either way).
 */
export async function saveProfile(wallet: PublicKey, c: Character, signMessage: SignMessage): Promise<void> {
  const message = profileMessage(wallet.toBase58(), c);
  const sig = await signMessage(new TextEncoder().encode(message));
  const signature = btoa(String.fromCharCode(...sig));
  const res = await fetch(SERVER_URL + "/api/profile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, signature }),
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      /* raw */
    }
    throw new Error(msg || `${res.status} from the server`);
  }
}

// ---------------------------------------------------------------- account

/**
 * The rest of the account under this wallet — settings, loadout, record —
 * or null if none is saved yet. `undefined` when the database could not be
 * reached, so a failed read is never mistaken for an empty account.
 */
export async function fetchAccount(
  wallet: PublicKey | null,
  signMessage: SignMessage | undefined,
): Promise<{ state: unknown; at: number } | null | undefined> {
  // Private since 2026-09-30: read through the server with a silent wallet
  // signature, the same proof a save uses. No wallet yet is "cannot tell".
  if (!DB_ENABLED || !wallet || !signMessage) return undefined;
  const message = ["RatPool account read", ...signedForLines(CLUSTER), `wallet: ${wallet.toBase58()}`, `issued: ${new Date().toISOString()}`].join(
    "\n",
  );
  try {
    const r = await postSigned<{ state: unknown; updated_at?: string }>(message, signMessage);
    return r.state ? { state: r.state, at: Date.parse(r.updated_at ?? "") || 0 } : null;
  } catch {
    return undefined;
  }
}

/** Save the account under the wallet: one silent message signature, no transaction. */
export async function saveAccount(wallet: PublicKey, state: unknown, signMessage: SignMessage): Promise<void> {
  const message = [
    "RatPool account",
    ...signedForLines(CLUSTER),
    `wallet: ${wallet.toBase58()}`,
    `issued: ${new Date().toISOString()}`,
    `state: ${JSON.stringify(state)}`,
  ].join("\n");
  const sig = await signMessage(new TextEncoder().encode(message));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  const res = await fetch(SERVER_URL + "/api/profile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, signature: btoa(bin) }),
  });
  if (!res.ok) throw new Error((await res.text()) || `${res.status} from the server`);
}

/**
 * The store items this wallet has paid for, as the server recorded them after
 * reading each payment back from the chain (api/store/buy.ts). Null when the
 * database could not be asked.
 */
export async function fetchPurchasedItems(wallet: string): Promise<string[] | null> {
  const rows = await select<{ item: string }[]>(`purchases?wallet=eq.${encodeURIComponent(wallet)}&select=item`);
  return rows ? [...new Set(rows.map((r) => r.item))] : null;
}

/** This wallet's skulls as the board counts them; undefined if unreachable. */
export async function fetchMySkulls(wallet: string): Promise<number | undefined> {
  const rows = await select<{ skulls: number }[]>(
    `leaderboard?wallet=eq.${encodeURIComponent(wallet)}&select=skulls`,
  );
  if (!rows) return undefined;
  return rows[0]?.skulls ?? 0;
}

// ---------------------------------------------------------------- the board

interface DbBoardRow {
  wallet: string;
  name: string;
  skulls: number;
  matches: number;
  earnings: number;
}

/**
 * The ladder as the database holds it: everyone who has finished a settled
 * match, best first, with the viewer's own row wherever it lands — pinned
 * below the hundred if that is where it is, and at the bottom with zero if
 * they have not played yet. Null when the database cannot be reached, so
 * the screen can say so rather than draw an empty board as if it were true.
 */
export async function fetchBoard(self: string, selfName: string): Promise<Board | null> {
  const rows = await select<DbBoardRow[]>(
    `leaderboard?select=wallet,name,skulls,matches,earnings&order=skulls.desc,name.asc&limit=${BOARD_SIZE}`,
  );
  if (!rows) return null;
  const top: BoardRow[] = rows.map((r, i) => ({
    rank: i + 1,
    name: r.name === r.wallet ? shortWallet(r.wallet) : r.name,
    skulls: r.skulls,
    isSelf: r.wallet === self,
  }));

  let selfRow = top.find((r) => r.isSelf);
  let total = rows.length;
  if (!selfRow) {
    // Off the hundred, or not on it at all. Ask where they actually stand.
    // Every figure here is asked, not guessed: if any answer is missing the
    // board is unavailable, rather than a rank and a field size made up from
    // what did arrive.
    const mine = await select<DbBoardRow[]>(`leaderboard?wallet=eq.${encodeURIComponent(self)}&select=skulls`);
    if (!mine) return null;
    const skulls = mine[0]?.skulls ?? 0;
    const above = await count(`leaderboard?select=wallet&skulls=gt.${skulls}`);
    const all = await count("leaderboard?select=wallet");
    if (above === null || all === null) return null;
    // Not in the list means below it: players tied on skulls are listed by
    // name, so counting only those above could rank someone inside the list
    // they were not in, and they were shown nowhere (review, 2026-10-12).
    const rank = mine[0] ? Math.max(above + 1, rows.length + 1) : above + 1;
    total = all + (mine[0] ? 0 : 1);
    selfRow = { rank, name: selfName || "You", skulls, isSelf: true };
  }
  return { top, self: selfRow, total, selfOffBoard: !top.some((r) => r.isSelf) };
}

/**
 * A settled match's board, as the server wrote it at settle: every staker's
 * rank and payout, with names where the wallets have registered a rat.
 * Null when the match has not been settled (or the database is off), so a
 * walked-out match can be told apart from one still running.
 */
/**
 * What the database says became of a match ("settled", "refunded",
 * "closed", ...), or null if it cannot say. A match refunded instead of paid
 * has no board, and its record used to wait for one for ever (review,
 * 2026-10-12).
 */
export async function fetchMatchState(matchId: string): Promise<string | null> {
  const rows = await select<{ state: string }[]>(`matches?id=eq.${encodeURIComponent(matchId)}&select=state`);
  return rows?.[0]?.state ?? null;
}

export async function fetchMatchBoard(
  matchId: string,
): Promise<{ wallet: string; name: string; rank: number; payout: number; skulls: number }[] | null> {
  const rows = await select<{ wallet: string; rank: number; payout: number; skulls: number }[]>(
    `results?match_id=eq.${encodeURIComponent(matchId)}&select=wallet,rank,payout,skulls&order=rank.asc`,
  );
  if (!rows || rows.length === 0) return null;
  const wallets = rows.map((r) => r.wallet);
  const names = await select<{ wallet: string; name: string }[]>(
    `profiles?wallet=in.(${wallets.map(encodeURIComponent).join(",")})&select=wallet,name`,
  );
  const byWallet = new Map((names ?? []).map((p) => [p.wallet, p.name]));
  return rows.map((r) => ({
    wallet: r.wallet,
    name: byWallet.get(r.wallet) ?? shortWallet(r.wallet),
    rank: r.rank,
    payout: Number(r.payout),
    skulls: r.skulls,
  }));
}

const shortWallet = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;

// ---------------------------------------------------------------- invites

/**
 * Invites, through the same signed door as the profile (api/_referral.ts):
 * the wallet signs a short text naming itself, silently with the in-app
 * wallet, and the server answers. Rewards are paid by the escrow at each
 * payout to the recorded referrers of invited podium finishers.
 */
export interface InviteInfo {
  code: string;
  invited: number;
  verified: number;
  /** USDC earned from invited friends' podium finishes, all time. */
  earned?: number;
  /** Each referral payout, newest first. */
  rewards?: { id: string; amount: number; at: string }[];
  recent:{ name: string; at: string; verified: boolean }[];
  /** This player's own invite, to record on chain (InviteRecord). */
  record?: InviteRecord;
}

/** The link a player shares. The website keeps the code for whoever opens it. */
export const inviteLink = (code: string) => `https://www.ratpool.xyz/r/${code}`;

/** A code a friend passed on: six letters and digits, none of 0/O or 1/I/L. */
export const INVITE_CODE_RE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/;

async function postSigned<T>(message: string, signMessage: SignMessage): Promise<T> {
  const sig = await signMessage(new TextEncoder().encode(message));
  const signature = btoa(String.fromCharCode(...sig));
  const res = await fetch(SERVER_URL + "/api/profile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, signature }),
    signal: deadline(10_000),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* raw */
  }
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? (text || `${res.status} from the server`));
  return data as T;
}

/** This player's invite code (made the first time) and who has used it. */
export function fetchInvite(wallet: PublicKey, signMessage: SignMessage): Promise<InviteInfo> {
  const message = ["RatPool referral", ...signedForLines(CLUSTER), `wallet: ${wallet.toBase58()}`, `issued: ${new Date().toISOString()}`].join(
    "\n",
  );
  return postSigned<InviteInfo>(message, signMessage);
}

/** A transaction recording this player's invite on chain, offered by the site when it is not recorded yet. */
export interface InviteRecord {
  tx: string;
  referrer: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

/** A new player names the friend who invited them. */
export function claimInvite(
  wallet: PublicKey,
  code: string,
  signMessage: SignMessage,
): Promise<{ ok: true; verified: boolean; referrer?: string; record?: InviteRecord }> {
  const message = [
    "RatPool referral claim",
    ...signedForLines(CLUSTER),
    `wallet: ${wallet.toBase58()}`,
    `code: ${code.trim().toUpperCase()}`,
    `issued: ${new Date().toISOString()}`,
  ].join("\n");
  return postSigned(message, signMessage);
}

/** A code the website saved when this browser opened an invite link, if it is recent. */
export function savedInviteCode(): string | null {
  try {
    const saved = JSON.parse(localStorage.getItem("ratpool.ref") ?? "null") as { code?: unknown; at?: unknown } | null;
    if (!saved || typeof saved.code !== "string" || !INVITE_CODE_RE.test(saved.code)) return null;
    if (typeof saved.at !== "number" || Date.now() - saved.at > 30 * 24 * 3600 * 1000) return null;
    return saved.code;
  } catch {
    return null;
  }
}

/** One row of the referral board: a player, what their invites earned them, and friends who joined. */
export interface ReferralRow {
  rank: number;
  name: string;
  earned: number;
  joined: number;
  isSelf: boolean;
}

/** How many the referral board shows. */
export const REFERRAL_BOARD_SIZE = 50;

/**
 * The referral board (supabase view referral_board): the top fifty by what
 * their invites earned them (owner, 2026-09-30), friends who joined breaking
 * ties, and the viewer's own place if they are not in it.
 * Null when the database cannot be reached.
 */
export async function fetchReferralBoard(
  self: string,
  selfName: string,
): Promise<{ top: ReferralRow[]; self: ReferralRow | null; selfOffBoard: boolean } | null> {
  const rows = await select<{ wallet: string; name: string; earned: number; joined: number }[]>(
    `referral_board?select=wallet,name,earned,joined&joined=gt.0&order=earned.desc,joined.desc,name.asc&limit=${REFERRAL_BOARD_SIZE}`,
  );
  if (!rows) return null;
  const top = rows.map((r, i) => ({
    rank: i + 1,
    name: r.name === r.wallet ? shortWallet(r.wallet) : r.name,
    earned: Number(r.earned) || 0,
    joined: r.joined,
    isSelf: r.wallet === self,
  }));
  const onBoard = top.find((r) => r.isSelf) ?? null;
  if (onBoard) return { top, self: onBoard, selfOffBoard: false };
  const mine = await select<{ earned: number; joined: number }[]>(`referral_board?wallet=eq.${encodeURIComponent(self)}&select=earned,joined`);
  const me = mine?.[0];
  if (!mine || !me || me.joined === 0) return { top, self: null, selfOffBoard: false };
  const above = await count(`referral_board?select=wallet&earned=gt.${Number(me.earned) || 0}`);
  if (above === null) return { top, self: null, selfOffBoard: false };
  return {
    top,
    self: { rank: above + 1, name: selfName || "You", earned: Number(me.earned) || 0, joined: me.joined, isSelf: true },
    selfOffBoard: true,
  };
}
