//! The escrow, exercised the way a sceptic would exercise it.
//!
//! Runs against the compiled program in LiteSVM: no validator, no network.
//! Mints and token accounts are written straight into the simulator's
//! account store in the SPL Token wire layout, which keeps the test free of
//! every SPL client crate and their version skew.

use anchor_lang::{
    prelude::Pubkey,
    solana_program::{
        clock::Clock,
        instruction::{AccountMeta, Instruction},
        system_program,
    },
    AccountDeserialize, InstructionData, ToAccountMetas,
};
use litesvm::LiteSVM;
use ratpool_escrow::{constants::*, state::*};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

const TOKEN_PROGRAM: Pubkey = anchor_spl::token::ID;
const DECIMALS: u8 = 6;
/// One USDC in base units.
const USDC: u64 = 1_000_000;
const ENTRY: u64 = USDC / 10; // the 0.10 tier
const FEE_BPS: u16 = 500;
const REFUND_DELAY: i64 = 1_800;

// ------------------------------------------------------------ SPL layouts

fn pack_mint(authority: &Pubkey) -> Vec<u8> {
    let mut d = vec![0u8; 82];
    d[0..4].copy_from_slice(&1u32.to_le_bytes()); // mint_authority: Some
    d[4..36].copy_from_slice(authority.as_ref());
    d[44] = DECIMALS;
    d[45] = 1; // is_initialized
    d
}

fn pack_token(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1; // state: Initialized
    d
}

fn token_amount(data: &[u8]) -> u64 {
    u64::from_le_bytes(data[64..72].try_into().unwrap())
}

fn token_delegate(data: &[u8]) -> Option<(Pubkey, u64)> {
    let tag = u32::from_le_bytes(data[72..76].try_into().unwrap());
    if tag != 1 {
        return None;
    }
    let key = Pubkey::new_from_array(data[76..108].try_into().unwrap());
    let amount = u64::from_le_bytes(data[121..129].try_into().unwrap());
    Some((key, amount))
}

// ------------------------------------------------------------ the world

struct World {
    svm: LiteSVM,
    program_id: Pubkey,
    authority: Keypair,
    /// The program's upgrade authority: the config, the room key and
    /// authority rotation answer to it. The same key as `authority` until a
    /// test rotates the payout authority away.
    admin: Keypair,
    /// The room server: signs every payout's ranking.
    room: Keypair,
    admission: Keypair,
    fee_wallet: Keypair,
    fee_ata: Pubkey,
    mint: Pubkey,
    config: Pubkey,
    last_logs: Vec<String>,
}

impl World {
    fn new() -> Self {
        let program_id = ratpool_escrow::id();
        let mut svm = LiteSVM::new();
        let bytes = include_bytes!(concat!(
            env!("CARGO_TARGET_TMPDIR"),
            "/../deploy/ratpool_escrow.so"
        ));
        svm.add_program(program_id, bytes).unwrap();

        let authority = Keypair::new();
        // Model the upgradeable loader metadata without reading any key files.
        let loader = "BPFLoaderUpgradeab1e11111111111111111111111".parse::<Pubkey>().unwrap();
        let program_data = Pubkey::find_program_address(&[program_id.as_ref()], &loader).0;
        let mut data = vec![0u8; 45];
        data[..4].copy_from_slice(&3u32.to_le_bytes()); // ProgramData
        data[12] = 1; // upgrade_authority_address: Some
        data[13..45].copy_from_slice(authority.pubkey().as_ref());
        data.extend_from_slice(bytes);
        svm.set_account(program_data, Account {
            lamports: svm.minimum_balance_for_rent_exemption(data.len()),
            data, owner: loader, executable: false, rent_epoch: 0,
        }).unwrap();
        let mut data = 2u32.to_le_bytes().to_vec(); // Program
        data.extend_from_slice(program_data.as_ref());
        svm.set_account(program_id, Account {
            lamports: svm.minimum_balance_for_rent_exemption(data.len()),
            data, owner: loader, executable: true, rent_epoch: 0,
        }).unwrap();
        let fee_wallet = Keypair::new();
        let admission = Keypair::new();
        svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();
        svm.airdrop(&admission.pubkey(), 10_000_000_000).unwrap();

        let mint = Keypair::new().pubkey();
        let mint_data = pack_mint(&authority.pubkey());
        let lamports = svm.minimum_balance_for_rent_exemption(mint_data.len());
        svm.set_account(
            mint,
            Account {
                lamports,
                data: mint_data,
                owner: TOKEN_PROGRAM,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();

        let (config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &program_id);
        let admin = authority.insecure_clone();
        let mut w = World {
            svm,
            program_id,
            authority,
            admin,
            room: Keypair::new(),
            admission,
            fee_wallet,
            fee_ata: Pubkey::default(),
            mint,
            config,
            last_logs: Vec::new(),
        };
        w.fee_ata = w.token_account(&w.fee_wallet.pubkey(), 0);
        w
    }

    /// A token account for `owner` holding `amount`, written directly.
    fn token_account(&mut self, owner: &Pubkey, amount: u64) -> Pubkey {
        let key = Keypair::new().pubkey();
        let data = pack_token(&self.mint, owner, amount);
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                key,
                Account {
                    lamports,
                    data,
                    owner: TOKEN_PROGRAM,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        key
    }

    /// A funded player: SOL for fees, `usdc` in a token account.
    fn player(&mut self, usdc: u64) -> (Keypair, Pubkey) {
        let kp = Keypair::new();
        self.svm.airdrop(&kp.pubkey(), 1_000_000_000).unwrap();
        let ata = self.token_account(&kp.pubkey(), usdc);
        (kp, ata)
    }

    /// Overwrite a token account's balance — "the player spent it".
    fn set_balance(&mut self, ata: &Pubkey, amount: u64) {
        let mut acc = self.svm.get_account(ata).unwrap();
        acc.data[64..72].copy_from_slice(&amount.to_le_bytes());
        self.svm.set_account(*ata, acc).unwrap();
    }

    fn balance(&self, ata: &Pubkey) -> u64 {
        token_amount(&self.svm.get_account(ata).unwrap().data)
    }

    fn delegate(&self, ata: &Pubkey) -> Option<(Pubkey, u64)> {
        token_delegate(&self.svm.get_account(ata).unwrap().data)
    }

    fn match_pda(&self, id: u64) -> Pubkey {
        Pubkey::find_program_address(&[MATCH_SEED, &id.to_le_bytes()], &self.program_id).0
    }

    fn vault_pda(&self, id: u64) -> Pubkey {
        let m = self.match_pda(id);
        Pubkey::find_program_address(&[VAULT_SEED, m.as_ref()], &self.program_id).0
    }

    fn get_match(&self, id: u64) -> Option<Match> {
        let acc = self.svm.get_account(&self.match_pda(id))?;
        if acc.data.is_empty() {
            return None;
        }
        let mut d: &[u8] = &acc.data;
        Some(Match::try_deserialize(&mut d).unwrap())
    }

    fn get_config(&self) -> Config {
        let acc = self.svm.get_account(&self.config).unwrap();
        Config::try_deserialize(&mut acc.data.as_slice()).unwrap()
    }

    fn advance_clock(&mut self, secs: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp += secs;
        self.svm.set_sysvar(&clock);
    }

    /// Send one instruction; the first signer pays. Failures come back as
    /// the program's log so a test can name the error it expects.
    fn send(&mut self, ix: Instruction, signers: &[&Keypair]) -> Result<(), String> {
        // A fresh blockhash each time. Several tests send the same instruction
        // twice to prove the second is refused; under one blockhash the bytes
        // are identical and the runtime rejects the duplicate before the
        // program ever sees it.
        self.svm.expire_blockhash();
        let blockhash = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(&[ix], Some(&signers[0].pubkey()), &blockhash);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &signers.to_vec())
            .unwrap();
        match self.svm.send_transaction(tx) {
            Ok(meta) => {
                self.last_logs = meta.logs;
                Ok(())
            }
            Err(e) => {
                self.last_logs = e.meta.logs;
                Err(format!("{:?}\n{}", e.err, self.last_logs.join("\n")))
            }
        }
    }

    fn ix(&self, data: Vec<u8>, metas: Vec<AccountMeta>) -> Instruction {
        Instruction::new_with_bytes(self.program_id, &data, metas)
    }

    fn expect_event(&self, event: impl anchor_lang::Event) {
        let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut encoded = String::new();
        for chunk in event.data().chunks(3) {
            let n = ((chunk[0] as u32) << 16)
                | ((chunk.get(1).copied().unwrap_or(0) as u32) << 8)
                | chunk.get(2).copied().unwrap_or(0) as u32;
            encoded.push(alphabet[((n >> 18) & 63) as usize] as char);
            encoded.push(alphabet[((n >> 12) & 63) as usize] as char);
            encoded.push(if chunk.len() > 1 { alphabet[((n >> 6) & 63) as usize] as char } else { '=' });
            encoded.push(if chunk.len() > 2 { alphabet[(n & 63) as usize] as char } else { '=' });
        }
        assert!(self.last_logs.iter().any(|line| line == &format!("Program data: {encoded}")), "missing event: {:?}", self.last_logs);
    }

    // -------------------------------------------------------- instructions

    fn initialize(&mut self, min_players: u8) -> Result<(), String> {
        let ix = self.ix(
            ratpool_escrow::instruction::Initialize {
                fee_bps: FEE_BPS,
                min_players,
                refund_delay: REFUND_DELAY,
                admission: self.admission.pubkey(),
            }
            .data(),
            ratpool_escrow::accounts::Initialize {
                program: self.program_id,
                program_data: self.program_data(),
                config: self.config,
                authority: self.authority.pubkey(),
                fee_wallet: self.fee_wallet.pubkey(),
                mint: self.mint,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let a = self.authority.insecure_clone();
        self.send(ix, &[&a])?;
        let logs = self.last_logs.clone();
        let admin = self.admin.insecure_clone();
        let room = self.room.pubkey();
        self.set_room_key_as(room, &admin)?;
        self.last_logs = logs;
        Ok(())
    }

    fn set_room_key_as(&mut self, room_key: Pubkey, signer: &Keypair) -> Result<(), String> {
        let ix = self.ix(
            ratpool_escrow::instruction::SetRoomKey { room_key }.data(),
            ratpool_escrow::accounts::SetRoomKey {
                guard: self.guard_pda(),
                admin: signer.pubkey(),
                payer: self.admission.pubkey(),
                program: self.program_id,
                program_data: self.program_data(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        // Rent from another key: the upgrade authority holds no SOL.
        let payer = self.admission.insecure_clone();
        self.send(ix, &[&payer, signer])
    }

    fn guard_pda(&self) -> Pubkey {
        Pubkey::find_program_address(&[GUARD_SEED], &self.program_id).0
    }

    fn referral_pda(&self, player: &Pubkey) -> Pubkey {
        Pubkey::find_program_address(&[REFERRAL_SEED, player.as_ref()], &self.program_id).0
    }

    /// The player records who invited them; `payer` covers the rent.
    fn set_referrer(&mut self, player: &Keypair, referrer: Pubkey) -> Result<(), String> {
        let payer = self.admission.insecure_clone();
        let ix = self.ix(
            ratpool_escrow::instruction::SetReferrer { referrer }.data(),
            ratpool_escrow::accounts::SetReferrer {
                referral: self.referral_pda(&player.pubkey()),
                player: player.pubkey(),
                payer: payer.pubkey(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        self.send(ix, &[&payer, player])
    }

    fn record_referral_as(&mut self, player: Pubkey, referrer: Pubkey, signer: &Keypair) -> Result<(), String> {
        let ix = self.ix(
            ratpool_escrow::instruction::RecordReferral { player, referrer }.data(),
            ratpool_escrow::accounts::RecordReferral {
                referral: self.referral_pda(&player),
                admin: signer.pubkey(),
                payer: self.admission.pubkey(),
                program: self.program_id,
                program_data: self.program_data(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let payer = self.admission.insecure_clone();
        self.send(ix, &[&payer, signer])
    }

    /// Several instructions in one transaction; the first signer pays.
    fn send_all(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
        self.svm.expire_blockhash();
        let blockhash = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &blockhash);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &signers.to_vec()).unwrap();
        match self.svm.send_transaction(tx) {
            Ok(meta) => {
                self.last_logs = meta.logs;
                Ok(())
            }
            Err(e) => {
                self.last_logs = e.meta.logs;
                Err(format!("{:?}\n{}", e.err, self.last_logs.join("\n")))
            }
        }
    }

    /// What the room server signs for match `id`, as it stands now (its
    /// start time on chain included; zero for a match that does not exist).
    fn settle_message(&self, id: u64, ranking: &[Pubkey]) -> Vec<u8> {
        let started = self.get_match(id).map(|m| m.collected_at).unwrap_or(0);
        let mut m = SETTLE_DOMAIN.to_vec();
        m.extend_from_slice(self.program_id.as_ref());
        m.extend_from_slice(&id.to_le_bytes());
        m.extend_from_slice(&started.to_le_bytes());
        m.push(ranking.len() as u8);
        for k in ranking {
            m.extend_from_slice(k.as_ref());
        }
        m
    }

    fn token_owner(&self, ata: &Pubkey) -> Pubkey {
        Pubkey::new_from_array(self.svm.get_account(ata).unwrap().data[32..64].try_into().unwrap())
    }

    /// The settle_signed instruction: `pay` are the winners' token accounts
    /// in podium order; each winner's invite record address follows (from
    /// the owner of its account); `refs` are the referrers' token accounts,
    /// for the records that exist, in podium order.
    fn settle_signed_ix(&self, id: u64, signer: &Pubkey, fee_ata: &Pubkey, pay: &[Pubkey], refs: &[Pubkey]) -> Instruction {
        let slots: Vec<Pubkey> = pay.iter().map(|a| self.referral_pda(&self.token_owner(a))).collect();
        self.settle_signed_ix_with(id, signer, fee_ata, pay, &slots, refs)
    }

    /// As settle_signed_ix, with the invite record addresses given outright.
    fn settle_signed_ix_with(&self, id: u64, signer: &Pubkey, fee_ata: &Pubkey, pay: &[Pubkey], slots: &[Pubkey], refs: &[Pubkey]) -> Instruction {
        let mut metas = ratpool_escrow::accounts::SettleSigned {
            config: self.config,
            guard: self.guard_pda(),
            match_account: self.match_pda(id),
            vault: self.vault_pda(id),
            mint: self.mint,
            fee_ata: *fee_ata,
            authority: *signer,
            token_program: TOKEN_PROGRAM,
            instructions: solana_sdk_ids::sysvar::instructions::ID,
        }
        .to_account_metas(None);
        for a in pay {
            metas.push(AccountMeta::new(*a, false));
        }
        for rec in slots {
            metas.push(AccountMeta::new_readonly(*rec, false));
        }
        for a in refs {
            metas.push(AccountMeta::new(*a, false));
        }
        self.ix(ratpool_escrow::instruction::SettleSigned { id }.data(), metas)
    }

    /// The full signed payout: the room's signature check, then the payout.
    fn settle_signed_as(&mut self, id: u64, signer: &Keypair, fee_ata: &Pubkey, ranking: &[Pubkey], pay: &[Pubkey], refs: &[Pubkey]) -> Result<(), String> {
        // The room signs when the match is over: never in the second it started.
        if let Some(m) = self.get_match(id) {
            if self.svm.get_sysvar::<Clock>().unix_timestamp <= m.collected_at {
                self.advance_clock(1);
            }
        }
        let msg = self.settle_message(id, ranking);
        let room = self.room.insecure_clone();
        let check = ed25519_ix(&room, &msg);
        let ix = self.settle_signed_ix(id, &signer.pubkey(), fee_ata, pay, refs);
        self.send_all(&[check, ix], &[signer])
    }

    fn create_match(&mut self, id: u64, entry: u64) -> Result<(), String> {
        let ix = self.ix(
            ratpool_escrow::instruction::CreateMatch { id, entry }.data(),
            ratpool_escrow::accounts::CreateMatch {
                config: self.config,
                match_account: self.match_pda(id),
                vault: self.vault_pda(id),
                mint: self.mint,
                authority: self.authority.pubkey(),
                token_program: TOKEN_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let a = self.authority.insecure_clone();
        self.send(ix, &[&a])
    }

    fn join_metas(&self, id: u64, player: &Pubkey, ata: &Pubkey) -> Vec<AccountMeta> {
        ratpool_escrow::accounts::Join {
            config: self.config,
            match_account: self.match_pda(id),
            player_ata: *ata,
            player: *player,
            admission: self.admission.pubkey(),
            token_program: TOKEN_PROGRAM,
        }
        .to_account_metas(None)
    }

    fn join(&mut self, id: u64, player: &Keypair, ata: &Pubkey) -> Result<(), String> {
        let ix = self.ix(
            ratpool_escrow::instruction::Join { id }.data(),
            self.join_metas(id, &player.pubkey(), ata),
        );
        let admission = self.admission.insecure_clone();
        self.send(ix, &[&admission, player])
    }

    fn join_without_admission(&mut self, id: u64, player: &Keypair, ata: &Pubkey) -> Result<(), String> {
        let mut metas = self.join_metas(id, &player.pubkey(), ata);
        metas.iter_mut().find(|m| m.pubkey == self.admission.pubkey()).unwrap().is_signer = false;
        let ix = self.ix(ratpool_escrow::instruction::Join { id }.data(), metas);
        self.send(ix, &[player])
    }

    fn leave(&mut self, id: u64, player: &Keypair, ata: &Pubkey) -> Result<(), String> {
        let ix = self.ix(
            ratpool_escrow::instruction::Leave { id }.data(),
            ratpool_escrow::accounts::Leave {
                config: self.config,
                match_account: self.match_pda(id),
                player_ata: *ata,
                player: player.pubkey(),
                token_program: TOKEN_PROGRAM,
            }.to_account_metas(None),
        );
        self.send(ix, &[player])
    }

    fn collect(&mut self, id: u64, atas: &[Pubkey]) -> Result<(), String> {
        let mut metas = ratpool_escrow::accounts::Collect {
            config: self.config,
            match_account: self.match_pda(id),
            vault: self.vault_pda(id),
            mint: self.mint,
            authority: self.authority.pubkey(),
            token_program: TOKEN_PROGRAM,
        }
        .to_account_metas(None);
        for a in atas {
            metas.push(AccountMeta::new(*a, false));
        }
        let ix = self.ix(ratpool_escrow::instruction::Collect { id }.data(), metas);
        let a = self.authority.insecure_clone();
        self.send(ix, &[&a])
    }

    fn authority_only(&self, id: u64, signer: &Pubkey) -> Vec<AccountMeta> {
        ratpool_escrow::accounts::AuthorityOnly {
            config: self.config,
            match_account: self.match_pda(id),
            authority: *signer,
        }
        .to_account_metas(None)
    }

    fn start(&mut self, id: u64) -> Result<(), String> {
        let a = self.authority.insecure_clone();
        let ix = self.ix(
            ratpool_escrow::instruction::Start { id }.data(),
            self.authority_only(id, &a.pubkey()),
        );
        self.send(ix, &[&a])
    }

    fn cancel(&mut self, id: u64) -> Result<(), String> {
        let a = self.authority.insecure_clone();
        let ix = self.ix(
            ratpool_escrow::instruction::Cancel { id }.data(),
            self.authority_only(id, &a.pubkey()),
        );
        self.send(ix, &[&a])
    }

    fn evict_as(&mut self, id: u64, player: Pubkey, signer: &Keypair) -> Result<(), String> {
        let ix = self.ix(
            ratpool_escrow::instruction::Evict { id, player }.data(),
            self.authority_only(id, &signer.pubkey()),
        );
        self.send(ix, &[signer])
    }

    fn evict(&mut self, id: u64, player: Pubkey) -> Result<(), String> {
        let a = self.authority.insecure_clone();
        self.evict_as(id, player, &a)
    }

    /// `winners`: (owner, token account), best first.
    fn settle_as(
        &mut self,
        id: u64,
        signer: &Keypair,
        fee_ata: &Pubkey,
        winners: &[(Pubkey, Pubkey)],
    ) -> Result<(), String> {
        self.settle_with_referrers_as(id, signer, fee_ata, winners, &[])
    }

    /// `winners`: (owner, token account) in podium order, signed as the
    /// ranking; `refs`: the referrers' token accounts, for the winners with
    /// an invite on record, in podium order.
    fn settle_with_referrers_as(
        &mut self,
        id: u64,
        signer: &Keypair,
        fee_ata: &Pubkey,
        winners: &[(Pubkey, Pubkey)],
        refs: &[Pubkey],
    ) -> Result<(), String> {
        let ranking: Vec<Pubkey> = winners.iter().map(|(k, _)| *k).collect();
        let pay: Vec<Pubkey> = winners.iter().map(|(_, a)| *a).collect();
        self.settle_signed_as(id, signer, fee_ata, &ranking, &pay, refs)
    }

    fn settle(&mut self, id: u64, winners: &[(Pubkey, Pubkey)]) -> Result<(), String> {
        let a = self.authority.insecure_clone();
        let fee = self.fee_ata;
        self.settle_as(id, &a, &fee, winners)
    }

    fn claim_refund(&mut self, id: u64, ata: &Pubkey) -> Result<(), String> {
        let ix = self.ix(
            ratpool_escrow::instruction::ClaimRefund { id }.data(),
            ratpool_escrow::accounts::ClaimRefund {
                config: self.config,
                match_account: self.match_pda(id),
                vault: self.vault_pda(id),
                mint: self.mint,
                player_ata: *ata,
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
        );
        // Anyone pays the fee. Here: a stranger with no stake at all.
        let stranger = Keypair::new();
        self.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
        self.send(ix, &[&stranger])
    }

    fn close_match(&mut self, id: u64) -> Result<(), String> {
        let a = self.authority.insecure_clone();
        let ix = self.ix(
            ratpool_escrow::instruction::CloseMatch { id }.data(),
            ratpool_escrow::accounts::CloseMatch {
                mint: self.mint,
                fee_ata: self.fee_ata,
                config: self.config,
                match_account: self.match_pda(id),
                vault: self.vault_pda(id),
                authority: a.pubkey(),
                token_program: TOKEN_PROGRAM,
            }
            .to_account_metas(None),
        );
        self.send(ix, &[&a])
    }

    /// A full room: `n` players with 5 USDC each, all joined.
    fn room(&mut self, id: u64, n: usize) -> Vec<(Keypair, Pubkey)> {
        let mut players = Vec::new();
        for _ in 0..n {
            let (kp, ata) = self.player(5 * USDC);
            self.join(id, &kp, &ata).unwrap();
            players.push((kp, ata));
        }
        players
    }

    fn program_data(&self) -> Pubkey {
        Pubkey::find_program_address(
            &[self.program_id.as_ref()],
            &"BPFLoaderUpgradeab1e11111111111111111111111".parse::<Pubkey>().unwrap(),
        ).0
    }

    fn update_config(&mut self, fee_bps: Option<u16>, refund_delay: Option<i64>) -> Result<(), String> {
        let ix = self.ix(
            ratpool_escrow::instruction::UpdateConfig {
                fee_bps, refund_delay, min_players: None, fee_wallet: None, admission: None,
            }.data(),
            ratpool_escrow::accounts::UpdateConfig {
                config: self.config, admin: self.admin.pubkey(),
                program: self.program_id, program_data: self.program_data(),
            }.to_account_metas(None),
        );
        let a = self.admin.insecure_clone();
        self.send(ix, &[&a])
    }

    fn update_terms(&mut self, min_players: Option<u8>, refund_delay: Option<i64>, fee_wallet: Option<Pubkey>, admission: Option<Pubkey>) -> Result<(), String> {
        let ix = self.ix(
            ratpool_escrow::instruction::UpdateConfig {
                fee_bps: None, min_players, refund_delay, fee_wallet, admission,
            }.data(),
            ratpool_escrow::accounts::UpdateConfig {
                config: self.config, admin: self.admin.pubkey(),
                program: self.program_id, program_data: self.program_data(),
            }.to_account_metas(None),
        );
        let a = self.admin.insecure_clone();
        self.send(ix, &[&a])
    }

    fn propose_as(&mut self, new: Pubkey, signer: &Keypair) -> Result<(), String> {
        let ix = self.ix(
            ratpool_escrow::instruction::ProposeAuthority { new }.data(),
            ratpool_escrow::accounts::UpdateConfig {
                config: self.config, admin: signer.pubkey(),
                program: self.program_id, program_data: self.program_data(),
            }.to_account_metas(None),
        );
        self.send(ix, &[signer])
    }

    fn accept_as(&mut self, signer: &Keypair) -> Result<(), String> {
        let ix = self.ix(
            ratpool_escrow::instruction::AcceptAuthority {}.data(),
            ratpool_escrow::accounts::AcceptAuthority {
                config: self.config, pending_authority: signer.pubkey(),
            }.to_account_metas(None),
        );
        self.send(ix, &[signer])
    }
}

fn spl(w: &mut World, data: Vec<u8>, metas: Vec<AccountMeta>, signer: &Keypair) {
    w.send(Instruction::new_with_bytes(TOKEN_PROGRAM, &data, metas), &[signer]).unwrap();
}

fn approve(w: &mut World, source: Pubkey, delegate: Pubkey, amount: u64, owner: &Keypair) {
    let mut data = vec![4]; // Approve
    data.extend_from_slice(&amount.to_le_bytes());
    spl(w, data, vec![AccountMeta::new(source, false), AccountMeta::new_readonly(delegate, false), AccountMeta::new_readonly(owner.pubkey(), true)], owner);
}

fn change_owner(w: &mut World, source: Pubkey, next: Pubkey, owner: &Keypair) {
    let mut data = vec![6, 2, 1]; // SetAuthority: AccountOwner
    data.extend_from_slice(next.as_ref());
    spl(w, data, vec![AccountMeta::new(source, false), AccountMeta::new_readonly(owner.pubkey(), true)], owner);
}

fn transfer(w: &mut World, source: Pubkey, destination: Pubkey, amount: u64, owner: &Keypair) {
    let mut data = vec![3]; // Transfer
    data.extend_from_slice(&amount.to_le_bytes());
    spl(w, data, vec![AccountMeta::new(source, false), AccountMeta::new(destination, false), AccountMeta::new_readonly(owner.pubkey(), true)], owner);
}

const ED25519: Pubkey = solana_sdk_ids::ed25519_program::ID;

/// The ed25519 precompile instruction for one signature: key, signature and
/// message all inside it (offsets 16, 48, 112), as the site builds it.
fn ed25519_ix(signer: &Keypair, msg: &[u8]) -> Instruction {
    ed25519_ix_with(signer.pubkey(), signer.sign_message(msg).as_ref(), msg, u16::MAX)
}

fn ed25519_ix_with(key: Pubkey, sig: &[u8], msg: &[u8], index: u16) -> Instruction {
    let mut d = vec![1u8, 0u8];
    for v in [48u16, index, 16, index, 112, msg.len() as u16, index] {
        d.extend_from_slice(&v.to_le_bytes());
    }
    d.extend_from_slice(key.as_ref());
    d.extend_from_slice(sig);
    d.extend_from_slice(msg);
    Instruction::new_with_bytes(ED25519, &d, vec![])
}

fn expect_err(r: Result<(), String>, name: &str) {
    match r {
        Ok(()) => panic!("expected {name}, but it succeeded"),
        Err(e) => assert!(e.contains(name), "expected {name}, got:\n{e}"),
    }
}

// ------------------------------------------------------------ the tests

#[test]
fn ten_rats_stake_and_the_podium_is_paid() {
    let mut w = World::new();
    w.initialize(10).unwrap();
    w.create_match(1, ENTRY).unwrap();
    let players = w.room(1, 10);

    // Joining moves nothing. It only grants the match the right to collect.
    for (kp, ata) in &players {
        assert_eq!(w.balance(ata), 5 * USDC);
        assert_eq!(w.delegate(ata), Some((w.match_pda(1), ENTRY)));
        assert!(w.get_match(1).unwrap().players.iter().any(|p| p.key == kp.pubkey()));
    }
    assert_eq!(w.balance(&w.vault_pda(1)), 0);

    // The room is full: one collect takes everyone's entry.
    let atas: Vec<Pubkey> = players.iter().map(|(_, a)| *a).collect();
    w.collect(1, &atas).unwrap();
    assert_eq!(w.balance(&w.vault_pda(1)), 10 * ENTRY);
    for (_, ata) in &players {
        assert_eq!(w.balance(ata), 5 * USDC - ENTRY);
    }
    let m = w.get_match(1).unwrap();
    assert_eq!(m.pool, 10 * ENTRY);
    assert_eq!(m.collected_count(), 10);

    w.start(1).unwrap();
    assert_eq!(w.get_match(1).unwrap().state, MatchState::Collected);

    // 95% of 1.00 = 0.95, split 50/30/20.
    let podium: Vec<(Pubkey, Pubkey)> = players[..3]
        .iter()
        .map(|(kp, ata)| (kp.pubkey(), *ata))
        .collect();
    w.settle(1, &podium).unwrap();
    assert_eq!(w.balance(&w.fee_ata), 50_000);
    assert_eq!(w.balance(&players[0].1), 5 * USDC - ENTRY + 475_000);
    assert_eq!(w.balance(&players[1].1), 5 * USDC - ENTRY + 285_000);
    assert_eq!(w.balance(&players[2].1), 5 * USDC - ENTRY + 190_000);
    assert_eq!(w.balance(&players[3].1), 5 * USDC - ENTRY);
    assert_eq!(w.balance(&w.vault_pda(1)), 0);
    let m = w.get_match(1).unwrap();
    assert_eq!(m.state, MatchState::Settled);
    assert_eq!(m.pool, 0);

    // Rent comes back and the accounts are gone.
    let before = w.svm.get_account(&w.authority.pubkey()).unwrap().lamports;
    w.close_match(1).unwrap();
    assert!(w.get_match(1).is_none());
    assert!(w.svm.get_account(&w.vault_pda(1)).map_or(true, |a| a.data.is_empty()));
    assert!(w.svm.get_account(&w.authority.pubkey()).unwrap().lamports > before);
}

#[test]
fn a_room_of_one_still_pays_out_the_whole_pool() {
    // The devnet case: one human, thirty-nine bots. min_players is 1 and
    // the single share is scaled to the whole net pool.
    let mut w = World::new();
    w.initialize(1).unwrap();
    w.create_match(7, ENTRY).unwrap();
    let players = w.room(7, 1);
    let ata = players[0].1;
    w.collect(7, &[ata]).unwrap();
    w.start(7).unwrap();
    w.settle(7, &[(players[0].0.pubkey(), ata)]).unwrap();
    assert_eq!(w.balance(&w.fee_ata), 5_000);
    assert_eq!(w.balance(&ata), 5 * USDC - ENTRY + 95_000);
    assert_eq!(w.balance(&w.vault_pda(7)), 0);
}

#[test]
fn two_stakers_split_the_scaled_shares() {
    let mut w = World::new();
    w.initialize(2).unwrap();
    w.create_match(2, USDC).unwrap(); // the 1 USDC tier
    let players = w.room(2, 2);
    let atas: Vec<Pubkey> = players.iter().map(|(_, a)| *a).collect();
    w.collect(2, &atas).unwrap();
    w.start(2).unwrap();
    let podium: Vec<(Pubkey, Pubkey)> =
        players.iter().map(|(kp, ata)| (kp.pubkey(), *ata)).collect();
    w.settle(2, &podium).unwrap();
    // pool 2.00, fee 0.10, net 1.90; shares 50:30 → 1.1875 / 0.7125
    assert_eq!(w.balance(&w.fee_ata), 100_000);
    assert_eq!(w.balance(&atas[1]), 4 * USDC + 712_500);
    assert_eq!(w.balance(&atas[0]), 4 * USDC + 1_187_500);
    assert_eq!(w.balance(&w.vault_pda(2)), 0);
}

#[test]
fn a_player_who_spent_the_money_is_dropped_not_fatal() {
    let mut w = World::new();
    w.initialize(10).unwrap();
    w.create_match(3, ENTRY).unwrap();
    let players = w.room(3, 10);
    // Player 4 spent everything between joining and collection.
    w.set_balance(&players[4].1, 0);

    let atas: Vec<Pubkey> = players.iter().map(|(_, a)| *a).collect();
    w.collect(3, &atas).unwrap();
    let m = w.get_match(3).unwrap();
    assert_eq!(m.collected_count(), 9);
    assert_eq!(m.players[4].status, PlayerStatus::Dropped);
    assert_eq!(w.balance(&w.vault_pda(3)), 9 * ENTRY);

    // Nine is below the minimum: start refuses, the server cancels, and
    // every collected stake is refundable at once — by anyone.
    expect_err(w.start(3), "TooFewPlayers");
    expect_err(w.close_match(3), "MatchNotOpen");
    w.cancel(3).unwrap();
    expect_err(w.close_match(3), "VaultNotEmpty");
    for (i, (_, ata)) in players.iter().enumerate() {
        if i == 4 {
            expect_err(w.claim_refund(3, ata), "NotAStaker");
            continue;
        }
        w.claim_refund(3, ata).unwrap();
        assert_eq!(w.balance(ata), 5 * USDC);
        expect_err(w.claim_refund(3, ata), "NotAStaker"); // not twice
    }
    assert_eq!(w.balance(&w.vault_pda(3)), 0);
    w.close_match(3).unwrap();
}

#[test]
fn the_fire_exit_opens_after_the_deadline() {
    let mut w = World::new();
    w.initialize(10).unwrap();
    w.create_match(4, ENTRY).unwrap();
    let players = w.room(4, 10);
    let atas: Vec<Pubkey> = players.iter().map(|(_, a)| *a).collect();
    w.collect(4, &atas).unwrap();
    w.start(4).unwrap();

    // The server has vanished. Nobody can touch the vault yet...
    expect_err(w.claim_refund(4, &atas[0]), "RefundNotOpen");
    w.advance_clock(REFUND_DELAY - 1);
    expect_err(w.claim_refund(4, &atas[0]), "RefundNotOpen");

    // ...until the deadline, when every stake goes home.
    w.advance_clock(1);
    for ata in &atas {
        w.claim_refund(4, ata).unwrap();
        assert_eq!(w.balance(ata), 5 * USDC);
    }
    assert_eq!(w.balance(&w.vault_pda(4)), 0);

    // Expiry prevents settlement even after all refunds finish.
    let podium: Vec<(Pubkey, Pubkey)> = players[..3]
        .iter()
        .map(|(kp, ata)| (kp.pubkey(), *ata))
        .collect();
    expect_err(w.settle(4, &podium), "DeadlineExpired");
    w.close_match(4).unwrap();
}

#[test]
fn leaving_costs_nothing_and_revokes_the_approval() {
    let mut w = World::new();
    w.initialize(10).unwrap();
    w.create_match(5, ENTRY).unwrap();
    let (kp, ata) = w.player(USDC);
    w.join(5, &kp, &ata).unwrap();
    assert!(w.delegate(&ata).is_some());
    w.leave(5, &kp, &ata).unwrap();
    assert_eq!(w.delegate(&ata), None);
    assert_eq!(w.balance(&ata), USDC);
    assert!(w.get_match(5).unwrap().players.is_empty());
    expect_err(w.leave(5, &kp, &ata), "NotInMatch");
}

#[test]
fn a_seat_you_cannot_pay_for_is_refused() {
    let mut w = World::new();
    w.initialize(10).unwrap();
    w.create_match(6, ENTRY).unwrap();
    let (kp, ata) = w.player(ENTRY - 1);
    expect_err(w.join(6, &kp, &ata), "InsufficientFunds");
    let (kp2, ata2) = w.player(ENTRY);
    w.join(6, &kp2, &ata2).unwrap();
    expect_err(w.join(6, &kp2, &ata2), "AlreadyJoined");
}

#[test]
fn only_stakers_can_be_paid_and_only_the_fee_wallet_takes_the_fee() {
    let mut w = World::new();
    w.initialize(10).unwrap();
    w.create_match(8, ENTRY).unwrap();
    let players = w.room(8, 10);
    let atas: Vec<Pubkey> = players.iter().map(|(_, a)| *a).collect();
    w.collect(8, &atas).unwrap();

    let podium: Vec<(Pubkey, Pubkey)> = players[..3]
        .iter()
        .map(|(kp, ata)| (kp.pubkey(), *ata))
        .collect();
    // Not started yet.
    expect_err(w.settle(8, &podium), "MatchNotCollected");
    w.start(8).unwrap();

    // A stranger in the ranking is passed over: the program fills the place
    // from the stakers in seat order, so the stranger's account is refused.
    let (stranger, stranger_ata) = w.player(0);
    let mut bad = podium.clone();
    bad[2] = (stranger.pubkey(), stranger_ata);
    expect_err(w.settle(8, &bad), "BadPodium");

    // A wallet named twice in the ranking.
    let mut dup = podium.clone();
    dup[2] = podium[0];
    expect_err(w.settle(8, &dup), "BadRanking");

    // A winner's key with somebody else's token account.
    let mut swapped = podium.clone();
    swapped[1].1 = podium[2].1;
    expect_err(w.settle(8, &swapped), "BadPodium");

    // The fee steered to a token account the fee wallet does not own.
    let rogue_fee = w.token_account(&stranger.pubkey(), 0);
    let a = w.authority.insecure_clone();
    expect_err(w.settle_as(8, &a, &rogue_fee, &podium), "WrongFeeAccount");

    // Somebody who is not the authority.
    let fee = w.fee_ata;
    expect_err(w.settle_as(8, &players[0].0, &fee, &podium), "ConstraintHasOne");

    // Done properly, once, and never again.
    w.settle(8, &podium).unwrap();
    expect_err(w.settle(8, &podium), "MatchNotCollected");
}

#[test]
fn collect_can_run_in_batches() {
    let mut w = World::new();
    w.initialize(10).unwrap();
    w.create_match(9, ENTRY).unwrap();
    let players = w.room(9, 12);
    let atas: Vec<Pubkey> = players.iter().map(|(_, a)| *a).collect();
    w.collect(9, &atas[..5]).unwrap();
    assert_eq!(w.get_match(9).unwrap().collected_count(), 5);
    w.collect(9, &atas[5..]).unwrap();
    assert_eq!(w.get_match(9).unwrap().collected_count(), 12);
    // Replayed candidates cannot collect the same stake twice.
    w.collect(9, &atas[..1]).unwrap();
    assert_eq!(w.balance(&w.vault_pda(9)), 12 * ENTRY);
}

#[test]
fn whoever_was_never_collected_is_dropped_at_start() {
    let mut w = World::new();
    w.initialize(10).unwrap();
    w.create_match(10, ENTRY).unwrap();
    let players = w.room(10, 11);
    let atas: Vec<Pubkey> = players.iter().map(|(_, a)| *a).collect();
    w.collect(10, &atas[..10]).unwrap();
    w.start(10).unwrap();
    let m = w.get_match(10).unwrap();
    assert_eq!(m.players[10].status, PlayerStatus::Dropped);
    assert_eq!(w.balance(&atas[10]), 5 * USDC);
    // And nothing can collect it any more.
    expect_err(w.collect(10, &atas[10..]), "MatchNotOpen");
    expect_err(w.join(10, &players[10].0, &atas[10]), "MatchNotOpen");
}

#[test]
fn config_guards_hold() {
    let mut w = World::new();
    expect_err(
        {
            let ix = w.ix(
                ratpool_escrow::instruction::Initialize {
                    fee_bps: MAX_FEE_BPS + 1,
                    min_players: 10,
                    refund_delay: REFUND_DELAY,
                    admission: w.admission.pubkey(),
                }
                .data(),
                ratpool_escrow::accounts::Initialize {
                    program: w.program_id,
                    program_data: w.program_data(),
                    config: w.config,
                    authority: w.authority.pubkey(),
                    fee_wallet: w.fee_wallet.pubkey(),
                    mint: w.mint,
                    system_program: system_program::ID,
                }
                .to_account_metas(None),
            );
            let a = w.authority.insecure_clone();
            w.send(ix, &[&a])
        },
        "FeeTooHigh",
    );
    w.initialize(10).unwrap();
    expect_err(w.create_match(11, 0), "BadEntry");
}

/// Six real stakes; referral payouts must never change the podium's 95%.
fn six_player_settlement(referrer_count: usize, duplicate: bool, entry: u64) {
    let mut w = World::new();
    w.initialize(6).unwrap();
    w.create_match(20, entry).unwrap();
    let players = w.room(20, 6);
    let atas: Vec<_> = players.iter().map(|(_, a)| *a).collect();
    w.collect(20, &atas).unwrap();
    w.start(20).unwrap();
    let podium: Vec<_> = players[..3].iter().map(|(k, a)| (k.pubkey(), *a)).collect();
    let (r1, a1) = w.player(0);
    let (r2, a2) = w.player(0);
    // Invites on record: the first winner's by r1; the second's by r2, or by
    // r1 again (one referrer, two invited winners: both shares).
    if referrer_count >= 1 {
        w.set_referrer(&players[0].0, r1.pubkey()).unwrap();
    }
    if referrer_count >= 2 {
        w.set_referrer(&players[1].0, if duplicate { r1.pubkey() } else { r2.pubkey() }).unwrap();
    }
    let refs: Vec<Pubkey> = match referrer_count {
        0 => vec![],
        1 => vec![a1],
        _ if duplicate => vec![a1, a1],
        _ => vec![a1, a2],
    };
    let a = w.authority.insecure_clone();
    let fee_ata = w.fee_ata;
    w.settle_with_referrers_as(20, &a, &fee_ata, &podium, &refs).unwrap();
    if entry == USDC {
        assert_eq!(w.balance(&atas[0]), 4_000_000 + 2_850_000);
        assert_eq!(w.balance(&atas[1]), 4_000_000 + 1_710_000);
        assert_eq!(w.balance(&atas[2]), 4_000_000 + 1_140_000);
        assert_eq!(w.balance(&fee_ata), if refs.is_empty() { 300_000 } else { 240_000 });
        assert_eq!(w.balance(&a1), match referrer_count { 0 => 0, 1 => 60_000, _ if duplicate => 60_000, _ => 30_000 });
        assert_eq!(w.balance(&a2), if referrer_count == 2 && !duplicate { 30_000 } else { 0 });
    } else {
        // 6 * 1,000,017 = 6,000,102: fee 300,005, referral total 60,001.
        assert_eq!(w.balance(&a1), 30_000);
        assert_eq!(w.balance(&a2), 30_000);
        assert_eq!(w.balance(&fee_ata), 240_005);
        // net 5,700,097: 30% floors to 1,710,029, 20% to 1,140,019, first takes the rest.
        assert_eq!(w.balance(&atas[0]), 5 * USDC - entry + 2_850_049);
        assert_eq!(w.balance(&atas[1]), 5 * USDC - entry + 1_710_029);
        assert_eq!(w.balance(&atas[2]), 5 * USDC - entry + 1_140_019);
    }
    assert_eq!(w.balance(&w.vault_pda(20)), 0);
    let m = w.get_match(20).unwrap();
    assert_eq!(m.state, MatchState::Settled);
    assert_eq!(m.pool, 0);
    assert!(m.players[..3].iter().all(|p| p.status == PlayerStatus::Paid));
}

#[test]
fn six_stakers_no_referrers() { six_player_settlement(0, false, USDC); }

#[test]
fn one_referrer_receives_one_percent() { six_player_settlement(1, false, USDC); }

#[test]
fn two_referrers_share_one_percent() { six_player_settlement(2, false, USDC); }

#[test]
fn referral_rounding_stays_with_platform() { six_player_settlement(2, false, USDC + 17); }

#[test]
fn duplicate_referrers_receive_both_shares() { six_player_settlement(2, true, USDC); }

#[test]
fn fewer_than_required_winners_are_refused() {
    for count in [2, 6] {
        let mut w = World::new();
        w.initialize(1).unwrap();
        w.create_match(21, USDC).unwrap();
        let players = w.room(21, count);
        let atas: Vec<_> = players.iter().map(|(_, a)| *a).collect();
        w.collect(21, &atas).unwrap();
        w.start(21).unwrap();
        let podium = vec![(players[0].0.pubkey(), atas[0])];
        expect_err(w.settle(21, &podium), "BadPodium");
        assert_eq!(w.balance(&w.vault_pda(21)), count as u64 * USDC);
    }
}

#[test]
fn open_match_fee_is_pinned() {
    let mut w = World::new();
    w.initialize(6).unwrap();
    w.create_match(22, USDC).unwrap();
    w.update_config(Some(1_000), None).unwrap();
    assert_eq!(w.get_match(22).unwrap().fee_bps, 500);
    w.create_match(23, USDC).unwrap();
    assert_eq!(w.get_match(23).unwrap().fee_bps, 1_000);
    let players = w.room(22, 6);
    let atas: Vec<_> = players.iter().map(|(_, a)| *a).collect();
    w.collect(22, &atas).unwrap();
    w.start(22).unwrap();
    let podium: Vec<_> = players[..3].iter().map(|(k, a)| (k.pubkey(), *a)).collect();
    w.settle(22, &podium).unwrap();
    assert_eq!(w.balance(&w.fee_ata), 300_000);
    assert_eq!(w.balance(&atas[0]), 4_000_000 + 2_850_000);
    assert_eq!(w.balance(&atas[1]), 4_000_000 + 1_710_000);
    assert_eq!(w.balance(&atas[2]), 4_000_000 + 1_140_000);
}

#[test]
fn ten_percent_match_settles_with_an_invite_reward() {
    // The deployed setting from 8 October 2026: the platform's 10%, out of
    // which the invite reward (1% of the pool) is paid; the podium shares 90%.
    let mut w = World::new();
    w.initialize(6).unwrap();
    w.update_config(Some(1_000), None).unwrap();
    w.create_match(25, USDC).unwrap();
    assert_eq!(w.get_match(25).unwrap().fee_bps, 1_000);
    let players = w.room(25, 6);
    let atas: Vec<_> = players.iter().map(|(_, a)| *a).collect();
    w.collect(25, &atas).unwrap();
    w.start(25).unwrap();
    let podium: Vec<_> = players[..3].iter().map(|(k, a)| (k.pubkey(), *a)).collect();
    let (r1, a1) = w.player(0);
    w.set_referrer(&players[0].0, r1.pubkey()).unwrap();
    let a = w.authority.insecure_clone();
    let fee_ata = w.fee_ata;
    w.settle_with_referrers_as(25, &a, &fee_ata, &podium, &[a1]).unwrap();
    // 6 USDC: 600,000 fee, 60,000 of it to the inviter; 5,400,000 at 50/30/20.
    assert_eq!(w.balance(&atas[0]), 4_000_000 + 2_700_000);
    assert_eq!(w.balance(&atas[1]), 4_000_000 + 1_620_000);
    assert_eq!(w.balance(&atas[2]), 4_000_000 + 1_080_000);
    assert_eq!(w.balance(&a1), 60_000);
    assert_eq!(w.balance(&fee_ata), 540_000);
    assert_eq!(w.balance(&w.vault_pda(25)), 0);
}

#[test]
fn open_match_refund_deadline_is_pinned_on_first_money() {
    let mut w = World::new();
    w.initialize(6).unwrap();
    w.create_match(24, USDC).unwrap();
    let players = w.room(24, 2);
    w.collect(24, &[]).unwrap();
    assert_eq!(w.get_match(24).unwrap().refund_after, 0);
    w.collect(24, &[players[0].1]).unwrap();
    let deadline = w.get_match(24).unwrap().refund_after;
    assert_eq!(deadline, w.svm.get_sysvar::<Clock>().unix_timestamp + REFUND_DELAY);
    w.update_config(None, Some(MAX_REFUND_DELAY)).unwrap();
    w.advance_clock(REFUND_DELAY - 1);
    w.collect(24, &[players[1].1]).unwrap();
    assert_eq!(w.get_match(24).unwrap().refund_after, deadline);
    expect_err(w.claim_refund(24, &players[0].1), "RefundNotOpen");
    assert_eq!(w.get_match(24).unwrap().state, MatchState::Open);
    w.advance_clock(1);
    for (_, ata) in &players {
        w.claim_refund(24, ata).unwrap();
        assert_eq!(w.balance(ata), 5 * USDC);
        expect_err(w.claim_refund(24, ata), "NotAStaker");
    }
    assert_eq!(w.get_match(24).unwrap().pool, 0);
    w.close_match(24).unwrap();
}

#[test]
fn collect_skips_closed_non_token_malformed_and_wrong_mint_accounts() {
    let mut w = World::new();
    w.initialize(2).unwrap();
    w.create_match(25, USDC).unwrap();
    let players = w.room(25, 6);
    let atas: Vec<_> = players.iter().map(|(_, a)| *a).collect();
    for i in 0..4 {
        let mut acc = w.svm.get_account(&atas[i]).unwrap();
        match i {
            0 => { acc.data.clear(); acc.owner = system_program::ID; acc.lamports = 0; }
            1 => acc.owner = system_program::ID,
            2 => acc.data = vec![0; 10],
            _ => acc.data[..32].copy_from_slice(Pubkey::new_unique().as_ref()),
        }
        w.svm.set_account(atas[i], acc).unwrap();
    }
    w.collect(25, &atas[..4]).unwrap();
    assert_eq!(w.get_match(25).unwrap().refund_after, 0);
    w.collect(25, &atas).unwrap();
    let m = w.get_match(25).unwrap();
    assert_eq!(m.collected_count(), 2);
    assert_eq!(m.pool, 2 * USDC);
    assert!(m.players[..4].iter().all(|p| p.status == PlayerStatus::Dropped));
    w.start(25).unwrap();
    assert!(w.get_match(25).unwrap().players[..4].iter().all(|p| p.status == PlayerStatus::Dropped));
}

#[test]
fn close_sweeps_dust_after_settlement_or_cancelled_refunds() {
    for settle in [true, false] {
        let mut w = World::new();
        w.initialize(1).unwrap();
        w.create_match(26, USDC).unwrap();
        let players = w.room(26, 1);
        w.collect(26, &[players[0].1]).unwrap();
        if settle {
            w.start(26).unwrap();
            w.settle(26, &[(players[0].0.pubkey(), players[0].1)]).unwrap();
        } else {
            w.cancel(26).unwrap();
            expect_err(w.close_match(26), "VaultNotEmpty");
            w.claim_refund(26, &players[0].1).unwrap();
        }
        let before = w.balance(&w.fee_ata);
        let vault = w.vault_pda(26);
        w.set_balance(&vault, 1);
        w.close_match(26).unwrap();
        assert_eq!(w.balance(&w.fee_ata), before + 1);
        assert!(w.get_match(26).is_none());
        assert!(w.svm.get_account(&vault).map_or(true, |a| a.data.is_empty()));
    }
}

#[test]
fn update_config_bounds_refund_delay() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    for delay in [-1, 0, 1, MAX_REFUND_DELAY + 1] {
        expect_err(w.update_config(None, Some(delay)), "BadRefundDelay");
    }
    w.update_config(None, Some(MAX_REFUND_DELAY)).unwrap();
    w.update_config(None, Some(MIN_REFUND_DELAY)).unwrap();
}

#[test]
fn initialize_requires_upgrade_authority() {
    let mut w = World::new();
    let (stranger, _) = w.player(0);
    let ix = w.ix(
        ratpool_escrow::instruction::Initialize {
            fee_bps: FEE_BPS, min_players: 1, refund_delay: REFUND_DELAY,
            admission: w.admission.pubkey(),
        }.data(),
        ratpool_escrow::accounts::Initialize {
            config: w.config, authority: stranger.pubkey(), fee_wallet: w.fee_wallet.pubkey(),
            mint: w.mint, system_program: system_program::ID,
            program: w.program_id, program_data: w.program_data(),
        }.to_account_metas(None),
    );
    expect_err(w.send(ix, &[&stranger]), "ConstraintRaw");
    w.initialize(1).unwrap();
}

#[test]
fn referral_shares_never_exceed_the_fee() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    w.update_config(Some(50), None).unwrap();
    w.create_match(27, USDC).unwrap();
    let players = w.room(27, 1);
    w.collect(27, &[players[0].1]).unwrap();
    w.start(27).unwrap();
    let podium = [(players[0].0.pubkey(), players[0].1)];
    let (r, ata) = w.player(0);
    w.set_referrer(&players[0].0, r.pubkey()).unwrap();
    let a = w.authority.insecure_clone();
    let fee = w.fee_ata;
    expect_err(w.settle_with_referrers_as(27, &a, &fee, &podium, &[ata; 2]), "BadReferral");
    assert_eq!(w.balance(&w.vault_pda(27)), USDC);
    // A 0.5% fee, under the 1% share: the referrer gets the whole fee and no
    // more; the winner's 99.5% is untouched.
    w.settle_with_referrers_as(27, &a, &fee, &podium, &[ata]).unwrap();
    assert_eq!(w.balance(&ata), 5_000);
    assert_eq!(w.balance(&fee), 0);
    assert_eq!(w.balance(&players[0].1), 5 * USDC - USDC + 995_000);
}

#[test]
fn referral_destinations_must_match_owner_and_mint() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    w.create_match(28, USDC).unwrap();
    let players = w.room(28, 1);
    w.collect(28, &[players[0].1]).unwrap();
    w.start(28).unwrap();
    let podium = [(players[0].0.pubkey(), players[0].1)];
    let (r, ata) = w.player(0);
    w.set_referrer(&players[0].0, r.pubkey()).unwrap();
    let a = w.authority.insecure_clone();
    let fee = w.fee_ata;
    // Paid only to an account the recorded referrer owns.
    expect_err(w.settle_with_referrers_as(28, &a, &fee, &podium,
        &[players[0].1]), "BadReferral");
    let mut acc = w.svm.get_account(&ata).unwrap();
    acc.data[..32].copy_from_slice(Pubkey::new_unique().as_ref());
    w.svm.set_account(ata, acc).unwrap();
    expect_err(w.settle_with_referrers_as(28, &a, &fee, &podium,
        &[ata]), "WrongMint");
    assert_eq!(w.balance(&fee), 0);
    assert_eq!(w.balance(&w.vault_pda(28)), USDC);
    assert_eq!(w.get_match(28).unwrap().state, MatchState::Collected);
}

#[test]
fn close_cannot_redirect_dust() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    w.create_match(29, USDC).unwrap();
    w.cancel(29).unwrap();
    let vault = w.vault_pda(29);
    w.set_balance(&vault, 1);
    let (_, rogue_fee) = w.player(0);
    let fee = w.fee_ata;
    w.fee_ata = rogue_fee;
    expect_err(w.close_match(29), "WrongFeeAccount");
    assert_eq!(w.balance(&vault), 1);
    assert!(w.get_match(29).is_some());
    w.fee_ata = fee;
    w.close_match(29).unwrap();
    assert_eq!(w.balance(&fee), 1);
}

#[test]
fn late_settle_cannot_preempt_refunds() {
    let mut w = World::new();
    w.initialize(3).unwrap();
    w.create_match(30, ENTRY).unwrap();
    let players = w.room(30, 3);
    let atas: Vec<_> = players.iter().map(|(_, a)| *a).collect();
    w.collect(30, &atas).unwrap();
    w.start(30).unwrap();
    w.advance_clock(REFUND_DELAY + 1);
    let podium: Vec<_> = players.iter().map(|(k, a)| (k.pubkey(), *a)).collect();
    expect_err(w.settle(30, &podium), "DeadlineExpired");
    assert_eq!(w.get_match(30).unwrap().pool, 3 * ENTRY);
    assert_eq!(w.balance(&w.fee_ata), 0);
    for ata in &atas {
        w.claim_refund(30, ata).unwrap();
        assert_eq!(w.balance(ata), 5 * USDC);
    }
    assert_eq!(w.balance(&w.vault_pda(30)), 0);
}

#[test]
fn partial_refund_cannot_enable_late_pool_repricing() {
    let mut w = World::new();
    w.initialize(6).unwrap();
    w.create_match(31, ENTRY).unwrap();
    let players = w.room(31, 6);
    let atas: Vec<_> = players.iter().map(|(_, a)| *a).collect();
    w.collect(31, &atas).unwrap();
    w.start(31).unwrap();
    w.advance_clock(REFUND_DELAY);
    w.claim_refund(31, &atas[0]).unwrap();
    let podium: Vec<_> = players[1..4].iter().map(|(k, a)| (k.pubkey(), *a)).collect();
    expect_err(w.settle(31, &podium), "DeadlineExpired");
    assert_eq!(w.get_match(31).unwrap().pool, 5 * ENTRY);
    assert_eq!(w.balance(&w.fee_ata), 0);
    for ata in &atas[1..] {
        w.claim_refund(31, ata).unwrap();
        assert_eq!(w.balance(ata), 5 * USDC);
    }
}

#[test]
fn collect_and_start_refuse_the_exact_refund_boundary_and_later() {
    for delay in [REFUND_DELAY, REFUND_DELAY + 1] {
        let mut w = World::new();
        w.initialize(1).unwrap();
        w.create_match(32, ENTRY).unwrap();
        let players = w.room(32, 2);
        w.collect(32, &[players[0].1]).unwrap();
        w.advance_clock(delay);
        expect_err(w.collect(32, &[players[1].1]), "DeadlineExpired");
        expect_err(w.collect(32, &[]), "DeadlineExpired");
        expect_err(w.start(32), "DeadlineExpired");
        assert_eq!(w.get_match(32).unwrap().state, MatchState::Open);
        assert_eq!(w.get_match(32).unwrap().pool, ENTRY);
        assert_eq!(w.balance(&players[1].1), 5 * USDC);
        w.claim_refund(32, &players[0].1).unwrap();
    }
}

#[test]
fn settle_is_allowed_one_second_before_the_refund_boundary() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    w.create_match(33, ENTRY).unwrap();
    let players = w.room(33, 1);
    w.collect(33, &[players[0].1]).unwrap();
    // Started two seconds before the boundary; paid in the last second
    // (a payout never comes in the second its match started).
    w.advance_clock(REFUND_DELAY - 2);
    w.start(33).unwrap();
    w.advance_clock(1);
    expect_err(w.claim_refund(33, &players[0].1), "RefundNotOpen");
    w.settle(33, &[(players[0].0.pubkey(), players[0].1)]).unwrap();
    assert_eq!(w.get_match(33).unwrap().state, MatchState::Settled);
}

#[test]
fn fee_wallet_updates_do_not_redirect_existing_match_fees() {
    let mut w = World::new();
    w.initialize(3).unwrap();
    w.create_match(34, ENTRY).unwrap();
    let players = w.room(34, 3);
    let atas: Vec<_> = players.iter().map(|(_, a)| *a).collect();
    w.collect(34, &atas).unwrap();
    w.start(34).unwrap();
    let (next_fee, next_ata) = w.player(0);
    w.update_terms(None, None, Some(next_fee.pubkey()), None).unwrap();
    let podium: Vec<_> = players.iter().map(|(k, a)| (k.pubkey(), *a)).collect();
    let a = w.authority.insecure_clone();
    expect_err(w.settle_as(34, &a, &next_ata, &podium), "WrongFeeAccount");
    w.settle(34, &podium).unwrap();
    assert_eq!(w.balance(&w.fee_ata), 3 * ENTRY / 20);
    assert_eq!(w.balance(&next_ata), 0);
    assert_eq!(w.get_match(34).unwrap().fee_wallet, w.fee_wallet.pubkey());
    w.create_match(35, ENTRY).unwrap();
    assert_eq!(w.get_match(35).unwrap().fee_wallet, next_fee.pubkey());
}

#[test]
fn close_uses_the_match_fee_wallet_after_config_changes() {
    for settled in [true, false] {
        let mut w = World::new();
        w.initialize(1).unwrap();
        w.create_match(36, ENTRY).unwrap();
        if settled {
            let players = w.room(36, 1);
            w.collect(36, &[players[0].1]).unwrap();
            w.start(36).unwrap();
            w.settle(36, &[(players[0].0.pubkey(), players[0].1)]).unwrap();
        } else {
            w.cancel(36).unwrap();
        }
        let (next_fee, next_ata) = w.player(0);
        w.update_terms(None, None, Some(next_fee.pubkey()), None).unwrap();
        let old_fee = w.fee_ata;
        let before = w.balance(&old_fee);
        let vault = w.vault_pda(36);
        w.set_balance(&vault, 1);
        w.fee_ata = next_ata;
        expect_err(w.close_match(36), "WrongFeeAccount");
        assert_eq!(w.balance(&vault), 1);
        w.fee_ata = old_fee;
        w.close_match(36).unwrap();
        assert_eq!(w.balance(&old_fee), before + 1);
        assert_eq!(w.balance(&next_ata), 0);
    }
}

#[test]
fn non_staker_referrals_remain_bounded_by_the_fee() {
    let mut w = World::new();
    w.initialize(3).unwrap();
    w.create_match(37, ENTRY).unwrap();
    let players = w.room(37, 3);
    let atas: Vec<_> = players.iter().map(|(_, a)| *a).collect();
    w.collect(37, &atas).unwrap();
    w.start(37).unwrap();
    let (outsider, outsider_ata) = w.player(0);
    let podium: Vec<_> = players.iter().map(|(k, a)| (k.pubkey(), *a)).collect();
    w.set_referrer(&players[0].0, outsider.pubkey()).unwrap();
    let a = w.authority.insecure_clone();
    let fee = w.fee_ata;
    w.settle_with_referrers_as(37, &a, &fee, &podium, &[outsider_ata]).unwrap();
    assert_eq!(w.balance(&outsider_ata), 3 * ENTRY / 100);
    assert_eq!(w.balance(&fee) + w.balance(&outsider_ata), 3 * ENTRY / 20);
    let payouts: u64 = atas.iter().map(|ata| w.balance(ata) - (5 * USDC - ENTRY)).sum();
    assert_eq!(payouts, 3 * ENTRY * 95 / 100);
}

#[test]
fn minimum_and_refund_delay_are_pinned_before_any_collection() {
    let mut w = World::new();
    w.initialize(6).unwrap();
    w.create_match(38, ENTRY).unwrap();
    let players = w.room(38, 1);
    w.update_terms(Some(1), Some(MAX_REFUND_DELAY), None, None).unwrap();
    assert_eq!(w.get_match(38).unwrap().min_players, 6);
    assert_eq!(w.get_match(38).unwrap().refund_delay, REFUND_DELAY);
    w.collect(38, &[players[0].1]).unwrap();
    expect_err(w.start(38), "TooFewPlayers");
    assert_eq!(w.get_match(38).unwrap().refund_after, w.svm.get_sysvar::<Clock>().unix_timestamp + REFUND_DELAY);
    w.create_match(39, ENTRY).unwrap();
    assert_eq!(w.get_match(39).unwrap().min_players, 1);
    assert_eq!(w.get_match(39).unwrap().refund_delay, MAX_REFUND_DELAY);
    let future_players = w.room(39, 1);
    w.collect(39, &[future_players[0].1]).unwrap();
    w.start(39).unwrap();
    assert_eq!(w.get_match(39).unwrap().refund_after, w.svm.get_sysvar::<Clock>().unix_timestamp + MAX_REFUND_DELAY);
    w.advance_clock(REFUND_DELAY);
    w.claim_refund(38, &players[0].1).unwrap();
    assert_eq!(w.balance(&players[0].1), 5 * USDC);
}

#[test]
fn authority_can_collect_a_batch_below_minimum_but_cannot_start_it() {
    let mut w = World::new();
    w.initialize(6).unwrap();
    w.create_match(40, ENTRY).unwrap();
    let players = w.room(40, 1);
    w.collect(40, &[players[0].1]).unwrap();
    assert_eq!(w.balance(&players[0].1), 5 * USDC - ENTRY);
    expect_err(w.start(40), "TooFewPlayers");
    w.cancel(40).unwrap();
    w.claim_refund(40, &players[0].1).unwrap();
    assert_eq!(w.balance(&players[0].1), 5 * USDC);
}

#[test]
fn owner_change_and_reapproval_drop_only_the_poisoned_source() {
    let mut w = World::new();
    w.initialize(2).unwrap();
    w.create_match(41, ENTRY).unwrap();
    let associated_program = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL".parse::<Pubkey>().unwrap();
    let mut players = Vec::new();
    for _ in 0..2 {
        let (player, source) = w.player(5 * USDC);
        let canonical = Pubkey::find_program_address(&[player.pubkey().as_ref(), TOKEN_PROGRAM.as_ref(), w.mint.as_ref()], &associated_program).0;
        w.svm.set_account(canonical, w.svm.get_account(&source).unwrap()).unwrap();
        w.join(41, &player, &canonical).unwrap();
        players.push((player, canonical));
    }
    let (next_owner, _) = w.player(0);
    let poisoned = players[1].1;
    change_owner(&mut w, poisoned, next_owner.pubkey(), &players[1].0);
    assert_eq!(w.delegate(&poisoned), None);
    let match_key = w.match_pda(41);
    approve(&mut w, poisoned, match_key, ENTRY, &next_owner);
    assert_eq!(w.delegate(&poisoned), Some((match_key, ENTRY)));
    w.collect(41, &[players[0].1, poisoned]).unwrap();
    let m = w.get_match(41).unwrap();
    assert_eq!(m.players[0].status, PlayerStatus::Collected);
    assert_eq!(m.players[1].status, PlayerStatus::Dropped);
    assert_eq!(m.pool, ENTRY);
    assert_eq!(w.balance(&players[0].1), 5 * USDC - ENTRY);
    assert_eq!(w.balance(&poisoned), 5 * USDC);
    expect_err(w.start(41), "TooFewPlayers");
    w.cancel(41).unwrap();
    w.claim_refund(41, &players[0].1).unwrap();
}

#[test]
fn fifty_outsider_joins_without_admission_cannot_fill_the_room() {
    let mut w = World::new();
    w.initialize(6).unwrap();
    w.create_match(42, ENTRY).unwrap();
    let attackers: Vec<_> = (0..MAX_PLAYERS).map(|i| w.player(if i == 0 { ENTRY } else { 0 })).collect();
    for i in 0..attackers.len() {
        expect_err(w.join_without_admission(42, &attackers[i].0, &attackers[i].1), "AccountNotSigner");
        if i + 1 < attackers.len() {
            transfer(&mut w, attackers[i].1, attackers[i + 1].1, ENTRY, &attackers[i].0);
        }
    }
    assert!(w.get_match(42).unwrap().players.is_empty());
    assert_eq!(attackers.iter().map(|(_, a)| w.balance(a)).sum::<u64>(), ENTRY);
    let (honest, honest_ata) = w.player(ENTRY);
    w.join(42, &honest, &honest_ata).unwrap();
    assert_eq!(w.get_match(42).unwrap().players.len(), 1);
    assert_eq!(w.balance(&w.vault_pda(42)), 0);
}

#[test]
fn leaving_first_match_preserves_the_second_match_approval() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    w.create_match(43, ENTRY).unwrap();
    w.create_match(44, ENTRY).unwrap();
    let (player, ata) = w.player(USDC);
    w.join(43, &player, &ata).unwrap();
    w.join(44, &player, &ata).unwrap();
    let second = w.match_pda(44);
    assert_eq!(w.delegate(&ata), Some((second, ENTRY)));
    w.leave(43, &player, &ata).unwrap();
    assert_eq!(w.delegate(&ata), Some((second, ENTRY)));
    w.collect(44, &[ata]).unwrap();
    assert_eq!(w.get_match(44).unwrap().players[0].status, PlayerStatus::Collected);
    assert_eq!(w.balance(&ata), USDC - ENTRY);
}

#[test]
fn stale_delegate_cannot_spend_a_reused_id_without_fresh_join() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    w.create_match(45, ENTRY).unwrap();
    let (player, ata) = w.player(USDC);
    w.join(45, &player, &ata).unwrap();
    w.cancel(45).unwrap();
    w.close_match(45).unwrap();
    assert_eq!(w.delegate(&ata), Some((w.match_pda(45), ENTRY)));
    w.create_match(45, ENTRY).unwrap();
    w.collect(45, &[ata]).unwrap();
    assert_eq!(w.get_match(45).unwrap().pool, 0);
    assert_eq!(w.balance(&ata), USDC);
    w.join(45, &player, &ata).unwrap();
    w.collect(45, &[ata]).unwrap();
    assert_eq!(w.balance(&ata), USDC - ENTRY);
}

#[test]
fn refunds_enforce_owner_and_exactly_one_payment() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    w.create_match(46, ENTRY).unwrap();
    let players = w.room(46, 1);
    w.collect(46, &[players[0].1]).unwrap();
    w.cancel(46).unwrap();
    let (_, rogue_ata) = w.player(0);
    expect_err(w.claim_refund(46, &rogue_ata), "NotAStaker");
    let alternate = w.token_account(&players[0].0.pubkey(), 0);
    w.claim_refund(46, &alternate).unwrap();
    assert_eq!(w.balance(&alternate), ENTRY);
    expect_err(w.claim_refund(46, &players[0].1), "NotAStaker");
    assert_eq!(w.balance(&w.vault_pda(46)), 0);
}

#[test]
fn duplicate_collect_candidates_transfer_the_entry_exactly_once() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    w.create_match(47, ENTRY).unwrap();
    let players = w.room(47, 1);
    w.collect(47, &[players[0].1, players[0].1]).unwrap();
    assert_eq!(w.balance(&players[0].1), 5 * USDC - ENTRY);
    assert_eq!(w.get_match(47).unwrap().pool, ENTRY);
    assert_eq!(w.get_match(47).unwrap().collected_count(), 1);
}

#[test]
fn wrong_match_and_vault_substitution_are_rejected() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    w.create_match(48, ENTRY).unwrap();
    w.create_match(49, ENTRY).unwrap();
    let (player, ata) = w.player(USDC);
    let mut metas = w.join_metas(48, &player.pubkey(), &ata);
    let index = metas.iter().position(|m| m.pubkey == w.match_pda(48)).unwrap();
    metas[index].pubkey = w.match_pda(49);
    let ix = w.ix(ratpool_escrow::instruction::Join { id: 48 }.data(), metas);
    let admission = w.admission.insecure_clone();
    expect_err(w.send(ix, &[&admission, &player]), "ConstraintSeeds");
    w.join(48, &player, &ata).unwrap();
    let mut metas = ratpool_escrow::accounts::Collect {
        config: w.config, match_account: w.match_pda(48), vault: w.vault_pda(49),
        mint: w.mint, authority: w.authority.pubkey(), token_program: TOKEN_PROGRAM,
    }.to_account_metas(None);
    metas.push(AccountMeta::new(ata, false));
    let ix = w.ix(ratpool_escrow::instruction::Collect { id: 48 }.data(), metas);
    let a = w.authority.insecure_clone();
    expect_err(w.send(ix, &[&a]), "ConstraintSeeds");
    assert_eq!(w.balance(&ata), USDC);
}

#[test]
fn non_authority_lifecycle_instructions_are_rejected() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    w.create_match(50, ENTRY).unwrap();
    let (attacker, ata) = w.player(USDC);
    let ix = w.ix(
        ratpool_escrow::instruction::CreateMatch { id: 51, entry: ENTRY }.data(),
        ratpool_escrow::accounts::CreateMatch {
            config: w.config, match_account: w.match_pda(51), vault: w.vault_pda(51),
            mint: w.mint, authority: attacker.pubkey(), token_program: TOKEN_PROGRAM,
            system_program: system_program::ID,
        }.to_account_metas(None),
    );
    expect_err(w.send(ix, &[&attacker]), "ConstraintHasOne");
    w.join(50, &attacker, &ata).unwrap();
    let mut metas = ratpool_escrow::accounts::Collect {
        config: w.config, match_account: w.match_pda(50), vault: w.vault_pda(50),
        mint: w.mint, authority: attacker.pubkey(), token_program: TOKEN_PROGRAM,
    }.to_account_metas(None);
    metas.push(AccountMeta::new(ata, false));
    let ix = w.ix(ratpool_escrow::instruction::Collect { id: 50 }.data(), metas);
    expect_err(w.send(ix, &[&attacker]), "ConstraintHasOne");
    for data in [ratpool_escrow::instruction::Start { id: 50 }.data(), ratpool_escrow::instruction::Cancel { id: 50 }.data()] {
        let ix = w.ix(data, w.authority_only(50, &attacker.pubkey()));
        expect_err(w.send(ix, &[&attacker]), "ConstraintHasOne");
    }
    w.cancel(50).unwrap();
    let ix = w.ix(
        ratpool_escrow::instruction::CloseMatch { id: 50 }.data(),
        ratpool_escrow::accounts::CloseMatch {
            config: w.config, match_account: w.match_pda(50), vault: w.vault_pda(50),
            mint: w.mint, fee_ata: w.fee_ata, authority: attacker.pubkey(), token_program: TOKEN_PROGRAM,
        }.to_account_metas(None),
    );
    expect_err(w.send(ix, &[&attacker]), "ConstraintHasOne");
    assert_eq!(w.balance(&ata), USDC);
}

#[test]
fn eviction_frees_a_full_room_seat_without_touching_tokens() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    w.create_match(52, ENTRY).unwrap();
    let players = w.room(52, MAX_PLAYERS as usize);
    let (replacement, replacement_ata) = w.player(ENTRY);
    expect_err(w.join(52, &replacement, &replacement_ata), "MatchFull");
    w.evict(52, players[0].0.pubkey()).unwrap();
    w.expect_event(ratpool_escrow::events::PlayerEvicted {
        id: 52, player: players[0].0.pubkey(), seats: MAX_PLAYERS - 1,
    });
    assert_eq!(w.get_match(52).unwrap().players.len(), MAX_PLAYERS as usize - 1);
    assert_eq!(w.balance(&players[0].1), 5 * USDC);
    assert_eq!(w.delegate(&players[0].1), Some((w.match_pda(52), ENTRY)));
    w.join(52, &replacement, &replacement_ata).unwrap();
    assert_eq!(w.get_match(52).unwrap().players.len(), MAX_PLAYERS as usize);
    w.collect(52, &[players[0].1, replacement_ata]).unwrap();
    assert_eq!(w.balance(&players[0].1), 5 * USDC);
    assert_eq!(w.get_match(52).unwrap().pool, ENTRY);
}

#[test]
fn eviction_requires_authority_open_state_and_a_joined_seat() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    w.create_match(53, ENTRY).unwrap();
    let players = w.room(53, 3);
    expect_err(w.evict_as(53, players[1].0.pubkey(), &players[0].0), "ConstraintHasOne");
    expect_err(w.evict(53, Pubkey::new_unique()), "NotInMatch");
    w.collect(53, &[players[0].1]).unwrap();
    expect_err(w.evict(53, players[0].0.pubkey()), "CannotEvict");
    w.set_balance(&players[1].1, 0);
    w.collect(53, &[players[1].1]).unwrap();
    expect_err(w.evict(53, players[1].0.pubkey()), "CannotEvict");
    assert_eq!(w.get_match(53).unwrap().pool, ENTRY);
    assert_eq!(w.get_match(53).unwrap().players.len(), 3);
    w.start(53).unwrap();
    expect_err(w.evict(53, players[2].0.pubkey()), "MatchNotOpen");
    assert_eq!(w.get_match(53).unwrap().pool, ENTRY);
}

#[test]
fn collection_binds_the_joined_account_address_not_just_its_owner() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    w.create_match(54, ENTRY).unwrap();
    let players = w.room(54, 2);
    let alternate = w.token_account(&players[0].0.pubkey(), USDC);
    let (outsider, outsider_ata) = w.player(USDC);
    let match_key = w.match_pda(54);
    approve(&mut w, alternate, match_key, ENTRY, &players[0].0);
    approve(&mut w, outsider_ata, match_key, ENTRY, &outsider);
    w.collect(54, &[alternate, outsider_ata, players[1].1]).unwrap();
    let m = w.get_match(54).unwrap();
    assert_eq!(m.players[0].token_account, players[0].1);
    assert_eq!(m.players[0].status, PlayerStatus::Joined);
    assert_eq!(m.players[1].status, PlayerStatus::Collected);
    assert_eq!(m.pool, ENTRY);
    assert_eq!(w.balance(&alternate), USDC);
    assert_eq!(w.balance(&outsider_ata), USDC);
    w.collect(54, &[players[0].1]).unwrap();
    assert_eq!(w.get_match(54).unwrap().pool, 2 * ENTRY);
}

#[test]
fn frozen_and_uncovered_sources_are_dropped_in_an_honest_batch() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    w.create_match(55, ENTRY).unwrap();
    let players = w.room(55, 6);
    for (i, (_, ata)) in players[..5].iter().enumerate() {
        let mut acc = w.svm.get_account(ata).unwrap();
        match i {
            0 => acc.data[108] = 2, // Frozen
            1 => acc.data[72..76].copy_from_slice(&0u32.to_le_bytes()),
            2 => acc.data[121..129].copy_from_slice(&(ENTRY - 1).to_le_bytes()),
            3 => acc.data[76..108].copy_from_slice(Pubkey::new_unique().as_ref()),
            _ => acc.data[108] = 0, // Uninitialized
        }
        w.svm.set_account(*ata, acc).unwrap();
    }
    let atas: Vec<_> = players.iter().map(|(_, a)| *a).collect();
    w.collect(55, &atas).unwrap();
    let m = w.get_match(55).unwrap();
    assert!(m.players[..5].iter().all(|p| p.status == PlayerStatus::Dropped));
    assert_eq!(m.players[5].status, PlayerStatus::Collected);
    assert_eq!(m.pool, ENTRY);
    assert_eq!(w.balance(&players[5].1), 5 * USDC - ENTRY);
    for ata in &atas[..5] {
        assert_eq!(w.balance(ata), 5 * USDC);
    }
}

#[test]
fn read_only_source_is_dropped_without_aborting_the_batch() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    w.create_match(56, ENTRY).unwrap();
    let players = w.room(56, 2);
    let mut metas = ratpool_escrow::accounts::Collect {
        config: w.config, match_account: w.match_pda(56), vault: w.vault_pda(56),
        mint: w.mint, authority: w.authority.pubkey(), token_program: TOKEN_PROGRAM,
    }.to_account_metas(None);
    metas.push(AccountMeta::new_readonly(players[0].1, false));
    metas.push(AccountMeta::new(players[1].1, false));
    let ix = w.ix(ratpool_escrow::instruction::Collect { id: 56 }.data(), metas);
    let a = w.authority.insecure_clone();
    w.send(ix, &[&a]).unwrap();
    let m = w.get_match(56).unwrap();
    assert_eq!(m.players[0].status, PlayerStatus::Dropped);
    assert_eq!(m.players[1].status, PlayerStatus::Collected);
    assert_eq!(m.pool, ENTRY);
}

#[test]
fn admission_rotation_is_enforced_and_emits_the_new_config() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    w.expect_event(ratpool_escrow::events::ConfigInitialized {
        authority: w.authority.pubkey(), admission: w.admission.pubkey(), fee_wallet: w.fee_wallet.pubkey(),
        mint: w.mint, fee_bps: FEE_BPS, min_players: 1, refund_delay: REFUND_DELAY,
    });
    w.create_match(57, ENTRY).unwrap();
    let (player, ata) = w.player(USDC);
    let (next_admission, _) = w.player(0);
    let mut wrong = w.join_metas(57, &player.pubkey(), &ata);
    wrong.iter_mut().find(|m| m.pubkey == w.admission.pubkey()).unwrap().pubkey = next_admission.pubkey();
    let ix = w.ix(ratpool_escrow::instruction::Join { id: 57 }.data(), wrong);
    expect_err(w.send(ix, &[&next_admission, &player]), "WrongAdmission");
    let previous_authority = w.authority.pubkey();
    w.update_terms(None, None, None, Some(next_admission.pubkey())).unwrap();
    w.expect_event(ratpool_escrow::events::ConfigUpdated {
        authority: previous_authority, admission: next_admission.pubkey(), fee_wallet: w.fee_wallet.pubkey(),
        fee_bps: FEE_BPS, min_players: 1, refund_delay: REFUND_DELAY,
    });
    assert_eq!(w.get_config().authority, previous_authority);
    expect_err(w.join(57, &player, &ata), "WrongAdmission");
    w.admission = next_admission;
    w.join(57, &player, &ata).unwrap();
    assert_eq!(w.get_match(57).unwrap().players[0].key, player.pubkey());
}

#[test]
fn authority_rotation_requires_proposal_and_the_pending_signature() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    let old = w.authority.insecure_clone();
    let (next, _) = w.player(0);
    let (stranger, _) = w.player(0);
    expect_err(w.accept_as(&next), "WrongPendingAuthority");
    expect_err(w.propose_as(next.pubkey(), &stranger), "NotUpgradeAuthority");
    expect_err(w.propose_as(Pubkey::default(), &old), "InvalidAuthority");
    expect_err(w.propose_as(old.pubkey(), &old), "InvalidAuthority");
    w.propose_as(next.pubkey(), &old).unwrap();
    w.expect_event(ratpool_escrow::events::AuthorityProposed {
        authority: old.pubkey(), pending_authority: next.pubkey(),
    });
    assert_eq!(w.get_config().authority, old.pubkey());
    assert_eq!(w.get_config().pending_authority, Some(next.pubkey()));
    let mut unsigned = ratpool_escrow::accounts::AcceptAuthority {
        config: w.config, pending_authority: next.pubkey(),
    }.to_account_metas(None);
    unsigned.iter_mut().find(|m| m.pubkey == next.pubkey()).unwrap().is_signer = false;
    let ix = w.ix(ratpool_escrow::instruction::AcceptAuthority {}.data(), unsigned);
    expect_err(w.send(ix, &[&old]), "AccountNotSigner");
    w.authority = next.insecure_clone();
    expect_err(w.create_match(58, ENTRY), "ConstraintHasOne");
    w.authority = old.insecure_clone();
    w.create_match(58, ENTRY).unwrap();
    expect_err(w.accept_as(&stranger), "WrongPendingAuthority");
    expect_err(w.accept_as(&old), "WrongPendingAuthority");
    w.accept_as(&next).unwrap();
    w.expect_event(ratpool_escrow::events::AuthorityAccepted {
        previous_authority: old.pubkey(), authority: next.pubkey(),
    });
    assert_eq!(w.get_config().authority, next.pubkey());
    assert_eq!(w.get_config().pending_authority, None);
    expect_err(w.create_match(59, ENTRY), "ConstraintHasOne");
    expect_err(w.accept_as(&next), "WrongPendingAuthority");
    w.authority = next.insecure_clone();
    w.create_match(59, ENTRY).unwrap();
    // The new payout key runs matches, never the config or its own succession.
    w.admin = next.insecure_clone();
    expect_err(w.update_config(None, Some(2)), "NotUpgradeAuthority");
    expect_err(w.propose_as(stranger.pubkey(), &next), "NotUpgradeAuthority");
    w.admin = old.insecure_clone();
    w.update_config(None, Some(2)).unwrap();
    w.cancel(58).unwrap();
}

#[test]
fn leave_needs_only_the_player_and_the_recorded_source() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    w.create_match(60, ENTRY).unwrap();
    let (player, ata) = w.player(USDC);
    w.join(60, &player, &ata).unwrap();
    let alternate = w.token_account(&player.pubkey(), USDC);
    expect_err(w.leave(60, &player, &alternate), "WrongTokenAccount");
    assert_eq!(w.get_match(60).unwrap().players.len(), 1);
    assert_eq!(w.delegate(&ata), Some((w.match_pda(60), ENTRY)));
    w.leave(60, &player, &ata).unwrap();
    assert!(w.get_match(60).unwrap().players.is_empty());
    assert_eq!(w.delegate(&ata), None);
    assert_eq!(w.balance(&ata), USDC);
}

#[test]
fn v2_seeds_isolate_legacy_config_and_match_accounts() {
    let mut w = World::new();
    assert_eq!(CONFIG_SEED, b"config_v2");
    assert_eq!(MATCH_SEED, b"match_v2");
    let legacy_config = Pubkey::find_program_address(&[b"config"], &w.program_id).0;
    let legacy_match = Pubkey::find_program_address(&[b"match".as_ref(), &61u64.to_le_bytes()], &w.program_id).0;
    assert_ne!(w.config, legacy_config);
    assert_ne!(w.match_pda(61), legacy_match);
    w.initialize(1).unwrap();
    w.create_match(61, ENTRY).unwrap();
    let legacy_vault = Pubkey::find_program_address(&[VAULT_SEED, legacy_match.as_ref()], &w.program_id).0;
    assert_ne!(w.vault_pda(61), legacy_vault);
    let (player, ata) = w.player(USDC);
    // Valid typed data at legacy addresses still cannot satisfy v2 seeds.
    w.svm.set_account(legacy_config, w.svm.get_account(&w.config).unwrap()).unwrap();
    w.svm.set_account(legacy_match, w.svm.get_account(&w.match_pda(61)).unwrap()).unwrap();
    let admission = w.admission.insecure_clone();
    for (expected, replacement) in [(w.config, legacy_config), (w.match_pda(61), legacy_match)] {
        let mut metas = w.join_metas(61, &player.pubkey(), &ata);
        metas.iter_mut().find(|m| m.pubkey == expected).unwrap().pubkey = replacement;
        let ix = w.ix(ratpool_escrow::instruction::Join { id: 61 }.data(), metas);
        expect_err(w.send(ix, &[&admission, &player]), "ConstraintSeeds");
    }
    assert!(w.get_match(61).unwrap().players.is_empty());
    assert_eq!(w.balance(&ata), USDC);
}

// ------------------------------------------------------------ signed payouts (2026-10-08)

const COMPUTE_BUDGET: Pubkey = solana_sdk_ids::compute_budget::ID;

/// SetComputeUnitLimit(400,000), as the site puts first in a payout.
fn compute_limit() -> Instruction {
    let mut d = vec![2u8];
    d.extend_from_slice(&400_000u32.to_le_bytes());
    Instruction::new_with_bytes(COMPUTE_BUDGET, &d, vec![])
}

/// A collected, started match of `n` stakers at 1 USDC.
fn started(w: &mut World, id: u64, n: usize) -> Vec<(Keypair, Pubkey)> {
    w.create_match(id, USDC).unwrap();
    let players = w.room(id, n);
    let atas: Vec<_> = players.iter().map(|(_, a)| *a).collect();
    w.collect(id, &atas).unwrap();
    w.start(id).unwrap();
    // A match is played before it is paid: never in the second it started.
    w.advance_clock(1);
    players
}

#[test]
fn a_payout_needs_the_room_servers_signature_on_its_ranking() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    let players = started(&mut w, 70, 6);
    let ranking: Vec<Pubkey> = players[..3].iter().map(|(k, _)| k.pubkey()).collect();
    let pay: Vec<Pubkey> = players[..3].iter().map(|(_, a)| *a).collect();
    let a = w.authority.insecure_clone();
    let room = w.room.insecure_clone();
    let fee = w.fee_ata;
    let settle = w.settle_signed_ix(70, &a.pubkey(), &fee, &pay, &[]);
    let msg = w.settle_message(70, &ranking);

    // No signature check at all.
    expect_err(w.send_all(&[settle.clone()], &[&a]), "MissingRoomSignature");
    // Signed, but by a key that is not the room's: the payout key's own.
    expect_err(w.send_all(&[ed25519_ix(&a, &msg), settle.clone()], &[&a]), "BadRoomSignature");
    // The room signed another order: the podium follows it, and accounts
    // in any other order are refused.
    let mut other = ranking.clone();
    other.swap(0, 2);
    let other_msg = w.settle_message(70, &other);
    expect_err(w.send_all(&[ed25519_ix(&room, &other_msg), settle.clone()], &[&a]), "BadPodium");
    // A signed message that is not a settlement.
    expect_err(w.send_all(&[ed25519_ix(&room, b"hello"), settle.clone()], &[&a]), "BadRoomSignature");
    // The room's signature for another match.
    let elsewhere = w.settle_message(71, &ranking);
    expect_err(w.send_all(&[ed25519_ix(&room, &elsewhere), settle.clone()], &[&a]), "BadRoomSignature");
    // The right bytes under a forged signature: the precompile refuses it.
    let forged = ed25519_ix_with(room.pubkey(), &[7u8; 64], &msg, u16::MAX);
    assert!(w.send_all(&[forged, settle.clone()], &[&a]).is_err());
    // Key, signature and message read from another instruction.
    let pointing = ed25519_ix_with(room.pubkey(), room.sign_message(&msg).as_ref(), &msg, 1);
    assert!(w.send_all(&[pointing, settle.clone()], &[&a]).is_err());
    // The check must come straight before the payout.
    expect_err(
        w.send_all(&[ed25519_ix(&room, &msg), compute_limit(), settle.clone()], &[&a]),
        "MissingRoomSignature",
    );
    assert_eq!(w.balance(&w.vault_pda(70)), 6 * USDC);

    // Signed by the room, straight before: paid.
    w.send_all(&[ed25519_ix(&room, &msg), settle], &[&a]).unwrap();
    assert_eq!(w.get_match(70).unwrap().state, MatchState::Settled);
    assert_eq!(w.balance(&w.vault_pda(70)), 0);
}

#[test]
fn the_program_picks_the_podium_from_the_signed_ranking() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    let players = started(&mut w, 72, 10);
    let (stranger, _) = w.player(0);
    // The room ranks 6, 2, someone who never staked, then 8.
    let ranking = vec![players[6].0.pubkey(), players[2].0.pubkey(), stranger.pubkey(), players[8].0.pubkey()];
    let a = w.authority.insecure_clone();
    let fee = w.fee_ata;
    // Paying the stranger's place to anyone but 8 is refused.
    expect_err(
        w.settle_signed_as(72, &a, &fee, &ranking, &[players[6].1, players[2].1, players[3].1], &[]),
        "BadPodium",
    );
    // Podium order matters: 2 first is refused.
    expect_err(
        w.settle_signed_as(72, &a, &fee, &ranking, &[players[2].1, players[6].1, players[8].1], &[]),
        "BadPodium",
    );
    w.settle_signed_as(72, &a, &fee, &ranking, &[players[6].1, players[2].1, players[8].1], &[]).unwrap();
    // 10 USDC: 0.50 fee, 9.50 net: 4.75, 2.85, 1.90.
    assert_eq!(w.balance(&players[6].1), 4 * USDC + 4_750_000);
    assert_eq!(w.balance(&players[2].1), 4 * USDC + 2_850_000);
    assert_eq!(w.balance(&players[8].1), 4 * USDC + 1_900_000);
    assert_eq!(w.balance(&fee), 500_000);
    let m = w.get_match(72).unwrap();
    assert_eq!(m.players[6].status, PlayerStatus::Paid);
    assert_eq!(m.players[0].status, PlayerStatus::Collected);
}

#[test]
fn a_ranking_with_too_few_stakers_is_refused_not_topped_up() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    let players = started(&mut w, 74, 6);
    let (stranger, _) = w.player(0);
    let a = w.authority.insecure_clone();
    let fee = w.fee_ata;
    // One staker ranked where three are paid: nobody unranked is paid instead.
    expect_err(
        w.settle_signed_as(74, &a, &fee, &[players[4].0.pubkey()], &[players[4].1, players[0].1, players[1].1], &[]),
        "BadPodium",
    );
    expect_err(
        w.settle_signed_as(74, &a, &fee, &[players[4].0.pubkey(), stranger.pubkey()], &[players[4].1, players[0].1, players[1].1], &[]),
        "BadPodium",
    );
    // Three stakers among the ranked, a stranger skipped: paid in that order.
    let ranking = [players[4].0.pubkey(), stranger.pubkey(), players[0].0.pubkey(), players[1].0.pubkey()];
    w.settle_signed_as(74, &a, &fee, &ranking, &[players[4].1, players[0].1, players[1].1], &[]).unwrap();
    assert_eq!(w.balance(&players[4].1), 4 * USDC + 2_850_000);
    assert_eq!(w.balance(&players[0].1), 4 * USDC + 1_710_000);
    assert_eq!(w.balance(&players[1].1), 4 * USDC + 1_140_000);
}

#[test]
fn a_ranking_holds_one_to_six_distinct_wallets() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    let players = started(&mut w, 75, 8);
    let a = w.authority.insecure_clone();
    let fee = w.fee_ata;
    let pay: Vec<Pubkey> = players[..3].iter().map(|(_, a)| *a).collect();
    expect_err(w.settle_signed_as(75, &a, &fee, &[], &pay, &[]), "BadRanking");
    let seven: Vec<Pubkey> = players[..7].iter().map(|(k, _)| k.pubkey()).collect();
    expect_err(w.settle_signed_as(75, &a, &fee, &seven, &pay, &[]), "BadRanking");
    w.settle_signed_as(75, &a, &fee, &seven[..6], &pay, &[]).unwrap();
}

#[test]
fn a_winner_can_be_paid_into_another_account_of_theirs() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    let players = started(&mut w, 73, 1);
    let spare = w.token_account(&players[0].0.pubkey(), 0);
    let a = w.authority.insecure_clone();
    let fee = w.fee_ata;
    w.settle_signed_as(73, &a, &fee, &[players[0].0.pubkey()], &[spare], &[]).unwrap();
    assert_eq!(w.balance(&spare), 950_000);
}

#[test]
fn referrals_are_the_winners_own_records() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    let players = started(&mut w, 76, 6);
    let (r0, r0_ata) = w.player(0);
    let (r3, r3_ata) = w.player(0);
    let (r1, r1_ata) = w.player(0);
    w.set_referrer(&players[0].0, r0.pubkey()).unwrap();
    w.set_referrer(&players[3].0, r3.pubkey()).unwrap();
    // Written once: nobody changes it, the player included.
    assert!(w.set_referrer(&players[0].0, r3.pubkey()).is_err());
    // Nobody writes one for someone else without their signature.
    let unsigned = {
        let payer = w.admission.insecure_clone();
        let mut metas = ratpool_escrow::accounts::SetReferrer {
            referral: w.referral_pda(&players[1].0.pubkey()),
            player: players[1].0.pubkey(),
            payer: payer.pubkey(),
            system_program: system_program::ID,
        }
        .to_account_metas(None);
        metas.iter_mut().find(|m| m.pubkey == players[1].0.pubkey()).unwrap().is_signer = false;
        let ix = w.ix(ratpool_escrow::instruction::SetReferrer { referrer: r3.pubkey() }.data(), metas);
        w.send(ix, &[&payer])
    };
    expect_err(unsigned, "AccountNotSigner");
    // Carried over by the upgrade authority only.
    let (stranger, _) = w.player(0);
    expect_err(w.record_referral_as(players[1].0.pubkey(), r1.pubkey(), &stranger), "NotUpgradeAuthority");
    let admin = w.admin.insecure_clone();
    w.record_referral_as(players[1].0.pubkey(), r1.pubkey(), &admin).unwrap();
    w.expect_event(ratpool_escrow::events::ReferralRecorded { player: players[1].0.pubkey(), referrer: r1.pubkey(), by_player: false });

    let podium: Vec<_> = players[..3].iter().map(|(k, a)| (k.pubkey(), *a)).collect();
    let pay: Vec<Pubkey> = podium.iter().map(|(_, a)| *a).collect();
    let rec = |w: &World, i: usize| w.referral_pda(&players[i].0.pubkey());
    let a = w.authority.insecure_clone();
    let fee = w.fee_ata;
    let room = w.room.insecure_clone();
    let ranking: Vec<Pubkey> = podium.iter().map(|(k, _)| *k).collect();
    let msg = w.settle_message(76, &ranking);
    let mut with_slots = |w: &mut World, slots: &[Pubkey], refs: &[Pubkey]| {
        let ix = w.settle_signed_ix_with(76, &a.pubkey(), &fee, &pay, slots, refs);
        w.send_all(&[ed25519_ix(&room, &msg), ix], &[&a])
    };
    // A record of someone off the podium in a winner's place.
    let (s0, s1, s2, s3) = (rec(&w, 0), rec(&w, 1), rec(&w, 2), rec(&w, 3));
    expect_err(with_slots(&mut w, &[s3, s1, s2], &[r3_ata, r1_ata]), "BadReferral");
    // The same record twice.
    expect_err(with_slots(&mut w, &[s0, s0, s2], &[r0_ata, r0_ata]), "BadReferral");
    // Not a record at all.
    let config = w.config;
    expect_err(with_slots(&mut w, &[config, s1, s2], &[r1_ata]), "BadReferral");
    // A record left out, to shift the shares: every one must be paid.
    expect_err(with_slots(&mut w, &[s0, s1, s2], &[r0_ata]), "BadReferral");
    // A winner's record paid to somebody else.
    expect_err(with_slots(&mut w, &[s0, s1, s2], &[r3_ata, r1_ata]), "BadReferral");
    assert_eq!(w.balance(&w.vault_pda(76)), 6 * USDC);

    // Both records: 1% of 6 USDC split between them, out of the 5%.
    with_slots(&mut w, &[s0, s1, s2], &[r0_ata, r1_ata]).unwrap();
    assert_eq!(w.balance(&r0_ata), 30_000);
    assert_eq!(w.balance(&r1_ata), 30_000);
    assert_eq!(w.balance(&r3_ata), 0);
    assert_eq!(w.balance(&fee), 240_000);
}

#[test]
fn one_invited_winner_earns_their_referrer_the_whole_one_percent() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    let players = started(&mut w, 77, 6);
    let (r0, r0_ata) = w.player(0);
    w.set_referrer(&players[0].0, r0.pubkey()).unwrap();
    let podium: Vec<_> = players[..3].iter().map(|(k, a)| (k.pubkey(), *a)).collect();
    // The record cannot be skipped.
    expect_err(w.settle(77, &podium), "BadReferral");
    let a = w.authority.insecure_clone();
    let fee = w.fee_ata;
    w.settle_with_referrers_as(77, &a, &fee, &podium, &[r0_ata]).unwrap();
    assert_eq!(w.balance(&r0_ata), 60_000);
    assert_eq!(w.balance(&fee), 240_000);
    // The podium's 95% is untouched either way.
    assert_eq!(w.balance(&players[0].1), 4 * USDC + 2_850_000);
}

#[test]
fn the_room_key_answers_to_the_upgrade_authority() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    let old = w.authority.insecure_clone();
    let (next, _) = w.player(0);
    w.propose_as(next.pubkey(), &old).unwrap();
    w.accept_as(&next).unwrap();
    w.authority = next.insecure_clone();
    // The payout key cannot name its own room key; nor can a stranger.
    let (stranger, _) = w.player(0);
    let fake_room = Keypair::new();
    expect_err(w.set_room_key_as(fake_room.pubkey(), &next), "NotUpgradeAuthority");
    expect_err(w.set_room_key_as(fake_room.pubkey(), &stranger), "NotUpgradeAuthority");
    expect_err(w.set_room_key_as(Pubkey::default(), &old), "RoomKeyNotSet");

    let players = started(&mut w, 78, 1);
    let podium = [(players[0].0.pubkey(), players[0].1)];
    // A ranking signed by a key the program does not know.
    let real_room = std::mem::replace(&mut w.room, fake_room.insecure_clone());
    expect_err(w.settle(78, &podium), "BadRoomSignature");
    // The upgrade authority moves the room key; the old room key stops counting.
    w.set_room_key_as(fake_room.pubkey(), &old).unwrap();
    w.expect_event(ratpool_escrow::events::RoomKeySet { room_key: fake_room.pubkey() });
    w.room = real_room;
    expect_err(w.settle(78, &podium), "BadRoomSignature");
    w.room = fake_room;
    w.settle(78, &podium).unwrap();
}

#[test]
fn no_payout_before_a_room_key_is_set() {
    let mut w = World::new();
    let ix = w.ix(
        ratpool_escrow::instruction::Initialize {
            fee_bps: FEE_BPS, min_players: 1, refund_delay: REFUND_DELAY, admission: w.admission.pubkey(),
        }.data(),
        ratpool_escrow::accounts::Initialize {
            program: w.program_id, program_data: w.program_data(), config: w.config,
            authority: w.authority.pubkey(), fee_wallet: w.fee_wallet.pubkey(), mint: w.mint,
            system_program: system_program::ID,
        }.to_account_metas(None),
    );
    let a = w.authority.insecure_clone();
    w.send(ix, &[&a]).unwrap();
    let players = started(&mut w, 79, 1);
    expect_err(w.settle(79, &[(players[0].0.pubkey(), players[0].1)]), "AccountNotInitialized");
    assert_eq!(w.balance(&w.vault_pda(79)), USDC);
}

#[test]
fn config_changes_need_the_upgrade_authority_not_the_payout_key() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    let old = w.authority.insecure_clone();
    let (next, _) = w.player(0);
    w.propose_as(next.pubkey(), &old).unwrap();
    w.accept_as(&next).unwrap();
    // The payout key, with the config's authority, still cannot redirect
    // fees, admit its own players or hand the authority on.
    let (thief, _) = w.player(0);
    w.admin = next.insecure_clone();
    expect_err(w.update_terms(None, None, Some(thief.pubkey()), None), "NotUpgradeAuthority");
    expect_err(w.update_terms(None, None, None, Some(thief.pubkey())), "NotUpgradeAuthority");
    expect_err(w.propose_as(thief.pubkey(), &next), "NotUpgradeAuthority");
    assert_eq!(w.get_config().fee_wallet, w.fee_wallet.pubkey());
    assert_eq!(w.get_config().admission, w.admission.pubkey());
    assert_eq!(w.get_config().pending_authority, None);
    w.admin = old;
    w.update_terms(None, None, None, Some(thief.pubkey())).unwrap();
    assert_eq!(w.get_config().admission, thief.pubkey());
}

#[test]
fn the_largest_payout_fits_one_transaction() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    let players = started(&mut w, 80, 6);
    let mut refs = Vec::new();
    for (kp, _) in players[..3].iter() {
        let (r, r_ata) = w.player(0);
        w.set_referrer(kp, r.pubkey()).unwrap();
        refs.push(r_ata);
    }
    let ranking: Vec<Pubkey> = players.iter().map(|(k, _)| k.pubkey()).collect();
    let pay: Vec<Pubkey> = players[..3].iter().map(|(_, a)| *a).collect();
    let a = w.authority.insecure_clone();
    let room = w.room.insecure_clone();
    let fee = w.fee_ata;
    let msg = w.settle_message(80, &ranking);
    let ixs = [compute_limit(), ed25519_ix(&room, &msg), w.settle_signed_ix(80, &a.pubkey(), &fee, &pay, &refs)];
    let blockhash = w.svm.latest_blockhash();
    let size = 1 + 64 + Message::new_with_blockhash(&ixs, Some(&a.pubkey()), &blockhash).serialize().len();
    assert!(size <= 1232, "a full payout is {size} bytes; a transaction holds 1232");
    w.send_all(&ixs, &[&a]).unwrap();
    for r_ata in refs.iter() {
        assert_eq!(w.balance(r_ata), 20_000);
    }
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

/// The room server's own bytes: made by server/src/api.ts signSettlement
/// from fixed seeds (.smoke/settle-bytes.mts: room key from [9; 32], players
/// from [1; 32], [2; 32], [3; 32], match 90 started at 1,791,400,000,
/// ranked 2, 3, 3, 1 with the duplicate dropped). If the two sides ever disagree on the format, this
/// fails before any payout does.
#[test]
fn the_room_servers_own_bytes_are_accepted() {
    const MSG: &str = "726174706f6f6c2d736574746c652d7631b0bc0a517d71414f686b8686dc70caae41dc190bdd46ba069467675148e3a31a5a000000000000004098c66a00000000038139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d18a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c";
    const SIG: &str = "536e2d1a16dfd1ec0719f093fa0b29c37e6ba3cb7985226f94a259afc9c5862f8553d841f05218c57706e9c21619ff48c73d36c7a8b42591cec760f52af6f50d";
    let mut w = World::new();
    w.room = Keypair::new_from_array([9u8; 32]);
    // The start time the room signed: the clock is there before the match opens.
    let mut clock = w.svm.get_sysvar::<Clock>();
    clock.unix_timestamp = 1_791_400_000;
    w.svm.set_sysvar(&clock);
    w.initialize(1).unwrap();
    w.create_match(90, USDC).unwrap();
    let mut players = Vec::new();
    for n in 1..=3u8 {
        let kp = Keypair::new_from_array([n; 32]);
        w.svm.airdrop(&kp.pubkey(), 1_000_000_000).unwrap();
        let ata = w.token_account(&kp.pubkey(), 5 * USDC);
        w.join(90, &kp, &ata).unwrap();
        players.push((kp, ata));
    }
    let atas: Vec<_> = players.iter().map(|(_, a)| *a).collect();
    w.collect(90, &atas).unwrap();
    w.start(90).unwrap();
    assert_eq!(w.get_match(90).unwrap().collected_at, 1_791_400_000);
    w.advance_clock(1);
    let a = w.authority.insecure_clone();
    let fee = w.fee_ata;
    let check = ed25519_ix_with(w.room.pubkey(), &unhex(SIG), &unhex(MSG), u16::MAX);
    let settle = w.settle_signed_ix(90, &a.pubkey(), &fee, &[atas[1], atas[2], atas[0]], &[]);
    w.send_all(&[check, settle], &[&a]).unwrap();
    // 3 USDC: 0.15 fee, 2.85 net: 1.425, 0.855, 0.57.
    assert_eq!(w.balance(&atas[1]), 4 * USDC + 1_425_000);
    assert_eq!(w.balance(&atas[2]), 4 * USDC + 855_000);
    assert_eq!(w.balance(&atas[0]), 4 * USDC + 570_000);
}


#[test]
fn a_signature_does_not_outlive_its_match() {
    // Paid, closed, then opened again under the same id: the old signature
    // named the old start time, so it pays nothing now.
    let mut w = World::new();
    w.initialize(1).unwrap();
    let players = started(&mut w, 91, 3);
    let ranking: Vec<Pubkey> = players.iter().map(|(k, _)| k.pubkey()).collect();
    let pay: Vec<Pubkey> = players.iter().map(|(_, a)| *a).collect();
    let a = w.authority.insecure_clone();
    let room = w.room.insecure_clone();
    let fee = w.fee_ata;
    let old_msg = w.settle_message(91, &ranking);
    let old_check = ed25519_ix(&room, &old_msg);
    let settle = w.settle_signed_ix(91, &a.pubkey(), &fee, &pay, &[]);
    w.send_all(&[old_check.clone(), settle], &[&a]).unwrap();
    w.close_match(91).unwrap();
    assert!(w.get_match(91).is_none());

    w.advance_clock(60);
    w.create_match(91, USDC).unwrap();
    for (kp, ata) in players.iter() {
        w.join(91, kp, ata).unwrap();
    }
    w.collect(91, &pay).unwrap();
    w.start(91).unwrap();
    w.advance_clock(1);
    let settle = w.settle_signed_ix(91, &a.pubkey(), &fee, &pay, &[]);
    expect_err(w.send_all(&[old_check, settle.clone()], &[&a]), "BadRoomSignature");
    // A signature for this start is accepted.
    let new_msg = w.settle_message(91, &ranking);
    w.send_all(&[ed25519_ix(&room, &new_msg), settle], &[&a]).unwrap();
}

#[test]
fn one_signature_per_check_and_all_of_it_inside() {
    let mut w = World::new();
    w.initialize(1).unwrap();
    let players = started(&mut w, 92, 3);
    let ranking: Vec<Pubkey> = players.iter().map(|(k, _)| k.pubkey()).collect();
    let pay: Vec<Pubkey> = players.iter().map(|(_, a)| *a).collect();
    let a = w.authority.insecure_clone();
    let room = w.room.insecure_clone();
    let fee = w.fee_ata;
    let msg = w.settle_message(92, &ranking);
    let settle = w.settle_signed_ix(92, &a.pubkey(), &fee, &pay, &[]);

    // Two valid signatures in one check (the room's first): refused.
    let other = Keypair::new();
    let other_msg = b"something else".to_vec();
    let mut d = vec![2u8, 0u8];
    let base = 2 + 14 * 2;
    let (pk1, sig1, msg1) = (base, base + 32, base + 96);
    let (pk2, sig2, msg2) = (msg1 + msg.len(), msg1 + msg.len() + 32, msg1 + msg.len() + 96);
    for v in [sig1, 0xffff, pk1, 0xffff, msg1, msg.len(), 0xffff, sig2, 0xffff, pk2, 0xffff, msg2, other_msg.len(), 0xffff] {
        d.extend_from_slice(&(v as u16).to_le_bytes());
    }
    d.extend_from_slice(room.pubkey().as_ref());
    d.extend_from_slice(room.sign_message(&msg).as_ref());
    d.extend_from_slice(&msg);
    d.extend_from_slice(other.pubkey().as_ref());
    d.extend_from_slice(other.sign_message(&other_msg).as_ref());
    d.extend_from_slice(&other_msg);
    let double = Instruction::new_with_bytes(ED25519, &d, vec![]);
    expect_err(w.send_all(&[double, settle.clone()], &[&a]), "BadRoomSignature");

    // A valid check that names its own position (0) rather than "this
    // instruction": the precompile accepts it, the program does not.
    let by_index = ed25519_ix_with(room.pubkey(), room.sign_message(&msg).as_ref(), &msg, 0);
    expect_err(w.send_all(&[by_index, settle.clone()], &[&a]), "BadRoomSignature");

    w.send_all(&[ed25519_ix(&room, &msg), settle], &[&a]).unwrap();
}


#[test]
fn a_payout_waits_for_the_second_after_the_start() {
    // Even within one second: paid no sooner than the next, so a match
    // reopened under the same id always has a later start than any signature.
    let mut w = World::new();
    w.initialize(1).unwrap();
    w.create_match(93, USDC).unwrap();
    let players = w.room(93, 3);
    let pay: Vec<Pubkey> = players.iter().map(|(_, a)| *a).collect();
    w.collect(93, &pay).unwrap();
    w.start(93).unwrap();
    let ranking: Vec<Pubkey> = players.iter().map(|(k, _)| k.pubkey()).collect();
    let a = w.authority.insecure_clone();
    let fee = w.fee_ata;
    let room = w.room.insecure_clone();
    let first = ed25519_ix(&room, &w.settle_message(93, &ranking));
    let settle = w.settle_signed_ix(93, &a.pubkey(), &fee, &pay, &[]);
    expect_err(w.send_all(&[first.clone(), settle.clone()], &[&a]), "TooSoon");
    w.advance_clock(1);
    w.send_all(&[first.clone(), settle.clone()], &[&a]).unwrap();
    // Closed and reopened without the clock moving: the old signature names
    // the old start and is refused.
    w.close_match(93).unwrap();
    w.create_match(93, USDC).unwrap();
    for (kp, ata) in players.iter() {
        w.join(93, kp, ata).unwrap();
    }
    w.collect(93, &pay).unwrap();
    w.start(93).unwrap();
    w.advance_clock(1);
    let settle = w.settle_signed_ix(93, &a.pubkey(), &fee, &pay, &[]);
    expect_err(w.send_all(&[first, settle], &[&a]), "BadRoomSignature");
}
