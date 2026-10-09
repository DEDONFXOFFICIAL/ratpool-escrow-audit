//! RatPool escrow.
//!
//! Holds the stakes for one match in a vault nobody has a key to, and pays
//! the podium out of it. The design is the owner's, from docs/SPEC-BACKLOG.md
//! Round 16, and it is deliberately small:
//!
//!   join         — the player lets the match take up to one entry from their
//!                  wallet. Nothing moves. (An SPL `approve` to the match PDA.)
//!   collect      — once the room is full, the server pulls every approved
//!                  stake into the vault in one go. A player who spent the
//!                  money in the meantime is dropped, not failed.
//!   start        — locks the match if enough stakes were collected.
//!   settle_signed — the pinned fee funds the project and recorded referrals;
//!                  the rest goes 50/30/20 to the podium, which the program
//!                  picks from a ranking the room server signed. No claiming.
//!   claim_refund — the fire exit. If a collected match is never settled,
//!                  anyone can return each stake after the deadline. A worker
//!                  can sponsor refunds without a player signature.
//!
//! What this program cannot do: know who won. It is told by the room server,
//! whose signature it checks (since 2026-10-08), so the online payout key
//! alone cannot choose the podium; docs/ESCROW.md §2 is honest about what
//! remains. What it can promise: podium payouts go only to stakers, in the
//! signed order; referrals go only to recorded referrers and come only from
//! the fee; and stakes become refundable at the pinned deadline. The config,
//! the room key and authority rotation answer to the upgrade authority.

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("Ctu4Q9hJKUksKZ9mXrydtua2LcuvmM8Wt34Xc6VK1wmj");

#[program]
pub mod ratpool_escrow {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        fee_bps: u16,
        min_players: u8,
        refund_delay: i64,
        admission: Pubkey,
    ) -> Result<()> {
        instructions::initialize::handle_initialize(ctx, fee_bps, min_players, refund_delay, admission)
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        fee_bps: Option<u16>,
        min_players: Option<u8>,
        refund_delay: Option<i64>,
        fee_wallet: Option<Pubkey>,
        admission: Option<Pubkey>,
    ) -> Result<()> {
        instructions::update_config::handle_update_config(
            ctx,
            fee_bps,
            min_players,
            refund_delay,
            fee_wallet,
            admission,
        )
    }

    pub fn propose_authority(ctx: Context<UpdateConfig>, new: Pubkey) -> Result<()> {
        instructions::authority::handle_propose_authority(ctx, new)
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        instructions::authority::handle_accept_authority(ctx)
    }

    pub fn create_match(ctx: Context<CreateMatch>, id: u64, entry: u64) -> Result<()> {
        instructions::create_match::handle_create_match(ctx, id, entry)
    }

    pub fn join(ctx: Context<Join>, id: u64) -> Result<()> {
        instructions::join::handle_join(ctx, id)
    }

    pub fn leave(ctx: Context<Leave>, id: u64) -> Result<()> {
        instructions::join::handle_leave(ctx, id)
    }

    pub fn evict(ctx: Context<AuthorityOnly>, id: u64, player: Pubkey) -> Result<()> {
        instructions::evict::handle_evict(ctx, id, player)
    }

    pub fn collect<'info>(
        ctx: Context<'info, Collect<'info>>,
        id: u64,
    ) -> Result<()> {
        instructions::collect::handle_collect(ctx, id)
    }

    pub fn start(ctx: Context<AuthorityOnly>, id: u64) -> Result<()> {
        instructions::lifecycle::handle_start(ctx, id)
    }

    pub fn cancel(ctx: Context<AuthorityOnly>, id: u64) -> Result<()> {
        instructions::lifecycle::handle_cancel(ctx, id)
    }

    pub fn settle_signed<'info>(ctx: Context<'info, SettleSigned<'info>>, id: u64) -> Result<()> {
        instructions::settle_signed::handle_settle_signed(ctx, id)
    }

    pub fn set_room_key(ctx: Context<SetRoomKey>, room_key: Pubkey) -> Result<()> {
        instructions::admin::handle_set_room_key(ctx, room_key)
    }

    pub fn record_referral(ctx: Context<RecordReferral>, player: Pubkey, referrer: Pubkey) -> Result<()> {
        instructions::admin::handle_record_referral(ctx, player, referrer)
    }

    pub fn set_referrer(ctx: Context<SetReferrer>, referrer: Pubkey) -> Result<()> {
        instructions::referral::handle_set_referrer(ctx, referrer)
    }

    pub fn claim_refund(ctx: Context<ClaimRefund>, id: u64) -> Result<()> {
        instructions::claim_refund::handle_claim_refund(ctx, id)
    }

    pub fn close_match(ctx: Context<CloseMatch>, id: u64) -> Result<()> {
        instructions::close_match::handle_close_match(ctx, id)
    }
}
