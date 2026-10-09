/**
 * The database, from the server's side.
 *
 * Supabase, spoken to over its REST endpoint with the service role — the one
 * key that may write. No client library: the functions' runtime has been
 * particular about what it can load (see _lib.ts), and three verbs over
 * fetch are all this needs.
 *
 * Every call here is best-effort and never throws. The chain is the source
 * of truth for money and the escrow must never wait on, or fail because of,
 * a record. A write that fails is logged with enough to redo it by hand;
 * the settle that produced it has already happened.
 *
 * Unconfigured is a legal state: no SUPABASE_URL, no writes. Limits warn once.
 */

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const DB_ENABLED = !!(URL_ && KEY);

let warnedLimitUnavailable = false;

function warnLimitUnavailable(): void {
  if (warnedLimitUnavailable) return;
  warnedLimitUnavailable = true;
  console.warn("[db] limits unavailable; configure the database and run the limits migration");
}

/**
 * The limits when the database cannot answer: counted in this instance's
 * memory, same keys and windows, and under one overall ceiling.
 *
 * Every limit used to open when the database was down, misconfigured or
 * answered oddly, so an outage took the brakes off exactly the endpoints the
 * platform pays for (review 2026-10-06, DB-01). Shutting them instead would
 * stop every join and leave while the database is away, and players never
 * see a wallet prompt to blame. So the game keeps running on a smaller,
 * local budget until the database is back.
 */
const fallback = new Map<string, { n: number; until: number }>();
const FALLBACK_CEILING = 300; // requests per minute per instance, all keys together
let fallbackMinute = { n: 0, until: 0 };

function withinFallback(key: string, max: number, windowSeconds: number): boolean {
  const now = Date.now();
  if (fallbackMinute.until <= now) fallbackMinute = { n: 0, until: now + 60_000 };
  if (++fallbackMinute.n > FALLBACK_CEILING) return false;
  if (fallback.size > 20_000) for (const [k, e] of fallback) if (e.until <= now) fallback.delete(k);
  const e = fallback.get(key);
  if (!e || e.until <= now) {
    fallback.set(key, { n: 1, until: now + windowSeconds * 1000 });
    return true;
  }
  if (e.n >= max) return false;
  e.n++;
  return true;
}

export async function withinLimit(key: string, max: number, windowSeconds: number): Promise<boolean> {
  if (!DB_ENABLED) {
    warnLimitUnavailable();
    return withinFallback(key, max, windowSeconds);
  }
  // Every signed room call now spends a nonce row, so the old windows are
  // swept now and then instead of never (clear_old_limits, 2026-09-29 migration).
  if (Math.random() < 1 / 200) {
    void fetch(`${URL_}/rest/v1/rpc/clear_old_limits`, {
      method: "POST",
      headers: { apikey: KEY!, authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(4000),
    }).catch(() => {});
  }
  try {
    const res = await fetch(`${URL_}/rest/v1/rpc/bump_limit`, {
      method: "POST",
      headers: {
        apikey: KEY!,
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ k: key, max_count: max, window_seconds: windowSeconds }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      const detail = await res.text();
      let code: unknown;
      try { code = JSON.parse(detail).code; } catch {}
      if (res.status < 500 && (code === "PGRST202" || code === "42883")) {
        warnLimitUnavailable();
      } else {
        console.error(`[db] bump_limit failed: ${res.status} ${detail}`);
      }
      return withinFallback(key, max, windowSeconds);
    }
    // Only a plain true lets the request through; anything else is the database not answering.
    const allowed: unknown = await res.json();
    if (typeof allowed === "boolean") return allowed;
    console.error("[db] bump_limit returned an unexpected response", allowed);
    return withinFallback(key, max, windowSeconds);
  } catch (e) {
    console.error("[db] bump_limit failed:", e);
    return withinFallback(key, max, windowSeconds);
  }
}

async function call(method: string, path: string, body?: unknown, prefer?: string): Promise<boolean> {
  if (!DB_ENABLED) return false;
  try {
    const res = await fetch(`${URL_}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: KEY!,
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
        ...(prefer ? { prefer } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[db] ${method} ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[db] ${method} ${path} failed:`, (e as Error).message);
    return false;
  }
}

/** Insert rows, replacing any with the same primary key. */
export function dbUpsert(table: string, rows: object | object[]): Promise<boolean> {
  return call("POST", table, rows, "resolution=merge-duplicates,return=minimal");
}

/** Patch the rows matching `where` (column → value, exact match). */
export function dbUpdate(table: string, where: Record<string, string>, patch: object): Promise<boolean> {
  const q = Object.entries(where)
    .map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`)
    .join("&");
  return call("PATCH", `${table}?${q}`, patch, "return=minimal");
}

/**
 * Read rows with the service role (PostgREST query after the table name,
 * e.g. `referral_codes?wallet=eq.X&select=code`). Null on any failure, so a
 * caller can tell "none" ([]) from "could not ask" (null).
 */
export async function dbSelect<T>(path: string): Promise<T[] | null> {
  if (!DB_ENABLED) return null;
  try {
    // Bounded like the limits: a stalled database answers "could not ask"
    // (null), which every caller already handles (review 2026-10-07).
    const res = await fetch(`${URL_}/rest/v1/${path}`, {
      headers: { apikey: KEY!, authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      console.warn(`[db] GET ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    return (await res.json()) as T[];
  } catch (e) {
    console.warn(`[db] GET ${path} failed:`, (e as Error).message);
    return null;
  }
}

/**
 * Insert one row that must be new. "exists" when a row with that key (or
 * another unique column) is already there, which for the referral tables is
 * the rule doing its job: one referrer per player, one code per code.
 */
export async function dbInsertNew(table: string, row: object): Promise<"ok" | "exists" | "error"> {
  if (!DB_ENABLED) return "error";
  try {
    const res = await fetch(`${URL_}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        apikey: KEY!,
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });
    if (res.ok) return "ok";
    if (res.status === 409) return "exists";
    console.warn(`[db] insert ${table} → ${res.status} ${(await res.text()).slice(0, 200)}`);
    return "error";
  } catch (e) {
    console.warn(`[db] insert ${table} failed:`, (e as Error).message);
    return "error";
  }
}

/** Patch the rows a PostgREST filter picks (`referrals?referred_wallet=eq.X&verified_at=is.null`). */
export function dbPatch(path: string, patch: object): Promise<boolean> {
  return call("PATCH", path, patch, "return=minimal");
}

/**
 * Patch the rows `path` selects and say how many there were (null when the
 * database could not be asked). The filter is the write's own condition, in
 * one statement, so nothing changes between checking and writing.
 */
export async function dbPatchCount(path: string, patch: object): Promise<number | null> {
  if (!DB_ENABLED) return null;
  try {
    const res = await fetch(`${URL_}/rest/v1/${path}`, {
      method: "PATCH",
      headers: { apikey: KEY!, authorization: `Bearer ${KEY}`, "content-type": "application/json", prefer: "return=representation" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      console.warn(`[db] PATCH ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const rows: unknown = await res.json();
    return Array.isArray(rows) ? rows.length : null;
  } catch (e) {
    console.warn(`[db] PATCH ${path} failed:`, (e as Error).message);
    return null;
  }
}

/** Base units of USDC as the numeric the tables hold. */
export const usdc = (units: bigint | number): number => Number(units) / 1e6;
