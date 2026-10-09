import { preflight, endpoint, HttpError, ipKey, parseId } from "../_lib.js";
import { withinLimit } from "../_db.js";

/**
 * POST /api/match/flag  { id }  →  { ok }
 *
 * The client's integrity audit threw the match out. Nothing is settled: the
 * program has no way to pay nobody, and giving the authority a way to send
 * the whole pool to the fee wallet is exactly the power it must not have.
 * The stake sits in the vault until the refund deadline, when anyone —
 * this server included — can return it. Recorded here so the log says why
 * a match was never settled.
 */
export const POST = endpoint(async (body, req) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be an object");
  // Unsigned and log-only, so every call is counted per network, reports and flags alike.
  if (!(await withinLimit(`flag:${ipKey(req!)}`, 30, 3600))) return { ok: true };
  // Also where browsers report what the site's script policy would block
  // (vercel.json, Content-Security-Policy-Report-Only): logged so the policy
  // can be enforced without breaking sign-in (review R22, 2026-10-07). A
  // function of its own would pass the plan's limit of twelve.
  const csp = body["csp-report"];
  if (csp && typeof csp === "object" && !Array.isArray(csp)) {
    const r = csp as Record<string, unknown>;
    // Strings only, no query (an OAuth return carries its code there), bounded.
    const at = (k: string) => (typeof r[k] === "string" ? (r[k] as string).split(/[?#]/)[0].slice(0, 200) : "");
    console.warn("[csp]", JSON.stringify({ directive: at("effective-directive") || at("violated-directive"), blocked: at("blocked-uri"), page: at("document-uri"), file: at("source-file") }));
    return { ok: true };
  }
  const id = parseId(body.id);
  console.warn("[flag] match", id.toString(), "left unsettled by the integrity audit");
  return { ok: true };
});

/** The Android app asks before it posts; see preflight in _lib. */
export const OPTIONS = preflight;
