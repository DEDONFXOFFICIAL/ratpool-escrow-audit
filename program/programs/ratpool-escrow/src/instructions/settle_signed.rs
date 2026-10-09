use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use crate::{
    constants::*,
    error::EscrowError,
    events::MatchSettled,
    state::{Config, Guard, Match, MatchState, PlayerStatus, Referral},
};

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct SettleSigned<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority, has_one = mint)]
    pub config: Account<'info, Config>,
    #[account(seeds = [GUARD_SEED], bump = guard.bump)]
    pub guard: Account<'info, Guard>,
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
    /// The fee can go to one place: a token account owned by the match's
    /// fee wallet. The authority cannot point it anywhere else.
    #[account(
        mut,
        token::mint = mint,
        constraint = fee_ata.owner == match_account.fee_wallet @ EscrowError::WrongFeeAccount
    )]
    pub fee_ata: Account<'info, TokenAccount>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: the instructions sysvar, fixed by its address; read for the
    /// room server's signature check.
    #[account(address = solana_sdk_ids::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

/// Pay the podium the room server signed for.
///
/// The instruction just before this one must be the ed25519 check of the
/// room server's signature, by the room key in the guard, over SETTLE_DOMAIN,
/// this program's id, this match's id and start time, a count and that many
/// wallets: the room's finishing order, best first. The ranking is read from
/// those signed bytes and from nowhere else (sent twice, it also overflowed a
/// transaction). The podium is the first stakers in that ranking; a ranking
/// holding too few is refused, never topped up from wallets the room did not
/// rank. The payout key chooses nothing.
///
/// Remaining accounts: one token account for each place, owned by that
/// winner (any of theirs: a winner whose usual account is unusable can be
/// paid into another); then each winner's invite record address, in podium
/// order, whether or not the record exists; then, for each record that
/// exists, a token account owned by its referrer. Every record is counted
/// and paid: none can be left out, invented or redirected.
pub fn handle_settle_signed<'info>(ctx: Context<'info, SettleSigned<'info>>, id: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        !ctx.accounts.match_account.deadline_expired(now),
        EscrowError::DeadlineExpired
    );
    require!(
        ctx.accounts.match_account.state == MatchState::Collected,
        EscrowError::MatchNotCollected
    );
    // Strictly after the start: a match closed and opened again under the
    // same id then always starts later than any match it replaced, so no
    // signature (which names the start) can carry over to it.
    require!(now > ctx.accounts.match_account.collected_at, EscrowError::TooSoon);
    let room_key = ctx.accounts.guard.room_key;
    require!(room_key != Pubkey::default(), EscrowError::RoomKeyNotSet);
    let ranking = signed_ranking(
        &ctx.accounts.instructions.to_account_info(),
        &room_key,
        ctx.program_id,
        id,
        ctx.accounts.match_account.collected_at,
    )?;

    // The podium, chosen here.
    let winners: Vec<Pubkey> = {
        let m = &ctx.accounts.match_account;
        let n = m.collected_count().min(PODIUM_SHARES.len());
        require!(n >= 1, EscrowError::BadPodium);
        let mut w: Vec<Pubkey> = Vec::with_capacity(n);
        for k in ranking.iter() {
            if w.len() == n {
                break;
            }
            if m.is_staker(k) && !w.contains(k) {
                w.push(*k);
            }
        }
        // Too few stakers in what the room signed: refused. Topping the podium
        // up from seat order would pay wallets the room never ranked.
        require!(w.len() == n, EscrowError::BadPodium);
        w
    };
    let n = winners.len();

    let rem = ctx.remaining_accounts;
    require!(rem.len() >= 2 * n, EscrowError::BadReferral);
    // Each place's account first: the winner's own, of this mint.
    for i in 0..n {
        let ta = Account::<TokenAccount>::try_from(&rem[i])?;
        require!(ta.mint == ctx.accounts.mint.key(), EscrowError::WrongMint);
        require!(ta.owner == winners[i], EscrowError::BadPodium);
    }

    // Every winner's invite record, at its own address: the program sees
    // which exist, so none can be left out to shift the shares.
    let mut referrers: Vec<Pubkey> = Vec::with_capacity(n);
    for (i, w) in winners.iter().enumerate() {
        let rec = &rem[n + i];
        let (address, _) = Pubkey::find_program_address(&[REFERRAL_SEED, w.as_ref()], ctx.program_id);
        require!(rec.key() == address, EscrowError::BadReferral);
        if rec.owner == ctx.program_id && !rec.data_is_empty() {
            referrers.push(Account::<Referral>::try_from(rec)?.referrer);
        }
    }
    let k = referrers.len();
    require!(rem.len() == 2 * n + k, EscrowError::BadReferral);

    let pool = ctx.accounts.match_account.pool;
    let fee = pool
        .checked_mul(ctx.accounts.match_account.fee_bps as u64)
        .ok_or(EscrowError::Overflow)?
        / BPS;
    let net = pool.checked_sub(fee).ok_or(EscrowError::Overflow)?;
    // Referrals come entirely from the fee, never more than it (every record
    // must be paid, so a fee smaller than the share is shared out rather
    // than leave the match unpayable); rounding dust stays with the platform.
    let referral_total = if referrers.is_empty() {
        0
    } else {
        (pool.checked_mul(REFERRAL_BPS).ok_or(EscrowError::Overflow)? / BPS).min(fee)
    };
    let referral_each = referral_total.checked_div(referrers.len() as u64).unwrap_or(0);
    let referral_amounts = vec![referral_each; referrers.len()];
    let referral_paid = referral_each
        .checked_mul(referrers.len() as u64)
        .ok_or(EscrowError::Overflow)?;
    let platform_fee = fee.checked_sub(referral_paid).ok_or(EscrowError::Overflow)?;

    // The shares that exist, scaled to the whole net pool. Any rounding
    // remainder goes to first place.
    let total: u64 = PODIUM_SHARES[..n].iter().sum();
    let mut amounts = vec![0u64; n];
    let mut below_first = 0u64;
    for i in 1..n {
        amounts[i] = net
            .checked_mul(PODIUM_SHARES[i])
            .ok_or(EscrowError::Overflow)?
            / total;
        below_first = below_first.checked_add(amounts[i]).ok_or(EscrowError::Overflow)?;
    }
    amounts[0] = net.checked_sub(below_first).ok_or(EscrowError::Overflow)?;

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

    let pay = |to: &AccountInfo<'info>, amount: u64| -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        token::transfer_checked(
            CpiContext::new_with_signer(
                token_program,
                TransferChecked {
                    from: vault_info.clone(),
                    mint: mint_info.clone(),
                    to: to.clone(),
                    authority: match_info.clone(),
                },
                signer,
            ),
            amount,
            decimals,
        )
    };

    pay(&ctx.accounts.fee_ata.to_account_info(), platform_fee)?;
    for i in 0..n {
        let acc = &rem[i];
        let ta = Account::<TokenAccount>::try_from(acc)?;
        require!(ta.mint == mint_key, EscrowError::WrongMint);
        require!(ta.owner == winners[i], EscrowError::BadPodium);
        pay(acc, amounts[i])?;
    }
    for j in 0..k {
        let acc = &rem[2 * n + j];
        let ta = Account::<TokenAccount>::try_from(acc)?;
        require!(ta.mint == mint_key, EscrowError::WrongMint);
        require!(ta.owner == referrers[j], EscrowError::BadReferral);
        pay(acc, referral_each)?;
    }

    let m = &mut ctx.accounts.match_account;
    for w in winners.iter() {
        if let Some(p) = m.players.iter_mut().find(|p| p.key == *w) {
            p.status = PlayerStatus::Paid;
        }
    }
    m.state = MatchState::Settled;
    m.pool = 0;
    emit!(MatchSettled {
        id,
        pool,
        fee,
        winners,
        amounts,
        referrers,
        referral_amounts,
        platform_fee
    });
    Ok(())
}

/// The ranking the room server signed for this match. The instruction just
/// before this one must be the ed25519 precompile checking one signature by
/// `key`, with the key, the signature and the message all inside that
/// instruction. The precompile has already failed the transaction if the
/// signature is wrong; what is checked here is that it was the room's key,
/// over a settlement of this match, and that the ranking is well formed.
fn signed_ranking(sysvar: &AccountInfo, key: &Pubkey, program_id: &Pubkey, id: u64, started: i64) -> Result<Vec<Pubkey>> {
    let current = load_current_index_checked(sysvar)? as usize;
    require!(current > 0, EscrowError::MissingRoomSignature);
    let ix = load_instruction_at_checked(current - 1, sysvar)?;
    require!(
        ix.program_id == solana_sdk_ids::ed25519_program::ID,
        EscrowError::MissingRoomSignature
    );
    let d = &ix.data;
    require!(d.len() >= 16 && d[0] == 1, EscrowError::BadRoomSignature);
    let at = |i: usize| u16::from_le_bytes([d[i], d[i + 1]]) as usize;
    let (pk_off, msg_off, msg_len) = (at(6), at(10), at(12));
    // Signature, key and message all in that same instruction: an offset into
    // another instruction could stand a signature over other bytes in.
    require!(
        at(4) == u16::MAX as usize && at(8) == u16::MAX as usize && at(14) == u16::MAX as usize,
        EscrowError::BadRoomSignature
    );
    let pk = d.get(pk_off..pk_off + 32).ok_or(EscrowError::BadRoomSignature)?;
    require!(pk == key.as_ref(), EscrowError::BadRoomSignature);
    let msg = d.get(msg_off..msg_off + msg_len).ok_or(EscrowError::BadRoomSignature)?;
    let d0 = SETTLE_DOMAIN.len();
    let head = d0 + 32 + 8 + 8 + 1;
    require!(msg.len() >= head, EscrowError::BadRoomSignature);
    require!(&msg[..d0] == SETTLE_DOMAIN, EscrowError::BadRoomSignature);
    require!(&msg[d0..d0 + 32] == program_id.as_ref(), EscrowError::BadRoomSignature);
    require!(msg[d0 + 32..d0 + 40] == id.to_le_bytes(), EscrowError::BadRoomSignature);
    require!(msg[d0 + 40..d0 + 48] == started.to_le_bytes(), EscrowError::BadRoomSignature);
    let count = msg[head - 1] as usize;
    require!(count >= 1 && count <= MAX_SIGNED_RANKING, EscrowError::BadRanking);
    require!(msg.len() == head + 32 * count, EscrowError::BadRoomSignature);
    let mut ranking: Vec<Pubkey> = Vec::with_capacity(count);
    for i in 0..count {
        let bytes: [u8; 32] = msg[head + 32 * i..head + 32 * (i + 1)]
            .try_into()
            .map_err(|_| EscrowError::BadRoomSignature)?;
        let k = Pubkey::new_from_array(bytes);
        require!(!ranking.contains(&k), EscrowError::BadRanking);
        ranking.push(k);
    }
    Ok(ranking)
}
