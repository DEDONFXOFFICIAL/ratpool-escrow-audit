use anchor_lang::prelude::*;

#[event]
pub struct ConfigInitialized {
    pub authority: Pubkey,
    pub admission: Pubkey,
    pub fee_wallet: Pubkey,
    pub mint: Pubkey,
    pub fee_bps: u16,
    pub min_players: u8,
    pub refund_delay: i64,
}

#[event]
pub struct ConfigUpdated {
    pub authority: Pubkey,
    pub admission: Pubkey,
    pub fee_wallet: Pubkey,
    pub fee_bps: u16,
    pub min_players: u8,
    pub refund_delay: i64,
}

#[event]
pub struct AuthorityProposed {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
}

#[event]
pub struct AuthorityAccepted {
    pub previous_authority: Pubkey,
    pub authority: Pubkey,
}

#[event]
pub struct MatchCreated {
    pub id: u64,
    pub entry: u64,
}

#[event]
pub struct PlayerJoined {
    pub id: u64,
    pub player: Pubkey,
    pub seats: u8,
}

#[event]
pub struct PlayerLeft {
    pub id: u64,
    pub player: Pubkey,
    pub seats: u8,
}

#[event]
pub struct PlayerEvicted {
    pub id: u64,
    pub player: Pubkey,
    pub seats: u8,
}

#[event]
pub struct StakesCollected {
    pub id: u64,
    pub collected: u8,
    pub dropped: u8,
}

#[event]
pub struct MatchStarted {
    pub id: u64,
    pub stakers: u8,
    pub pool: u64,
}

#[event]
pub struct MatchCancelled {
    pub id: u64,
}

#[event]
pub struct MatchSettled {
    pub id: u64,
    pub pool: u64,
    pub fee: u64,
    pub winners: Vec<Pubkey>,
    pub amounts: Vec<u64>,
    pub referrers: Vec<Pubkey>,
    pub referral_amounts: Vec<u64>,
    pub platform_fee: u64,
}

#[event]
pub struct RoomKeySet {
    pub room_key: Pubkey,
}

#[event]
pub struct ReferralRecorded {
    pub player: Pubkey,
    pub referrer: Pubkey,
    /// Signed by the player; false when carried over by the upgrade authority.
    pub by_player: bool,
}

#[event]
pub struct StakeRefunded {
    pub id: u64,
    pub player: Pubkey,
    pub amount: u64,
}

#[event]
pub struct MatchClosed {
    pub id: u64,
}
