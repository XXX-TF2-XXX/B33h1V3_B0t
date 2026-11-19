// Unit tests for the pure helpers in lookupTable.js — no network needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { missingAddresses, chunk, loadLookupTableRegistry, saveLookupTableRegistry } from '../lookupTable.js';

test('missingAddresses returns only addresses not in the table, deduplicated, in order', () => {
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    const c = Keypair.generate().publicKey;
    const missing = missingAddresses([a], [a, b, c, b]);
    assert.deepEqual(missing.map(k => k.toBase58()), [b.toBase58(), c.toBase58()]);
    assert.deepEqual(missingAddresses([a, b, c], [a, b]), []);
    assert.deepEqual(missingAddresses([], []), []);
});

test('chunk splits arrays into fixed-size pieces', () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunk([], 3), []);
    assert.deepEqual(chunk([1, 2], 5), [[1, 2]]);
});

test('registry round-trips through JSON and tolerates a missing file', () => {
    const file = path.join(os.tmpdir(), `alt-registry-${process.pid}-${Date.now()}.json`);
    try {
        assert.deepEqual(loadLookupTableRegistry(file), {});
        saveLookupTableRegistry({ mint1: { address: 'abc', createdAt: 'now' } }, file);
        assert.deepEqual(loadLookupTableRegistry(file), { mint1: { address: 'abc', createdAt: 'now' } });
    } finally {
        try { fs.unlinkSync(file); } catch {}
    }
});
