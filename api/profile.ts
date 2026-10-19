import { preflight, endpoint, HttpError, ipKey, parsePubkey, signedBy } from "./_lib.js";
import { DB_ENABLED, dbInsertNew, dbPatchCount, dbSelect, withinLimit } from "./_db.js";
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
 * change; ten minutes is generous for a wallet prompt. Within them, the save
 * is stored with its signed time and only ever replaces an older one.
 */
const MAX_AGE_MS = 10 * 60 * 1000;
const NAME_MAX = 24;
/** A profile message is a name and a rat's traits: a few hundred characters. */
const PROFILE_MAX = 2048;

export const POST = endpoint(async (body, req) => {
  if (!DB_ENABLED) throw new HttpError(503, "no database configured");
  const message = body.message;
  const signature = body.signature;
  if (typeof message !== "string" || typeof signature !== "string") {
    throw new HttpError(400, "message and signature required");
  }

  // The rest of the account (settings, loadout, record) rides the same door:
  // a function of its own would pass the hosting plan's limit of twelve.
  if (message.startsWith("RatPool account\n")) return saveAccountState(body, req!);
  if (message.startsWith("RatPool account read\n")) return readAccountState(body, req!);
  // And invites (api/_referral.ts), for the same reason.
  if (isReferralMessage(message)) return referralMessage(body, req);

  const lines = message.split("\n");
  const field = (k: string) => {
    const l = lines.find((x) => x.startsWith(k + ": "));
    return l ? l.slice(k.length + 2) : null;
  };
  if (lines[0] !== "RatPool profile") throw new HttpError(400, "not a profile message");
  // Bounded, and counted per network before any work: a wallet costs nothing
  // to make, so saves from a script making fresh ones were unlimited in
  // number and in size (traits of any length), and could fill the database
  // the whole platform runs on (red-team review, 2026-10-13).
  if (message.length > PROFILE_MAX) throw new HttpError(413, "profile too large");
  if (!(await withinLimit(`profile:ip:${ipKey(req!)}`, 120, 3600))) throw new HttpError(429, "Too many saves. Try again later.");
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
  // Per wallet only once its signature is checked, so nobody can use up a
  // player's saves in their name; and a new profile is counted apart.
  if (!(await withinLimit(`profile:w:${wallet.toBase58()}`, 30, 3600))) throw new HttpError(429, "Too many saves. Try again later.");

  // Never older over newer: an earlier signed save replayed within its ten
  // minutes put back an older name or look (security review, 2026-10-13).
  // As account saves (_account.ts): stored with its signed time, and written
  // only over an older one, the condition the write's own (one statement).
  const w = wallet.toBase58();
  const at = new Date(issued).toISOString();
  const overOlder = async () => {
    const n = await dbPatchCount(`profiles?wallet=eq.${w}&updated_at=lt.${encodeURIComponent(at)}&select=wallet`, { name, traits, updated_at: at });
    if (n === null) throw new HttpError(502, "the profile could not be saved");
    return n > 0;
  };
  if (!(await overOlder())) {
    // Nothing older to replace: a new rat, or a newer save is there, or
    // another save made the rat a moment ago (asked once more against it).
    const there = await dbSelect<{ wallet: string }>(`profiles?wallet=eq.${w}&select=wallet&limit=1`);
    if (there === null) throw new HttpError(502, "the profile could not be saved");
    if (there.length) {
      if (!(await overOlder())) throw new HttpError(409, "a newer save exists");
    } else {
      if (!(await withinLimit(`profile:new:ip:${ipKey(req!)}`, 50, 86400)) || !(await withinLimit("profile:new:all", 3000, 86400))) {
        throw new HttpError(429, "Too many new players right now. Try again later.");
      }
      const created = await dbInsertNew("profiles", { wallet: w, name, traits, updated_at: at });
      if (created === "exists") {
        if (!(await overOlder())) throw new HttpError(409, "a newer save exists");
      } else if (created !== "ok") {
        throw new HttpError(502, "the profile could not be saved");
      }
    }
  }
  // A rat now exists: an invite this player claimed before building it counts.
  await verifyReferral(w);
  return { ok: true };
});

/** The Android app asks before it posts; see preflight in _lib. */
export const OPTIONS = preflight;
