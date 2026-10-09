use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};

use crate::{
    constants::*,
    error::EscrowError,
    events::MatchClosed,
    state::{Config, Match, MatchState},
};

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CloseMatch<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority, has_one = mint)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [MATCH_SEED, id.to_le_bytes().as_ref()],
        bump = match_account.bump,
        close = authority
    )]
    pub match_account: Account<'info, Match>,
    #[account(
        mut,
        seeds = [VAULT_SEED, match_account.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = match_account
    )]
    pub vault: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        constraint = fee_ata.owner == match_account.fee_wallet @ EscrowError::WrongFeeAccount
    )]
    pub fee_ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

/// Sweep unsolicited dust only after all obligations have been discharged.
pub fn handle_close_match(ctx: Context<CloseMatch>, id: u64) -> Result<()> {
    require!(
        matches!(ctx.accounts.match_account.state, MatchState::Settled | MatchState::Cancelled),
        EscrowError::MatchNotOpen
    );
    let m = &ctx.accounts.match_account;
    require!(m.pool == 0, EscrowError::VaultNotEmpty);
    require!(m.state == MatchState::Settled || m.collected_count() == 0, EscrowError::VaultNotEmpty);

    let bump = ctx.accounts.match_account.bump;
    let id_bytes = id.to_le_bytes();
    let seeds: &[&[u8]] = &[MATCH_SEED, &id_bytes, &[bump]];
    if ctx.accounts.vault.amount > 0 {
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.fee_ata.to_account_info(),
                    authority: ctx.accounts.match_account.to_account_info(),
                },
                &[seeds],
            ),
            ctx.accounts.vault.amount,
            ctx.accounts.mint.decimals,
        )?;
    }
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.authority.to_account_info(),
            authority: ctx.accounts.match_account.to_account_info(),
        },
        &[seeds],
    ))?;
    emit!(MatchClosed { id });
    Ok(())
}
