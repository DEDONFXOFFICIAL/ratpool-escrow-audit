use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token::spl_token::state::AccountState;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::{
    constants::*,
    error::EscrowError,
    events::StakesCollected,
    state::{Config, Match, MatchState, PlayerStatus},
};

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct Collect<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority, has_one = mint)]
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
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

/// The room is full: pull every approved stake into the vault.
///
/// The players' token accounts come as remaining accounts, any subset, any
/// order, so a big room can be collected in batches under the transaction
/// size limit. A player whose approval no longer covers the entry — they
/// spent it, or revoked — is marked Dropped and skipped. It has to be a
/// check-then-transfer rather than try-then-catch: a failed CPI aborts the
/// whole transaction, and one empty wallet must not stop thirty-nine full
/// ones.
///
/// `min_after`: the collected stakes there must be once this batch is done,
/// or the whole batch is undone. The last batch asks for the room's minimum:
/// a player withdrawing their approval between the site's check and the
/// collection used to leave too few, and the match was cancelled; now
/// nothing moves and the pool is filled again (escrow v4).
pub fn handle_collect<'info>(
    ctx: Context<'info, Collect<'info>>,
    id: u64,
    min_after: u8,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        !ctx.accounts.match_account.deadline_expired(now),
        EscrowError::DeadlineExpired
    );
    require!(
        ctx.accounts.match_account.state == MatchState::Open,
        EscrowError::MatchNotOpen
    );
    let entry = ctx.accounts.match_account.entry;
    let match_key = ctx.accounts.match_account.key();
    let bump = ctx.accounts.match_account.bump;
    let id_bytes = id.to_le_bytes();
    let seeds: &[&[u8]] = &[MATCH_SEED, &id_bytes, &[bump]];
    let signer: &[&[&[u8]]] = &[seeds];

    let token_program = ctx.accounts.token_program.key();
    let match_info = ctx.accounts.match_account.to_account_info();
    let vault_info = ctx.accounts.vault.to_account_info();
    let mint_info = ctx.accounts.mint.to_account_info();
    let mint_key = ctx.accounts.mint.key();
    let decimals = ctx.accounts.mint.decimals;

    let mut collected = 0u8;
    let mut dropped = 0u8;
    for acc in ctx.remaining_accounts.iter() {
        let Some(idx) = ctx
            .accounts
            .match_account
            .players
            .iter()
            .position(|p| p.token_account == acc.key() && p.status == PlayerStatus::Joined)
        else {
            continue;
        };

        // Bind approval to its source address; changed owners cannot poison a batch.
        let covered = acc.is_writable
            && acc.owner == &token_program
            && Account::<TokenAccount>::try_from(acc)
                .map(|ata| {
                    ata.state == AccountState::Initialized
                        && ata.mint == mint_key
                        && ata.owner == ctx.accounts.match_account.players[idx].key
                        && ata.amount >= entry
                        && ata.delegate == COption::Some(match_key)
                        && ata.delegated_amount >= entry
                })
                .unwrap_or(false);
        if !covered {
            ctx.accounts.match_account.players[idx].status = PlayerStatus::Dropped;
            dropped += 1;
            continue;
        }

        token::transfer_checked(
            CpiContext::new_with_signer(
                token_program,
                TransferChecked {
                    from: acc.clone(),
                    mint: mint_info.clone(),
                    to: vault_info.clone(),
                    authority: match_info.clone(),
                },
                signer,
            ),
            entry,
            decimals,
        )?;

        let m = &mut ctx.accounts.match_account;
        if m.refund_after == 0 {
            m.refund_after = now
                .checked_add(m.refund_delay)
                .ok_or(EscrowError::Overflow)?;
        }
        m.players[idx].status = PlayerStatus::Collected;
        m.pool = m.pool.checked_add(entry).ok_or(EscrowError::Overflow)?;
        collected += 1;
    }
    require!(
        ctx.accounts.match_account.collected_count() >= min_after as usize,
        EscrowError::TooFewPlayers
    );
    emit!(StakesCollected {
        id,
        collected,
        dropped
    });
    Ok(())
}
