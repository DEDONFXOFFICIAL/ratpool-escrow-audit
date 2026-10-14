use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    #[msg("Fee exceeds the ceiling")]
    FeeTooHigh,
    #[msg("min_players must be between 1 and MAX_PLAYERS")]
    BadMinPlayers,
    #[msg("refund_delay must be at least two seconds and at most seven days")]
    BadRefundDelay,
    #[msg("Entry must be positive")]
    BadEntry,
    #[msg("Match is not open")]
    MatchNotOpen,
    #[msg("Match is full")]
    MatchFull,
    #[msg("Already in this match")]
    AlreadyJoined,
    #[msg("Not in this match")]
    NotInMatch,
    #[msg("Token account does not hold the entry")]
    InsufficientFunds,
    #[msg("Wrong mint")]
    WrongMint,
    #[msg("Too few stakes collected to start")]
    TooFewPlayers,
    #[msg("Match has not been collected")]
    MatchNotCollected,
    #[msg("Podium must contain min(3, collected_count) distinct stakers with matching token accounts")]
    BadPodium,
    #[msg("Not a staker in this match")]
    NotAStaker,
    #[msg("Fee account is not owned by the fee wallet")]
    WrongFeeAccount,
    #[msg("Refund is not open yet")]
    RefundNotOpen,
    #[msg("Vault still holds funds")]
    VaultNotEmpty,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Referrers must fit the podium and have matching token accounts")]
    BadReferrers,
    #[msg("Referral total exceeds the match fee")]
    ReferralExceedsFee,
    #[msg("The refund deadline has expired")]
    DeadlineExpired,
    #[msg("Admission signer does not match the config")]
    WrongAdmission,
    #[msg("Only a Joined seat can be evicted")]
    CannotEvict,
    #[msg("Token account does not match the joined source")]
    WrongTokenAccount,
    #[msg("Proposed authority must be a new nonzero key")]
    InvalidAuthority,
    #[msg("Signer is not the pending authority")]
    WrongPendingAuthority,
    #[msg("Only the program's upgrade authority can do this")]
    NotUpgradeAuthority,
    #[msg("The room server's key is not set")]
    RoomKeyNotSet,
    #[msg("A payout needs the room server's signature on its ranking")]
    MissingRoomSignature,
    #[msg("The signature check is not the room server's, or not for this ranking")]
    BadRoomSignature,
    #[msg("The ranking must hold one to six distinct wallets")]
    BadRanking,
    #[msg("A referral must be a winner's own record, paid to its referrer")]
    BadReferral,
    #[msg("A payout cannot come in the second its match started")]
    TooSoon,
    #[msg("Prizes and refunds go only to the wallet's usual token account")]
    NotUsualAccount,
}
