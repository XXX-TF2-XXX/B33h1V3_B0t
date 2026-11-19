/**
 * pumpswap.js — direct PumpSwap (pump.fun AMM) swap instructions for B33h1V3_B0t.
 *
 * Replaces Jupiter's quote+swap HTTP round-trips with instructions built
 * locally from the pool's reserves (one RPC read) using pump.fun's official
 * SDK. The TRADING WALLET is the fee payer and the only signer of its own buy
 * and sell — exactly as with the Jupiter path — so on-chain and on every
 * tracker the trade belongs to the fresh wallet, not to the main wallet.
 *
 * Transaction shapes (wallet pays, wallet signs):
 *   buy   : create WSOL acct -> wrap buy amount -> create token acct -> buy -> unwrap
 *   sell  : create WSOL acct -> sell ALL -> unwrap (proceeds land in the wallet as SOL)
 *   close : close token acct (rent -> main), close leftover WSOL acct (-> main),
 *           close PumpSwap per-user PDA (rent -> wallet), sweep everything -> main
 */

import { PublicKey, SystemProgram, Keypair, ComputeBudgetProgram } from '@solana/web3.js';
import {
    getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
    createCloseAccountInstruction, createSyncNativeInstruction,
    NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, AccountLayout, MintLayout,
} from '@solana/spl-token';
import BN from 'bn.js';
import {
    PUMP_AMM_SDK, PUMP_AMM_PROGRAM_ID, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA,
    canonicalPumpPoolPda, buyQuoteInput, sellBaseInput, poolV2Pda, userVolumeAccumulatorPda,
} from '@pump-fun/pump-swap-sdk';
import { ensureLookupTable } from './lookupTable.js';
import { pumpfunUserVolumeAccumulatorPda } from './pumpfun.js';

export { PUMP_AMM_PROGRAM_ID };

// PumpSwap's buy initialises a per-user "volume accumulator" PDA (for pump.fun's
// incentive programme) and charges its rent to the USER, even with track_volume
// off. On-chain it is 137 bytes (1,844,400 lamports as of 2026-08). The wallet
// pays it out of its buffer and gets it back when the account is closed on drain.
export const USER_VOLUME_ACCUMULATOR_SPACE = 137;
const TOKEN_ACCOUNT_SPACE = 165;        // classic SPL token account
const TOKEN_2022_ATA_SPACE = 170;       // Token-2022 ATA (ImmutableOwner extension)

// ============================================================
// DETECTION + STATIC STATE
// ============================================================

/** The token's canonical PumpSwap pool, or null if it doesn't exist. */
export async function detectPumpSwapPool(ctx) {
    const poolKey = canonicalPumpPoolPda(ctx.tokenMint);
    const info = await ctx.connection.getAccountInfo(poolKey, 'confirmed');
    if (!info || !info.owner.equals(PUMP_AMM_PROGRAM_ID)) return null;
    return { poolKey, poolAccountInfo: info, pool: PUMP_AMM_SDK.decodePool(info) };
}

/**
 * Fetch the things that (almost) never change — global config, fee config,
 * the mints, rents — once, and cache them on ctx.pumpswap.
 */
export async function loadPumpSwapStaticState(ctx, detected) {
    const { poolKey, pool, poolAccountInfo } = detected;
    const [gcInfo, fcInfo, baseMintInfo, quoteMintInfo] = await ctx.connection.getMultipleAccountsInfo(
        [GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, pool.baseMint, pool.quoteMint], 'confirmed');
    if (!gcInfo) throw new Error('PumpSwap global config account not found');
    if (!baseMintInfo || !quoteMintInfo) throw new Error('PumpSwap pool mint account(s) not found');

    const baseTokenProgram = baseMintInfo.owner;
    const tokenAtaSpace = baseTokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_ATA_SPACE : TOKEN_ACCOUNT_SPACE;
    const [accumulator, wsolAta, tokenAta] = await Promise.all([
        ctx.connection.getMinimumBalanceForRentExemption(USER_VOLUME_ACCUMULATOR_SPACE, 'confirmed'),
        ctx.connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SPACE, 'confirmed'),
        ctx.connection.getMinimumBalanceForRentExemption(tokenAtaSpace, 'confirmed'),
    ]);

    ctx.pumpswap = {
        poolKey,
        pool,
        poolAccountInfo,
        globalConfig: PUMP_AMM_SDK.decodeGlobalConfig(gcInfo),
        feeConfig: fcInfo ? PUMP_AMM_SDK.decodeFeeConfig(fcInfo) : null,
        baseMint: pool.baseMint,
        quoteMint: pool.quoteMint,
        baseTokenProgram,
        quoteTokenProgram: quoteMintInfo.owner,
        baseMintAccount: MintLayout.decode(baseMintInfo.data),
        slippagePct: ctx.slippageBps / 100,
        trackVolume: false,
        rents: { accumulator, wsolAta, tokenAta },
        lookupTables: [],
        loadedAt: Date.now(),
    };
    return ctx.pumpswap;
}

/**
 * Smallest wallet buffer (on top of the buy amount) that lets a fresh wallet
 * complete buy -> sell -> close on its own: the three rents it fronts (all
 * returned), the slippage margin on the buy, and fees/tips for three txs.
 */
export function minWalletBufferLamports(ctx, buyLamports) {
    const r = ctx.pumpswap?.rents || { accumulator: 1_844_400, wsolAta: 2_039_280, tokenAta: 2_074_080 };
    const slippageMargin = Math.ceil(buyLamports * (ctx.slippageBps / 10_000));
    const tip = ctx.landing?.senderMode === 'max' ? 1_000_000 : (ctx.landing?.senderMode === 'off' ? 0 : 5_000);
    const feesPerTx = 5_000 + tip + 25_000; // base + tip + generous priority allowance
    return r.accumulator + r.wsolAta + r.tokenAta + slippageMargin + 3 * feesPerTx;
}

/** Associated token accounts (and the PumpSwap PDA) for an owner. */
export function walletAtas(ctx, owner) {
    const ps = ctx.pumpswap;
    return {
        tokenAta: getAssociatedTokenAddressSync(ps.baseMint, owner, true, ps.baseTokenProgram),
        wsolAta: getAssociatedTokenAddressSync(NATIVE_MINT, owner, true, TOKEN_PROGRAM_ID),
        accumulator: userVolumeAccumulatorPda(owner),
        // pump.fun's bonding-curve accumulator (different program): created by
        // any buy made on the curve before graduation, e.g. via Jupiter.
        pumpfunAccumulator: pumpfunUserVolumeAccumulatorPda(owner),
    };
}

// ============================================================
// LIVE STATE (one RPC read per swap)
// ============================================================

/**
 * Everything a swap needs, in ONE getMultipleAccountsInfo: pool (refreshed),
 * pool vaults (reserves), the user's token + WSOL accounts, the user's system
 * account and PumpSwap PDA. Returns the SDK's SwapSolanaState shape plus extras.
 */
export async function fetchSwapState(ctx, user) {
    const ps = ctx.pumpswap;
    const { tokenAta, wsolAta, accumulator, pumpfunAccumulator } = walletAtas(ctx, user);
    const [poolInfo, poolBaseInfo, poolQuoteInfo, userBaseInfo, userQuoteInfo, userInfo, accInfo, pfInfo] =
        await ctx.connection.getMultipleAccountsInfo(
            [ps.poolKey, ps.pool.poolBaseTokenAccount, ps.pool.poolQuoteTokenAccount, tokenAta, wsolAta, user, accumulator, pumpfunAccumulator],
            'confirmed');
    if (!poolInfo || !poolBaseInfo || !poolQuoteInfo) throw new Error('PumpSwap pool accounts not found');

    const pool = PUMP_AMM_SDK.decodePool(poolInfo);
    ps.pool = pool;
    ps.poolAccountInfo = poolInfo;

    return {
        // --- SDK SwapSolanaState shape ---
        globalConfig: ps.globalConfig,
        feeConfig: ps.feeConfig,
        poolKey: ps.poolKey,
        poolAccountInfo: poolInfo,
        pool,
        poolBaseAmount: new BN(AccountLayout.decode(poolBaseInfo.data).amount.toString()),
        poolQuoteAmount: new BN(AccountLayout.decode(poolQuoteInfo.data).amount.toString()),
        baseTokenProgram: ps.baseTokenProgram,
        quoteTokenProgram: ps.quoteTokenProgram,
        baseMint: ps.baseMint,
        baseMintAccount: ps.baseMintAccount,
        user,
        userBaseTokenAccount: tokenAta,
        userQuoteTokenAccount: wsolAta,
        userBaseAccountInfo: userBaseInfo,
        userQuoteAccountInfo: userQuoteInfo,
        // --- extras ---
        userTokenBalance: userBaseInfo ? AccountLayout.decode(userBaseInfo.data).amount : 0n,
        userLamports: userInfo ? userInfo.lamports : 0,
        userHasTokenAccount: !!userBaseInfo,
        userHasWsolAccount: !!userQuoteInfo,
        userHasAccumulator: !!accInfo,
        tokenAtaLamports: userBaseInfo ? userBaseInfo.lamports : 0,
        wsolAtaLamports: userQuoteInfo ? userQuoteInfo.lamports : 0,
        accumulatorLamports: accInfo ? accInfo.lamports : 0,
        accumulator,
        userHasPumpfunAccumulator: !!pfInfo,
        pumpfunAccumulatorLamports: pfInfo ? pfInfo.lamports : 0,
        pumpfunAccumulator,
    };
}

/** Is the wallet completely gone (no lamports, no token accounts, no PDA)? */
export async function walletAccountsSnapshot(ctx, owner) {
    const { tokenAta, wsolAta, accumulator, pumpfunAccumulator } = walletAtas(ctx, owner);
    const [userInfo, tokenInfo, wsolInfo, accInfo, pfInfo] = await ctx.connection.getMultipleAccountsInfo([owner, tokenAta, wsolAta, accumulator, pumpfunAccumulator], 'confirmed');
    const lamports = userInfo ? userInfo.lamports : 0;
    const tokenBalance = tokenInfo ? AccountLayout.decode(tokenInfo.data).amount : 0n;
    return {
        lamports, tokenBalance,
        hasTokenAccount: !!tokenInfo, hasWsolAccount: !!wsolInfo, hasAccumulator: !!accInfo, hasPumpfunAccumulator: !!pfInfo,
        empty: lamports === 0 && !tokenInfo && !wsolInfo && !accInfo && !pfInfo,
    };
}

// ============================================================
// QUOTES (pure, from reserves)
// ============================================================

function quoteParams(ctx, state, slippageBps) {
    return {
        slippage: slippageBps != null ? slippageBps / 100 : ctx.pumpswap.slippagePct,
        baseReserve: state.poolBaseAmount,
        quoteReserve: state.poolQuoteAmount,
        virtualQuoteReserves: state.pool.virtualQuoteReserves,
        baseMintAccount: state.baseMintAccount,
        baseMint: state.baseMint,
        coinCreator: state.pool.coinCreator,
        creator: state.pool.creator,
        feeConfig: state.feeConfig,
        globalConfig: state.globalConfig,
    };
}

/** Spend `quoteLamports` of SOL: tokens out, and the worst-case SOL in with slippage. */
export function quoteBuy(ctx, state, quoteLamports) {
    const { base, maxQuote } = buyQuoteInput({ quote: new BN(quoteLamports.toString()), ...quoteParams(ctx, state) });
    return { baseOut: base, maxQuoteIn: maxQuote };
}

/** Sell `baseAmount` tokens: expected SOL out, and the minimum acceptable with slippage. */
export function quoteSell(ctx, state, baseAmount, slippageBps) {
    const { uiQuote, minQuote } = sellBaseInput({ base: new BN(baseAmount.toString()), ...quoteParams(ctx, state, slippageBps) });
    return { expectedQuoteOut: uiQuote, minQuoteOut: minQuote };
}

// ============================================================
// RAW PUMPSWAP INSTRUCTIONS
// ============================================================

// Mirrors the SDK's buyInstructionsNoPool() remaining-accounts logic, but lets
// us choose track_volume and do our own (wallet-paid) wrapping.
async function pumpBuyInstruction(state, baseOut, maxQuoteIn, trackVolume) {
    const accounts = PUMP_AMM_SDK.swapAccounts(state);
    const remaining = [];
    if (state.pool.isCashbackCoin) {
        remaining.push({
            pubkey: getAssociatedTokenAddressSync(accounts.quoteMint, userVolumeAccumulatorPda(state.user), true, accounts.quoteTokenProgram),
            isWritable: true, isSigner: false,
        });
    }
    if (!state.pool.coinCreator.equals(PublicKey.default)) {
        remaining.push({ pubkey: poolV2Pda(state.pool.baseMint), isWritable: false, isSigner: false });
    }
    remaining.push(
        { pubkey: accounts.buybackFeeRecipient, isWritable: false, isSigner: false },
        { pubkey: accounts.buybackFeeRecipientTokenAccount, isWritable: true, isSigner: false },
    );
    return PUMP_AMM_SDK.offlineProgram.methods
        .buy(baseOut, maxQuoteIn, { 0: trackVolume })
        .accounts(accounts)
        .remainingAccounts(remaining)
        .instruction();
}

// The SDK's sell builder wraps the sell in its own ATA create/close; keep only
// the PumpSwap program instruction and do our own wrapping.
async function pumpSellInstruction(state, baseIn, minQuoteOut) {
    const ixs = await PUMP_AMM_SDK.sellInstructionsNoPool(state, baseIn, minQuoteOut);
    const own = ixs.filter(ix => ix.programId.equals(PUMP_AMM_PROGRAM_ID));
    if (own.length !== 1) throw new Error(`unexpected PumpSwap sell instruction count: ${own.length}`);
    return own[0];
}

/** Close the wallet's PumpSwap per-user PDA; its rent returns to the wallet. */
export async function closeAccumulatorInstruction(owner) {
    return PUMP_AMM_SDK.closeUserVolumeAccumulator(owner);
}

// ============================================================
// BUY — wallet pays, wallet signs
// ============================================================

export async function buildWalletBuyInstructions(ctx, state, wallet, quoteLamports) {
    const owner = wallet.publicKey;
    const { baseOut, maxQuoteIn } = quoteBuy(ctx, state, quoteLamports);
    if (baseOut.lten(0)) throw new Error('PumpSwap quote returned 0 tokens out');

    const instructions = [
        createAssociatedTokenAccountIdempotentInstruction(owner, state.userQuoteTokenAccount, owner, NATIVE_MINT, TOKEN_PROGRAM_ID),
        SystemProgram.transfer({ fromPubkey: owner, toPubkey: state.userQuoteTokenAccount, lamports: BigInt(maxQuoteIn.toString()) }),
        createSyncNativeInstruction(state.userQuoteTokenAccount, TOKEN_PROGRAM_ID),
        createAssociatedTokenAccountIdempotentInstruction(owner, state.userBaseTokenAccount, owner, state.baseMint, state.baseTokenProgram),
        await pumpBuyInstruction(state, baseOut, maxQuoteIn, ctx.pumpswap.trackVolume),
        // Unwrap: unspent SOL + the WSOL account's rent come straight back to the wallet.
        createCloseAccountInstruction(state.userQuoteTokenAccount, owner, owner, [], TOKEN_PROGRAM_ID),
    ];
    return {
        instructions,
        signers: [wallet],
        payer: owner,
        lookupTables: ctx.pumpswap.lookupTables || [],
        quote: { baseOut, maxQuoteIn, quoteLamports: BigInt(quoteLamports.toString()) },
    };
}

// ============================================================
// SELL — wallet pays, wallet signs; proceeds land in the wallet as SOL
// ============================================================

export async function buildWalletSellInstructions(ctx, state, wallet, { slippageBps } = {}) {
    const owner = wallet.publicKey;
    if (state.userTokenBalance <= 0n) throw new Error('wallet holds no tokens to sell');
    const { expectedQuoteOut, minQuoteOut } = quoteSell(ctx, state, state.userTokenBalance, slippageBps);

    const instructions = [
        createAssociatedTokenAccountIdempotentInstruction(owner, state.userQuoteTokenAccount, owner, NATIVE_MINT, TOKEN_PROGRAM_ID),
        await pumpSellInstruction(state, new BN(state.userTokenBalance.toString()), minQuoteOut),
        createCloseAccountInstruction(state.userQuoteTokenAccount, owner, owner, [], TOKEN_PROGRAM_ID),
    ];
    return {
        instructions,
        signers: [wallet],
        payer: owner,
        lookupTables: ctx.pumpswap.lookupTables || [],
        expected: { solFromSale: Number(expectedQuoteOut.toString()) },
    };
}

// ============================================================
// LOOKUP TABLE (keeps each tx ~600-800 bytes; invisible on-chain)
// ============================================================

/**
 * Every static account a cycle touches, collected by building the three
 * wallet transactions for a throwaway wallet. The throwaway wallet's own
 * accounts are excluded — they are different every cycle. Sender tip accounts
 * are deliberately NOT included (Helius validates the tip on static keys).
 */
export async function collectStaticAddresses(ctx) {
    const dummy = Keypair.generate();
    const state = await fetchSwapState(ctx, dummy.publicKey);
    const buy = await buildWalletBuyInstructions(ctx, state, dummy, 1_000_000);
    const sellState = { ...state, userTokenBalance: 1n, userHasTokenAccount: true, userHasAccumulator: true };
    const sell = await buildWalletSellInstructions(ctx, sellState, dummy);
    const { tokenAta, wsolAta, accumulator } = walletAtas(ctx, dummy.publicKey);
    const exclude = new Set([dummy.publicKey, tokenAta, wsolAta, accumulator].map(k => k.toBase58()));

    const out = new Map();
    const add = (k) => { const s = k.toBase58(); if (!exclude.has(s) && !out.has(s)) out.set(s, k); };
    for (const ix of [...buy.instructions, ...sell.instructions, await closeAccumulatorInstruction(dummy.publicKey)]) {
        add(ix.programId);
        for (const k of ix.keys) add(k.pubkey);
    }
    add(ctx.mainWallet.publicKey);
    // PumpSwap picks its protocol / buyback fee recipient AT RANDOM for every
    // instruction, so seed every possible recipient and its WSOL account.
    const gc = ctx.pumpswap.globalConfig;
    const recipients = [
        ...(gc.protocolFeeRecipients || []),
        ...(gc.reservedFeeRecipients || []),
        ...(gc.buybackFeeRecipients || []),
        gc.reservedFeeRecipient,
    ].filter(k => k && !k.equals(PublicKey.default));
    for (const r of recipients) {
        add(r);
        add(getAssociatedTokenAddressSync(ctx.pumpswap.quoteMint, r, true, ctx.pumpswap.quoteTokenProgram));
    }
    add(ComputeBudgetProgram.programId);
    return [...out.values()];
}

/** Create/verify the token's lookup table and attach it to the engine. */
export async function ensurePumpSwapLookupTable(ctx, log = () => {}) {
    const wanted = await collectStaticAddresses(ctx);
    const table = await ensureLookupTable(ctx, ctx.tokenMint.toBase58(), wanted, { log });
    ctx.pumpswap.lookupTables = [table];
    log(`Lookup table ${table.key.toBase58()} ready (${table.state.addresses.length} addresses)`);
    return table;
}
