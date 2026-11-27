import { HttpError } from "./_lib.js";

/** Cutover gate: existing settlements, refunds, leaves and Free Play stay available. */
export function requirePaidPoolsOpen() {
  if (process.env.PAID_POOLS_PAUSED === "1") {
    throw new HttpError(503, "Paid pools are being upgraded. Please try again shortly; Free Play is available.");
  }
}
