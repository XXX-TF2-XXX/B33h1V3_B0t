/**
 * B33h1V3_B0t V2.4 — open-source Solana volume bot
 *
 * Two kinds of trading wallet run side by side. Both sign and pay for their
 * own buys and sells (each is the trader on-chain), both are logged to
 * active_wallets.json the moment they are created, and both end drained to
 * exactly zero and retired.
 *
 *   RECYCLERS (WALLET_CONCURRENCY at once): a fresh wallet per trade.
 *     fund -> buy -> sell -> close + sweep -> retire
 *
 *   VETERANS (VETERAN_WALLETS at once): funded once, then several visits
 *     with random waits between them (each visit = buy+sell, or buy and hold
 *     until the next visit, or sell what it held), then drained and retired
 *     and replaced by a new veteran. 1-2 transactions per visit instead of 4.
 *
 * Every transaction goes through the landing layer (landing.js): free
 * simulation first (a failing tx costs nothing), exact compute limit, dynamic
 * priority fee under your cap, Sender + RPC, rebroadcast, rebuild on expiry.
 */

import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
    SOL_MINT, getJupiterQuote, fetchSwapStateForPreflight,
    createContext, resolveEngine, checkGraduation, getTokenProgramId, getSolBalance,
    buyToken, sellWithRetry, drainWallet, readDrainState, recoverAll, rentExemptEmptyAccount,
    fundWalletFromMain, appendActiveWallet, removeActiveWallet, loadActiveWallets, sleep,
} from './solUtils.js';
import { senderUrl, SENDER_TIP_LAMPORTS } from './landing.js';
import { minWalletBufferLamports } from './pumpswap.js';
import {
    parseVeteranConfig, intSetting, randInt, decideHold, veteranReserveLamports, veteranBuyLamports,
} from './veteran.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHUTDOWN_FILE = path.join(__dirname, '.shutdown');
// LEDGER_FILE lets tests use their own ledger instead of the live one.
const WALLETS_FILE = process.env.LEDGER_FILE ? path.resolve(process.env.LEDGER_FILE) : path.join(__dirname, 'active_wallets.json');

// ============================================================
// LOGGING
// ============================================================
// Every run is also saved to logs/run-<start time>.log so a session can be
// audited afterwards (the GUI window's log is lost when it closes).
const LOG_FILE = (() => {
    try {
        const dir = path.join(__dirname, 'logs');
        fs.mkdirSync(dir, { recursive: true });
        return path.join(dir, `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.log`);
    } catch { return null; }
})();
function emit(stream, level, msg, data) {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    stream(line, data);
    if (LOG_FILE) {
        try { fs.appendFileSync(LOG_FILE, `${line}${data ? ' ' + (typeof data === 'string' ? data : JSON.stringify(data)) : ''}\n`); } catch {}
    }
}
const log = {
    info: (msg, data = '') => emit(console.log, 'INFO', msg, data),
    success: (msg, data = '') => emit(console.log, 'SUCCESS', msg, data),
    warn: (msg, data = '') => emit(console.warn, 'WARN', msg, data),
    error: (msg, data = '') => emit(console.error, 'ERROR', msg, data),
};

// ============================================================
// CONFIG VALIDATION
// ============================================================
function validateConfig() {
    const required = ['RPC_ENDPOINT', 'KEY', 'TOKEN_ADDRESS', 'MIN_BUY_AMOUNT', 'MAX_BUY_AMOUNT', 'PRIORITY_FEE', 'DELAY'];
    const missing = required.filter(key => !process.env[key]);
    if (missing.length > 0) {
        log.error(`Missing required environment variables: ${missing.join(', ')}`);
        log.error('Please check your .env file and ensure all required variables are set.');
        process.exit(1);
    }

    // Friendly errors for a fresh install: template text left in place, or a
    // key that isn't a base58 private key.
    const placeholders = ['RPC_ENDPOINT', 'KEY', 'TOKEN_ADDRESS'].filter(k => /PUT_YOUR|YOUR_|_HERE/i.test(process.env[k] || ''));
    if (placeholders.length > 0) {
        log.error(`These settings still contain placeholder text: ${placeholders.join(', ')}`);
        log.error('Open the app and click Save Config, or edit .env and replace every PUT_YOUR_..._HERE value.');
        process.exit(1);
    }
    try {
        const secret = bs58.decode(process.env.KEY.trim());
        if (secret.length !== 64) throw new Error(`decoded to ${secret.length} bytes, expected 64`);
    } catch (e) {
        log.error(`KEY is not a valid Solana private key (${e.message}).`);
        log.error('Export it from your wallet app in base58 form (Phantom: Settings > Security & Privacy > Export Private Key). Do not use a seed phrase.');
        process.exit(1);
    }

    const minBuy = Number(process.env.MIN_BUY_AMOUNT);
    const maxBuy = Number(process.env.MAX_BUY_AMOUNT);
    if (!(minBuy > 0) || !(minBuy < maxBuy)) {
        log.error('MIN_BUY_AMOUNT must be above 0 and less than MAX_BUY_AMOUNT');
        process.exit(1);
    }

    if (!(process.env.JUPITER_API_KEY || '').trim()) {
        log.info('No JUPITER_API_KEY set — using the free keyless lite-api.jup.ag tier.');
    }

    log.success('Configuration validated successfully');
}

validateConfig();

// ============================================================
// INITIALIZATION
// ============================================================
const ctx = createContext(process.env);
const { mainWallet } = ctx;

const minBuyLamports = Math.floor(Number(process.env.MIN_BUY_AMOUNT) * LAMPORTS_PER_SOL);
const maxBuyLamports = Math.floor(Number(process.env.MAX_BUY_AMOUNT) * LAMPORTS_PER_SOL);
const bufferLamports = Math.floor(Number(process.env.SOL_TRANSFER_AMOUNT || 0.01) * LAMPORTS_PER_SOL);
const recyclerCount = Math.max(0, Math.min(10, intSetting(process.env.WALLET_CONCURRENCY, 3)));
const vet = parseVeteranConfig(process.env);
const delaySec = Math.max(0, Number(process.env.DELAY) || 0);
// Keep this much SOL untouched in the main wallet so concurrent funding never
// overdraws it (a wallet that can't be funded is skipped, not failed).
const mainReserveLamports = Math.floor(0.01 * LAMPORTS_PER_SOL);

if (recyclerCount + vet.count === 0) {
    log.error('Nothing to run: set Concurrency (recyclers) and/or Veteran Wallets above 0.');
    process.exit(1);
}

let cycleCount = 0;
let isShuttingDown = false;
const inUse = new Set();        // wallets a worker is currently handling (janitor skips them)
let fundingInFlight = 0;        // lamports being sent from main right now
let bufferWarned = false;

// Running totals, reported periodically and on shutdown.
const totals = {
    recyclerCycles: 0, okCycles: 0, veterans: 0, visits: 0,
    buys: 0, sells: 0, volumeLamports: 0,
    gasLamports: 0, txCount: 0, txLandMs: 0, cycleMs: 0,
};
let mainStartLamports = null;

const sol = (l) => (l / LAMPORTS_PER_SOL).toFixed(6);

function tally(stats) {
    if (!stats) return;
    totals.gasLamports += stats.gasLamports || 0;
    totals.txCount++;
    totals.txLandMs += stats.landMs || 0;
}

// ============================================================
// STARTUP LOGGING
// ============================================================
log.info('='.repeat(50));
log.info('B33h1V3_B0t V2.4 - Recyclers + Veterans');
log.info('='.repeat(50));
log.info(`Main Wallet: ${mainWallet.publicKey.toBase58()}`);
log.info(`Token Address: ${ctx.tokenAddress}`);
log.info(`Buy Range: ${process.env.MIN_BUY_AMOUNT} - ${process.env.MAX_BUY_AMOUNT} SOL`);
log.info(`Wallet Buffer: ${sol(bufferLamports)} SOL (returned every time)`);
log.info(`Priority: dynamic, ${ctx.landing.baseFeeLevel}, cap ${sol(ctx.priorityMaxLamports)} SOL/tx`);
log.info(`Slippage: ${ctx.slippageBps} bps (${(ctx.slippageBps / 100).toFixed(2)}%)`);
log.info(`Jupiter: ${ctx.jupiterHost} (${ctx.jupiterApiKey ? 'with key' : 'free keyless tier'})`);
log.info(`Recyclers: ${recyclerCount} at once | Delay ${delaySec}s between cycles`);
log.info(vet.count > 0
    ? `Veterans: ${vet.count} at once | ${vet.minTrades}-${vet.maxTrades} trades each | hold ${vet.holdPct}% | wait ${vet.waitMin}-${vet.waitMax}s between visits`
    : 'Veterans: off');
log.info('='.repeat(50));

// ============================================================
// SHUTDOWN HELPERS
// ============================================================
function checkShutdownFile() {
    if (fs.existsSync(SHUTDOWN_FILE)) {
        log.warn('Shutdown file detected. Finishing up...');
        try { fs.unlinkSync(SHUTDOWN_FILE); } catch {}
        return true;
    }
    return false;
}

// Clean up any leftover shutdown file on startup.
try { fs.unlinkSync(SHUTDOWN_FILE); } catch {}

process.on('SIGINT', () => { log.warn('Received SIGINT. Shutting down gracefully...'); isShuttingDown = true; });
process.on('SIGTERM', () => { log.warn('Received SIGTERM. Shutting down gracefully...'); isShuttingDown = true; });
// A stray rejection must never take the process down while wallets hold funds.
process.on('unhandledRejection', (e) => { log.error(`Unhandled error (continuing): ${e?.message || e}`); });

// Sleep that bails out early if a shutdown is requested mid-wait.
async function interruptibleSleep(seconds) {
    const end = Date.now() + (Number(seconds) || 0) * 1000;
    while (Date.now() < end) {
        if (isShuttingDown || checkShutdownFile()) { isShuttingDown = true; return; }
        await sleep(Math.min(1, (end - Date.now()) / 1000));
    }
    if (checkShutdownFile()) isShuttingDown = true;
}

// ============================================================
// SHARED WALLET HELPERS
// ============================================================
function newLedgerWallet(role, extra = {}) {
    const wallet = Keypair.generate();
    const entry = {
        publicKey: wallet.publicKey.toBase58(),
        privateKey: bs58.encode(wallet.secretKey),
        createdAt: new Date().toISOString(),
        role, ...extra,
    };
    appendActiveWallet(WALLETS_FILE, entry);   // persisted BEFORE any SOL is sent
    inUse.add(entry.publicKey);
    return { wallet, entry };
}

/**
 * Fund a new wallet from main, unless that would dip main below its reserve
 * (counting funding other workers have in flight). { skipped: true } means
 * nothing was sent.
 */
async function fundFromMain(label, wallet, lamports) {
    fundingInFlight += lamports;
    try {
        const mainBal = await getSolBalance(ctx, mainWallet.publicKey);
        if (mainBal - (fundingInFlight - lamports) < lamports + mainReserveLamports) {
            return { skipped: true, mainBal };
        }
        const r = await fundWalletFromMain(ctx, wallet.publicKey, lamports, (m) => log.info(`[${label}] ${m}`));
        if (r.confirmed) fundedOut.set(wallet.publicKey.toBase58(), lamports);
        return r;
    } finally {
        fundingInFlight -= lamports;
    }
}

function walletBuffer(buyLamports) {
    // The wallet fronts its own rents (token account, wrapped-SOL account,
    // per-user PDA) and fees; all of it comes back on the drain. Make sure
    // the buffer covers that, so a cycle can never fail for gas.
    const minBuffer = minWalletBufferLamports(ctx, buyLamports);
    if (bufferLamports >= minBuffer) return bufferLamports;
    if (!bufferWarned) {
        log.warn(`Wallet Buffer ${sol(bufferLamports)} SOL is below the ${sol(minBuffer)} SOL a wallet needs — using the minimum (it is all returned).`);
        bufferWarned = true;
    }
    return minBuffer;
}

// Consecutive failed buys across all workers. Five in a row means something
// outside the bot is wrong (token not tradable right now, RPC down...), so
// workers pause instead of paying fund+sweep fees on cycles that can't trade.
let buyFailStreak = 0;
const BUY_FAIL_PAUSE_AFTER = 5;
const buyFailReasons = new Map();   // short reason -> count, for the session report
function noteBuyResult(ok, reason) {
    buyFailStreak = ok ? 0 : buyFailStreak + 1;
    if (!ok) {
        const key = String(reason || 'unknown').replace(/\s+/g, ' ').slice(0, 120);
        buyFailReasons.set(key, (buyFailReasons.get(key) || 0) + 1);
    }
}
async function pauseIfFailing(label) {
    if (buyFailStreak < BUY_FAIL_PAUSE_AFTER) return;
    log.warn(`[${label}] ${buyFailStreak} buys in a row failed — pausing 60s (check the token is still tradable and the RPC is up)`);
    await interruptibleSleep(60);
    if (buyFailStreak >= BUY_FAIL_PAUSE_AFTER) buyFailStreak = BUY_FAIL_PAUSE_AFTER - 1; // one probe cycle, then pause again if it fails
}

// ---- live stats for the GUI's "This Run" box ----------------------------
// One machine-readable line per update ("@@STATS {...}"); the GUI shows it in
// the box and keeps it out of the log. Not written to the log file.
const fundedOut = new Map();   // live wallet -> lamports main sent it (for "spent so far")
let lastSpentLamports = null;
function emitStats() {
    console.log('@@STATS ' + JSON.stringify({
        volumeSol: totals.volumeLamports / LAMPORTS_PER_SOL,
        buys: totals.buys,
        sells: totals.sells,
        feesSol: totals.gasLamports / LAMPORTS_PER_SOL,
        spentSol: lastSpentLamports == null ? null : lastSpentLamports / LAMPORTS_PER_SOL,
        liveWallets: inUse.size,
    }));
}

function recordBuy(lamports) { totals.buys++; totals.volumeLamports += Number(lamports); emitStats(); }
function recordSell(lamportsReceived) { totals.sells++; totals.volumeLamports += Number(lamportsReceived || 0); emitStats(); }

/**
 * Drain a wallet to zero (sell anything held, close every account, sweep all
 * SOL to main), retrying once after a short pause. Never throws. Removes the
 * wallet from the ledger only when it is verifiably empty.
 */
async function drainAndRetire(label, wallet, entry, { keepListed = false, expectTokens = false } = {}) {
    let drain = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            drain = await drainWallet(ctx, wallet, { log: (m) => log.info(`[${label}] ${m}`), expectTokens });
        } catch (e) {
            drain = { ok: false, error: e.message, solSwept: 0, rentReclaimed: 0 };
        }
        tally(drain.sellStats);
        tally(drain.sweepStats);
        if (drain.tokensSold) recordSell(drain.lamportsFromSale);
        if (drain.ok) break;
        if (attempt === 1) {
            log.warn(`[${label}] Drain incomplete (${JSON.stringify(drain.leftover || drain.error)}) — retrying in 3s`);
            await sleep(3);
        }
    }
    const returned = (drain.solSwept || 0) + (drain.rentReclaimed || 0);
    if (drain.ok) {
        log.success(`[${label}] Returned ${returned.toFixed(6)} SOL to main (swept ${(drain.solSwept || 0).toFixed(6)} + rent ${(drain.rentReclaimed || 0).toFixed(6)})`);
        if (!keepListed) {
            removeActiveWallet(WALLETS_FILE, entry.publicKey);
            log.info(`[${label}] Wallet drained to zero and retired.`);
        } else {
            log.warn(`[${label}] Drained, but kept listed for a later re-check (its buy never confirmed).`);
        }
    } else {
        log.warn(`[${label}] Wallet not fully drained (${JSON.stringify(drain.leftover || drain.error)}) — kept in the ledger; the cleanup pass will retry it.`);
    }
    inUse.delete(entry.publicKey);
    return drain;
}

// ============================================================
// RECYCLER — one fresh wallet per trade
// ============================================================
async function runCycle(label) {
    const tCycle = Date.now();
    const buyAmount = randInt(minBuyLamports, maxBuyLamports);
    const fundingAmount = buyAmount + walletBuffer(buyAmount);

    const { wallet, entry } = newLedgerWallet('recycler');
    log.info(`[${label}] New wallet ${entry.publicKey} | buy ${sol(buyAmount)} SOL`);

    let buyConfirmed = false;
    try {
        // 1. Fund (main -> wallet).
        const fund = await fundFromMain(label, wallet, fundingAmount);
        if (fund.skipped) {
            removeActiveWallet(WALLETS_FILE, entry.publicKey);  // nothing was sent
            inUse.delete(entry.publicKey);
            log.warn(`[${label}] Main wallet low (${sol(fund.mainBal)} SOL) — skipping cycle.`);
            await interruptibleSleep(10);
            return;
        }
        tally(fund.stats);
        if (!fund.confirmed) throw new Error(`funding did not confirm: ${JSON.stringify(fund.err)}`);

        // 2. Buy — signed and paid by the fresh wallet.
        const buy = await buyToken(ctx, wallet, buyAmount, { label: `${label} buy`, log: (m) => log.info(m) });
        tally(buy.stats);
        buyConfirmed = buy.confirmed;
        noteBuyResult(buyConfirmed, `not confirmed: ${typeof buy.err === 'string' ? buy.err : JSON.stringify(buy.err)}`);
        if (buyConfirmed) {
            recordBuy(buyAmount);
            log.success(`[${label}] Buy landed in ${buy.stats.landMs}ms via ${buy.stats.via}: ${buy.signature}`);
        } else {
            log.warn(`[${label}] Buy not confirmed (${JSON.stringify(buy.err)}) after ${buy.attempts} attempt(s). Draining...`);
        }
    } catch (error) {
        const http = error.response ? `HTTP ${error.response.status} ${JSON.stringify(error.response.data || '').slice(0, 80)}` : '';
        noteBuyResult(false, `${error.message}${http ? ' | ' + http : ''}${error.logs?.length ? ' | ' + error.logs.slice(-1)[0] : ''}`);
        log.error(`[${label}] Cycle step failed: ${error.message}${http ? ` (${http})` : ''}. Draining wallet...`);
        if (error.logs?.length) log.error(`[${label}] sim: ${error.logs.slice(-3).join(' | ')}`);
    }

    // 3. Drain (sell, close every account, sweep to zero), then retire.
    //    An unconfirmed buy can't land later (its blockhash expired), but
    //    keep it listed anyway so the cleanup pass re-checks it once.
    const drain = await drainAndRetire(label, wallet, entry, { keepListed: !buyConfirmed, expectTokens: buyConfirmed });

    const ms = Date.now() - tCycle;
    totals.recyclerCycles++;
    totals.cycleMs += ms;
    if (drain.ok && buyConfirmed && drain.tokensSold) totals.okCycles++;
    log.info(`[${label}] Cycle ${ms}ms`);
}

async function recyclerWorker(id) {
    while (!isShuttingDown) {
        if (checkShutdownFile()) { isShuttingDown = true; break; }
        await pauseIfFailing(`r${id}`);
        if (isShuttingDown) break;
        const label = `r${id}#${++cycleCount}`;
        log.info(`[${label}] --- Cycle starting ---`);
        try {
            await runCycle(label);
        } catch (error) {
            log.error(`[${label}] Cycle failed: ${error.message}`);
            if (error.response?.data) log.error('API Response:', JSON.stringify(error.response.data));
            await interruptibleSleep(5);
        }
        if (isShuttingDown) break;
        await interruptibleSleep(delaySec);
    }
}

// ============================================================
// VETERAN — funded once, several visits, then retired
// ============================================================
async function runVeteran(id) {
    const life = randInt(vet.minTrades, vet.maxTrades);
    const fundingAmount = maxBuyLamports + walletBuffer(maxBuyLamports);
    const { wallet, entry } = newLedgerWallet('veteran', { trades: life });
    const tag = `v${id}:${entry.publicKey.slice(0, 4)}`;
    totals.veterans++;
    let started = true;
    let holding = false;   // holds tokens bought on an earlier visit

    try {
        const fund = await fundFromMain(tag, wallet, fundingAmount);
        if (fund.skipped) {
            started = false;   // nothing was sent: no drain needed
            removeActiveWallet(WALLETS_FILE, entry.publicKey);
            inUse.delete(entry.publicKey);
            totals.veterans--;
            log.warn(`[${tag}] Main wallet low (${sol(fund.mainBal)} SOL) — veteran not started.`);
            await interruptibleSleep(15);
            return;
        }
        tally(fund.stats);
        if (!fund.confirmed) throw new Error(`funding did not confirm: ${JSON.stringify(fund.err)}`);
        log.info(`[${tag}] New veteran ${entry.publicKey} | funded ${sol(fundingAmount)} SOL | ${life} trade(s) planned`);

        const tipLamports = SENDER_TIP_LAMPORTS[ctx.landing.senderMode] || 0;
        const rentFloor = await rentExemptEmptyAccount(ctx);

        for (let visit = 1; visit <= life && !isShuttingDown; visit++) {
            const label = `${tag} #${visit}/${life}`;
            totals.visits++;
            if (holding) {
                // This visit sells what the previous visit held.
                const s = await sellWithRetry(ctx, wallet, { log: (m) => log.info(m), label: `${label} sell`, expectTokens: true });
                tally(s.stats);
                if (s.sold) { recordSell(s.lamportsReceived); log.success(`[${label}] Sold held tokens: ${s.signature}`); }
                holding = s.tokenBalance > 0n;
                if (holding) { log.warn(`[${label}] Could not sell held tokens — retiring this veteran (the drain will retry).`); break; }
            } else {
                const st = await readDrainState(ctx, wallet.publicKey);
                const reserve = veteranReserveLamports({
                    rents: ctx.pumpswap?.rents,
                    hasTokenAta: !!st.tokenAtaInfo,
                    hasAccumulator: ctx.engine === 'pumpswap' ? st.hasAccumulator : st.hasPumpfunAccumulator,
                    buyLamports: maxBuyLamports, slippageBps: ctx.slippageBps, tipLamports, rentFloor,
                });
                const amount = veteranBuyLamports({ walletLamports: st.lamports, reserveLamports: reserve, minBuy: minBuyLamports, maxBuy: maxBuyLamports });
                if (!amount) { log.info(`[${label}] Not enough SOL left for a minimum buy — retiring early.`); break; }

                let buy;
                try {
                    buy = await buyToken(ctx, wallet, amount, { label: `${label} buy`, log: (m) => log.info(m) });
                } catch (e) {
                    buy = { confirmed: false, err: e.message };
                    if (e.logs?.length) log.warn(`[${label}] sim: ${e.logs.slice(-3).join(' | ')}`);
                }
                tally(buy.stats);
                noteBuyResult(buy.confirmed, `veteran: ${typeof buy.err === 'string' ? buy.err : JSON.stringify(buy.err)}`);
                if (!buy.confirmed) {
                    log.warn(`[${label}] Buy did not land (${typeof buy.err === 'string' ? buy.err : JSON.stringify(buy.err)}).`);
                    if (buyFailStreak >= BUY_FAIL_PAUSE_AFTER) break; // retire; the worker pauses before the next veteran
                } else {
                    recordBuy(amount);
                    log.success(`[${label}] Bought ${sol(amount)} SOL in ${buy.stats.landMs}ms via ${buy.stats.via}: ${buy.signature}`);
                    if (decideHold({ visit, life, holdPct: vet.holdPct })) {
                        holding = true;
                        log.info(`[${label}] Holding until the next visit.`);
                    } else {
                        const s = await sellWithRetry(ctx, wallet, { log: (m) => log.info(m), label: `${label} sell`, expectTokens: true });
                        tally(s.stats);
                        if (s.sold) { recordSell(s.lamportsReceived); log.success(`[${label}] Sold (round trip): ${s.signature}`); }
                        holding = s.tokenBalance > 0n;
                    }
                }
            }
            if (visit < life && !isShuttingDown) await interruptibleSleep(randInt(vet.waitMin, vet.waitMax));
        }
    } catch (e) {
        log.error(`[${tag}] Veteran error: ${e.message}`);
        if (e.logs?.length) log.error(`[${tag}] sim: ${e.logs.slice(-3).join(' | ')}`);
    } finally {
        if (started) {
            log.info(`[${tag}] Retiring veteran — draining to zero...`);
            await drainAndRetire(tag, wallet, entry, { expectTokens: holding });
        }
    }
}

async function veteranWorker(id) {
    while (!isShuttingDown) {
        if (checkShutdownFile()) { isShuttingDown = true; break; }
        await pauseIfFailing(`v${id}`);
        if (isShuttingDown) break;
        try {
            await runVeteran(id);
        } catch (e) {
            log.error(`[v${id}] ${e.message}`);
            await interruptibleSleep(5);
        }
        if (isShuttingDown) break;
        await interruptibleSleep(delaySec);
    }
}

// ============================================================
// BACKGROUND LOOPS
// ============================================================

// Cleanup pass: drain any listed wallet no worker is handling (a drain that
// failed, a buy that never confirmed) so its SOL doesn't sit idle until stop.
async function janitor() {
    while (!isShuttingDown) {
        await interruptibleSleep(90);
        if (isShuttingDown) break;
        try {
            const now = Date.now();
            const stale = (w) => {
                if (inUse.has(w.publicKey)) return false;
                const t = Date.parse(w.createdAt);
                return !Number.isFinite(t) || now - t > 60_000;
            };
            const list = loadActiveWallets(WALLETS_FILE).filter(stale);
            if (list.length === 0) continue;
            const keys = new Set(list.map(w => w.publicKey));
            keys.forEach(k => inUse.add(k));
            log.info(`Cleanup pass: re-draining ${list.length} leftover wallet(s)...`);
            try {
                const r = await recoverAll(ctx, WALLETS_FILE, (m) => log.info(m), { filter: (w) => keys.has(w.publicKey) });
                log.info(`Cleanup pass: ${r.drained}/${r.wallets} drained, ${r.total.toFixed(6)} SOL returned`);
            } finally {
                keys.forEach(k => inUse.delete(k));
            }
        } catch (e) {
            log.warn(`Cleanup pass failed (${e.message}); will retry`);
        }
    }
}

// While on Jupiter in auto mode, notice the token graduating to PumpSwap and
// switch to the cheaper, faster direct engine.
async function graduationWatch() {
    while (!isShuttingDown && ctx.engine === 'jupiter' && ctx.engineSetting === 'auto') {
        await interruptibleSleep(60);
        if (isShuttingDown) break;
        await checkGraduation(ctx, (m) => log.info(m));
    }
}

// Every 30 s: refresh "spent so far" for the GUI = how far main is below its
// start, minus the SOL currently out in live wallets (it comes back). Every
// 5 min: also a STATUS line in the log.
async function statusLoop() {
    let ticks = 0;
    while (!isShuttingDown) {
        await interruptibleSleep(30);
        if (isShuttingDown) break;
        try {
            const bal = await getSolBalance(ctx, mainWallet.publicKey);
            const listed = new Set(loadActiveWallets(WALLETS_FILE).map(w => w.publicKey));
            for (const k of fundedOut.keys()) if (!listed.has(k)) fundedOut.delete(k);
            const out = [...fundedOut.values()].reduce((a, b) => a + b, 0);
            lastSpentLamports = Math.max(0, mainStartLamports - bal - out);
            emitStats();
            if (++ticks % 10 === 0) {
                log.info(`STATUS | swaps ${totals.buys} buys + ${totals.sells} sells | volume ${sol(totals.volumeLamports)} SOL | network fees ${sol(totals.gasLamports)} SOL | spent so far ~${sol(lastSpentLamports)} SOL | main ${sol(bal)} SOL, ${sol(out)} SOL out in ${fundedOut.size} live wallet(s)`);
            }
        } catch { /* skip this report */ }
    }
}

// ============================================================
// MAIN
// ============================================================
async function finalRecovery() {
    const remaining = loadActiveWallets(WALLETS_FILE);
    if (remaining.length === 0) {
        log.success('No leftover wallets — nothing to recover.');
        return;
    }
    log.warn(`Recovering ${remaining.length} leftover wallet(s) before exit...`);
    const r = await recoverAll(ctx, WALLETS_FILE, (m) => log.info(m));
    log.success(`Final recovery returned ${r.total.toFixed(6)} SOL to ${mainWallet.publicKey.toBase58()}`);
}

async function main() {
    // Resolve the token program (SPL vs Token-2022) once up front.
    const programId = await getTokenProgramId(ctx);
    log.info(`Token program: ${programId.toBase58()}`);

    await resolveEngine(ctx, (m) => log.info(m));
    const l = ctx.landing;
    log.info(`Landing: ${l.senderMode === 'off' ? 'RPC only' : `Helius Sender ${l.senderMode} (${senderUrl(l.senderRegion, l.senderMode)}, tip ${SENDER_TIP_LAMPORTS[l.senderMode]} lamports) + RPC`} | fee level ${l.baseFeeLevel}, cap ${sol(l.priorityCapLamports)} SOL/tx, ${l.maxAttempts} attempts`);

    // Wallets left over from a crashed or force-closed run: get their SOL back first.
    const leftovers = loadActiveWallets(WALLETS_FILE);
    if (leftovers.length > 0) {
        log.warn(`Found ${leftovers.length} wallet(s) from a previous run — recovering them first...`);
        const r = await recoverAll(ctx, WALLETS_FILE, (m) => log.info(m));
        log.success(`Startup recovery: ${r.drained}/${r.wallets} drained, ${r.total.toFixed(6)} SOL returned`);
    }

    // Free pre-flight: make sure the token can actually be traded before any
    // wallet is funded (a dead or delisted token would otherwise cost
    // fund+sweep fees on every cycle).
    try {
        if (ctx.engine === 'pumpswap') {
            await fetchSwapStateForPreflight(ctx);
        } else {
            const q = await getJupiterQuote(ctx, SOL_MINT, ctx.tokenAddress, minBuyLamports);
            if (!q?.outAmount) throw new Error('no route');
        }
        log.info('Pre-flight: token is tradable.');
    } catch (e) {
        const detail = e.response?.data?.error || e.message;
        log.error(`Pre-flight: this token cannot be traded right now (${detail}).`);
        log.error('Check the Token Address. A pump.fun token whose curve has gone quiet can be refused by Jupiter.');
        process.exit(1);
    }

    mainStartLamports = await getSolBalance(ctx, mainWallet.publicKey);
    log.info(`Main balance at start: ${sol(mainStartLamports)} SOL`);
    lastSpentLamports = 0;
    emitStats();
    log.info(`Launching ${recyclerCount} recycler(s) + ${vet.count} veteran(s)...`);

    // Stagger starts so funding txs don't all hit in the same instant.
    const workers = [];
    for (let i = 0; i < recyclerCount; i++) { workers.push(recyclerWorker(i + 1)); await sleep(0.4); }
    for (let i = 0; i < vet.count; i++) { workers.push(veteranWorker(i + 1)); await sleep(0.4); }
    const background = [janitor(), graduationWatch(), statusLoop()];
    await Promise.all(workers);
    await Promise.allSettled(background);

    // Every worker has drained its own wallet. Sweep anything still listed.
    log.warn('All workers stopped. Running final recovery...');
    await finalRecovery();

    const mainEnd = await getSolBalance(ctx, mainWallet.publicKey);
    const delta = mainEnd - mainStartLamports;
    lastSpentLamports = Math.max(0, -delta);
    emitStats();
    const swaps = totals.buys + totals.sells;
    log.info('='.repeat(50));
    log.info('Bot stopped gracefully — SESSION REPORT');
    log.info(`Recycler cycles: ${totals.okCycles}/${totals.recyclerCycles} clean` + (totals.recyclerCycles ? ` | avg ${(totals.cycleMs / totals.recyclerCycles).toFixed(0)}ms` : ''));
    log.info(`Veterans: ${totals.veterans} | visits ${totals.visits}`);
    log.info(`Swaps: ${totals.buys} buys + ${totals.sells} sells | volume ${sol(totals.volumeLamports)} SOL`);
    log.info(`Network fees (base + priority + tips): ${sol(totals.gasLamports)} SOL over ${totals.txCount} tx` + (totals.txCount ? ` | avg land ${(totals.txLandMs / totals.txCount).toFixed(0)}ms` : ''));
    log.info(`Main wallet: ${sol(mainStartLamports)} -> ${sol(mainEnd)} SOL = ${delta >= 0 ? '+' : ''}${sol(delta)} SOL total session cost (venue fees + network fees + price movement)`);
    if (swaps > 0) log.info(`Cost per swap: ${sol(-delta / swaps)} SOL | ${((-delta / Math.max(1, totals.volumeLamports)) * 100).toFixed(2)}% of volume`);
    if (buyFailReasons.size > 0) {
        const total = [...buyFailReasons.values()].reduce((a, b) => a + b, 0);
        log.info(`Failed buys: ${total} — top reasons:`);
        [...buyFailReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
            .forEach(([r, n]) => log.info(`  ${n}x ${r}`));
    }
    const left = loadActiveWallets(WALLETS_FILE).length;
    if (left > 0) log.warn(`${left} wallet(s) still listed — run Recover Funds to retry them.`);
    if (LOG_FILE) log.info(`Full log saved to ${LOG_FILE}`);
    log.info('='.repeat(50));
    process.exit(0);
}

main().catch(async (e) => {
    log.error(`Fatal: ${e.message}`);
    if (e.logs?.length) log.error(e.logs.slice(-5).join(' | '));
    isShuttingDown = true;
    try { await finalRecovery(); } catch (e2) { log.error(`Recovery after fatal error failed: ${e2.message} — run Recover Funds.`); }
    process.exit(1);
});
