use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::EscrowError,
    events::ReferralRecorded,
    state::{Config, Referral},
};

/// The player records who invited them, once. Their own signature makes it
/// theirs: nobody can name a referrer for someone else, or change it later.
/// The platform's admission key signs as well, given only for an invite the
/// site accepted: alone, a player could name any referrer, skipping the
/// site's rules (escrow v4, security review 2026-10-13). The platform pays the
/// account's rent as the fee payer, so the player still pays nothing. The two
/// accounts come last, so the first four are where they always were.
#[derive(Accounts)]
pub struct SetReferrer<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Referral::INIT_SPACE,
        seeds = [REFERRAL_SEED, player.key().as_ref()],
        bump
    )]
    pub referral: Account<'info, Referral>,
    pub player: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(constraint = admission.key() == config.admission @ EscrowError::WrongAdmission)]
    pub admission: Signer<'info>,
}

pub fn handle_set_referrer(ctx: Context<SetReferrer>, referrer: Pubkey) -> Result<()> {
    require!(referrer != Pubkey::default(), EscrowError::BadReferral);
    let r = &mut ctx.accounts.referral;
    r.referrer = referrer;
    r.bump = ctx.bumps.referral;
    emit!(ReferralRecorded {
        player: ctx.accounts.player.key(),
        referrer,
        by_player: true,
    });
    Ok(())
}
