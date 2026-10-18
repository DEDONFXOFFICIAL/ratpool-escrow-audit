// Which address a request comes from, for the per-network counts. Its own
// file, with nothing heavy imported, so it can be tested alone
// (.probes/client-ip.ts). Files starting with _ are not functions on Vercel.

/**
 * Cloudflare's own addresses (cloudflare.com/ips-v4 and ips-v6, 2026-10-18).
 * ratpool.xyz is proxied through Cloudflare, so the address Vercel reports is
 * Cloudflare's, not the player's, and every per-network count was shared by
 * everyone behind the same Cloudflare data centre (outside report,
 * 2026-10-18). From one of these, the player's own address is Cloudflare's
 * CF-Connecting-IP; from anywhere else (someone reaching Vercel directly)
 * that header is theirs to make up, and is ignored.
 */
const CLOUDFLARE = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
  "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
  "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32",
  "2a06:98c0::/29", "2c0f:f248::/32",
];

/** An address as a number (IPv4 in 32 bits, IPv6 in 128), or null if it is not one. */
function addressBits(ip: string): { bits: bigint; width: number } | null {
  if (ip.includes(":")) {
    const halves = ip.split("::");
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(":") : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const groups = halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail] : head;
    if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
    return { bits: groups.reduce((n, g) => (n << 16n) + BigInt(parseInt(g, 16)), 0n), width: 128 };
  }
  const parts = ip.split(".");
  if (parts.length !== 4 || !parts.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255)) return null;
  return { bits: parts.reduce((n, x) => (n << 8n) + BigInt(Number(x)), 0n), width: 32 };
}

export function fromCloudflare(ip: string): boolean {
  const a = addressBits(ip);
  if (!a) return false;
  return CLOUDFLARE.some((range) => {
    const [base, size] = range.split("/");
    const b = addressBits(base);
    if (!b || b.width !== a.width) return false;
    const shift = BigInt(a.width - Number(size));
    return a.bits >> shift === b.bits >> shift;
  });
}

/** The domains Cloudflare proxies for us. */
const OUR_HOSTS = new Set(["ratpool.xyz", "www.ratpool.xyz"]);

let saidHow = false;
export function clientIp(req: Request): string {
  // Vercel sets these itself and overwrites any a client sends; its own
  // header first, which no proxy in front could replace either.
  const seen = req.headers.get("x-vercel-forwarded-for")?.split(",")[0].trim()
    || req.headers.get("x-forwarded-for")?.split(",")[0].trim()
    || req.headers.get("x-real-ip")?.trim()
    || "unknown";
  const visitor = req.headers.get("cf-connecting-ip")?.trim();
  // Through Cloudflare AND to our own domain: our zone sets the visitor
  // header itself, over anything a client sent. Someone else's Cloudflare
  // Worker calling the Vercel address directly also comes from these ranges,
  // with a header of its own making, but not to this host.
  const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").toLowerCase().split(":")[0];
  const via = fromCloudflare(seen) && OUR_HOSTS.has(host);
  // Once per instance, no address in it: whether requests come through
  // Cloudflare, and with its visitor header (for the logs).
  if (!saidHow) {
    saidHow = true;
    console.log("[api] requests arrive", via ? "through Cloudflare" : "directly", visitor ? "with a visitor address" : "without a visitor address");
  }
  return via && visitor && addressBits(visitor) ? visitor : seen;
}
