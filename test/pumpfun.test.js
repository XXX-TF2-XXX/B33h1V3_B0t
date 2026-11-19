// Unit tests for pumpfun.js — no network needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

import {
    PUMP_PROGRAM_ID, CLOSE_USER_VOLUME_ACCUMULATOR_DISCRIMINATOR,
    pumpfunUserVolumeAccumulatorPda, pumpfunEventAuthorityPda,
    closePumpfunUserVolumeAccumulatorInstruction,
} from '../pumpfun.js';

// A wallet from the 2026-08-28 session whose accumulator was verified on-chain
// (owner 6EF8..., 137 bytes, 1,844,400 lamports) at this exact address.
const USER = new PublicKey('Y83omzFgJhVj8PEedtt9A4fFEK2BTZK2iuEsA9PaYyR');
const USER_PDA = '9T4PZ29bDU17TTfMHeEuCGf5AC1hTHyxw2J6SU52xEF5';
const EVENT_AUTHORITY = 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1';

test('PDA derivations match the accounts observed on-chain', () => {
    assert.equal(pumpfunUserVolumeAccumulatorPda(USER).toBase58(), USER_PDA);
    assert.equal(pumpfunEventAuthorityPda().toBase58(), EVENT_AUTHORITY);
});

test('close instruction matches the IDL: discriminator, account order, signer/writable flags', () => {
    const ix = closePumpfunUserVolumeAccumulatorInstruction(USER);
    assert.ok(ix.programId.equals(PUMP_PROGRAM_ID));
    assert.deepEqual([...ix.data], [249, 69, 164, 218, 150, 103, 84, 138]);
    // Anchor convention, so the pinned bytes can be re-derived without the IDL.
    const anchor = createHash('sha256').update('global:close_user_volume_accumulator').digest().subarray(0, 8);
    assert.deepEqual([...anchor], [...CLOSE_USER_VOLUME_ACCUMULATOR_DISCRIMINATOR]);
    assert.deepEqual(ix.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [
        [USER.toBase58(), true, true],
        [USER_PDA, false, true],
        [EVENT_AUTHORITY, false, false],
        [PUMP_PROGRAM_ID.toBase58(), false, false],
    ]);
});
