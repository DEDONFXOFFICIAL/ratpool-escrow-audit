use anchor_lang::prelude::*;

#[constant]
pub const CONFIG_SEED: &[u8] = b"config_v6";

#[constant]
pub const MATCH_SEED: &[u8] = b"match_v6";

#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

/// Seats in a room. The client's roster cap is 40; this leaves headroom
/// without changing the account size later.
#[constant]
pub const MAX_PLAYERS: u8 = 50;

/// Default payout weights, first place first, applied to the net pool.
/// With a 10% fee, 10/9/8/6/5/4/3 gives gross-pot shares
/// 20/18/16/12/10/8/6%. The current game starts with at least 25
/// actual stakers. Future policies may have up to twelve winners.
/// Each match pins its policy at creation; updates apply to future rooms.
/// Integer rounding remainder goes to first place.
pub const MAX_WINNERS: usize = 12;
pub const ECONOMY_VERSION: u8 = 6;
pub const PODIUM_SHARES: [u16; 7] = [10, 9, 8, 6, 5, 4, 3];

pub fn default_payout_weights() -> [u16; MAX_WINNERS] {
    let mut weights = [0; MAX_WINNERS];
    weights[..PODIUM_SHARES.len()].copy_from_slice(&PODIUM_SHARES);
    weights
}

/// Fee ceiling, in basis points. A config that asks for more is refused; the
/// product's own setting is in the config (1000 since 2026-10-08).
#[constant]
pub const MAX_FEE_BPS: u16 = 2_000;

pub const BPS: u64 = 10_000;

// Referral rewards are backend leaderboard points; no cash referral budget.

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
pub const SETTLE_DOMAIN: &[u8] = b"ratpool-settle-v6";

/// Wallets in a signed ranking. The podium is three; the rest stand in for a
/// ranked wallet the chain did not collect. More would not fit a transaction.
pub const MAX_SIGNED_RANKING: usize = MAX_WINNERS;

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
