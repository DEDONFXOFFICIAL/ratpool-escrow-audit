use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::EscrowError,
    events::{AuthorityAccepted, AuthorityProposed},
    instructions::update_config::UpdateConfig,
    state::Config,
};

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.pending_authority == Some(pending_authority.key()) @ EscrowError::WrongPendingAuthority
    )]
    pub config: Account<'info, Config>,
    pub pending_authority: Signer<'info>,
}

pub fn handle_propose_authority(ctx: Context<UpdateConfig>, new: Pubkey) -> Result<()> {
    let c = &mut ctx.accounts.config;
    require!(new != Pubkey::default() && new != c.authority, EscrowError::InvalidAuthority);
    c.pending_authority = Some(new);
    emit!(AuthorityProposed {
        authority: c.authority,
        pending_authority: new,
    });
    Ok(())
}

pub fn handle_accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
    let c = &mut ctx.accounts.config;
    let previous_authority = c.authority;
    c.authority = ctx.accounts.pending_authority.key();
    c.pending_authority = None;
    emit!(AuthorityAccepted {
        previous_authority,
        authority: c.authority,
    });
    Ok(())
}
