import { HttpError, ipKey, parsePubkey, requireWalletProof } from "./_lib.js";
import { dbRpc, withinLimit } from "./_db.js";
import { freePlayDetail, freePlayStartDetail } from "../src/chain/walletRequest.js";

const NETWORK = process.env.SOLANA_CLUSTER || process.env.VITE_SOLANA_CLUSTER || "devnet";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Signed account results only: no roster, bot wallet, skull amount or total
 * is accepted. Placement is client-reported, not server-simulated gameplay;
 * this ladder must not be used to distribute prizes without stronger proof. */
export async function freePlayMessage(body: Record<string, unknown>, req: Request) {
  const wallet = parsePubkey(body.wallet);
  const session = body.session;
  if (typeof session !== "string" || !UUID.test(session)) throw new HttpError(400, "Invalid Free Play session.");
  const finish = body.freePlay === "finish";
  const version = body.rewardVersion === undefined ? 1 : body.rewardVersion;
  if (version !== 1 && version !== 2) throw new HttpError(400, "Unsupported Free Play reward version.");
  const rank = body.rank as number;
  const elapsedMs = body.elapsedMs as number;
  if (finish && (!Number.isInteger(rank) || rank < 1 || rank > 40 || !Number.isInteger(elapsedMs) || elapsedMs < 600000 || elapsedMs > 630000)) {
    throw new HttpError(400, "Only a completed Free Play match can earn skulls.");
  }
  await requireWalletProof(body, wallet, finish ? "freeplay-finish" : "freeplay-start",
    finish ? freePlayDetail(session, rank, elapsedMs, version) : freePlayStartDetail(session, version));
  // Request abuse throttles, not a daily play quota. A full match is 10 min.
  if (!(await withinLimit(`freeplay:ip:${ipKey(req)}`, 240, 60)) ||
      !(await withinLimit(`freeplay:w:${wallet.toBase58()}`, 30, 60))) {
    throw new HttpError(429, "Too many requests. Try again shortly.");
  }
  const result = await dbRpc<{ ok: boolean; error?: string; session?: string; awarded?: number; total?: number }>(
    finish ? "finish_free_play_session_versioned" : "start_free_play_session_versioned", {
      p_network: NETWORK, p_wallet: wallet.toBase58(), p_session: session,
      p_reward_version: version,
      ...(finish ? { p_rank: rank, p_elapsed_ms: elapsedMs } : {}),
    });
  if (!result) throw new HttpError(503, "Free Play rankings are unavailable. Your game can still be played.");
  if (!result.ok) throw new HttpError(400, result.error || "This match could not be credited.");
  return result;
}
