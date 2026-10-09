use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token::{self, Approve, Revoke, Token, TokenAccount};

use crate::{
    constants::*,
    error::EscrowError,
    events::{PlayerJoined, PlayerLeft},
    state::{Config, Match, MatchState, Player, PlayerStatus},
};

/// The platform admits the room's player while sponsoring the transaction.
#[derive(Accounts)]
#[instruction(id: u64)]
pub struct Join<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [MATCH_SEED, id.to_le_bytes().as_ref()], bump = match_account.bump)]
    pub match_account: Account<'info, Match>,
    #[account(mut, token::mint = config.mint, token::authority = player)]
    pub player_ata: Account<'info, TokenAccount>,
    pub player: Signer<'info>,
    #[account(constraint = admission.key() == config.admission @ EscrowError::WrongAdmission)]
    pub admission: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct Leave<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [MATCH_SEED, id.to_le_bytes().as_ref()], bump = match_account.bump)]
    pub match_account: Account<'info, Match>,
    #[account(mut, token::mint = config.mint, token::authority = player)]
    pub player_ata: Account<'info, TokenAccount>,
    pub player: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

/// The embedded wallet approves one entry automatically; nothing moves yet.
pub fn handle_join(ctx: Context<Join>, id: u64) -> Result<()> {
    let player = ctx.accounts.player.key();
    {
        let m = &ctx.accounts.match_account;
        require!(m.state == MatchState::Open, EscrowError::MatchNotOpen);
        require!(
            m.players.len() < MAX_PLAYERS as usize,
            EscrowError::MatchFull
        );
        require!(
            !m.players.iter().any(|p| p.key == player),
            EscrowError::AlreadyJoined
        );
        // A seat you cannot pay for is refused now rather than dropped at
        // collection, so the room count means something while it fills.
        require!(
            ctx.accounts.player_ata.amount >= m.entry,
            EscrowError::InsufficientFunds
        );
    }

    let entry = ctx.accounts.match_account.entry;
    token::approve(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Approve {
                to: ctx.accounts.player_ata.to_account_info(),
                delegate: ctx.accounts.match_account.to_account_info(),
                authority: ctx.accounts.player.to_account_info(),
            },
        ),
        entry,
    )?;

    let m = &mut ctx.accounts.match_account;
    m.players.push(Player {
        key: player,
        token_account: ctx.accounts.player_ata.key(),
        status: PlayerStatus::Joined,
    });
    emit!(PlayerJoined {
        id,
        player,
        seats: m.players.len() as u8
    });
    Ok(())
}

/// Walk out while the room is still filling. Costs nothing, by design.
pub fn handle_leave(ctx: Context<Leave>, id: u64) -> Result<()> {
    let player = ctx.accounts.player.key();
    let idx = {
        let m = &ctx.accounts.match_account;
        require!(m.state == MatchState::Open, EscrowError::MatchNotOpen);
        m.players
            .iter()
            .position(|p| p.key == player && p.status == PlayerStatus::Joined)
            .ok_or(EscrowError::NotInMatch)?
    };

    require!(
        ctx.accounts.match_account.players[idx].token_account == ctx.accounts.player_ata.key(),
        EscrowError::WrongTokenAccount
    );
    // Leaving an older room must not revoke a newer room's approval.
    if ctx.accounts.player_ata.delegate == COption::Some(ctx.accounts.match_account.key()) {
        token::revoke(CpiContext::new(
            ctx.accounts.token_program.key(),
            Revoke {
                source: ctx.accounts.player_ata.to_account_info(),
                authority: ctx.accounts.player.to_account_info(),
            },
        ))?;
    }

    let m = &mut ctx.accounts.match_account;
    m.players.remove(idx);
    emit!(PlayerLeft {
        id,
        player,
        seats: m.players.len() as u8
    });
    Ok(())
}
