/**
 * landing.js — fast, cheap, reliable transaction landing for B33h1V3_B0t.
 *
 * One entry point, landTransaction(), takes a *builder* (a function that
 * returns instructions + signers) and does everything needed to get that
 * transaction on-chain for the least fee that actually lands:
 *
 *   1. simulate once        -> exact compute units (tight CU limit) and a
 *                              free pre-flight that catches errors before any
 *                              fee is paid
 *   2. price the fee        -> Helius Priority Fee API (or, on any other RPC,
 *                              the standard recent-fees method), account-aware,
 *                              at the configured level, capped at PRIORITY_FEE
 *   3. send everywhere      -> Helius Sender (staked SWQOS route, 5k-lamport
 *                              tip) AND the normal RPC, in parallel
 *   4. confirm fast         -> one shared, batched status poller for every
 *                              tx in flight (400 ms ticks)
 *   5. never give up silently -> re-send every 2 s until confirmed or the
 *                              blockhash expires; on expiry rebuild one fee
 *                              level higher (fresh blockhash, fresh state),
 *                              up to maxAttempts
 *
 * Everything below that is a pure helper is exported so it can be unit-tested
 * without a network (see test/landing.test.js).
 */

import {
    VersionedTransaction, TransactionMessage, ComputeBudgetProgram,
    SystemProgram, PublicKey, Keypair, LAMPORTS_PER_SOL, AddressLookupTableAccount,
} from '@solana/web3.js';
import axios from 'axios';
import bs58 from 'bs58';

// ============================================================
// CONSTANTS
// ============================================================

// Helius Sender tip accounts (mainnet). Any one of them works; we pick at
// random so we don't all pile onto one account's write lock.
export const SENDER_TIP_ACCOUNTS = [
    '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
    'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
    '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
    '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
    '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
    '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
    'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
    '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
    '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
    '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
];

export const SENDER_REGIONS = ['auto', 'slc', 'ewr', 'lon', 'fra', 'ams', 'sg', 'tyo'];
export const SENDER_MODES = ['swqos', 'max', 'off'];

// Minimum tips documented by Helius for each Sender mode.
export const SENDER_TIP_LAMPORTS = {
    swqos: 5_000,        // 0.000005 SOL — single staked (SWQOS) path
    max: 1_000_000,      // 0.001 SOL   — all pathways incl. Jito
    off: 0,
};

// Helius Priority Fee API levels, in escalation order.
export const FEE_LEVELS = ['Low', 'Medium', 'High', 'VeryHigh', 'UnsafeMax'];

// Never price below this (micro-lamports per CU). At ~100k CU this is ~100
// lamports — negligible — but it keeps us out of the "literally zero" bucket
// that some schedulers deprioritise.
export const MIN_CU_PRICE = 1_000;

// Placeholder CU limit used only for the simulation pass.
const SIM_CU_LIMIT = 1_400_000;

// CU headroom on top of what the simulation consumed.
const CU_MARGIN_RATIO = 1.10;
const CU_MARGIN_FLAT = 5_000;

// ============================================================
// PURE HELPERS (unit-tested)
// ============================================================

/** Normalise a PRIORITY_LEVEL string ('medium', 'veryhigh', ...) to a Helius level. */
export function normalizeFeeLevel(level) {
    const key = String(level || 'medium').toLowerCase().replace(/[^a-z]/g, '');
    const map = { min: 'Low', low: 'Low', medium: 'Medium', high: 'High', veryhigh: 'VeryHigh', unsafemax: 'UnsafeMax' };
    return map[key] || 'Medium';
}

/** Next level up the ladder; saturates at the top. */
export function escalateFeeLevel(level) {
    const i = FEE_LEVELS.indexOf(level);
    if (i < 0) return 'Medium';
    return FEE_LEVELS[Math.min(i + 1, FEE_LEVELS.length - 1)];
}

/** Level to start at for attempt N (0-based) given the configured base level. */
export function feeLevelForAttempt(baseLevel, attempt) {
    let level = normalizeFeeLevel(baseLevel);
    for (let i = 0; i < attempt; i++) level = escalateFeeLevel(level);
    return level;
}

/** CU limit to request given what the simulation consumed. */
export function computeCuLimit(unitsConsumed) {
    const used = Math.max(0, Math.floor(Number(unitsConsumed) || 0));
    // Integer math (used * 110 / 100) so 100_000 -> 115_000 exactly, not
    // 115_000.00000000001 -> 115_001 from float multiplication.
    return Math.ceil((used * Math.round(CU_MARGIN_RATIO * 100)) / 100) + CU_MARGIN_FLAT;
}

/**
 * Clamp a CU price so that (price * cuLimit) never exceeds capLamports, and
 * never drops below MIN_CU_PRICE. Returns micro-lamports per CU (integer).
 */
export function capCuPrice(microLamportsPerCu, cuLimit, capLamports) {
    let price = Math.max(MIN_CU_PRICE, Math.ceil(Number(microLamportsPerCu) || 0));
    if (capLamports > 0 && cuLimit > 0) {
        const maxPrice = Math.floor((capLamports * 1_000_000) / cuLimit);
        price = Math.min(price, Math.max(MIN_CU_PRICE, maxPrice));
    }
    return price;
}

/** Total priority fee in lamports for a price/limit pair. */
export function priorityFeeLamports(microLamportsPerCu, cuLimit) {
    return Math.ceil((microLamportsPerCu * cuLimit) / 1_000_000);
}

/** Helius Sender URL for a region/mode. Returns null when Sender is off. */
export function senderUrl(region, mode) {
    if (mode === 'off') return null;
    const r = SENDER_REGIONS.includes(region) ? region : 'auto';
    const base = r === 'auto'
        ? 'https://sender.helius-rpc.com/fast'
        : `http://${r}-sender.helius-rpc.com/fast`;
    return mode === 'swqos' ? `${base}?swqos_only=true` : base;
}

/** Pick a tip account (uniform random unless an index is given). */
export function pickTipAccount(index) {
    const i = Number.isInteger(index) ? index : Math.floor(Math.random() * SENDER_TIP_ACCOUNTS.length);
    return new PublicKey(SENDER_TIP_ACCOUNTS[((i % SENDER_TIP_ACCOUNTS.length) + SENDER_TIP_ACCOUNTS.length) % SENDER_TIP_ACCOUNTS.length]);
}

/**
 * Helius Sender validates the tip by scanning a transaction's STATIC account
 * keys, so a tip account referenced through a lookup table is "not there" and
 * the send is rejected. Return copies of the tables with any tip account
 * replaced by a throwaway key at the same index, so the compiler keeps the tip
 * account static while every other index still maps to the on-chain table.
 */
export function maskLookupTables(tables) {
    const tipSet = new Set(SENDER_TIP_ACCOUNTS);
    return (tables || []).map(t => {
        if (!t.state.addresses.some(a => tipSet.has(a.toBase58()))) return t;
        return new AddressLookupTableAccount({
            key: t.key,
            state: {
                ...t.state,
                addresses: t.state.addresses.map(a => tipSet.has(a.toBase58()) ? Keypair.generate().publicKey : a),
            },
        });
    });
}

/** Parse landing-related config out of an env-like object. */
export function parseLandingConfig(env) {
    const mode = String(env.SENDER_MODE || 'swqos').toLowerCase();
    const region = String(env.SENDER_REGION || 'auto').toLowerCase();
    return {
        senderMode: SENDER_MODES.includes(mode) ? mode : 'swqos',
        senderRegion: SENDER_REGIONS.includes(region) ? region : 'auto',
        baseFeeLevel: normalizeFeeLevel(env.PRIORITY_LEVEL),
        priorityCapLamports: Math.round(Number(env.PRIORITY_FEE || 0.0005) * LAMPORTS_PER_SOL),
        maxAttempts: Math.max(1, Math.min(5, Number(env.LANDING_MAX_ATTEMPTS) || 3)),
    };
}

// ============================================================
// NETWORK HELPERS
// ============================================================

function sleepMs(ms) {
    return new Promise(r => setTimeout(r, ms));
}

/**
 * Percentile of a getRecentPrioritizationFees() sample for a fee level. Used
 * when the RPC is not Helius (any free/public RPC supports this standard
 * method). Lower levels pick a lower percentile, so 'low' really is cheap.
 */
export const LEVEL_PERCENTILE = { Low: 0.25, Medium: 0.5, High: 0.75, VeryHigh: 0.9, UnsafeMax: 1 };
export function percentileFee(samples, level) {
    const vals = (samples || []).map(f => Number(f?.prioritizationFee) || 0).sort((x, y) => x - y);
    if (vals.length === 0) return 0;
    const p = LEVEL_PERCENTILE[level] ?? 0.5;
    const idx = Math.min(vals.length - 1, Math.max(0, Math.ceil(p * vals.length) - 1));
    return vals[idx];
}

/** Which fee API an RPC URL supports: Helius' estimator, or the standard method. */
export function feeApiFor(rpcUrl) {
    return /helius/i.test(String(rpcUrl || '')) ? 'helius' : 'standard';
}

/**
 * Priority fee estimate in micro-lamports per CU, for exactly the writable
 * accounts this tx touches. Helius RPC: its account-aware Priority Fee API.
 * Any other RPC (free/public ones included): the standard
 * getRecentPrioritizationFees method, read at the level's percentile. Falls
 * back to a conservative constant if both fail, so a fee-API hiccup can never
 * stop a trade.
 */
export async function estimateCuPrice(ctx, accountKeys, level) {
    const fallback = { Low: 1_000, Medium: 10_000, High: 50_000, VeryHigh: 200_000, UnsafeMax: 500_000 }[level] || 10_000;
    if (!ctx.feeApi) ctx.feeApi = feeApiFor(ctx.rpcUrl);
    if (ctx.feeApi === 'helius') {
        try {
            const res = await axios.post(ctx.rpcUrl, {
                jsonrpc: '2.0', id: 'fee',
                method: 'getPriorityFeeEstimate',
                params: [{
                    accountKeys: accountKeys.map(k => k.toBase58()),
                    options: { priorityLevel: level, evaluateEmptySlotAsZero: true },
                }],
            }, { timeout: 2_500 });
            const est = res.data?.result?.priorityFeeEstimate;
            if (typeof est === 'number' && Number.isFinite(est)) return Math.ceil(est);
            // "method not found": this endpoint has no Helius estimator; stop asking.
            if (res.data?.error?.code === -32601) ctx.feeApi = 'standard';
        } catch { /* fall through to the standard method */ }
    }
    try {
        const samples = await ctx.connection.getRecentPrioritizationFees({ lockedWritableAccounts: accountKeys.slice(0, 128) });
        return Math.ceil(percentileFee(samples, level));
    } catch {
        return fallback;
    }
}

/** POST a signed tx to Helius Sender. Returns the signature or throws. */
async function sendViaSender(url, serializedBase64) {
    let res;
    try {
        res = await axios.post(url, {
            jsonrpc: '2.0', id: 'send',
            method: 'sendTransaction',
            params: [serializedBase64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }],
        }, { timeout: 3_000 });
    } catch (e) {
        const body = e.response?.data;
        const detail = body ? (typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)) : e.message;
        throw new Error(`sender HTTP ${e.response?.status || '?'}: ${detail}`);
    }
    if (res.data?.error) throw new Error(`sender: ${res.data.error.message || JSON.stringify(res.data.error)}`);
    return res.data?.result;
}

/** Wait until a signature is finalized (or give up after timeoutMs). */
export async function waitFinalized(ctx, signature, timeoutMs = 25_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const { value } = await ctx.connection.getSignatureStatuses([signature]);
            const st = value[0];
            if (st?.confirmationStatus === 'finalized') return true;
            if (st?.err) return false;
        } catch { /* retry */ }
        await sleepMs(500);
    }
    return false;
}

/**
 * Send the same signed tx via Sender and RPC at once; succeed if either did.
 * `useRpc: false` skips the RPC copy (Sender is free; an RPC send costs a
 * request on a metered plan). Used for every other rebroadcast.
 */
async function broadcast(ctx, tx, senderUrlStr, { useRpc = true } = {}) {
    const raw = tx.serialize();
    const tasks = [];
    if (useRpc || !senderUrlStr) {
        tasks.push(ctx.connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })
            .then(sig => ({ via: 'rpc', sig }))
            .catch(e => ({ via: 'rpc', error: e?.message || String(e) })));
    }
    if (senderUrlStr) {
        tasks.push(sendViaSender(senderUrlStr, Buffer.from(raw).toString('base64'))
            .then(sig => ({ via: 'sender', sig }))
            .catch(e => ({ via: 'sender', error: e?.message || String(e) })));
    }
    const results = await Promise.all(tasks);
    const ok = results.filter(r => r.sig);
    return { ok: ok.length > 0, results };
}

// ============================================================
// BUILD + SIMULATE
// ============================================================

function compile(payer, blockhash, instructions, lookupTables = []) {
    return new TransactionMessage({
        payerKey: payer,
        recentBlockhash: blockhash,
        instructions,
    }).compileToV0Message(lookupTables);
}

/**
 * Simulate the instruction list (with a generous CU placeholder) and return
 * { unitsConsumed, logs } or throw an Error carrying the simulation logs.
 */
export async function simulateInstructions(ctx, { payer, instructions, lookupTables = [], blockhash }) {
    const simIxs = [ComputeBudgetProgram.setComputeUnitLimit({ units: SIM_CU_LIMIT }), ...instructions];
    const tx = new VersionedTransaction(compile(payer, blockhash, simIxs, lookupTables));
    const sim = await ctx.connection.simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'confirmed',
    });
    const v = sim.value;
    if (v.err) {
        const err = new Error(`simulation failed: ${JSON.stringify(v.err)}`);
        err.logs = v.logs || [];
        err.simulationError = v.err;
        throw err;
    }
    return { unitsConsumed: Number(v.unitsConsumed || 0), logs: v.logs || [] };
}

// ============================================================
// LAND
// ============================================================

/**
 * Build, price, send and confirm a transaction; escalate the fee on expiry.
 *
 * @param ctx      context from solUtils.createContext (connection, rpcUrl,
 *                 landing config, mainWallet)
 * @param build    async (attempt) => { instructions, signers, payer, lookupTables?, label? }
 *                 Called fresh for every attempt so the caller can re-read
 *                 on-chain state / re-quote.
 * @param opts     { label, maxAttempts, log }
 * @returns { confirmed, signature, err, attempts, stats }
 *          stats: { cuLimit, cuPrice, priorityFeeLamports, tipLamports,
 *                   feeLevel, simMs, landMs, totalMs, via }
 */
export async function landTransaction(ctx, build, opts = {}) {
    const cfg = ctx.landing;
    const label = opts.label || 'tx';
    const log = opts.log || (() => {});
    const maxAttempts = opts.maxAttempts || cfg.maxAttempts;
    const senderUrlStr = senderUrl(cfg.senderRegion, cfg.senderMode);
    const tipLamports = SENDER_TIP_LAMPORTS[cfg.senderMode] || 0;

    let lastErr = 'unknown';
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const t0 = Date.now();
        const level = feeLevelForAttempt(cfg.baseFeeLevel, attempt);

        // 1. Fresh instructions + fresh blockhash for this attempt.
        const built = await build(attempt);
        const payer = built.payer;
        const signers = built.signers;
        const lookupTables = maskLookupTables(built.lookupTables || []);
        const tipIx = tipLamports > 0
            ? SystemProgram.transfer({ fromPubkey: payer, toPubkey: pickTipAccount(), lamports: tipLamports })
            : null;
        // The tip is the LAST instruction, so a sweep built by the caller can
        // leave exactly `tipLamports` behind for it.
        const userIxs = tipIx ? [...built.instructions, tipIx] : [...built.instructions];
        const baseFeeLamports = 5_000 * new Set(signers.map(s => s.publicKey.toBase58())).size;

        const { blockhash, lastValidBlockHeight } = await ctx.connection.getLatestBlockhash('confirmed');

        // 2. Simulate: exact CU + free pre-flight.
        const { unitsConsumed } = await simulateInstructions(ctx, { payer, instructions: userIxs, lookupTables, blockhash });
        const cuLimit = computeCuLimit(unitsConsumed);
        const simMs = Date.now() - t0;

        // 3. Price: account-aware estimate at this attempt's level, capped.
        const accountKeys = uniqueWritableKeys(userIxs, payer);
        const rawPrice = await estimateCuPrice(ctx, accountKeys, level);
        const cuPrice = capCuPrice(rawPrice, cuLimit, cfg.priorityCapLamports);
        const feeLamports = priorityFeeLamports(cuPrice, cuLimit);

        // Callers that sweep a wallet to exactly zero need the exact fee; give
        // them the numbers and let them re-emit their instructions.
        let bodyIxs = userIxs;
        if (typeof built.finalize === 'function') {
            const exact = await built.finalize({ baseFeeLamports, priorityFeeLamports: feeLamports, tipLamports });
            bodyIxs = tipIx ? [...exact, tipIx] : [...exact];
        }
        const finalIxs = [
            ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
            ...bodyIxs,
        ];
        const tx = new VersionedTransaction(compile(payer, blockhash, finalIxs, lookupTables));
        tx.sign(signers);
        const signature = bs58Signature(tx);
        const txBytes = tx.serialize().length;

        log(`[${label}] attempt ${attempt + 1}/${maxAttempts}: ${level} fee, CU ${cuLimit} @ ${cuPrice} µL = ${feeLamports} lamports, tip ${tipLamports}, ${txBytes} bytes, sim ${simMs}ms`);

        // 4. Send + confirm with rebroadcast until confirmed or expired.
        const tSend = Date.now();
        const first = await broadcast(ctx, tx, senderUrlStr);
        if (!first.ok) {
            lastErr = `broadcast failed: ${first.results.map(r => `${r.via}: ${r.error}`).join(' | ')}`;
            log(`[${label}] ${lastErr}`);
            await sleepMs(500);
            continue;
        }
        const via = first.results.filter(r => r.sig).map(r => r.via).join('+');
        for (const r of first.results) {
            if (r.error) log(`[${label}] ${r.via} send failed: ${r.error}`);
        }

        const outcome = await confirmWithRebroadcast(ctx, tx, signature, lastValidBlockHeight, senderUrlStr);
        const landMs = Date.now() - tSend;
        const stats = {
            cuLimit, cuPrice, priorityFeeLamports: feeLamports, tipLamports, baseFeeLamports, feeLevel: level,
            gasLamports: baseFeeLamports + feeLamports + tipLamports,
            simMs, landMs, totalMs: Date.now() - t0, via, bytes: txBytes,
        };

        if (outcome.confirmed) {
            return { confirmed: true, signature, attempts: attempt + 1, stats };
        }
        if (outcome.err && outcome.err !== 'expired') {
            // Executed on-chain and failed: do NOT blindly retry (state changed).
            return { confirmed: false, signature, err: outcome.err, attempts: attempt + 1, stats };
        }
        lastErr = 'expired';
        log(`[${label}] not landed before blockhash expiry — escalating fee`);
    }
    return { confirmed: false, err: lastErr, attempts: maxAttempts };
}

// ============================================================
// SHARED SIGNATURE WATCHER
// ============================================================

/**
 * One status poller per connection, shared by every transaction in flight.
 * With N wallets landing at once this is ONE getSignatureStatuses call per
 * tick (up to 256 signatures) instead of N, and one cached block-height read
 * instead of N. That keeps the bot inside a free RPC plan's request limit.
 */
export class SignatureWatcher {
    constructor(connection, { pollMs = 400, heightTtlMs = 1_500 } = {}) {
        this.connection = connection;
        this.pollMs = pollMs;
        this.heightTtlMs = heightTtlMs;
        this.subs = new Map();      // signature -> latest status (or null)
        this.running = false;
        this.calls = 0;             // RPC calls made (for tests / stats)
        this._height = { value: 0, at: 0, inflight: null };
    }

    watch(signature) {
        if (!this.subs.has(signature)) this.subs.set(signature, null);
        if (!this.running) {
            this.running = true;
            this._loop();
        }
    }

    unwatch(signature) { this.subs.delete(signature); }

    status(signature) { return this.subs.get(signature) ?? null; }

    async _loop() {
        // A short first wait lets signatures sent in the same moment share the
        // first call (a tx never confirms faster than this anyway).
        await sleepMs(Math.min(200, this.pollMs));
        while (this.subs.size > 0) {
            const sigs = [...this.subs.keys()].slice(0, 256);
            try {
                this.calls++;
                const { value } = await this.connection.getSignatureStatuses(sigs);
                value.forEach((st, i) => { if (st && this.subs.has(sigs[i])) this.subs.set(sigs[i], st); });
            } catch { /* transient RPC error: next tick */ }
            await sleepMs(this.pollMs);
        }
        this.running = false;
    }

    /** Current block height, cached briefly and shared between callers. */
    async blockHeight() {
        const h = this._height;
        if (Date.now() - h.at < this.heightTtlMs && h.value) return h.value;
        if (!h.inflight) {
            this.calls++;
            h.inflight = this.connection.getBlockHeight('confirmed')
                .then(v => { h.value = v; h.at = Date.now(); return v; })
                .finally(() => { h.inflight = null; });
        }
        return h.inflight;
    }
}

function watcherFor(ctx) {
    if (!ctx.sigWatcher) ctx.sigWatcher = new SignatureWatcher(ctx.connection);
    return ctx.sigWatcher;
}

/**
 * Wait on the shared watcher; re-send every 2 s (Sender every time, the RPC
 * copy every other time); stop on confirmation, on-chain error, or when the
 * blockhash can no longer be valid.
 */
async function confirmWithRebroadcast(ctx, tx, signature, lastValidBlockHeight, senderUrlStr) {
    const CHECK_MS = 150;          // local check of the shared status (no RPC)
    const RESEND_MS = 2_000;
    const HEIGHT_CHECK_MS = 2_000;
    const watcher = watcherFor(ctx);
    let lastResend = Date.now();
    let lastHeightCheck = Date.now();
    let resends = 0;
    const done = (st) => st && !st.err && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized');

    watcher.watch(signature);
    try {
        for (;;) {
            const st = watcher.status(signature);
            if (st) {
                if (st.err) return { confirmed: false, err: st.err };
                if (done(st)) return { confirmed: true };
            }

            const now = Date.now();
            if (now - lastHeightCheck >= HEIGHT_CHECK_MS) {
                lastHeightCheck = now;
                try {
                    const height = await watcher.blockHeight();
                    if (height > lastValidBlockHeight) {
                        // One last direct check: it may have landed in the final slots.
                        const { value } = await ctx.connection.getSignatureStatuses([signature]);
                        const last = value[0];
                        if (done(last)) return { confirmed: true };
                        if (last && last.err) return { confirmed: false, err: last.err };
                        return { confirmed: false, err: 'expired' };
                    }
                } catch {
                    // ignore; next tick
                }
            }
            if (now - lastResend >= RESEND_MS) {
                lastResend = now;
                resends++;
                broadcast(ctx, tx, senderUrlStr, { useRpc: resends % 2 === 0 }).catch(() => {});
            }
            await sleepMs(CHECK_MS);
        }
    } finally {
        watcher.unwatch(signature);
    }
}

// ============================================================
// SMALL UTILITIES
// ============================================================

function bs58Signature(tx) {
    // web3.js exposes signatures as Uint8Array; the first is the fee payer's,
    // which is the transaction's signature/id.
    return bs58.encode(tx.signatures[0]);
}

/** Unique writable (non-signer-only) account keys across instructions, for fee estimation. */
export function uniqueWritableKeys(instructions, payer) {
    const seen = new Map();
    if (payer) seen.set(payer.toBase58(), payer);
    for (const ix of instructions) {
        for (const k of ix.keys) {
            if (k.isWritable) seen.set(k.pubkey.toBase58(), k.pubkey);
        }
    }
    return [...seen.values()];
}
