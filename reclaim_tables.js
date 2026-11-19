/**
 * reclaim_tables.js — get back the SOL locked in old address lookup tables.
 *
 * The direct PumpSwap engine creates one lookup table per token (its rent,
 * ~0.01-0.02 SOL, is paid by the main wallet). A table for a token you no
 * longer trade can be closed and its rent returned: first it is deactivated,
 * then — once the network's ~512-slot cooldown passes (about 4 minutes) — it
 * is closed and the rent goes back to the main wallet.
 *
 *   node reclaim_tables.js          # every table EXCEPT the current TOKEN_ADDRESS's
 *   node reclaim_tables.js --all    # include the current token's table too
 *
 * Safe to re-run: it picks up where it left off. The bot simply makes a new
 * table if you ever trade a reclaimed token again.
 */

import { AddressLookupTableProgram, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import dotenv from 'dotenv';

import { createContext, getSolBalance, sleep } from './solUtils.js';
import { landTransaction } from './landing.js';
import { loadLookupTableRegistry, saveLookupTableRegistry } from './lookupTable.js';

dotenv.config();
const ctx = createContext(process.env);
const main = ctx.mainWallet;
const includeCurrent = process.argv.includes('--all');
const sol = (l) => (l / LAMPORTS_PER_SOL).toFixed(6);
const say = (m) => console.log(`  ${m}`);
const NOT_DEACTIVATED = 18446744073709551615n;

async function reclaim(mint, address) {
    const key = new PublicKey(address);
    const res = await ctx.connection.getAddressLookupTable(key);
    const table = res.value;
    if (!table) { say(`${address}: already closed`); return { done: true, lamports: 0 }; }
    if (!table.state.authority || !table.state.authority.equals(main.publicKey)) {
        say(`${address}: not owned by this main wallet — skipped`);
        return { done: false, lamports: 0 };
    }
    const info = await ctx.connection.getAccountInfo(key);
    const lamports = info?.lamports || 0;
    say(`${address} (token ${mint.slice(0, 6)}…): ${sol(lamports)} SOL locked`);

    if (BigInt(table.state.deactivationSlot) === NOT_DEACTIVATED) {
        const ix = AddressLookupTableProgram.deactivateLookupTable({ lookupTable: key, authority: main.publicKey });
        const r = await landTransaction(ctx, async () => ({ instructions: [ix], signers: [main], payer: main.publicKey }), { label: 'deactivate', log: say });
        if (!r.confirmed) throw new Error(`deactivate failed: ${JSON.stringify(r.err)}`);
        say(`deactivated (${r.signature}); waiting out the ~4 minute cooldown...`);
    } else {
        say('already deactivated; waiting for the cooldown to end...');
    }

    const ix = AddressLookupTableProgram.closeLookupTable({ lookupTable: key, authority: main.publicKey, recipient: main.publicKey });
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
        try {
            // landTransaction simulates first, so while the cooldown is still
            // running the close fails in simulation and costs nothing.
            const r = await landTransaction(ctx, async () => ({ instructions: [ix], signers: [main], payer: main.publicKey }), { label: 'close', log: () => {} });
            if (r.confirmed) { say(`closed: +${sol(lamports)} SOL back (${r.signature})`); return { done: true, lamports }; }
            say(`close did not land (${JSON.stringify(r.err)}); retrying`);
        } catch {
            // still cooling down
        }
        await sleep(20);
    }
    say('cooldown not over yet — run this again in a few minutes');
    return { done: false, lamports: 0 };
}

const registry = loadLookupTableRegistry();
const targets = Object.entries(registry).filter(([mint]) => includeCurrent || mint !== ctx.tokenAddress);
console.log(`Lookup tables to reclaim: ${targets.length}`);
const before = await getSolBalance(ctx, main.publicKey);
for (const [mint, entry] of targets) {
    try {
        const r = await reclaim(mint, entry.address);
        if (r.done) {
            delete registry[mint];
            saveLookupTableRegistry(registry);
        }
    } catch (e) {
        say(`${entry.address}: ${e.message}`);
    }
}
const after = await getSolBalance(ctx, main.publicKey);
console.log(`Main wallet: ${sol(before)} -> ${sol(after)} SOL`);
process.exit(0);
