import { CLUSTER, SERVER_URL } from "./config";
import { FAUCET_DETAIL, proveWalletRequest } from "./walletRequest";

/**
 * Test USDC, from inside the app.
 *
 * Devnet only: the mint is ours and the server holds its authority. On
 * mainnet there is no such thing — USDC is Circle's and nobody prints it —
 * so the button that calls this does not exist there.
 */
export const FAUCET_AVAILABLE = CLUSTER !== "mainnet-beta";

/** What one claim is worth. Kept in step with api/faucet.ts. */
export const FAUCET_CLAIM = 2;

/** Asked for in the wallet's own name: it signs the request, silently (walletRequest.ts). */
export async function claimTestUsdc(
  wallet: string,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
): Promise<{ signature: string; balance: number }> {
  const proof = await proveWalletRequest(wallet, "faucet", FAUCET_DETAIL, signMessage);
  const res = await fetch(SERVER_URL + "/api/faucet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet, proof }),
  });
  const data = (await res.json().catch(() => null)) as
    | { signature?: string; balance?: number; error?: string }
    | null;
  if (!res.ok) throw new Error(data?.error ?? `The faucet is not answering (${res.status})`);
  return { signature: data?.signature ?? "", balance: data?.balance ?? 0 };
}
