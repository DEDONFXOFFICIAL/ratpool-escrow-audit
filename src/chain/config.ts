/**
 * Which chain this build talks to, and what money it moves.
 *
 * Everything chain-shaped reads its endpoint and its mint from here, so a build
 * can be pointed at devnet, at a local validator, or one day at mainnet by
 * changing environment variables rather than source.
 *
 * The defaults are devnet on purpose. A build that forgets to configure itself
 * should land on the network where a mistake costs nothing, never on the one
 * where it costs somebody money.
 */

export type Cluster = "devnet" | "mainnet-beta" | "localnet";

const env = import.meta.env as unknown as Record<string, string | undefined>;

export const CLUSTER: Cluster = (env.VITE_SOLANA_CLUSTER as Cluster) || "devnet";

const DEFAULT_RPC: Record<Cluster, string> = {
  devnet: "https://api.devnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  localnet: "http://127.0.0.1:8899",
};

/**
 * The public RPC is rate-limited and will start refusing under any real load.
 * It is the right default for a devnet demo and the wrong one for a launch;
 * VITE_SOLANA_RPC takes a Helius/Triton/QuickNode URL when that day comes.
 */
export const RPC_ENDPOINT = env.VITE_SOLANA_RPC || DEFAULT_RPC[CLUSTER];

/**
 * USDC, per cluster.
 *
 * Mainnet is Circle's USDC and nothing else. Devnet is a test mint of our
 * own, minted by the in-app faucet (Round 16): Circle's devnet faucet makes a
 * tester leave the app and caps them at 20 per two hours, and a claim button
 * inside the game needs a mint the faucet function holds the authority for.
 * The address comes from the environment because it is created by
 * scripts/devnet-setup.mjs, not known in advance; a devnet build without it
 * is misconfigured and says so rather than pointing at a mint we cannot fund.
 */
export const USDC_MINT: Record<Cluster, string | null> = {
  devnet: env.VITE_USDC_MINT || null,
  "mainnet-beta": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  localnet: env.VITE_USDC_MINT || null,
};

export const USDC: string | null = USDC_MINT[CLUSTER];

/** USDC is six decimals on every chain it exists on. */
export const USDC_DECIMALS = 6;

/** A UI amount (1.5 USDC) as base units (1500000). */
export function toBaseUnits(amount: number): bigint {
  return BigInt(Math.round(amount * 10 ** USDC_DECIMALS));
}

/** Base units back to a UI amount. */
export function fromBaseUnits(units: bigint | number): number {
  return Number(units) / 10 ** USDC_DECIMALS;
}

/** Explorer link for a signature or an address, on whichever cluster we are on. */
export function explorerUrl(what: string, kind: "tx" | "address" = "tx"): string {
  const suffix = CLUSTER === "mainnet-beta" ? "" : "?cluster=" + CLUSTER;
  return "https://explorer.solana.com/" + kind + "/" + what + suffix;
}

/**
 * The deployed escrow program, or null while there is not one.
 *
 * This is the switch the whole money layer hangs off, and it is a program ID
 * rather than a feature flag on purpose: the question "should the game move
 * real USDC" has exactly one honest answer, and it is "is there a program
 * deployed to move it with". A flag can be turned on by mistake. An address
 * cannot be invented.
 *
 * Unset means the game runs on MockEconomy (the demo) and says so. See
 * docs/ESCROW.md.
 */
export const ESCROW_PROGRAM_ID: string | null = env.VITE_ESCROW_PROGRAM_ID || null;

/**
 * Whether the game talks to a chain at all.
 *
 * On only when there is a program to talk to and a mint to stake, and never
 * when VITE_CHAIN=off. Everything else is the demo: a made-up wallet, a mock
 * balance, every screen labelled as such (ratpool.xyz/demo), the build arena
 * work iterates on with no wallet or RPC in the way, and — deliberately —
 * where a misconfigured build lands. The alternative,
 * a real wallet at the door with mock money behind it, is the one
 * combination that can make a person believe a number that is not theirs.
 */
export const CHAIN_ENABLED =
  env.VITE_CHAIN !== "off" && ESCROW_PROGRAM_ID !== null && USDC !== null;

/** Whether this build can actually move money on chain. Same condition,
 *  kept as its own name because the two questions read differently at the
 *  call sites: "is there a chain" versus "can it move money". */
export const ESCROW_LIVE = CHAIN_ENABLED;

/**
 * Where the server that signs for the escrow lives. Same origin by default:
 * the Vercel functions under /api deploy alongside the client.
 */
export const SERVER_URL: string = env.VITE_SERVER_URL || "";

/**
 * What the stakes are, in the words the player reads: "test USDC" until the
 * game is on mainnet. Devnet USDC is worthless on purpose, and a screen that
 * calls it "real" is telling a tester something untrue about their money.
 */
export const STAKE_WORD: string = CLUSTER === "mainnet-beta" ? "real USDC" : "test USDC";
