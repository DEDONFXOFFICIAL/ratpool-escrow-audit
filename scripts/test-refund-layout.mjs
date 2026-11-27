import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import anchor from '@anchor-lang/core';
import { Keypair } from '@solana/web3.js';
import { readMatch, configMint } from './refund-expired.mjs';

// Encode with the generated Anchor IDL; the standalone recovery tool must
// decode these real account layouts without contacting any service.
const coder = new anchor.BorshCoder(JSON.parse(readFileSync('src/chain/idl/ratpool_escrow.json','utf8')));
const key = () => Keypair.generate().publicKey;
const mint = key(), authority = key();
for (const pending_authority of [null,key()]) {
  const data = await coder.accounts.encode('Config', { winner_count:7,
    winner_weights:[10,9,8,6,5,4,3,0,0,0,0,0],authority,pending_authority,
    admission:key(),fee_wallet:key(),mint,fee_bps:1000,min_players:25,refund_delay:new anchor.BN(1800),bump:250 });
  assert.equal(configMint(data).toBase58(),mint.toBase58());
}
const player=key(), tokenAccount=key();
for (const state of ['Open','Collected','Settled','Cancelled']) {
  const data = await coder.accounts.encode('Match', { economy_version:6,winner_count:7,
    winner_weights:[10,9,8,6,5,4,3,0,0,0,0,0],id:new anchor.BN(12345),entry:new anchor.BN(1000000),
    fee_bps:1000,fee_wallet:key(),min_players:25,refund_delay:new anchor.BN(1800),refund_after:new anchor.BN(1791401800),
    state:{[state]:{}},collected_at:new anchor.BN(1791400000),pool:new anchor.BN(25000000),bump:240,
    players:[{key:player,token_account:tokenAccount,status:{Collected:{}}}] });
  const m=readMatch(data);
  assert.equal(m.id,12345n);assert.equal(m.entry,1000000n);assert.equal(m.pool,25000000n);
  assert.equal(m.refundAfter,1791401800n);assert.equal(m.state,state);
  assert.equal(m.players[0].key.toBase58(),player.toBase58());
  assert.equal(m.players[0].tokenAccount.toBase58(),tokenAccount.toBase58());
  assert.equal(m.players[0].status,'Collected');
  const invalid=Buffer.from(data);invalid[8]=5;
  assert.throws(()=>readMatch(invalid),/Unknown escrow layout/);
}
console.log('PASS: standalone refund recovery reads the generated v6 Config/Match layouts, optional authority and every match state.');
