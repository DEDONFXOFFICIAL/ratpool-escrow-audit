/**
 * The room server's calls to the money functions on Vercel.
 *
 * Every call is signed with the room server's own Ed25519 key, so the settle
 * function can tell a ranking the room server produced from one a browser
 * made up: see api/_lib.ts, `endpoint({ signed: true })`. The signature
 * covers the function's path, the time, a one-time nonce and the exact body
 * bytes ("POST <path>", ms, nonce, body on four lines; version 5): a body
 * that changes in flight voids it, a copy replayed later is refused, and a
 * signature made for one function is refused by every other. The site holds
 * only the public half; the secret the two used to share is retired
 * (review 2026-10-07, T02).
 */

export interface Env {
  ROOM: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
  /** The site whose /api this room server drives, e.g. https://www.ratpool.xyz */
  API_URL: string;
  /**
   * The room server's own signing key: Ed25519, PKCS#8, base64. Held by
   * Cloudflare alone; the site keeps only the public half (api/_lib.ts
   * ROOM_PUBLIC_KEY), so a leak of the site's secrets cannot sign as the room.
   * Whoever can deploy this Worker can still run code beside the key: that is
   * the deploy token's to guard. Without it no room call is accepted.
   */
  ROOM_SIGNING_KEY?: string;
  /** Pool rooms start with this many staked players. 2 on devnet. */
  MIN_POOL_PLAYERS?: string;
  /**
   * "on" only for a local server under the load test (`wrangler dev --var
   * FREE_ROOMS:on`): Free Play is played on the device, and the deployed
   * server hands out no Free Play rooms. Never set in wrangler.toml.
   */
  FREE_ROOMS?: string;
  /**
   * "challenge" once every build in use signs the room's one-time challenge
   * (0.4.7.2 and later, after the required update has moved past older ones):
   * a sign-in without it is then refused. Unset, both are accepted.
   */
  ROOM_SIGNIN?: string;
  /** A shorter match, for a local run that cannot wait ten minutes. Never set in production. */
  MATCH_SECONDS_OVERRIDE?: string;
  /** The shot ledger's mode. See room.ts. */
  COMBAT_CHECKS?: string;
  /** The escrow program's id: a signed ranking names it (signSettlement). */
  ESCROW_PROGRAM?: string;
  /** The sign-in service's (Privy's) app id, for the Google sign-in check (google.ts). */
  PRIVY_APP_ID?: string;
  /** "require": a pool seat needs a Google sign-in. Unset: counted only. */
  ROOM_GOOGLE?: string;
  /** "refuse": a hit naming a shot never fired is refused (room.ts whyNoShot). Unset: watched. */
  NEVER_FIRED?: string;
  /** Seconds: a kill of the same rat sooner than this after the last scores nothing (room.ts kill). Unset or 0: off. */
  REPEAT_KILL_SECONDS?: string;
  /** Milliseconds: a pool's hit by a bullet or a rocket on where its target was longer ago than this is refused (room.ts lateness). Unset or 0: watched. */
  REWIND_LIMIT_MS?: string;
}

const hex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

let roomKey: { from: string; key: Promise<CryptoKey> } | null = null;

/** The room's own key, imported once per isolate. */
function signingKey(env: Env): Promise<CryptoKey> | null {
  const from = env.ROOM_SIGNING_KEY?.trim();
  if (!from) return null;
  if (roomKey?.from !== from) {
    const der = Uint8Array.from(atob(from), (c) => c.charCodeAt(0));
    roomKey = { from, key: crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]) };
  }
  return roomKey.key;
}

/** Sign as the room (version 5, base64). Null when the key is missing or will not load: the log says which. */
export async function signAsRoom(env: Env, text: string): Promise<{ v: "5"; sig: string } | null> {
  try {
    const key = signingKey(env);
    if (!key) {
      console.error("[room] no signing key (ROOM_SIGNING_KEY): the site will refuse this call");
      return null;
    }
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, await key, new TextEncoder().encode(text)));
    return { v: "5", sig: btoa(String.fromCharCode(...sig)) };
  } catch (e) {
    console.error("[room] signing key will not load:", (e as Error).message);
    roomKey = null;
    return null;
  }
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A Solana address as its 32 bytes. Throws on anything else. */
export function addressBytes(s: string): Uint8Array {
  const out: number[] = [];
  for (const c of s) {
    let carry = BASE58.indexOf(c);
    if (carry < 0) throw new Error("not an address");
    for (let i = 0; i < out.length; i++) {
      carry += out[i] * 58;
      out[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      out.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < s.length && s[i] === "1"; i++) out.push(0);
  if (out.length !== 32) throw new Error("not an address");
  return new Uint8Array(out.reverse());
}

/** What a signed ranking starts with (program/.../constants.rs SETTLE_DOMAIN). */
const SETTLE_DOMAIN = "ratpool-settle-v1";
/** Wallets in a signed ranking: the program takes no more (MAX_SIGNED_RANKING). */
const SIGNED_RANKING = 6;

/**
 * The finishing order, signed for the escrow itself: SETTLE_DOMAIN, the
 * program's id, the match id (u64, little-endian), the time it started on
 * chain (collected_at, i64, little-endian: a match later opened under the
 * same id never shares it), a count and that many wallets, best first. The program pays only a podium this signature names
 * (settle_signed), so the payout key alone cannot choose who is paid
 * (T02 step 3, 2026-10-08). Base64 message and signature; null when there is
 * no key or the ranking cannot be read, and the site then cannot pay.
 */
export async function signSettlement(
  env: Env,
  matchId: string,
  startedAt: number,
  ranking: string[],
): Promise<{ message: string; signature: string } | null> {
  try {
    const key = signingKey(env);
    const program = env.ESCROW_PROGRAM?.trim();
    if (!key || !program) return null;
    const wallets = [...new Set(ranking)].slice(0, SIGNED_RANKING).map(addressBytes);
    if (!wallets.length) return null;
    const domain = new TextEncoder().encode(SETTLE_DOMAIN);
    if (!Number.isSafeInteger(startedAt) || startedAt <= 0) return null;
    const msg = new Uint8Array(domain.length + 32 + 8 + 8 + 1 + 32 * wallets.length);
    msg.set(domain, 0);
    msg.set(addressBytes(program), domain.length);
    const view = new DataView(msg.buffer);
    view.setBigUint64(domain.length + 32, BigInt(matchId), true);
    view.setBigInt64(domain.length + 40, BigInt(startedAt), true);
    msg[domain.length + 48] = wallets.length;
    wallets.forEach((w, i) => msg.set(w, domain.length + 49 + 32 * i));
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, await key, msg));
    return { message: btoa(String.fromCharCode(...msg)), signature: btoa(String.fromCharCode(...sig)) };
  } catch (e) {
    console.error("[room] could not sign the ranking:", (e as Error).message);
    return null;
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    /** The function's whole answer, when it sent one (settle's search place). */
    public data?: unknown,
  ) {
    super(message);
  }
}

/** POST to the site's /api, signed. Throws ApiError with the function's own message. */
export async function api<T>(env: Env, path: string, body: unknown): Promise<T> {
  const text = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const ts = String(Date.now());
  // Signed and spent once by the site: a copy of this request replayed
  // inside the time window is refused (review 2026-10-04, R15).
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const signed = await signAsRoom(env, `POST ${path}\n${ts}\n${nonce}\n${text}`);
  if (signed) {
    headers["x-room-ts"] = ts;
    headers["x-room-nonce"] = nonce;
    headers["x-room-sig-v"] = signed.v;
    headers["x-room-signature"] = signed.sig;
  }
  const res = await fetch(env.API_URL.replace(/\/$/, "") + path, { method: "POST", headers, body: text });
  const raw = await res.text();
  let data: unknown = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    throw new ApiError((data as { error?: string } | null)?.error ?? raw ?? `${res.status} from ${path}`, res.status, data);
  }
  return data as T;
}
