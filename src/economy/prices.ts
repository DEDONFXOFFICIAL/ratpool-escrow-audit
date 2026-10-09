// What each store item costs and which weapon it is, in one place with no
// imports, because three sides need the same numbers: the store screen
// (catalog.ts), the purchase function that builds and checks the payment
// (api/store/buy.ts), and the room, which lets a player bring only the
// weapons they bought (api/match/status.ts). A price the client could name
// was a price the client could change.

/** USDC, by store item id. */
export const STORE_PRICES: Record<string, number> = {
  w_pistol: 0,
  w_smg: 0.1,
  w_rifle: 0.45,
  w_shotgun: 0.85,
  w_sniper: 1.2,
  w_rocket: 1.6,
  w_cutlass: 2,
};

/** The WEAPONS index each weapon item puts in a rat's hands. */
export const ITEM_WEAPON: Record<string, number> = {
  w_pistol: 0,
  w_smg: 1,
  w_shotgun: 2,
  w_rifle: 3,
  w_sniper: 4,
  w_rocket: 5,
  w_cutlass: 6,
};

/** Weapons every player has without buying anything. */
export const FREE_WEAPONS: readonly number[] = [0];

/** The memo a purchase carries, which ties the payment to the item on chain. */
export const purchaseMemo = (item: string) => `ratpool:buy:${item}`;

/**
 * Store treasuries used before the current one (the escrow config's fee
 * wallet), as base58 wallets. A payment that went to one of them, and was
 * not yet recorded when the treasury changed, is still a purchase
 * (api/store/buy.ts): add the old wallet here in the same change that moves
 * the treasury. None so far.
 */
export const PAST_STORE_TREASURIES: readonly string[] = [];
