use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::{
    constants::*,
    error::EscrowError,
    events::StakeRefunded,
    state::{Config, Match, MatchState, PlayerStatus},
};

/// No signer beyond the fee payer: a refund is owed, not requested. The
/// staker is named, and the refund goes to their usual token account and
/// nowhere else: any account they owned used to do, so a stranger could send
/// it to one the app does not show (escrow v4, security review 2026-10-13).
#[derive(Accounts)]
#[instruction(id: u64, player: Pubkey)]
pub struct ClaimRefund<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = mint)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [MATCH_SEED, id.to_le_bytes().as_ref()], bump = match_account.bump)]
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
        address = usual_account(&player, &mint.key()) @ EscrowError::NotUsualAccount
    )]
    pub player_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// The fire exit. Anyone may call it, for any staker, once the match is
/// cancelled or the settle deadline has passed. Returns exactly the entry.
pub fn handle_claim_refund(ctx: Context<ClaimRefund>, id: u64, player: Pubkey) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let owner = player;
    let idx = {
        let m = &ctx.accounts.match_account;
        let open = match m.state {
            MatchState::Cancelled => true,
            MatchState::Open | MatchState::Collected => m.deadline_expired(now),
            _ => false,
        };
        require!(open, EscrowError::RefundNotOpen);
        m.players
            .iter()
            .position(|p| p.key == owner && p.status == PlayerStatus::Collected)
            .ok_or(EscrowError::NotAStaker)?
    };

    let entry = ctx.accounts.match_account.entry;
    let bump = ctx.accounts.match_account.bump;
    let id_bytes = id.to_le_bytes();
    let seeds: &[&[u8]] = &[MATCH_SEED, &id_bytes, &[bump]];
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.player_ata.to_account_info(),
                authority: ctx.accounts.match_account.to_account_info(),
            },
            &[seeds],
        ),
        entry,
        ctx.accounts.mint.decimals,
    )?;

    let m = &mut ctx.accounts.match_account;
    m.players[idx].status = PlayerStatus::Refunded;
    m.pool = m.pool.checked_sub(entry).ok_or(EscrowError::Overflow)?;
    // A fully refunded room has no result left to settle.
    if m.collected_count() == 0 {
        m.state = MatchState::Cancelled;
    }
    emit!(StakeRefunded {
        id,
        player: owner,
        amount: entry
    });
    Ok(())
}
