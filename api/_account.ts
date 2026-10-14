import { HttpError, ipKey, parsePubkey, signedBy } from "./_lib.js";
import { DB_ENABLED, dbInsertNew, dbPatchCount, dbSelect, withinLimit } from "./_db.js";

/**
 * POST /api/profile with an account message  →  { ok }  (routed by api/profile.ts;
 * a function of its own would pass the plan's limit of twelve)
 *
 * Everything about a player that is not their rat — settings, HUD layout,
 * loadout, skulls, stats, history, tier progress, terms, guide — saved under
 * their wallet so it is the same account on every device. Same proof as
 * /api/profile: the wallet signs a short text carrying the state, and this
 * checks the signature against the wallet named inside it before writing.
 *
 *   RatPool account
 *   wallet: <base58>
 *   issued: <ISO time>
 *   state: <JSON, one line>
 *
 * Reads come back through here too (readAccountState): the document is private.
 */
const MAX_AGE_MS = 10 * 60 * 1000;
/** A phone clock set by hand can run fast; refusing it would stop that phone saving at all. */
const MAX_AHEAD_MS = 10 * 60 * 1000;
const MAX_STATE = 64 * 1024;

export async function saveAccountState(body: Record<string, unknown>, req: Request): Promise<{ ok: true }> {
  if (!DB_ENABLED) throw new HttpError(503, "no database configured");
  const { message, signature } = body;
  if (typeof message !== "string" || typeof signature !== "string") {
    throw new HttpError(400, "message and signature required");
  }
  if (message.length > MAX_STATE) throw new HttpError(413, "account state too large");
  // Counted per network before any work: fresh wallets cost nothing, and
  // saves from a script making them were unlimited (red-team review,
  // 2026-10-13). A player's own saves come a few a minute at most.
  if (!(await withinLimit(`acct:ip:${ipKey(req)}`, 1200, 3600))) throw new HttpError(429, "Too many saves. Try again later.");

  const lines = message.split("\n");
  const field = (k: string) => {
    const l = lines.find((x) => x.startsWith(k + ": "));
    return l ? l.slice(k.length + 2) : null;
  };
  if (lines[0] !== "RatPool account") throw new HttpError(400, "not an account message");
  const wallet = parsePubkey(field("wallet"));
  const issued = Date.parse(field("issued") ?? "");
  if (!Number.isFinite(issued) || Date.now() - issued > MAX_AGE_MS || issued - Date.now() > MAX_AHEAD_MS) {
    throw new HttpError(400, "signature too old");
  }
  let state: unknown;
  try {
    state = JSON.parse(field("state") ?? "");
  } catch {
    throw new HttpError(400, "state is not JSON");
  }
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    throw new HttpError(400, "state is not an object");
  }
  if (!signedBy(wallet, message, signature)) throw new HttpError(401, "signature does not match the wallet");
  // Per wallet only once its signature is checked: nobody can use up a
  // player's saves in their name.
  if (!(await withinLimit(`acct:w:${wallet.toBase58()}`, 600, 3600))) throw new HttpError(429, "Too many saves. Try again later.");

  // Never older over newer: a signed save replayed later, or a slow one
  // arriving after a newer device's, used to roll the account back (review
  // 2026-10-06, DB-03). The condition is the write's own (one statement), so
  // two saves at once cannot both pass it. The app merges and saves again on
  // its next change.
  const w = wallet.toBase58();
  const at = new Date(issued).toISOString();
  const updated = await dbPatchCount(`accounts?wallet=eq.${w}&updated_at=lt.${encodeURIComponent(at)}&select=wallet`, { state, updated_at: at });
  if (updated === null) throw new HttpError(502, "the account could not be saved");
  if (updated > 0) return { ok: true };
  // Nothing older to replace: the first save of this account, or a newer one is there.
  // Which, asked before a new account is counted: a stale save used to count
  // as a new account and use up the allowance (security review, round two).
  const there = await dbSelect<{ wallet: string }>(`accounts?wallet=eq.${w}&select=wallet&limit=1`);
  if (there === null) throw new HttpError(502, "the account could not be saved");
  if (there.length) throw new HttpError(409, "a newer save exists");
  // A new account is counted apart, per network and overall.
  if (!(await withinLimit(`acct:new:ip:${ipKey(req)}`, 50, 86400)) || !(await withinLimit("acct:new:all", 3000, 86400))) {
    throw new HttpError(429, "Too many new players right now. Try again later.");
  }
  const created = await dbInsertNew("accounts", { wallet: w, state, updated_at: at });
  if (created === "ok") return { ok: true };
  if (created === "exists") throw new HttpError(409, "a newer save exists");
  throw new HttpError(502, "the account could not be saved");
}

/**
 * POST /api/profile with an account-read message  →  { state, updated_at } | { state: null }
 *
 * The account document is private (2026-09-30): the public key can no longer
 * read its contents, so a device reads its own through here, proving the
 * wallet the same silent way it saves.
 *
 *   RatPool account read
 *   wallet: <base58>
 *   issued: <ISO time>
 */
export async function readAccountState(body: Record<string, unknown>, req: Request): Promise<{ state: unknown; updated_at?: string }> {
  if (!DB_ENABLED) throw new HttpError(503, "no database configured");
  // Counted like saves: a read returns the whole document (up to 64 KB), and
  // one signed read used to be repeatable without limit for ten minutes
  // (security review, 2026-10-14). A game reads on sign-in and on start.
  if (!(await withinLimit(`acct:read:ip:${ipKey(req)}`, 3000, 3600))) throw new HttpError(429, "Too many requests. Try again later.");
  const { message, signature } = body;
  if (typeof message !== "string" || typeof signature !== "string") {
    throw new HttpError(400, "message and signature required");
  }
  if (message.length > 512) throw new HttpError(413, "message too large");
  const lines = message.split("\n");
  const field = (k: string) => {
    const l = lines.find((x) => x.startsWith(k + ": "));
    return l ? l.slice(k.length + 2) : null;
  };
  if (lines[0] !== "RatPool account read") throw new HttpError(400, "not an account read");
  const wallet = parsePubkey(field("wallet"));
  const issued = Date.parse(field("issued") ?? "");
  if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > MAX_AGE_MS) {
    throw new HttpError(400, "signature too old");
  }
  if (!signedBy(wallet, message, signature)) throw new HttpError(401, "signature does not match the wallet");
  if (!(await withinLimit(`acct:read:w:${wallet.toBase58()}`, 300, 3600))) throw new HttpError(429, "Too many requests. Try again later.");
  const rows = await dbSelect<{ state: unknown; updated_at: string }>(
    `accounts?wallet=eq.${wallet.toBase58()}&select=state,updated_at&limit=1`,
  );
  if (!rows) throw new HttpError(502, "the account could not be read");
  return rows[0] ?? { state: null };
}
