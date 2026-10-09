use anchor_lang::prelude::*;

use crate::program::RatpoolEscrow;
use crate::{constants::*, error::EscrowError, events::ConfigUpdated, state::Config};

/// Tune future rooms. Authority changes use propose/accept; the mint is fixed.
///
/// Signed by the program's upgrade authority, the offline key, not by the
/// payout authority: that key lives on a server, and with it alone someone
/// could have pointed future fees at their own wallet, admitted their own
/// players, or proposed and accepted themselves as the authority, locking
/// the owner out (review 2026-10-08).
#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, RatpoolEscrow>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(admin.key()) @ EscrowError::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
}

pub fn handle_update_config(
    ctx: Context<UpdateConfig>,
    fee_bps: Option<u16>,
    min_players: Option<u8>,
    refund_delay: Option<i64>,
    fee_wallet: Option<Pubkey>,
    admission: Option<Pubkey>,
) -> Result<()> {
    let c = &mut ctx.accounts.config;
    if let Some(f) = fee_bps {
        require!(f <= MAX_FEE_BPS, EscrowError::FeeTooHigh);
        c.fee_bps = f;
    }
    if let Some(m) = min_players {
        require!(m >= 1 && m <= MAX_PLAYERS, EscrowError::BadMinPlayers);
        c.min_players = m;
    }
    if let Some(d) = refund_delay {
        require!(d >= MIN_REFUND_DELAY && d <= MAX_REFUND_DELAY, EscrowError::BadRefundDelay);
        c.refund_delay = d;
    }
    if let Some(w) = fee_wallet {
        c.fee_wallet = w;
    }
    if let Some(a) = admission {
        c.admission = a;
    }
    emit!(ConfigUpdated {
        authority: c.authority,
        admission: c.admission,
        fee_wallet: c.fee_wallet,
        fee_bps: c.fee_bps,
        min_players: c.min_players,
        refund_delay: c.refund_delay,
    });
    Ok(())
}
