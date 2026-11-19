// Crash-recovery ledger: atomic writes, never treat a damaged ledger as
// empty, salvage every readable key. Uses a temp dir — never the live file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

import {
    loadActiveWallets, saveActiveWallets, appendActiveWallet, removeActiveWallet, salvageWallets,
} from '../solUtils.js';

function tmpLedger() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svb-ledger-'));
    return { dir, file: path.join(dir, 'active_wallets.json') };
}
function entry() {
    const kp = Keypair.generate();
    return { publicKey: kp.publicKey.toBase58(), privateKey: bs58.encode(kp.secretKey), createdAt: new Date().toISOString() };
}

test('missing ledger loads as empty', () => {
    const { file } = tmpLedger();
    assert.deepEqual(loadActiveWallets(file), []);
});

test('append / remove round-trip, file deleted when empty, no temp file left', () => {
    const { dir, file } = tmpLedger();
    const a = entry(), b = entry();
    appendActiveWallet(file, a);
    appendActiveWallet(file, b);
    assert.deepEqual(loadActiveWallets(file).map(w => w.publicKey), [a.publicKey, b.publicKey]);
    removeActiveWallet(file, a.publicKey);
    assert.deepEqual(loadActiveWallets(file).map(w => w.publicKey), [b.publicKey]);
    removeActiveWallet(file, b.publicKey);
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(fs.readdirSync(dir), []);
});

test('a truncated (crash mid-write) ledger is NOT treated as empty: keys are salvaged and a copy is kept', () => {
    const { dir, file } = tmpLedger();
    const a = entry(), b = entry();
    const full = JSON.stringify([a, b], null, 2);
    fs.writeFileSync(file, full.slice(0, full.length - 10)); // cut off mid-write
    const loaded = loadActiveWallets(file);
    assert.deepEqual(loaded.map(w => w.publicKey).sort(), [a.publicKey, b.publicKey].sort());
    assert.ok(fs.readdirSync(dir).some(f => f.includes('.corrupt-')), 'corrupt copy kept');
    // The next append must keep the salvaged keys.
    const c = entry();
    appendActiveWallet(file, c);
    assert.deepEqual(loadActiveWallets(file).map(w => w.publicKey).sort(), [a.publicKey, b.publicKey, c.publicKey].sort());
});

test('salvageWallets ignores garbage and duplicates, derives the public key', () => {
    const a = entry();
    const raw = `junk "privateKey": "${a.privateKey}" more "privateKey": "${a.privateKey}" "privateKey": "notakey"`;
    const s = salvageWallets(raw);
    assert.equal(s.length, 1);
    assert.equal(s[0].publicKey, a.publicKey);
    assert.equal(s[0].salvaged, true);
});

test('saveActiveWallets overwrites atomically (content always valid JSON)', () => {
    const { file } = tmpLedger();
    const list = Array.from({ length: 20 }, entry);
    saveActiveWallets(file, list);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 20);
    saveActiveWallets(file, list.slice(0, 3));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 3);
});
