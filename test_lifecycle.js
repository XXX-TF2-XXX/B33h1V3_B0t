/**
 * test_lifecycle.js — end-to-end check of the wallet lifecycle + recovery.
 *
 * Proves that funds are NEVER left behind and a wallet is always drained to
 * exactly zero. Uses tiny amounts; net cost is only a few transaction fees.
 *
 *   node test_lifecycle.js            # cheap tests (no trading): empty / fund / crash-recovery
 *   node test_lifecycle.js simulate   # FREE: build the wallet's buy tx and simulate it on mainnet
 *   node test_lifecycle.js cycle      # one REAL tiny cycle exactly like the bot: fund -> buy -> sell -> close+sweep
 *   node test_lifecycle.js trade      # legacy: real tiny buy via Jupiter, then drain
 *
 * Requires a configured .env with a funded main wallet.
 */

import {
    VersionedTransaction, Keypair, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import {
    SOL_MINT, createContext, resolveEngine, drainWallet, recoverAll, confirmSignature,
    fundWalletFromMain, getSolBalance, getTokenBalance, getJupiterQuote, getJupiterSwapTransaction,
    buyToken, buildJupiterSwap, readDrainState,
    appendActiveWallet, loadActiveWallets, removeActiveWallet, sleep,
} from './solUtils.js';
import { landTransaction, simulateInstructions, computeCuLimit } from './landing.js';
import { fetchSwapState, buildWalletBuyInstructions, walletAccountsSnapshot, minWalletBufferLamports, quoteBuy } from './pumpswap.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Tests keep their own ledger so they never touch the live bot's file.
const WALLETS_FILE = path.join(__dirname, 'active_wallets.test.json');

const ctx = createContext(process.env);
const main = ctx.mainWallet;
const FUND = Math.floor(Number(process.env.SOL_TRANSFER_AMOUNT || 0.005) * LAMPORTS_PER_SOL);
const TINY_BUY = Math.floor(Number(process.env.MIN_BUY_AMOUNT || 0.005) * LAMPORTS_PER_SOL);

const sol = (lamports) => (lamports / LAMPORTS_PER_SOL).toFixed(6);
const results = [];
function record(name, pass, detail) {
    results.push({ name, pass });
    console.log(`  ${pass ? '✅ PASS' : '❌ FAIL'} — ${name}${detail ? `  (${detail})` : ''}`);
}
const say = (m) => console.log(`    ${m}`);

// Send SOL from the main wallet and wait until it confirms.
async function fundWallet(toPubkey, lamports) {
    const r = await fundWalletFromMain(ctx, toPubkey, lamports, say);
    if (!r.confirmed) throw new Error(`funding tx did not confirm: ${JSON.stringify(r.err)}`);
    return r;
}

async function testEmptyDrain() {
    console.log('\n[1] Drain a brand-new empty wallet (should be a clean no-op)');
    const w = Keypair.generate();
    const d = await drainWallet(ctx, w, { log: say });
    record('empty wallet drains cleanly', d.ok && d.solSwept === 0 && d.solFromSale === 0);
}

async function testFundDrain() {
    console.log('\n[2] Fund a fresh wallet, then drain it back to zero');
    const w = Keypair.generate();
    console.log(`    funding ${w.publicKey.toBase58()} with ${sol(FUND)} SOL...`);
    await fundWallet(w.publicKey, FUND);

    const before = await getSolBalance(ctx, w.publicKey);
    const mainBefore = await getSolBalance(ctx, main.publicKey);
    console.log(`    wallet balance after funding: ${sol(before)} SOL`);

    const d = await drainWallet(ctx, w, { log: say });
    await sleep(1);
    const after = await getSolBalance(ctx, w.publicKey);
    const mainAfter = await getSolBalance(ctx, main.publicKey);

    console.log(`    wallet balance after drain:   ${sol(after)} SOL (swept ${d.solSwept.toFixed(6)})`);
    record('funded wallet drains to exactly 0', after === 0 && d.ok, `wallet=${sol(after)}`);
    record('main wallet received the swept SOL', mainAfter > mainBefore, `+${sol(mainAfter - mainBefore)} net`);
}

async function testCrashRecovery() {
    console.log('\n[3] Simulate a crash: fund a wallet, write it to active_wallets.json, then run recovery');
    const w = Keypair.generate();
    await fundWallet(w.publicKey, FUND);
    appendActiveWallet(WALLETS_FILE, {
        publicKey: w.publicKey.toBase58(),
        privateKey: bs58.encode(w.secretKey),
        createdAt: new Date().toISOString(),
    });
    console.log('    wrote wallet to ledger as if the bot crashed mid-cycle.');

    const totals = await recoverAll(ctx, WALLETS_FILE, (m) => console.log(`    ${m}`));
    await sleep(1);
    const after = await getSolBalance(ctx, w.publicKey);
    const stillListed = loadActiveWallets(WALLETS_FILE).some(e => e.publicKey === w.publicKey);

    record('recover.js drains the crashed wallet to 0', after === 0 && !stillListed, `recovered ${totals.total.toFixed(6)} SOL`);
}

// FREE: build the wallet-paid buy transaction and simulate it on mainnet. The
// simulation needs a payer with SOL, so the main wallet stands in as the
// "trading wallet" — same instructions, same accounts, nothing sent.
async function testSimulate() {
    console.log('\n[S] Direct engine: build the buy tx (wallet pays) and simulate it — no SOL spent');
    if (ctx.engine !== 'pumpswap') {
        const t0 = Date.now();
        const built = await buildJupiterSwap(ctx, main, SOL_MINT, ctx.tokenAddress, TINY_BUY);
        say(`Jupiter quote+instructions in ${Date.now() - t0}ms | ${sol(TINY_BUY)} SOL -> ${built.expected.outAmount} tokens | ${built.instructions.length} ix, ${built.lookupTables.length} lookup table(s)`);
        const { blockhash } = await ctx.connection.getLatestBlockhash('confirmed');
        try {
            const sim = await simulateInstructions(ctx, { payer: main.publicKey, instructions: built.instructions, lookupTables: built.lookupTables, blockhash });
            record('Jupiter buy simulates successfully', true, `${sim.unitsConsumed} CU -> limit ${computeCuLimit(sim.unitsConsumed)}`);
        } catch (e) {
            record('Jupiter buy simulates successfully', false, e.message);
            (e.logs || []).slice(-10).forEach(say);
        }
        return;
    }
    const t0 = Date.now();
    const state = await fetchSwapState(ctx, main.publicKey);
    const q = quoteBuy(ctx, state, TINY_BUY);
    say(`state in ${Date.now() - t0}ms | pool SOL reserve ${sol(Number(state.poolQuoteAmount))} | ${sol(TINY_BUY)} SOL -> ${q.baseOut.toString()} tokens (max in ${q.maxQuoteIn.toString()})`);
    say(`min wallet buffer for this buy: ${sol(minWalletBufferLamports(ctx, TINY_BUY))} SOL (all returned on drain)`);
    const built = await buildWalletBuyInstructions(ctx, state, main, TINY_BUY);
    const { blockhash } = await ctx.connection.getLatestBlockhash('confirmed');
    try {
        const t1 = Date.now();
        const sim = await simulateInstructions(ctx, { payer: main.publicKey, instructions: built.instructions, lookupTables: built.lookupTables, blockhash });
        record('buy simulates successfully', true, `${sim.unitsConsumed} CU -> limit ${computeCuLimit(sim.unitsConsumed)}, ${Date.now() - t1}ms`);
    } catch (e) {
        record('buy simulates successfully', false, e.message);
        (e.logs || []).slice(-10).forEach(say);
    }
}

// REAL: one tiny cycle exactly as the bot runs it.
async function testCycle() {
    console.log('\n[4] REAL tiny cycle, exactly like the bot: fund -> buy (wallet signs) -> sell (wallet signs) -> close + sweep');
    const w = Keypair.generate();
    appendActiveWallet(WALLETS_FILE, { publicKey: w.publicKey.toBase58(), privateKey: bs58.encode(w.secretKey), createdAt: new Date().toISOString() });
    const buffer = Math.max(FUND, minWalletBufferLamports(ctx, TINY_BUY));
    say(`wallet ${w.publicKey.toBase58()} | buy ${sol(TINY_BUY)} SOL | buffer ${sol(buffer)} SOL`);
    const mainBefore = await getSolBalance(ctx, main.publicKey);
    const tCycle = Date.now();
    let gas = 0;
    const tally = (s) => { if (s) gas += s.gasLamports || 0; };

    // fund
    const fund = await fundWallet(w.publicKey, TINY_BUY + buffer);
    tally(fund.stats);
    record('fund lands', fund.confirmed, `${fund.stats.landMs}ms via ${fund.stats.via}`);

    // buy (wallet pays + signs)
    // Same call the bot makes, on either engine, through the landing layer.
    const buy = await buyToken(ctx, w, TINY_BUY, { label: 'buy', log: say });
    tally(buy.stats);
    record('buy lands (signed + paid by the fresh wallet)', buy.confirmed, buy.stats ? `${buy.stats.landMs}ms via ${buy.stats.via}, ${buy.stats.feeLevel}, CU ${buy.stats.cuLimit} @ ${buy.stats.cuPrice} µL, gas ${buy.stats.gasLamports} lamports, ${buy.stats.bytes} bytes` : JSON.stringify(buy.err));
    if (buy.signature) say(`https://solscan.io/tx/${buy.signature}`);
    if (buy.confirmed) {
        const tokBal = await getTokenBalance(ctx, w.publicKey);
        record('wallet holds tokens after buy', tokBal > 0n, `${tokBal} raw units`);
    }

    // drain (sell, then close + sweep) — wallet pays + signs both
    const d = await drainWallet(ctx, w, { log: say });
    tally(d.sellStats);
    tally(d.sweepStats);
    if (d.sellSignature) say(`sell:  https://solscan.io/tx/${d.sellSignature}`);
    if (d.signature) say(`sweep: https://solscan.io/tx/${d.signature}`);
    record('sell lands', d.tokensSold, d.sellStats ? `${d.sellStats.landMs}ms via ${d.sellStats.via}, gas ${d.sellStats.gasLamports} lamports` : (d.error || 'no sell'));
    record('close + sweep lands', !!d.signature && !d.error, d.sweepStats ? `${d.sweepStats.landMs}ms via ${d.sweepStats.via}, swept ${d.solSwept.toFixed(6)} + rent ${d.rentReclaimed.toFixed(6)} SOL` : (d.error || ''));

    await sleep(1);
    // Every account the wallet could own on either engine: SOL, token account,
    // WSOL account, PumpSwap PDA, pump.fun curve PDA.
    const s = await readDrainState(ctx, w.publicKey);
    const end = { lamports: s.lamports, empty: s.lamports === 0 && !s.tokenAtaInfo && !s.wsolAtaInfo && !s.hasAccumulator && !s.hasPumpfunAccumulator };
    record('wallet ends at exactly zero (no SOL, no accounts, no PDA)', end.empty && d.ok,
        `lamports=${s.lamports} tokenAcct=${!!s.tokenAtaInfo} wsol=${!!s.wsolAtaInfo} pumpswapPda=${s.hasAccumulator} curvePda=${s.hasPumpfunAccumulator}`);
    if (end.empty && d.ok) removeActiveWallet(WALLETS_FILE, w.publicKey.toBase58());

    const mainAfter = await getSolBalance(ctx, main.publicKey);
    const ms = Date.now() - tCycle;
    say(`cycle ${ms}ms | gas ${gas} lamports (${sol(gas)} SOL) | main net ${sol(mainAfter - mainBefore)} SOL (gas + pool swap fees + price move)`);
    record('cycle under 10 seconds', ms < 10000, `${ms}ms`);
}

// Legacy: real tiny buy via Jupiter, then drain.
async function testRealTradeDrain() {
    console.log('\n[5] Legacy: real tiny buy via Jupiter (creates a token account + balance), then drain');
    const w = Keypair.generate();
    console.log(`    wallet ${w.publicKey.toBase58()}`);
    await fundWallet(w.publicKey, TINY_BUY + FUND);

    const quote = await getJupiterQuote(ctx, SOL_MINT, ctx.tokenAddress, TINY_BUY);
    if (!quote?.outAmount) { record('real-trade drain', false, 'no Jupiter buy route'); return; }
    const swap = await getJupiterSwapTransaction(ctx, quote, w.publicKey);
    const buyTx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
    buyTx.sign([w]);
    const buySig = await ctx.connection.sendTransaction(buyTx, { skipPreflight: true, maxRetries: 3 });
    const br = await confirmSignature(ctx, buySig);
    if (!br.confirmed) { record('real-trade drain', false, `buy did not land: ${JSON.stringify(br.err)}`); return; }

    const tokBal = await getTokenBalance(ctx, w.publicKey);
    console.log(`    bought ${tokBal.toString()} tokens. Draining...`);

    const d = await drainWallet(ctx, w, { log: say });
    await sleep(1);
    const solAfter = await getSolBalance(ctx, w.publicKey);
    const tokAfter = await getTokenBalance(ctx, w.publicKey);

    console.log(`    after drain: ${sol(solAfter)} SOL, ${tokAfter.toString()} tokens`);
    record('token-holding wallet fully drained (0 SOL, 0 tokens)', solAfter === 0 && tokAfter === 0n && d.ok,
        `sold ${d.solFromSale.toFixed(6)} + rent ${d.rentReclaimed.toFixed(6)} + swept ${d.solSwept.toFixed(6)}`);
}

async function run() {
    const mode = process.argv[2] || '';
    console.log('================================================');
    console.log(' B33h1V3_B0t — wallet lifecycle & recovery test');
    console.log('================================================');
    console.log(`Main wallet: ${main.publicKey.toBase58()}`);
    const bal = await getSolBalance(ctx, main.publicKey);
    console.log(`Main balance: ${sol(bal)} SOL`);
    if (bal < FUND * 4) console.log('⚠️  Main wallet looks low — fund it before running the test.');

    if (mode === 'simulate') ctx.skipLookupTable = true; // free: never create a table
    await resolveEngine(ctx, (m) => console.log(m));

    if (mode === 'simulate') {
        await testSimulate();
    } else if (mode === 'cycle') {
        await testCycle();
    } else {
        await testEmptyDrain();
        await testFundDrain();
        await testCrashRecovery();
        if (mode === 'trade') await testRealTradeDrain();
        else console.log('\nSkipped real-trade tests. Options:  node test_lifecycle.js simulate | cycle | trade');
    }

    const passed = results.filter(r => r.pass).length;
    console.log('\n================================================');
    console.log(` RESULT: ${passed}/${results.length} checks passed`);
    console.log('================================================');
    process.exit(passed === results.length ? 0 : 1);
}

run().catch(e => { console.error(`Test crashed: ${e.message}`); if (e.logs) console.error(e.logs.slice(-10).join('\n')); process.exit(1); });
