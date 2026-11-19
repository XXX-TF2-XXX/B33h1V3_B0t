// Free-RPC fee estimation, the shared signature watcher, Jupiter
// instruction decoding and retry policy — no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';

import { percentileFee, feeApiFor, SignatureWatcher } from '../landing.js';
import {
    jupiterIx, jupiterInstructionsFromResponse, isRetryableHttpError, withRetry, exitSlippageBps, MAX_EXIT_SLIPPAGE_BPS,
} from '../solUtils.js';

test('feeApiFor: Helius URL uses the Helius estimator, anything else the standard method', () => {
    assert.equal(feeApiFor('https://mainnet.helius-rpc.com/?api-key=x'), 'helius');
    assert.equal(feeApiFor('https://solana-rpc.publicnode.com'), 'standard');
    assert.equal(feeApiFor('https://api.mainnet-beta.solana.com'), 'standard');
});

test('percentileFee picks a lower fee for a lower level', () => {
    const samples = [0, 0, 100, 200, 300, 400, 500, 1000].map(prioritizationFee => ({ slot: 1, prioritizationFee }));
    assert.equal(percentileFee(samples, 'Low'), 0);
    assert.equal(percentileFee(samples, 'Medium'), 200);
    assert.equal(percentileFee(samples, 'High'), 400);
    assert.equal(percentileFee(samples, 'VeryHigh'), 1000);
    assert.equal(percentileFee(samples, 'UnsafeMax'), 1000);
    assert.equal(percentileFee([], 'Medium'), 0);
});

test('SignatureWatcher batches every in-flight signature into one RPC call per tick', async () => {
    const calls = [];
    const fake = {
        async getSignatureStatuses(sigs) {
            calls.push(sigs.length);
            return { value: sigs.map(s => ({ confirmationStatus: 'confirmed', err: null, s })) };
        },
        async getBlockHeight() { return 100; },
    };
    const w = new SignatureWatcher(fake, { pollMs: 20 });
    try {
        w.watch('a'); w.watch('b'); w.watch('c');
        await new Promise(r => setTimeout(r, 60));
        assert.equal(w.status('a').confirmationStatus, 'confirmed');
        assert.equal(calls[0], 3, 'three signatures, one call');
    } finally {
        w.unwatch('a'); w.unwatch('b'); w.unwatch('c');
    }
    await new Promise(r => setTimeout(r, 80));
    assert.equal(w.running, false, 'poller stops when nothing is watched');
    // block height is cached and shared
    const [h1, h2] = await Promise.all([w.blockHeight(), w.blockHeight()]);
    assert.equal(h1, 100); assert.equal(h2, 100);
});

test('Jupiter instructions decode in order: setup -> swap -> cleanup (compute budget dropped)', () => {
    const pk = () => Keypair.generate().publicKey.toBase58();
    const mk = (tag) => ({ programId: pk(), accounts: [{ pubkey: pk(), isSigner: true, isWritable: true }], data: Buffer.from(tag).toString('base64') });
    const r = {
        computeBudgetInstructions: [mk('cb')],
        setupInstructions: [mk('s1'), mk('s2')],
        swapInstruction: mk('swap'),
        cleanupInstruction: mk('clean'),
        otherInstructions: [mk('tip')],
        addressLookupTableAddresses: [],
    };
    const ixs = jupiterInstructionsFromResponse(r);
    assert.deepEqual(ixs.map(i => i.data.toString()), ['s1', 's2', 'swap', 'clean']);
    assert.ok(ixs[0].programId instanceof PublicKey);
    assert.equal(ixs[0].keys[0].isSigner, true);
    assert.throws(() => jupiterInstructionsFromResponse({}), /no swap instruction/);
    assert.equal(jupiterIx({ programId: pk(), data: '' }).keys.length, 0);
});

test('HTTP retry policy: network/429/5xx retry, other 4xx fail fast', async () => {
    assert.equal(isRetryableHttpError(new Error('ECONNRESET')), true);
    assert.equal(isRetryableHttpError({ response: { status: 429 } }), true);
    assert.equal(isRetryableHttpError({ response: { status: 503 } }), true);
    assert.equal(isRetryableHttpError({ response: { status: 400 } }), false);
    let n = 0;
    await assert.rejects(withRetry(async () => { n++; const e = new Error('no route'); e.response = { status: 400 }; throw e; },
        { retries: 5, baseMs: 1, shouldRetry: isRetryableHttpError }));
    assert.equal(n, 1, '4xx is not retried');
    n = 0;
    const v = await withRetry(async () => { if (++n < 3) throw new Error('blip'); return 'ok'; }, { retries: 5, baseMs: 1 });
    assert.equal(v, 'ok'); assert.equal(n, 3);
});

test('shared rate bucket: burst passes at once, the rest is spaced at the rate, a pause holds everyone', async () => {
    const { createRateBucket, takeRateToken, pauseRateBucket } = await import('../solUtils.js');
    const b = createRateBucket(20, 2);           // 20/s, burst 2
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 6 }, () => takeRateToken(b)));
    const took = Date.now() - t0;
    assert.ok(took >= 180 && took < 600, `6 takes at 20/s with burst 2 took ${took}ms`);
    pauseRateBucket(b, 150);
    const t1 = Date.now();
    await takeRateToken(b);
    assert.ok(Date.now() - t1 >= 140, 'a 429 pause delays the next call');
});

test('exit slippage widens per sell retry and is capped', () => {
    assert.equal(exitSlippageBps(700, 0), 700);
    assert.equal(exitSlippageBps(700, 1), 1050);
    assert.equal(exitSlippageBps(700, 2), 1400);
    assert.equal(exitSlippageBps(2000, 2), MAX_EXIT_SLIPPAGE_BPS);
});
