use anchor_lang::prelude::*;

use crate::program::RatpoolEscrow;
use crate::{
    constants::*,
    error::EscrowError,
    events::{ReferralRecorded, RoomKeySet},
    state::{Guard, Referral},
};

/// The room server's key, set by the program's upgrade authority: the offline
/// key, never the online payout key. Every payout must then carry the room
/// server's signature over its ranking (settle_signed). Rent comes from a
/// separate payer, so the offline key never needs to hold SOL.
#[derive(Accounts)]
pub struct SetRoomKey<'info> {
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Guard::INIT_SPACE,
        seeds = [GUARD_SEED],
        bump
    )]
    pub guard: Account<'info, Guard>,
    pub admin: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, RatpoolEscrow>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(admin.key()) @ EscrowError::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

pub fn handle_set_room_key(ctx: Context<SetRoomKey>, room_key: Pubkey) -> Result<()> {
    require!(room_key != Pubkey::default(), EscrowError::RoomKeyNotSet);
    let g = &mut ctx.accounts.guard;
    g.room_key = room_key;
    g.bump = ctx.bumps.guard;
    emit!(RoomKeySet { room_key });
    Ok(())
}

/// An invite made before invites were recorded on chain, carried over by the
/// upgrade authority. Like the player's own record (set_referrer) it is
/// written once and never changed.
#[derive(Accounts)]
#[instruction(player: Pubkey)]
pub struct RecordReferral<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Referral::INIT_SPACE,
        seeds = [REFERRAL_SEED, player.as_ref()],
        bump
    )]
    pub referral: Account<'info, Referral>,
    pub admin: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, RatpoolEscrow>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(admin.key()) @ EscrowError::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

pub fn handle_record_referral(ctx: Context<RecordReferral>, player: Pubkey, referrer: Pubkey) -> Result<()> {
    require!(referrer != Pubkey::default(), EscrowError::BadReferral);
    let r = &mut ctx.accounts.referral;
    r.referrer = referrer;
    r.bump = ctx.bumps.referral;
    emit!(ReferralRecorded {
        player,
        referrer,
        by_player: false,
    });
    Ok(())
}
