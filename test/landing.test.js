// Unit tests for the pure helpers in landing.js — no network needed.
//   node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey, SystemProgram, Keypair } from '@solana/web3.js';

import {
    normalizeFeeLevel, escalateFeeLevel, feeLevelForAttempt,
    computeCuLimit, capCuPrice, priorityFeeLamports,
    senderUrl, pickTipAccount, parseLandingConfig, uniqueWritableKeys,
    SENDER_TIP_ACCOUNTS, SENDER_TIP_LAMPORTS, MIN_CU_PRICE, FEE_LEVELS,
} from '../landing.js';

test('normalizeFeeLevel maps config strings to Helius levels', () => {
    assert.equal(normalizeFeeLevel('medium'), 'Medium');
    assert.equal(normalizeFeeLevel('veryHigh'), 'VeryHigh');
    assert.equal(normalizeFeeLevel('VERYHIGH'), 'VeryHigh');
    assert.equal(normalizeFeeLevel('high'), 'High');
    assert.equal(normalizeFeeLevel('low'), 'Low');
    assert.equal(normalizeFeeLevel('min'), 'Low');
    assert.equal(normalizeFeeLevel(undefined), 'Medium');
    assert.equal(normalizeFeeLevel('garbage'), 'Medium');
});

test('escalateFeeLevel climbs the ladder and saturates at the top', () => {
    assert.equal(escalateFeeLevel('Low'), 'Medium');
    assert.equal(escalateFeeLevel('Medium'), 'High');
    assert.equal(escalateFeeLevel('High'), 'VeryHigh');
    assert.equal(escalateFeeLevel('VeryHigh'), 'UnsafeMax');
    assert.equal(escalateFeeLevel('UnsafeMax'), 'UnsafeMax');
    assert.equal(escalateFeeLevel('nonsense'), 'Medium');
});

test('feeLevelForAttempt escalates one step per attempt from the base level', () => {
    assert.equal(feeLevelForAttempt('medium', 0), 'Medium');
    assert.equal(feeLevelForAttempt('medium', 1), 'High');
    assert.equal(feeLevelForAttempt('medium', 2), 'VeryHigh');
    assert.equal(feeLevelForAttempt('medium', 10), 'UnsafeMax');
    assert.deepEqual(FEE_LEVELS, ['Low', 'Medium', 'High', 'VeryHigh', 'UnsafeMax']);
});

test('computeCuLimit adds 10% + 5k headroom and tolerates junk', () => {
    assert.equal(computeCuLimit(100_000), 115_000);
    assert.equal(computeCuLimit(0), 5_000);
    assert.equal(computeCuLimit(undefined), 5_000);
    assert.equal(computeCuLimit(-5), 5_000);
});

test('capCuPrice enforces the floor and the total-fee cap', () => {
    // Floor: never below MIN_CU_PRICE.
    assert.equal(capCuPrice(0, 100_000, 500_000), MIN_CU_PRICE);
    assert.equal(capCuPrice(10, 100_000, 500_000), MIN_CU_PRICE);
    // Pass-through when under the cap.
    assert.equal(capCuPrice(20_000, 100_000, 500_000), 20_000);
    // Cap: price * cuLimit / 1e6 must not exceed capLamports.
    // cap 500_000 lamports, 100_000 CU -> max 5_000_000 µL/CU
    assert.equal(capCuPrice(9_000_000, 100_000, 500_000), 5_000_000);
    // cap of 1_000 lamports at 100_000 CU -> 10_000 µL/CU
    assert.equal(capCuPrice(50_000, 100_000, 1_000), 10_000);
    // No cap (0) -> no clamping
    assert.equal(capCuPrice(9_000_000, 100_000, 0), 9_000_000);
});

test('priorityFeeLamports rounds up', () => {
    assert.equal(priorityFeeLamports(10_000, 100_000), 1_000);
    assert.equal(priorityFeeLamports(1, 1), 1);
    assert.equal(priorityFeeLamports(1_500, 115_000), 173); // 172.5 -> 173
});

test('senderUrl builds the documented endpoints', () => {
    assert.equal(senderUrl('auto', 'swqos'), 'https://sender.helius-rpc.com/fast?swqos_only=true');
    assert.equal(senderUrl('auto', 'max'), 'https://sender.helius-rpc.com/fast');
    assert.equal(senderUrl('ewr', 'swqos'), 'http://ewr-sender.helius-rpc.com/fast?swqos_only=true');
    assert.equal(senderUrl('tyo', 'max'), 'http://tyo-sender.helius-rpc.com/fast');
    assert.equal(senderUrl('mars', 'swqos'), 'https://sender.helius-rpc.com/fast?swqos_only=true');
    assert.equal(senderUrl('ewr', 'off'), null);
});

test('tip amounts match the Helius minimums', () => {
    assert.equal(SENDER_TIP_LAMPORTS.swqos, 5_000);
    assert.equal(SENDER_TIP_LAMPORTS.max, 1_000_000);
    assert.equal(SENDER_TIP_LAMPORTS.off, 0);
});

test('pickTipAccount returns a valid tip account, deterministic when indexed', () => {
    assert.equal(SENDER_TIP_ACCOUNTS.length, 10);
    for (const a of SENDER_TIP_ACCOUNTS) assert.ok(PublicKey.isOnCurve(new PublicKey(a).toBytes()) || true, 'parses');
    assert.equal(pickTipAccount(0).toBase58(), SENDER_TIP_ACCOUNTS[0]);
    assert.equal(pickTipAccount(13).toBase58(), SENDER_TIP_ACCOUNTS[3]);
    const random = pickTipAccount().toBase58();
    assert.ok(SENDER_TIP_ACCOUNTS.includes(random));
});

test('parseLandingConfig applies fast-path defaults and validates values', () => {
    const d = parseLandingConfig({});
    assert.equal(d.senderMode, 'swqos');
    assert.equal(d.senderRegion, 'auto');
    assert.equal(d.baseFeeLevel, 'Medium');
    assert.equal(d.priorityCapLamports, 500_000);
    assert.equal(d.maxAttempts, 3);

    const c = parseLandingConfig({
        SENDER_MODE: 'MAX', SENDER_REGION: 'EWR', PRIORITY_LEVEL: 'high',
        PRIORITY_FEE: '0.001', LANDING_MAX_ATTEMPTS: '9',
    });
    assert.equal(c.senderMode, 'max');
    assert.equal(c.senderRegion, 'ewr');
    assert.equal(c.baseFeeLevel, 'High');
    assert.equal(c.priorityCapLamports, 1_000_000);
    assert.equal(c.maxAttempts, 5); // clamped

    const bad = parseLandingConfig({ SENDER_MODE: 'turbo', SENDER_REGION: 'moon' });
    assert.equal(bad.senderMode, 'swqos');
    assert.equal(bad.senderRegion, 'auto');
});

test('uniqueWritableKeys collects payer + writable keys once each', () => {
    const payer = Keypair.generate().publicKey;
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    const ixs = [
        SystemProgram.transfer({ fromPubkey: payer, toPubkey: a, lamports: 1 }),
        SystemProgram.transfer({ fromPubkey: payer, toPubkey: a, lamports: 2 }),
        SystemProgram.transfer({ fromPubkey: payer, toPubkey: b, lamports: 3 }),
    ];
    const keys = uniqueWritableKeys(ixs, payer).map(k => k.toBase58());
    assert.deepEqual(new Set(keys), new Set([payer.toBase58(), a.toBase58(), b.toBase58()]));
    assert.equal(keys.length, 3);
});

test('maskLookupTables hides tip accounts from the compiler but keeps indexes', async () => {
    const { AddressLookupTableAccount } = await import('@solana/web3.js');
    const { maskLookupTables } = await import('../landing.js');
    const a = Keypair.generate().publicKey;
    const tip = new PublicKey(SENDER_TIP_ACCOUNTS[2]);
    const b = Keypair.generate().publicKey;
    const table = new AddressLookupTableAccount({
        key: Keypair.generate().publicKey,
        state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0, authority: a, addresses: [a, tip, b] },
    });
    const [masked] = maskLookupTables([table]);
    assert.equal(masked.state.addresses.length, 3);
    assert.equal(masked.state.addresses[0].toBase58(), a.toBase58());
    assert.equal(masked.state.addresses[2].toBase58(), b.toBase58());
    assert.notEqual(masked.state.addresses[1].toBase58(), tip.toBase58());
    assert.equal(masked.key.toBase58(), table.key.toBase58());
    // Tables without tip accounts are returned as-is.
    const plain = new AddressLookupTableAccount({ key: table.key, state: { ...table.state, addresses: [a, b] } });
    assert.equal(maskLookupTables([plain])[0], plain);
});
