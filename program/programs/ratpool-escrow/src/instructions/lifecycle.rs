use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::EscrowError,
    events::{MatchCancelled, MatchStarted},
    state::{Config, Match, MatchState, PlayerStatus},
};

/// Match management needs only the authority and the match.
#[derive(Accounts)]
#[instruction(id: u64)]
pub struct AuthorityOnly<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [MATCH_SEED, id.to_le_bytes().as_ref()], bump = match_account.bump)]
    pub match_account: Account<'info, Match>,
    pub authority: Signer<'info>,
}

/// Lock the match. Fails if too few stakes were collected — then the server
/// cancels instead, and the collected ones go back.
pub fn handle_start(ctx: Context<AuthorityOnly>, id: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let m = &mut ctx.accounts.match_account;
    require!(!m.deadline_expired(now), EscrowError::DeadlineExpired);
    require!(m.state == MatchState::Open, EscrowError::MatchNotOpen);
    let collected = m.collected_count();
    require!(collected >= m.min_players as usize, EscrowError::TooFewPlayers);

    // Whoever was never collected is not in this match. Their approval is
    // now dead weight the client revokes on its own; this program can no
    // longer spend it, because collect needs an Open match.
    for p in m.players.iter_mut() {
        if p.status == PlayerStatus::Joined {
            p.status = PlayerStatus::Dropped;
        }
    }
    m.state = MatchState::Collected;
    m.collected_at = now;
    emit!(MatchStarted {
        id,
        stakers: collected as u8,
        pool: m.pool
    });
    Ok(())
}

/// The room never filled. Anything already collected is refundable at once
/// through claim_refund.
pub fn handle_cancel(ctx: Context<AuthorityOnly>, id: u64) -> Result<()> {
    let m = &mut ctx.accounts.match_account;
    require!(m.state == MatchState::Open, EscrowError::MatchNotOpen);
    m.state = MatchState::Cancelled;
    emit!(MatchCancelled { id });
    Ok(())
}
