use anchor_lang::prelude::*;

#[constant]
pub const CONFIG_SEED: &[u8] = b"config_v2";

#[constant]
pub const MATCH_SEED: &[u8] = b"match_v2";

#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

/// Seats in a room. The client's roster cap is 40; this leaves headroom
/// without changing the account size later.
#[constant]
pub const MAX_PLAYERS: u8 = 50;

/// The podium split, in whole percent, first place first. Applied to the net
/// pool (after the fee). When fewer than three stakers finish — a devnet
/// room with one human in it — the shares that exist are scaled up to the
/// whole pool so nothing is left in the vault. The game pays the top three
/// (src/state/payout.ts) and starts a pool only with six stakers, so every
/// pool it settles is exactly 50/30/20.
pub const PODIUM_SHARES: [u64; 3] = [50, 30, 20];

/// Fee ceiling, in basis points. A config that asks for more is refused; the
/// product's own setting is in the config (1000 since 2026-10-08).
#[constant]
pub const MAX_FEE_BPS: u16 = 2_000;

pub const BPS: u64 = 10_000;

pub const REFERRAL_BPS: u64 = 100;

/// The room server's key, which a payout needs a signature from.
#[constant]
pub const GUARD_SEED: &[u8] = b"guard";

/// Who invited a player: one record per player, written once.
#[constant]
pub const REFERRAL_SEED: &[u8] = b"referral";

/// What the room server signs for a payout: this, the program's id, the match
/// id (u64, little-endian), the time the match started on chain (its
/// collected_at, i64, little-endian), the number of wallets, then the
/// wallets, best first. The prefix keeps the signature from meaning anything
/// else the same key signs; the program id keeps it to this deployment; the
/// start time keeps it to this match, never to one later opened under the
/// same id.
pub const SETTLE_DOMAIN: &[u8] = b"ratpool-settle-v1";

/// Wallets in a signed ranking. The podium is three; the rest stand in for a
/// ranked wallet the chain did not collect. More would not fit a transaction.
pub const MAX_SIGNED_RANKING: usize = 6;

/// The associated token account program. A wallet's usual token account for
/// a mint is the one this program derives for it: the one the app shows and
/// spends from. Prizes and refunds go there and nowhere else (escrow v4).
pub const ASSOCIATED_TOKEN_PROGRAM: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/// A wallet's usual token account for a mint (its associated token account).
pub fn usual_account(wallet: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[wallet.as_ref(), anchor_spl::token::ID.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM,
    )
    .0
}
pub const MAX_REFUND_DELAY: i64 = 7 * 24 * 3600;
/// A payout comes at least a second after its start (settle_signed), and
/// before the refund deadline: one second of delay would leave no second.
pub const MIN_REFUND_DELAY: i64 = 2;
