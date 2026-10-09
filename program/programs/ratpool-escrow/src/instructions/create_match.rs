use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{
    constants::*,
    error::EscrowError,
    events::MatchCreated,
    state::{Config, Match, MatchState},
};

/// A room opens. The server pays the rent and gets it back on close.
#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateMatch<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority, has_one = mint)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = authority,
        space = 8 + Match::INIT_SPACE,
        seeds = [MATCH_SEED, id.to_le_bytes().as_ref()],
        bump
    )]
    pub match_account: Account<'info, Match>,
    /// The vault: a token account whose only authority is the match PDA,
    /// which has no private key. Nobody can sign for it; only this program
    /// can, through the instructions that follow.
    #[account(
        init,
        payer = authority,
        seeds = [VAULT_SEED, match_account.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = match_account
    )]
    pub vault: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_match(ctx: Context<CreateMatch>, id: u64, entry: u64) -> Result<()> {
    require!(entry > 0, EscrowError::BadEntry);
    let m = &mut ctx.accounts.match_account;
    m.id = id;
    m.entry = entry;
    m.fee_bps = ctx.accounts.config.fee_bps;
    m.fee_wallet = ctx.accounts.config.fee_wallet;
    m.min_players = ctx.accounts.config.min_players;
    m.refund_delay = ctx.accounts.config.refund_delay;
    m.refund_after = 0;
    m.state = MatchState::Open;
    m.collected_at = 0;
    m.pool = 0;
    m.bump = ctx.bumps.match_account;
    m.players = Vec::new();
    emit!(MatchCreated { id, entry });
    Ok(())
}
