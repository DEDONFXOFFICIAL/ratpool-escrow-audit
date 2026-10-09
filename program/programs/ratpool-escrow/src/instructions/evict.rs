use anchor_lang::prelude::*;

use crate::{
    error::EscrowError,
    events::PlayerEvicted,
    instructions::lifecycle::AuthorityOnly,
    state::{MatchState, PlayerStatus},
};

pub fn handle_evict(ctx: Context<AuthorityOnly>, id: u64, player: Pubkey) -> Result<()> {
    let m = &mut ctx.accounts.match_account;
    require!(m.state == MatchState::Open, EscrowError::MatchNotOpen);
    let idx = m.players.iter().position(|p| p.key == player).ok_or(EscrowError::NotInMatch)?;
    require!(m.players[idx].status == PlayerStatus::Joined, EscrowError::CannotEvict);
    m.players.remove(idx);
    emit!(PlayerEvicted {
        id,
        player,
        seats: m.players.len() as u8,
    });
    Ok(())
}
