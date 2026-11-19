/**
 * solUtils.js — shared logic for B33h1V3_B0t (index.js + recover.js)
 *
 * The single source of truth for the money-critical operations:
 *   - Jupiter quotes / swaps
 *   - balance reads
 *   - drainWallet(): reads the ACTUAL on-chain balance, sells any token
 *     remainder, closes the token account (rent -> main wallet) and sweeps
 *     every last lamport back to the main wallet so the trading wallet ends
 *     at exactly zero and is destroyed.
 *
 * Nothing here estimates balances from quotes. Every sweep is based on what
 * is really on-chain, which is what guarantees no funds are left behind.
 */

import {
    VersionedTransaction, Connection, Keypair, TransactionMessage, TransactionInstruction,
    SystemProgram, PublicKey, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
    getAssociatedTokenAddress, getAssociatedTokenAddressSync, createCloseAccountInstruction,
    TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, AccountLayout,
} from '@solana/spl-token';
import { userVolumeAccumulatorPda } from '@pump-fun/pump-swap-sdk';
import bs58 from 'bs58';
import axios from 'axios';
import fs from 'fs';

import { parseLandingConfig, landTransaction, SENDER_TIP_LAMPORTS } from './landing.js';
import {
    detectPumpSwapPool, loadPumpSwapStaticState, ensurePumpSwapLookupTable, fetchSwapState,
    buildWalletBuyInstructions, buildWalletSellInstructions, closeAccumulatorInstruction, walletAtas,
} from './pumpswap.js';
import { closePumpfunUserVolumeAccumulatorInstruction, pumpfunUserVolumeAccumulatorPda } from './pumpfun.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
// Pro host (api.jup.ag) needs an x-api-key and has higher rate limits; the lite
// host (lite-api.jup.ag) is free/keyless. createContext picks one based on
// whether a key is configured. Both expose the same /swap/v1 routes, which
// return a signable transaction we can drop into a Jito bundle.
const JUPITER_PRO_HOST = 'https://api.jup.ag';
const JUPITER_LITE_HOST = 'https://lite-api.jup.ag';

// Base signature fee kept in the wallet so the drain/sweep tx itself can pay.
// A system-owned account has no rent-exempt minimum, so after the sweep tx
// pays this fee the wallet lands at 0 lamports and ceases to exist on-chain.
const FEE_RESERVE_LAMPORTS = 5000;

// Typical rent for an SPL token ATA, used only as a display fallback.
const ATA_RENT_LAMPORTS = 2039280;

export function sleep(seconds) {
    return new Promise(resolve => setTimeout(resolve, (Number(seconds) || 0) * 1000));
}

/**
 * Build a context object from env-derived values. Both index.js and recover.js
 * construct one of these and pass it into every helper, so the two entry points
 * share identical behaviour.
 */
export const SWAP_ENGINES = ['auto', 'pumpswap', 'jupiter'];

export function createContext(env) {
    const jupiterApiKey = (env.JUPITER_API_KEY || '').trim();
    const level = (env.PRIORITY_LEVEL || 'medium').toLowerCase();
    // Jupiter (fallback engine) only knows medium/high/veryHigh; anything lower
    // maps to medium there. The direct engine uses the full Helius ladder via
    // ctx.landing.baseFeeLevel.
    const priorityLevel = ['medium', 'high', 'veryhigh'].includes(level)
        ? (level === 'veryhigh' ? 'veryHigh' : level)
        : 'medium';
    const engineSetting = String(env.SWAP_ENGINE || 'auto').toLowerCase();
    return {
        connection: new Connection(env.RPC_ENDPOINT, 'confirmed'),
        rpcUrl: env.RPC_ENDPOINT,
        mainWallet: Keypair.fromSecretKey(bs58.decode(env.KEY)),
        tokenMint: new PublicKey(env.TOKEN_ADDRESS),
        tokenAddress: env.TOKEN_ADDRESS,
        jupiterApiKey,
        jupiterHost: jupiterApiKey ? JUPITER_PRO_HOST : JUPITER_LITE_HOST,
        jupiterRps: Number(env.JUPITER_RPS) > 0 ? Number(env.JUPITER_RPS) : 1,
        // PRIORITY_FEE is the MAX cap per transaction. Both engines pay the
        // real-time rate for the chosen level, capped at this amount.
        priorityMaxLamports: Math.round(Number(env.PRIORITY_FEE || 0.0005) * LAMPORTS_PER_SOL),
        priorityLevel,
        slippageBps: Math.round(Number(env.SLIPPAGE_BPS || 700)),
        // Swap engine + landing settings (defaults are the fast path).
        engineSetting: SWAP_ENGINES.includes(engineSetting) ? engineSetting : 'auto',
        engine: null,            // resolved by resolveEngine(): 'pumpswap' | 'jupiter'
        pumpswap: null,          // engine state, set by pumpswap.js when active
        landing: parseLandingConfig(env),
    };
}

/**
 * Decide which swap engine to use and prepare it. 'auto' picks the direct
 * PumpSwap engine when the token's canonical PumpSwap pool exists, otherwise
 * falls back to Jupiter (the original path, unchanged).
 */
export async function resolveEngine(ctx, log = () => {}) {
    if (ctx.engine) return ctx.engine;
    if (ctx.engineSetting === 'jupiter') {
        ctx.engine = 'jupiter';
        return ctx.engine;
    }
    const pool = await detectPumpSwapPool(ctx);
    if (pool) {
        ctx.engine = 'pumpswap';
        await loadPumpSwapStaticState(ctx, pool);
        log(`Swap engine: direct PumpSwap (pool ${pool.poolKey.toBase58()})`);
        // One reusable address lookup table per token keeps each transaction
        // well under the 1,232-byte limit and faster to propagate. (Free
        // simulation tests skip it so they never lock up its rent.)
        if (!ctx.skipLookupTable) await ensurePumpSwapLookupTable(ctx, log);
        return ctx.engine;
    }
    if (ctx.engineSetting === 'pumpswap') {
        throw new Error('SWAP_ENGINE=pumpswap but no canonical PumpSwap pool exists for this token');
    }
    ctx.engine = 'jupiter';
    log('Swap engine: Jupiter (no PumpSwap pool found for this token)');
    return ctx.engine;
}

/** Free pre-flight for the direct engine: the pool's live state can be read and quoted. */
export async function fetchSwapStateForPreflight(ctx) {
    const state = await fetchSwapState(ctx, ctx.mainWallet.publicKey);
    if (state.poolQuoteAmount.isZero() || state.poolBaseAmount.isZero()) throw new Error('PumpSwap pool is empty');
    return state;
}

/**
 * A pump.fun token graduates from its bonding curve to PumpSwap mid-session
 * when its curve fills. In 'auto' mode, call this periodically while on the
 * Jupiter path: once the canonical pool exists, prepare the direct engine
 * (state + lookup table) and only THEN flip ctx.engine, so every in-flight
 * swap sees either a complete Jupiter setup or a complete PumpSwap one. The
 * drain on either engine reads and closes both programs' per-user PDAs, so a
 * wallet that bought on one engine and sells on the other is still recovered.
 * Returns true when it switched.
 */
export async function checkGraduation(ctx, log = () => {}) {
    if (ctx.engine !== 'jupiter' || ctx.engineSetting !== 'auto' || ctx.graduating) return false;
    ctx.graduating = true;
    try {
        const pool = await detectPumpSwapPool(ctx);
        if (!pool) return false;
        log(`Token graduated to PumpSwap (pool ${pool.poolKey.toBase58()}) — switching to the direct engine...`);
        await loadPumpSwapStaticState(ctx, pool);
        await ensurePumpSwapLookupTable(ctx, log);
        ctx.engine = 'pumpswap';
        log('Swap engine: direct PumpSwap (switched live after graduation)');
        return true;
    } catch (e) {
        log(`Graduation check failed (${e.message}); staying on Jupiter for now`);
        return false;
    } finally {
        ctx.graduating = false;
    }
}

// Only send the key header when we actually have a key (the lite host rejects
// an empty x-api-key header).
function jupiterHeaders(ctx) {
    return ctx.jupiterApiKey ? { 'x-api-key': ctx.jupiterApiKey } : {};
}

// Resolve (and cache) which token program owns the mint. Many newer launchpad
// tokens (incl. pump.fun) are Token-2022, and using the wrong program ID would
// derive the wrong token account — stranding the balance and its rent.
export async function getTokenProgramId(ctx) {
    if (!ctx.tokenProgramId) {
        const info = await ctx.connection.getAccountInfo(ctx.tokenMint);
        ctx.tokenProgramId = (info && info.owner.equals(TOKEN_2022_PROGRAM_ID))
            ? TOKEN_2022_PROGRAM_ID
            : TOKEN_PROGRAM_ID;
    }
    return ctx.tokenProgramId;
}

// ATA for our target token, using the correct (possibly Token-2022) program.
async function getTokenAta(ctx, owner) {
    const programId = await getTokenProgramId(ctx);
    return getAssociatedTokenAddress(ctx.tokenMint, owner, false, programId);
}

// ============================================================
// JUPITER
// ============================================================
// Retry an HTTP call only when retrying can help: no response (network),
// 429 (rate limit) or 5xx. A 4xx such as "no route" fails fast instead of
// burning ~20 s of backoff.
export function isRetryableHttpError(e) {
    const status = e?.response?.status;
    if (!status) return true;
    return status === 429 || status >= 500;
}

/**
 * Shared request budget (token bucket) for one API. Every worker takes a
 * token before calling, so N wallets together stay under the API's rate
 * limit instead of each tripping it. A 429 pauses the whole bucket briefly.
 */
export function createRateBucket(ratePerSec, burst) {
    return { rate: Math.max(0.1, ratePerSec), burst: Math.max(1, burst), tokens: Math.max(1, burst), last: Date.now(), pauseUntil: 0 };
}

export async function takeRateToken(b) {
    for (;;) {
        const now = Date.now();
        if (now < b.pauseUntil) { await sleep((b.pauseUntil - now) / 1000); continue; }
        b.tokens = Math.min(b.burst, b.tokens + ((now - b.last) / 1000) * b.rate);
        b.last = now;
        if (b.tokens >= 1) { b.tokens -= 1; return; }
        await sleep((1 - b.tokens) / b.rate);
    }
}

export function pauseRateBucket(b, ms) {
    b.pauseUntil = Math.max(b.pauseUntil, Date.now() + ms);
    b.tokens = 0;
}

// Jupiter's free tiers allow roughly 1 request/second sustained (measured
// 2026-11-19: 5 wallets at ~2.5 req/s got HTTP 429). JUPITER_RPS overrides.
function jupiterBucket(ctx) {
    if (!ctx.jupiterBucket) ctx.jupiterBucket = createRateBucket(ctx.jupiterRps || 1, 4);
    return ctx.jupiterBucket;
}

/** One Jupiter HTTP call through the shared budget; a 429 pauses everyone for 2 s. */
async function jupiterCall(ctx, fn) {
    return withRetry(async () => {
        await takeRateToken(jupiterBucket(ctx));
        try {
            return await fn();
        } catch (e) {
            if (e?.response?.status === 429) pauseRateBucket(jupiterBucket(ctx), 2_000);
            throw e;
        }
    }, { retries: 5, baseMs: 300, shouldRetry: isRetryableHttpError });
}

export async function getJupiterQuote(ctx, inputMint, outputMint, amount, slippageBps) {
    const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: amount.toString(),
        slippageBps: String(slippageBps ?? ctx.slippageBps),
    });
    const res = await jupiterCall(ctx, () => axios.get(`${ctx.jupiterHost}/swap/v1/quote?${params}`, {
        headers: jupiterHeaders(ctx), timeout: 10_000,
    }));
    return res.data;
}

/** Jupiter's JSON instruction -> web3.js TransactionInstruction. */
export function jupiterIx(j) {
    return new TransactionInstruction({
        programId: new PublicKey(j.programId),
        keys: (j.accounts || []).map(a => ({ pubkey: new PublicKey(a.pubkey), isSigner: !!a.isSigner, isWritable: !!a.isWritable })),
        data: Buffer.from(j.data || '', 'base64'),
    });
}

/**
 * The instructions to run from a /swap-instructions response, in Jupiter's
 * documented order: setup (create ATAs, wrap SOL) -> swap -> cleanup (unwrap).
 * Jupiter's own compute-budget instructions are dropped: the landing layer
 * sets an exact CU limit and our own (lower) price. otherInstructions only
 * carries a Jito tip when one is requested, which we never do.
 */
export function jupiterInstructionsFromResponse(r) {
    if (!r?.swapInstruction) throw new Error('Jupiter returned no swap instruction');
    return [
        ...(r.setupInstructions || []).map(jupiterIx),
        jupiterIx(r.swapInstruction),
        ...(r.cleanupInstruction ? [jupiterIx(r.cleanupInstruction)] : []),
    ];
}

export async function getJupiterSwapInstructions(ctx, quoteResponse, userPublicKey) {
    const res = await jupiterCall(ctx, () => axios.post(`${ctx.jupiterHost}/swap/v1/swap-instructions`, {
        quoteResponse,
        userPublicKey: userPublicKey.toString(),
        wrapAndUnwrapSol: true,
    }, { headers: jupiterHeaders(ctx), timeout: 10_000 }));
    return res.data;
}

// Jupiter's lookup tables never change for a given address; cache them.
async function loadLookupTables(ctx, addresses) {
    if (!ctx.altCache) ctx.altCache = new Map();
    const out = [];
    for (const a of addresses || []) {
        if (!ctx.altCache.has(a)) {
            const res = await withRetry(() => ctx.connection.getAddressLookupTable(new PublicKey(a)));
            if (!res.value) throw new Error(`lookup table ${a} not found`);
            ctx.altCache.set(a, res.value);
        }
        out.push(ctx.altCache.get(a));
    }
    return out;
}

/**
 * A Jupiter swap as a landing-layer build (wallet pays, wallet signs): fresh
 * quote + fresh instructions on every call, so each landing attempt re-quotes.
 * `amount` may be a function (re-read e.g. the live token balance per attempt).
 */
export async function buildJupiterSwap(ctx, wallet, inputMint, outputMint, amount, { slippageBps } = {}) {
    const raw = typeof amount === 'function' ? await amount() : amount;
    if (BigInt(raw) <= 0n) {
        const e = new Error('nothing to swap');
        e.nothingToSell = true;
        throw e;
    }
    const quote = await getJupiterQuote(ctx, inputMint, outputMint, raw, slippageBps);
    if (!quote?.outAmount) throw new Error('Jupiter could not find a route. Check token liquidity.');
    const r = await getJupiterSwapInstructions(ctx, quote, wallet.publicKey);
    return {
        instructions: jupiterInstructionsFromResponse(r),
        signers: [wallet],
        payer: wallet.publicKey,
        lookupTables: await loadLookupTables(ctx, r.addressLookupTableAddresses),
        expected: { inAmount: BigInt(raw), outAmount: BigInt(quote.outAmount) },
    };
}

/**
 * Buy the token with `lamports` of SOL from `wallet` (it signs and pays), on
 * whichever engine is active, through the landing layer: free simulation
 * first, exact CU, dynamic fee under the cap, rebroadcast, rebuild on expiry.
 * Throws if the build/simulation fails (nothing was sent, nothing was paid).
 */
export async function buyToken(ctx, wallet, lamports, { label = 'buy', log = () => {} } = {}) {
    return landTransaction(ctx, async () => {
        if (ctx.engine === 'pumpswap') {
            const state = await fetchSwapState(ctx, wallet.publicKey);
            return buildWalletBuyInstructions(ctx, state, wallet, lamports);
        }
        return buildJupiterSwap(ctx, wallet, SOL_MINT, ctx.tokenAddress, lamports);
    }, { label, log });
}

export async function getJupiterSwapTransaction(ctx, quoteResponse, userPublicKey) {
    const res = await withRetry(() => axios.post(`${ctx.jupiterHost}/swap/v1/swap`, {
        quoteResponse,
        userPublicKey: userPublicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        // Dynamic priority fee: Jupiter estimates the real-time rate for the
        // chosen level and caps it at maxLamports, so we pay only what's needed
        // to land instead of a flat fee every time.
        prioritizationFeeLamports: {
            priorityLevelWithMaxLamports: {
                maxLamports: ctx.priorityMaxLamports,
                priorityLevel: ctx.priorityLevel,
            },
        },
    }, {
        headers: jupiterHeaders(ctx),
    }));
    return res.data;
}

// Retry an RPC call with exponential backoff. Critical for concurrency: when
// several workers hit the RPC at once, transient errors/rate-limits must be
// retried, NOT silently treated as "empty" (which would strand funds).
export async function withRetry(fn, { retries = 5, baseMs = 350, shouldRetry = () => true } = {}) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (e) {
            lastErr = e;
            if (i === retries || !shouldRetry(e)) break;
            await sleep((baseMs * Math.pow(2, i)) / 1000);
        }
    }
    throw lastErr;
}

// ============================================================
// BALANCES  (retry on RPC error; only return 0 when truly empty)
// ============================================================
export async function getTokenBalance(ctx, owner) {
    const ata = await getTokenAta(ctx, owner);
    // Read the raw account and decode the amount ourselves. getAccountInfo
    // works on every RPC, while getTokenAccountBalance is an "indexed" method
    // some free public RPCs refuse (publicnode: HTTP 403). A missing account
    // comes back as null = a real zero; an RPC error throws and is retried.
    return withRetry(async () => {
        const info = await ctx.connection.getAccountInfo(ata, 'confirmed');
        if (!info) return 0n;
        return AccountLayout.decode(info.data.subarray(0, AccountLayout.span)).amount;
    });
}

export async function getSolBalance(ctx, owner) {
    // getBalance returns 0 for a missing account and only throws on RPC error,
    // so any throw here is worth retrying rather than reporting a false zero.
    return withRetry(() => ctx.connection.getBalance(owner));
}

// ============================================================
// CONFIRMATION (poll signature status, no deprecated blockhash form)
// ============================================================
export async function confirmSignature(ctx, signature, { timeoutMs = 30000, intervalMs = 300 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const { value } = await ctx.connection.getSignatureStatuses([signature]);
            const st = value[0];
            if (st) {
                if (st.err) return { confirmed: false, err: st.err };
                if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') {
                    return { confirmed: true };
                }
            }
        } catch {
            // transient RPC error — keep polling until the deadline
        }
        await sleep(intervalMs / 1000);
    }
    return { confirmed: false, err: 'timeout' };
}

// ============================================================
// SELL ALL TOKENS (RPC, exact on-chain balance)
// ============================================================
/**
 * Sell the wallet's ENTIRE token balance (the wallet signs and pays) through
 * the landing layer, on whichever engine is active. Balance and quote are
 * re-read on every landing attempt. Proceeds land in the wallet as native SOL.
 * `slippageBps` overrides the configured slippage (the drain widens it on
 * retries so a fast-moving price can't trap tokens).
 */
export async function sellAllTokens(ctx, wallet, { log = () => {}, slippageBps, label } = {}) {
    const short = wallet.publicKey.toBase58().slice(0, 6);
    let expected = 0;
    try {
        const r = await landTransaction(ctx, async () => {
            if (ctx.engine === 'pumpswap') {
                const state = await fetchSwapState(ctx, wallet.publicKey);
                if (state.userTokenBalance <= 0n) {
                    const e = new Error('no tokens to sell');
                    e.nothingToSell = true;
                    throw e;
                }
                const built = await buildWalletSellInstructions(ctx, state, wallet, { slippageBps });
                expected = built.expected.solFromSale;
                return built;
            }
            const built = await buildJupiterSwap(ctx, wallet, ctx.tokenAddress, SOL_MINT,
                () => getTokenBalance(ctx, wallet.publicKey), { slippageBps });
            expected = Number(built.expected.outAmount);
            return built;
        }, { label: label || `sell ${short}`, log });
        if (!r.confirmed) {
            return { success: false, solReceived: 0, signature: r.signature, error: typeof r.err === 'string' ? r.err : JSON.stringify(r.err) };
        }
        return { success: true, solReceived: expected / LAMPORTS_PER_SOL, lamportsReceived: expected, signature: r.signature, stats: r.stats };
    } catch (e) {
        if (e.nothingToSell) return { success: true, solReceived: 0, lamportsReceived: 0, nothing: true };
        return { success: false, solReceived: 0, error: e.message, logs: e.logs };
    }
}

// Sell attempts the drain makes before giving the wallet to recovery, and the
// slippage ceiling for those exit retries (getting out beats a perfect price).
export const SELL_ATTEMPTS = 3;
export const MAX_EXIT_SLIPPAGE_BPS = 2500;

/** Slippage for exit-sell attempt i (0-based): configured, then +50 % per retry, capped. */
export function exitSlippageBps(baseBps, attempt) {
    return Math.min(MAX_EXIT_SLIPPAGE_BPS, Math.round(baseBps * (1 + 0.5 * attempt)));
}

/**
 * Sell everything, retrying with a fresh quote (and gradually wider slippage)
 * if a sell fails, e.g. on slippage while the price is moving fast. Tops the
 * wallet up from main if it has no SOL left for gas (the top-up comes back on
 * the sweep). Returns { sold, solFromSale, lamportsReceived, signature, stats,
 * tokenBalance (left after), toppedUp }.
 */
export async function sellWithRetry(ctx, wallet, { log = () => {}, label, expectTokens = false } = {}) {
    const short = wallet.publicKey.toBase58().slice(0, 6);
    const out = { sold: false, solFromSale: 0, lamportsReceived: 0, signature: null, stats: null, toppedUp: false };
    let tokenBalance = await getTokenBalance(ctx, wallet.publicKey);
    // Right after a buy confirms, a load-balanced RPC can answer from a node
    // that hasn't seen it yet ("no token account" -> 0). When tokens are
    // expected, give the read a few moments before believing a zero.
    for (let i = 0; expectTokens && tokenBalance === 0n && i < 5; i++) {
        await sleep(0.6);
        tokenBalance = await getTokenBalance(ctx, wallet.publicKey);
    }
    for (let i = 0; i < SELL_ATTEMPTS && tokenBalance > 0n; i++) {
        const solForGas = await getSolBalance(ctx, wallet.publicKey);
        if (solForGas < GAS_TOPUP_LAMPORTS) {
            out.toppedUp = true;
            await topUpFromMain(ctx, wallet.publicKey, GAS_TOPUP_LAMPORTS - solForGas, log);
        }
        const slippageBps = exitSlippageBps(ctx.slippageBps, i);
        if (i > 0) log(`  [sell ${short}] retry ${i + 1}/${SELL_ATTEMPTS} with ${(slippageBps / 100).toFixed(1)}% slippage`);
        const sale = await sellAllTokens(ctx, wallet, { log, slippageBps, label });
        if (sale.success && !sale.nothing) {
            out.sold = true;
            out.solFromSale += sale.solReceived;
            out.lamportsReceived += sale.lamportsReceived || 0;
            out.signature = sale.signature || out.signature;
            out.stats = sale.stats || out.stats;
        } else if (sale.error) {
            log(`  [sell ${short}] failed: ${sale.error}`);
            if (sale.logs?.length) log(`  [sell ${short}] sim: ${sale.logs.slice(-2).join(' | ')}`);
        }
        // Re-read: only an on-chain zero counts as sold.
        tokenBalance = await getTokenBalance(ctx, wallet.publicKey);
        if (tokenBalance > 0n && i < SELL_ATTEMPTS - 1) await sleep(1.5);
    }
    out.tokenBalance = tokenBalance;
    return out;
}

// Minimum SOL a wallet needs to pay for selling its tokens + closing the
// account (priority fee + base fees). Recovered on the final sweep.
const GAS_TOPUP_LAMPORTS = 3_000_000; // 0.003 SOL

// Send SOL from the main wallet to a trading wallet and confirm it. Used to give
// a stuck (tokens-but-no-SOL) wallet enough gas to sell and close.
async function topUpFromMain(ctx, toPubkey, lamports, log = () => {}) {
    const r = await landTransaction(ctx, async () => ({
        instructions: [SystemProgram.transfer({ fromPubkey: ctx.mainWallet.publicKey, toPubkey, lamports })],
        signers: [ctx.mainWallet],
        payer: ctx.mainWallet.publicKey,
    }), { label: `topup ${toPubkey.toBase58().slice(0, 6)}`, log });
    return { confirmed: r.confirmed, err: r.err };
}

/**
 * Send SOL from the main wallet to a (fresh) trading wallet and confirm it.
 * Used by index.js to fund each cycle. Main signs and pays; the trading wallet
 * is untouched by this beyond receiving lamports.
 */
export async function fundWalletFromMain(ctx, toPubkey, lamports, log = () => {}) {
    return landTransaction(ctx, async () => ({
        instructions: [SystemProgram.transfer({ fromPubkey: ctx.mainWallet.publicKey, toPubkey, lamports })],
        signers: [ctx.mainWallet],
        payer: ctx.mainWallet.publicKey,
    }), { label: `fund ${toPubkey.toBase58().slice(0, 6)}`, log });
}

// Minimum native SOL a wallet needs to pay for its own close+sweep tx.
const CLOSE_GAS_MIN_LAMPORTS = 60_000;

// A system account may only exist at 0 lamports or at/above the rent-exempt
// minimum for an empty account (810,624 lamports as of 2026-09). The runtime
// also checks the FEE PAYER against that minimum right after deducting the fee
// and before any instruction runs, so a wallet that is to pay for its own
// sweep needs the rent floor PLUS fee headroom up front, even though the sweep
// is allowed to end it at exactly 0. Any top-up comes back on the sweep.
export async function rentExemptEmptyAccount(ctx) {
    if (!ctx.rentExemptEmpty) {
        ctx.rentExemptEmpty = await withRetry(() => ctx.connection.getMinimumBalanceForRentExemption(0, 'confirmed'));
    }
    return ctx.rentExemptEmpty;
}

/**
 * Everything the drain needs to know about a wallet, engine-aware, in one or
 * two RPC reads: lamports, token balance/account, leftover WSOL account and
 * (PumpSwap) per-user PDA.
 */
export async function readDrainState(ctx, owner) {
    if (ctx.engine === 'pumpswap') {
        const s = await fetchSwapState(ctx, owner);
        return {
            lamports: s.userLamports,
            tokenBalance: s.userTokenBalance,
            tokenAta: s.userBaseTokenAccount, tokenAtaInfo: s.userBaseAccountInfo, tokenProgramId: s.baseTokenProgram,
            wsolAta: s.userQuoteTokenAccount, wsolAtaInfo: s.userQuoteAccountInfo,
            accumulator: s.accumulator, accumulatorLamports: s.accumulatorLamports, hasAccumulator: s.userHasAccumulator,
            pumpfunAccumulatorLamports: s.pumpfunAccumulatorLamports, hasPumpfunAccumulator: s.userHasPumpfunAccumulator,
        };
    }
    const tokenProgramId = await getTokenProgramId(ctx);
    const tokenAta = await getTokenAta(ctx, owner);
    // Jupiter routes a pump.fun token through its bonding curve before
    // graduation and through PumpSwap after it. Each program makes the BUYER
    // pay rent for its own per-user "volume accumulator" PDA, so check and
    // close both — otherwise a token that graduates mid-session silently
    // leaks 0.00184 SOL per wallet. Also catch a WSOL account a failed
    // Jupiter cleanup could leave behind.
    const pumpfunAccumulator = pumpfunUserVolumeAccumulatorPda(owner);
    const accumulator = userVolumeAccumulatorPda(owner);
    const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true, TOKEN_PROGRAM_ID);
    const [userInfo, ataInfo, pfInfo, accInfo, wsolInfo] = await withRetry(() => ctx.connection.getMultipleAccountsInfo(
        [owner, tokenAta, pumpfunAccumulator, accumulator, wsolAta], 'confirmed'));
    // Token-2022 accounts share the classic layout for their first 165 bytes,
    // so the amount decodes the same way for both programs.
    const tokenBalance = ataInfo ? AccountLayout.decode(ataInfo.data.subarray(0, AccountLayout.span)).amount : 0n;
    return {
        lamports: userInfo ? userInfo.lamports : 0,
        tokenBalance,
        tokenAta, tokenAtaInfo: ataInfo, tokenProgramId,
        wsolAta, wsolAtaInfo: wsolInfo,
        accumulator, accumulatorLamports: accInfo ? accInfo.lamports : 0, hasAccumulator: !!accInfo,
        pumpfunAccumulatorLamports: pfInfo ? pfInfo.lamports : 0, hasPumpfunAccumulator: !!pfInfo,
    };
}

/**
 * The close + sweep transaction, paid and signed by the wallet:
 *   close token account (rent -> main)         if it exists and is empty
 *   close leftover WSOL account (-> main)      if it exists
 *   close PumpSwap PDA (rent -> wallet)        if it exists
 *   close pump.fun curve PDA (rent -> wallet)  if it exists
 *   transfer EVERYTHING else -> main, leaving exactly the tx fee + tip
 * The final amount is set by `finalize` once the landing layer knows the
 * exact fee, so the wallet ends at precisely zero. Returns null if there is
 * nothing to do.
 */
async function buildCloseSweep(ctx, s, wallet) {
    const owner = wallet.publicKey;
    const main = ctx.mainWallet.publicKey;
    const head = [];
    const expected = { rentLamports: 0, sweptLamports: 0 };

    if (s.tokenAtaInfo && s.tokenBalance === 0n) {
        head.push(createCloseAccountInstruction(s.tokenAta, main, owner, [], s.tokenProgramId));
        expected.rentLamports += s.tokenAtaInfo.lamports;
    }
    if (s.wsolAtaInfo) {
        head.push(createCloseAccountInstruction(s.wsolAta, main, owner, [], TOKEN_PROGRAM_ID));
        expected.rentLamports += s.wsolAtaInfo.lamports;
    }
    let refunds = 0;
    if (s.hasAccumulator) {
        head.push(await closeAccumulatorInstruction(owner));
        refunds += s.accumulatorLamports;
    }
    if (s.hasPumpfunAccumulator) {
        head.push(closePumpfunUserVolumeAccumulatorInstruction(owner));
        refunds += s.pumpfunAccumulatorLamports;
    }
    const available = s.lamports + refunds;
    if (head.length === 0 && available === 0) return null;

    const sweepIx = (amount) => SystemProgram.transfer({ fromPubkey: owner, toPubkey: main, lamports: amount });
    // A system account may not be left with a non-zero balance below the
    // rent-exempt minimum, so the sweep must end the wallet at EXACTLY zero in
    // the simulation too. The simulation charges only the base fee (no priority
    // price is set for it) plus the tip the landing layer appends, so leave
    // precisely those; finalize() below subtracts the real priority fee.
    const tipLamports = SENDER_TIP_LAMPORTS[ctx.landing.senderMode] || 0;
    const placeholder = available - 5_000 - tipLamports;
    const instructions = placeholder > 0 ? [...head, sweepIx(placeholder)] : [...head];

    return {
        instructions,
        signers: [wallet],
        payer: owner,
        lookupTables: ctx.pumpswap?.lookupTables || [],
        expected,
        finalize: ({ baseFeeLamports, priorityFeeLamports, tipLamports }) => {
            const amount = available - baseFeeLamports - priorityFeeLamports - tipLamports;
            expected.sweptLamports = Math.max(0, amount);
            return amount > 0 ? [...head, sweepIx(amount)] : [...head];
        },
    };
}

// ============================================================
// DRAIN WALLET — recover everything, then destroy the wallet
// ============================================================
/**
 * Reads the wallet's real balances and returns every recoverable lamport to
 * the main wallet:
 *   1. sell any leftover tokens (so the token account can be closed)
 *   2. close the (now-empty) token account, sending its rent to the main wallet
 *   3. sweep all remaining SOL to the main wallet, leaving the wallet at zero
 *
 * `ok` is true only when the wallet is fully drained (no tokens left and the
 * sweep confirmed). A false `ok` means the wallet should be kept in
 * active_wallets.json so recovery can retry it later.
 */
export async function drainWallet(ctx, wallet, { sellTokens = true, log = () => {}, expectTokens = false } = {}) {
    const result = { solFromSale: 0, rentReclaimed: 0, solSwept: 0, tokensSold: false, ok: false, signature: null };
    const short = wallet.publicKey.toBase58().slice(0, 6);
    const takeSale = (sale) => {
        if (sale.toppedUp) result.toppedUp = true;
        if (sale.sold) {
            result.solFromSale += sale.solFromSale;
            result.lamportsFromSale = (result.lamportsFromSale || 0) + sale.lamportsReceived;
            result.tokensSold = true;
            result.sellSignature = sale.signature || result.sellSignature || null;
            result.sellStats = sale.stats || result.sellStats || null;
        }
    };

    // 1. Sell any tokens so the ATA can be closed for its rent. sellWithRetry
    //    tops the wallet up for gas if needed (returned on the sweep) and
    //    retries with a fresh quote if the price moved.
    let tokenBalance = await getTokenBalance(ctx, wallet.publicKey);
    if (sellTokens && (tokenBalance > 0n || expectTokens)) {
        const sale = await sellWithRetry(ctx, wallet, { log, expectTokens });
        takeSale(sale);
        // If the sale still failed, tokenBalance stays > 0 and we must NOT try
        // to close the account (closing a non-empty token account fails).
        tokenBalance = sale.tokenBalance;
    }

    // 2. Close the empty token account (+ any leftover WSOL account and the
    //    PumpSwap PDA) and sweep ALL remaining SOL to main, in one tx that the
    //    wallet pays for — leaving exactly zero behind.
    let state = await readDrainState(ctx, wallet.publicKey);
    if (sellTokens && tokenBalance === 0n && state.tokenBalance > 0n) {
        // A lagging RPC node reported no tokens earlier, but the account
        // holds some. Never sweep the gas away from unsold tokens: sell first.
        log(`  [drain ${short}] tokens showed up late (lagging RPC read) — selling before the sweep`);
        const sale = await sellWithRetry(ctx, wallet, { log, expectTokens: true });
        takeSale(sale);
        tokenBalance = sale.tokenBalance;
        state = await readDrainState(ctx, wallet.publicKey);
    }
    const somethingToClose = (state.tokenAtaInfo && tokenBalance === 0n) || state.wsolAtaInfo || state.hasAccumulator || state.hasPumpfunAccumulator;
    if (!somethingToClose && state.lamports === 0) {
        // Nothing to recover. Fully drained only if no tokens are stuck.
        result.ok = tokenBalance === 0n;
        return result;
    }
    const gasFloor = somethingToClose ? await rentExemptEmptyAccount(ctx) + CLOSE_GAS_MIN_LAMPORTS : 0;
    if (somethingToClose && state.lamports < gasFloor) {
        // Accounts to close but no gas to do it with (e.g. rent went to main).
        // PDA refunds arrive inside the tx and cannot pay its up-front fee, so
        // only native lamports count here, and the wallet must clear the rent
        // floor with the fee headroom on top (see rentExemptEmptyAccount).
        result.toppedUp = true;
        const topUp = gasFloor - state.lamports;
        const t = await topUpFromMain(ctx, wallet.publicKey, topUp, log);
        if (!t.confirmed) {
            result.error = `gas top-up did not confirm: ${typeof t.err === 'string' ? t.err : JSON.stringify(t.err)}`;
            result.leftover = { lamports: state.lamports, tokens: tokenBalance.toString(), tokenAccount: !!state.tokenAtaInfo, wsolAccount: !!state.wsolAtaInfo, pda: state.hasAccumulator, pumpfunPda: state.hasPumpfunAccumulator };
            return result;
        }
    }

    let expected = null;
    let landed;
    try {
        landed = await landTransaction(ctx, async () => {
            const s = await readDrainState(ctx, wallet.publicKey); // real balances, every attempt
            const built = await buildCloseSweep(ctx, s, wallet);
            if (!built) {
                const e = new Error('nothing left to sweep');
                e.nothing = true;
                throw e;
            }
            expected = built.expected;
            return built;
        }, { label: `sweep ${short}`, log });
    } catch (e) {
        landed = e.nothing ? { confirmed: true, nothing: true } : { confirmed: false, err: e.message };
        if (e.logs?.length) log(`  [sweep ${short}] sim: ${e.logs.slice(-3).join(' | ')}`);
    }

    if (landed.confirmed && expected) {
        result.signature = landed.signature;
        result.sweepStats = landed.stats || null;
        result.rentReclaimed = expected.rentLamports / LAMPORTS_PER_SOL;
        result.solSwept = expected.sweptLamports / LAMPORTS_PER_SOL;
    } else if (!landed.confirmed) {
        result.error = typeof landed.err === 'string' ? landed.err : JSON.stringify(landed.err);
    }

    // 3. Verify on-chain rather than assume.
    state = await readDrainState(ctx, wallet.publicKey);
    result.ok = tokenBalance === 0n && state.lamports === 0 && !state.tokenAtaInfo && !state.wsolAtaInfo && !state.hasAccumulator && !state.hasPumpfunAccumulator;
    if (!result.ok) {
        result.leftover = {
            lamports: state.lamports, tokens: state.tokenBalance.toString(),
            tokenAccount: !!state.tokenAtaInfo, wsolAccount: !!state.wsolAtaInfo, pda: state.hasAccumulator, pumpfunPda: state.hasPumpfunAccumulator,
        };
    }
    return result;
}

// ============================================================
// ACTIVE WALLETS FILE (crash-recovery ledger)
// ============================================================
// The ledger is the ONLY copy of each trading wallet's private key while the
// wallet holds funds. So: writes are atomic (temp file + rename — a crash
// mid-write leaves the old file intact), and an unreadable ledger is never
// silently treated as empty (that would let the next save erase the keys):
// it is copied aside and every key still readable in it is salvaged.

const BASE58_KEY = /"privateKey"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{64,100})"/g;

/** Every wallet whose private key can still be read out of damaged ledger text. */
export function salvageWallets(raw) {
    const out = [];
    const seen = new Set();
    for (const m of String(raw || '').matchAll(BASE58_KEY)) {
        try {
            const kp = Keypair.fromSecretKey(bs58.decode(m[1]));
            const publicKey = kp.publicKey.toBase58();
            if (seen.has(publicKey)) continue;
            seen.add(publicKey);
            out.push({ publicKey, privateKey: m[1], createdAt: null, salvaged: true });
        } catch { /* not a valid key; skip */ }
    }
    return out;
}

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function loadActiveWallets(file) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e; // locked/unreadable: let the caller retry rather than assume empty
    }
    try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr;
        throw new Error('ledger is not a list');
    } catch {
        const backup = `${file}.corrupt-${Date.now()}`;
        try { fs.copyFileSync(file, backup); } catch {}
        const salvaged = salvageWallets(raw);
        console.warn(`[WARN] ${file} was unreadable — copied to ${backup}; salvaged ${salvaged.length} wallet key(s).`);
        return salvaged;
    }
}

export function saveActiveWallets(file, arr) {
    if (!arr || arr.length === 0) {
        try { fs.unlinkSync(file); } catch {}
        return;
    }
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
    // Windows can briefly refuse a rename while antivirus/indexer holds the
    // target open; retry, then fall back to a direct write.
    for (let i = 0; i < 6; i++) {
        try {
            fs.renameSync(tmp, file);
            return;
        } catch {
            sleepSync(50 * (i + 1));
        }
    }
    fs.writeFileSync(file, JSON.stringify(arr, null, 2));
    try { fs.unlinkSync(tmp); } catch {}
}

export function appendActiveWallet(file, entry) {
    const arr = loadActiveWallets(file);
    arr.push(entry);
    saveActiveWallets(file, arr);
}

export function removeActiveWallet(file, publicKey) {
    const arr = loadActiveWallets(file).filter(w => w.publicKey !== publicKey);
    saveActiveWallets(file, arr);
}

// ============================================================
// RECOVER ALL — drain every wallet still listed in the ledger
// ============================================================
export async function recoverAll(ctx, file, log = () => {}, { filter = () => true } = {}) {
    const wallets = loadActiveWallets(file).filter(filter);
    const totals = { wallets: wallets.length, drained: 0, solFromSale: 0, rentReclaimed: 0, solSwept: 0 };
    if (wallets.length > 0) await resolveEngine(ctx, log);

    for (const data of wallets) {
        let wallet;
        try {
            wallet = Keypair.fromSecretKey(bs58.decode(data.privateKey));
        } catch {
            log(`  Skipping malformed wallet entry ${data.publicKey || '?'}`);
            continue;
        }

        // One wallet's failure must never stop the others from being drained.
        let d;
        try {
            d = await drainWallet(ctx, wallet, { log });
        } catch (e) {
            log(`  ${data.publicKey}: drain threw (${e.message}) — kept for retry`);
            if (e.logs?.length) log(`    sim: ${e.logs.slice(-3).join(' | ')}`);
            continue;
        }
        totals.solFromSale += d.solFromSale;
        totals.rentReclaimed += d.rentReclaimed;
        totals.solSwept += d.solSwept;

        const recovered = d.solFromSale + d.rentReclaimed + d.solSwept;
        log(`  ${data.publicKey}: recovered ${recovered.toFixed(6)} SOL${d.ok ? '' : ' (incomplete — kept for retry)'}`);

        if (d.ok) {
            totals.drained++;
            removeActiveWallet(file, data.publicKey);
        }
        await sleep(1);
    }

    // Swept already includes any token-sale proceeds, so the real amount
    // returned to main is swept + rent (rent is sent to main on account close).
    totals.total = totals.solSwept + totals.rentReclaimed;
    return totals;
}
