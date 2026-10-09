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
}

const HEAD = "RatPool request";

export const sendDetail = (to: unknown, amount: unknown) => `${String(to)} ${String(amount)}`;
export const buyDetail = (item: unknown, amount: unknown) =>
  typeof item === "string" ? `item ${item}` : `amount ${String(amount)}`;
export const FAUCET_DETAIL = "-";
export const leaveDetail = (match: unknown) => `match ${String(match)}`;

export function walletRequestText(r: WalletRequest): string {
  return [HEAD, `wallet: ${r.wallet}`, `action: ${r.action}`, `detail: ${r.detail}`, `issued: ${r.issued}`, `nonce: ${r.nonce}`].join("\n");
}

/** The fields of a request text, or null when it is not one. */
export function readWalletRequest(message: string): WalletRequest | null {
  const lines = message.split("\n");
  if (lines.length !== 6 || lines[0] !== HEAD) return null;
  const keys = ["wallet", "action", "detail", "issued", "nonce"] as const;
  const out: Partial<WalletRequest> = {};
  for (let i = 0; i < keys.length; i++) {
    const prefix = `${keys[i]}: `;
    if (!lines[i + 1].startsWith(prefix)) return null;
    out[keys[i]] = lines[i + 1].slice(prefix.length);
  }
  return /^[0-9a-f]{32}$/.test(out.nonce!) ? (out as WalletRequest) : null;
}

/** Sign a request with the wallet: no prompt on the embedded wallet. */
export async function proveWalletRequest(
  wallet: string,
  action: WalletAction,
  detail: string,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
): Promise<WalletProof> {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const message = walletRequestText({ wallet, action, detail, issued: new Date().toISOString(), nonce });
  const sig = await signMessage(new TextEncoder().encode(message));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return { message, signature: btoa(bin) };
}
