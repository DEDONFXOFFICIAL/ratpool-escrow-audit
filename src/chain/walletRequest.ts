/**
 * A request in a wallet's name, proven by that wallet (review 2026-10-06).
 *
 * Sends, store purchases and test-USDC claims name the wallet they are for,
 * and the server counts that wallet's allowances against the name. A name
 * is not proof: wallet addresses are public on chain, so anyone could spend
 * another player's allowance with requests the player never made. The app
 * signs this text with the wallet, silently, as it does an account save, and
 * the server checks it before it prepares or counts anything.
 *
 *   RatPool request
 *   site: ratpool.xyz
 *   network: devnet | mainnet-beta
 *   wallet: <base58>
 *   action: send | buy | faucet | leave
 *   detail: <exactly what: recipient and amount, the item, the match, or ->
 *   issued: <ISO time>
 *   nonce: <32 hex>
 *
 * Shared by the app and api/_lib.ts (requireWalletProof), so both build the
 * detail the same way from the same request.
 */
export type WalletAction = "send" | "buy" | "faucet" | "leave";

export interface WalletProof {
  message: string;
  /** Base64. */
  signature: string;
}

export interface WalletRequest {
  wallet: string;
  action: string;
  detail: string;
  issued: string;
  nonce: string;
  /** The network it was signed for; absent from apps before 0.4.8.4. */
  network?: string;
}

const HEAD = "RatPool request";

/**
 * Where a signature is good: this site, and this network (outside report,
 * 2026-10-18). Two lines in every text the app signs for RatPool, under its
 * first, so one signed on devnet is refused by a mainnet server and one
 * signed for another site is refused here. Apps from before send neither:
 * taken on devnet while they update, never on mainnet (api/_lib.ts
 * checkSignedFor).
 */
export const SIGNED_SITE = "ratpool.xyz";
export const signedForLines = (network: string): string[] => [`site: ${SIGNED_SITE}`, `network: ${network}`];

export const sendDetail = (to: unknown, amount: unknown) => `${String(to)} ${String(amount)}`;
export const buyDetail = (item: unknown, amount: unknown) =>
  typeof item === "string" ? `item ${item}` : `amount ${String(amount)}`;
export const FAUCET_DETAIL = "-";
export const leaveDetail = (match: unknown) => `match ${String(match)}`;

export function walletRequestText(r: WalletRequest): string {
  return [
    HEAD,
    ...(r.network ? signedForLines(r.network) : []),
    `wallet: ${r.wallet}`,
    `action: ${r.action}`,
    `detail: ${r.detail}`,
    `issued: ${r.issued}`,
    `nonce: ${r.nonce}`,
  ].join("\n");
}

/** The fields of a request text, or null when it is not one. */
export function readWalletRequest(message: string): WalletRequest | null {
  let lines = message.split("\n");
  let network: string | undefined;
  if (lines.length === 8 && lines[1] === `site: ${SIGNED_SITE}` && lines[2].startsWith("network: ")) {
    network = lines[2].slice("network: ".length);
    lines = [lines[0], ...lines.slice(3)];
  }
  if (lines.length !== 6 || lines[0] !== HEAD) return null;
  const keys = ["wallet", "action", "detail", "issued", "nonce"] as const;
  const out: Partial<WalletRequest> = {};
  for (let i = 0; i < keys.length; i++) {
    const prefix = `${keys[i]}: `;
    if (!lines[i + 1].startsWith(prefix)) return null;
    out[keys[i]] = lines[i + 1].slice(prefix.length);
  }
  if (network) out.network = network;
  return /^[0-9a-f]{32}$/.test(out.nonce!) ? (out as WalletRequest) : null;
}

/** Sign a request with the wallet: no prompt on the embedded wallet. */
export async function proveWalletRequest(
  wallet: string,
  action: WalletAction,
  detail: string,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
  network: string,
): Promise<WalletProof> {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const message = walletRequestText({ wallet, action, detail, issued: new Date().toISOString(), nonce, network });
  const sig = await signMessage(new TextEncoder().encode(message));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return { message, signature: btoa(bin) };
}
