/**
 * lookupTable.js — one reusable Address Lookup Table (ALT) per token.
 *
 * A v0 transaction normally spends 32 bytes per account it touches; a
 * PumpSwap buy with our wrapping touches ~27, which is right at Solana's
 * 1,232-byte packet limit once the compute-budget and tip instructions are
 * added. With an ALT each static account costs 1 byte instead, so the same
 * transaction is ~600 bytes: it fits with room to spare and propagates faster.
 *
 * The table is created once by the main wallet (it is the authority), stored in
 * lookup_tables.json keyed by token mint, verified on-chain at every start, and
 * extended in place if new addresses are ever needed. Rent (~0.008 SOL) is a
 * one-time, reclaimable cost.
 */

import { AddressLookupTableProgram, PublicKey } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { landTransaction, waitFinalized } from './landing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LOOKUP_TABLES_FILE = path.join(__dirname, 'lookup_tables.json');

// Max addresses per extend instruction that still fits in one transaction.
const EXTEND_CHUNK = 20;

function sleepMs(ms) { return new Promise(r => setTimeout(r, ms)); }

export function loadLookupTableRegistry(file = LOOKUP_TABLES_FILE) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

export function saveLookupTableRegistry(reg, file = LOOKUP_TABLES_FILE) {
    fs.writeFileSync(file, JSON.stringify(reg, null, 2));
}

/** Which of `wanted` are not in the table yet (order preserved). */
export function missingAddresses(tableAddresses, wanted) {
    const have = new Set(tableAddresses.map(a => a.toBase58()));
    const out = [];
    const seen = new Set();
    for (const a of wanted) {
        const k = a.toBase58();
        if (!have.has(k) && !seen.has(k)) { out.push(a); seen.add(k); }
    }
    return out;
}

/** Split an array into chunks of n. */
export function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
}

async function fetchTable(ctx, address) {
    const res = await ctx.connection.getAddressLookupTable(address, { commitment: 'confirmed' });
    return res.value; // AddressLookupTableAccount | null
}

/**
 * Make sure a lookup table exists for `key` (the token mint) that contains
 * every address in `wanted`, creating/extending it as needed. Returns the
 * AddressLookupTableAccount ready to pass to compileToV0Message().
 */
export async function ensureLookupTable(ctx, key, wanted, { log = () => {}, file = LOOKUP_TABLES_FILE } = {}) {
    const registry = loadLookupTableRegistry(file);
    const main = ctx.mainWallet;
    let address = registry[key]?.address ? new PublicKey(registry[key].address) : null;
    let table = address ? await fetchTable(ctx, address) : null;

    if (table && table.state.authority && !table.state.authority.equals(main.publicKey)) {
        log(`Lookup table ${address.toBase58()} belongs to another authority — creating a new one`);
        table = null;
        address = null;
    }

    // Signature of the last create/extend we sent, if any. Leaders only load
    // addresses from a table once they have seen the extension, so the first
    // use right after extending can be dropped by nodes still catching up. We
    // wait for finalization once (a one-time ~13 s per token) to avoid that.
    let lastChangeSig = null;

    // --- create (and seed with the first chunk) ---
    if (!table) {
        const recentSlot = await ctx.connection.getSlot('finalized');
        const [createIx, newAddress] = AddressLookupTableProgram.createLookupTable({
            authority: main.publicKey,
            payer: main.publicKey,
            recentSlot,
        });
        const [first, ...rest] = chunk(wanted, EXTEND_CHUNK);
        const ixs = [createIx];
        if (first?.length) {
            ixs.push(AddressLookupTableProgram.extendLookupTable({
                payer: main.publicKey, authority: main.publicKey, lookupTable: newAddress, addresses: first,
            }));
        }
        log(`Creating lookup table ${newAddress.toBase58()} with ${first?.length || 0} address(es)...`);
        const r = await landTransaction(ctx, async () => ({ instructions: ixs, signers: [main], payer: main.publicKey }), { label: 'alt-create', log });
        if (!r.confirmed) throw new Error(`lookup table creation failed: ${JSON.stringify(r.err)}`);
        lastChangeSig = r.signature;
        address = newAddress;
        registry[key] = { address: address.toBase58(), createdAt: new Date().toISOString() };
        saveLookupTableRegistry(registry, file);
        for (const more of rest) lastChangeSig = await extend(ctx, address, more, log);
    } else {
        const missing = missingAddresses(table.state.addresses, wanted);
        if (missing.length) {
            log(`Lookup table ${address.toBase58()} is missing ${missing.length} address(es) — extending`);
            for (const part of chunk(missing, EXTEND_CHUNK)) lastChangeSig = await extend(ctx, address, part, log);
        }
    }

    if (lastChangeSig) {
        log('Waiting for the lookup table change to finalize (one-time)...');
        await waitFinalized(ctx, lastChangeSig);
    }

    // --- wait until the table is readable AND warm (addresses added in slot S
    //     are usable only from the next slot) ---
    const wantedSet = new Set(wanted.map(a => a.toBase58()));
    for (let i = 0; i < 40; i++) {
        table = await fetchTable(ctx, address);
        if (table) {
            const have = new Set(table.state.addresses.map(a => a.toBase58()));
            const complete = [...wantedSet].every(a => have.has(a));
            const slot = await ctx.connection.getSlot('confirmed');
            if (complete && slot > Number(table.state.lastExtendedSlot) + 1) return table;
        }
        await sleepMs(400);
    }
    throw new Error(`lookup table ${address.toBase58()} did not become ready`);
}

async function extend(ctx, address, addresses, log) {
    const main = ctx.mainWallet;
    const ix = AddressLookupTableProgram.extendLookupTable({
        payer: main.publicKey, authority: main.publicKey, lookupTable: address, addresses,
    });
    const r = await landTransaction(ctx, async () => ({ instructions: [ix], signers: [main], payer: main.publicKey }), { label: 'alt-extend', log });
    if (!r.confirmed) throw new Error(`lookup table extension failed: ${JSON.stringify(r.err)}`);
    return r.signature;
}
