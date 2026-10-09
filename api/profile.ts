import { preflight, endpoint, HttpError, parsePubkey, signedBy } from "./_lib.js";
import { DB_ENABLED, dbUpsert } from "./_db.js";
import { readAccountState, saveAccountState } from "./_account.js";
import { isReferralMessage, referralMessage, verifyReferral } from "./_referral.js";

/**
 * POST /api/profile  { message, signature }  →  { ok }
 *
 * The rat behind a wallet, written to the database — but only when the
 * wallet says so. The client composes a short text naming the wallet, the
 * name and the look, the wallet signs it (a message signature, no
 * transaction, no fee), and this verifies the signature against the wallet
 * named inside the text before writing. Nobody can rename or redress a rat
 * they do not hold the key to, and the server never has to be trusted with
 * knowing who is asking: the signature is the proof.
 *
 * The text, line by line, exactly as the client builds it in chain/db.ts:
 *
 *   RatPool profile
 *   wallet: <base58>
 *   name: <display name>
 *   traits: <JSON>
 *   issued: <ISO time>
 *
 * The time keeps an old signature from being replayed later to undo a newer
 * change; ten minutes is generous for a wallet prompt.
 */
const MAX_AGE_MS = 10 * 60 * 1000;
const NAME_MAX = 24;

export const POST = endpoint(async (body, req) => {
  if (!DB_ENABLED) throw new HttpError(503, "no database configured");
  const message = body.message;
  const signature = body.signature;
  if (typeof message !== "string" || typeof signature !== "string") {
    throw new HttpError(400, "message and signature required");
  }

  // The rest of the account (settings, loadout, record) rides the same door:
  // a function of its own would pass the hosting plan's limit of twelve.
  if (message.startsWith("RatPool account\n")) return saveAccountState(body);
  if (message.startsWith("RatPool account read\n")) return readAccountState(body);
  // And invites (api/_referral.ts), for the same reason.
  if (isReferralMessage(message)) return referralMessage(body, req);

  const lines = message.split("\n");
  const field = (k: string) => {
    const l = lines.find((x) => x.startsWith(k + ": "));
    return l ? l.slice(k.length + 2) : null;
  };
  if (lines[0] !== "RatPool profile") throw new HttpError(400, "not a profile message");
  const wallet = parsePubkey(field("wallet"));
  const name = (field("name") ?? "").trim();
  const traitsRaw = field("traits");
  const issued = Date.parse(field("issued") ?? "");
  if (!name || name.length > NAME_MAX) throw new HttpError(400, "bad name");
  if (!traitsRaw) throw new HttpError(400, "no traits");
  if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > MAX_AGE_MS) {
    throw new HttpError(400, "signature too old");
  }
  let traits: unknown;
  try {
    traits = JSON.parse(traitsRaw);
  } catch {
    throw new HttpError(400, "traits are not JSON");
  }
  if (typeof traits !== "object" || traits === null || Array.isArray(traits)) {
    throw new HttpError(400, "traits are not an object");
  }

  if (!signedBy(wallet, message, signature)) throw new HttpError(401, "signature does not match the wallet");

  const written = await dbUpsert("profiles", {
    wallet: wallet.toBase58(),
    name,
    traits,
    updated_at: new Date().toISOString(),
  });
  if (!written) throw new HttpError(502, "the profile could not be saved");
  // A rat now exists: an invite this player claimed before building it counts.
  await verifyReferral(wallet.toBase58());
  return { ok: true };
});

/** The Android app asks before it posts; see preflight in _lib. */
export const OPTIONS = preflight;
