use anchor_lang::prelude::*;

use crate::constants::MAX_PLAYERS;

#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Signs match management; rotation requires the next key to accept.
    pub authority: Pubkey,
    pub pending_authority: Option<Pubkey>,
    /// Platform signer that admits players from the room roster.
    pub admission: Pubkey,
    /// Owner of the token account the fee is paid to.
    pub fee_wallet: Pubkey,
    pub mint: Pubkey,
    pub fee_bps: u16,
    pub min_players: u8,
    /// Seconds after first collection before refunds open.
    pub refund_delay: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Match {
    pub id: u64,
    /// Entry fee in the mint's base units.
    pub entry: u64,
    /// Pin the fee so config changes cannot reprice an open room.
    pub fee_bps: u16,
    pub fee_wallet: Pubkey,
    pub min_players: u8,
    pub refund_delay: i64,
    /// Pin the fire exit on first collection; zero before money moves.
    pub refund_after: i64,
    pub state: MatchState,
    /// Unix time of `start`; zero until then.
    pub collected_at: i64,
    /// What the vault holds that has not been paid or refunded.
    pub pool: u64,
    pub bump: u8,
    #[max_len(MAX_PLAYERS)]
    pub players: Vec<Player>,
}

impl Match {
    pub fn deadline_expired(&self, now: i64) -> bool {
        self.refund_after != 0 && now >= self.refund_after
    }

    pub fn collected_count(&self) -> usize {
        self.players
            .iter()
            .filter(|p| p.status == PlayerStatus::Collected)
            .count()
    }

    pub fn is_staker(&self, key: &Pubkey) -> bool {
        self.players
            .iter()
            .any(|p| p.key == *key && p.status == PlayerStatus::Collected)
    }
}

/// The room server's Ed25519 key. Set only by the program's upgrade
/// authority; every payout must carry the room server's signature over its
/// ranking, so the payout key alone cannot choose who is paid.
#[account]
#[derive(InitSpace)]
pub struct Guard {
    pub room_key: Pubkey,
    pub bump: u8,
}

/// Who invited this player. Written once: by the player, or by the upgrade
/// authority for invites made before this record existed. A payout can pay
/// only the referrer recorded here.
#[account]
#[derive(InitSpace)]
pub struct Referral {
    pub referrer: Pubkey,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum MatchState {
    Open,
    Collected,
    Settled,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum PlayerStatus {
    /// Approved an entry; nothing taken yet.
    Joined,
    /// Entry is in the vault.
    Collected,
    /// Could not be collected, or was never collected before start.
    Dropped,
    Paid,
    Refunded,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace)]
pub struct Player {
    pub key: Pubkey,
    pub token_account: Pubkey,
    pub status: PlayerStatus,
}
