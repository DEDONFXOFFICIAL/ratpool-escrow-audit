use anchor_lang::prelude::*;
use anchor_spl::token::Mint;
use crate::program::RatpoolEscrow;

use crate::{constants::*, error::EscrowError, events::ConfigInitialized, state::Config};

/// Only the upgrade authority can establish the initial escrow config.
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: any wallet; only its address is stored, and settle pays to a
    /// token account it must own.
    pub fee_wallet: UncheckedAccount<'info>,
    pub mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, RatpoolEscrow>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()))]
    pub program_data: Account<'info, ProgramData>,
}

pub fn handle_initialize(
    ctx: Context<Initialize>,
    fee_bps: u16,
    min_players: u8,
    refund_delay: i64,
    admission: Pubkey,
) -> Result<()> {
    require!(fee_bps <= MAX_FEE_BPS, EscrowError::FeeTooHigh);
    require!(
        min_players >= 1 && min_players <= MAX_PLAYERS,
        EscrowError::BadMinPlayers
    );
    require!(
        refund_delay >= MIN_REFUND_DELAY && refund_delay <= MAX_REFUND_DELAY,
        EscrowError::BadRefundDelay
    );

    let c = &mut ctx.accounts.config;
    c.authority = ctx.accounts.authority.key();
    c.pending_authority = None;
    c.admission = admission;
    c.fee_wallet = ctx.accounts.fee_wallet.key();
    c.mint = ctx.accounts.mint.key();
    c.fee_bps = fee_bps;
    c.min_players = min_players;
    c.refund_delay = refund_delay;
    c.bump = ctx.bumps.config;
    emit!(ConfigInitialized {
        authority: c.authority,
        admission: c.admission,
        fee_wallet: c.fee_wallet,
        mint: c.mint,
        fee_bps: c.fee_bps,
        min_players: c.min_players,
        refund_delay: c.refund_delay,
    });
    Ok(())
}
