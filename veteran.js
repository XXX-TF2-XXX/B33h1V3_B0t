/**
 * veteran.js — pure helpers for veteran wallets (no network; unit-tested).
 *
 * A veteran is a trading wallet that is funded ONCE, then trades several
 * times with random waits in between before it is drained to zero and
 * retired, like every other wallet. Each visit is either:
 *   - a sell, if it is holding tokens from its previous visit, or
 *   - a buy, after which it either sells straight away (round trip) or, with
 *     VETERAN_HOLD_PCT chance, holds the tokens until its next visit.
 * The last visit never holds, and the final drain sells anything left.
 *
 * Cost: a veteran visit is 1-2 transactions instead of a recycler's 4 (no
 * funding, no sweep), and its token account + per-user PDA stay open across
 * visits instead of being created and closed every time.
 */

export function randInt(min, max, rand = Math.random) {
    const lo = Math.ceil(Math.min(min, max));
    const hi = Math.floor(Math.max(min, max));
    return Math.floor(rand() * (hi - lo + 1)) + lo;
}

function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
}

/** Integer env value; blank/missing/garbage -> default (and 0 stays 0). */
export function intSetting(value, dflt) {
    if (value == null || String(value).trim() === '') return dflt;
    const n = Number(value);
    return Number.isFinite(n) ? Math.floor(n) : dflt;
}

export function parseVeteranConfig(env) {
    const count = clamp(intSetting(env.VETERAN_WALLETS, 1), 0, 10);
    const minTrades = clamp(intSetting(env.VETERAN_MIN_TRADES, 3), 1, 100);
    const maxTrades = Math.max(minTrades, clamp(intSetting(env.VETERAN_MAX_TRADES, 8), 1, 100));
    const holdPct = clamp(intSetting(env.VETERAN_HOLD_PCT, 50), 0, 100);
    const waitMin = clamp(intSetting(env.VETERAN_WAIT_MIN, 10), 0, 3600);
    const waitMax = Math.max(waitMin, clamp(intSetting(env.VETERAN_WAIT_MAX, 60), 0, 3600));
    return { count, minTrades, maxTrades, holdPct, waitMin, waitMax };
}

/** After a buy on visit `visit` of `life`: hold until the next visit? Never on the last visit. */
export function decideHold({ visit, life, holdPct, rand = Math.random }) {
    if (visit >= life) return false;
    return rand() * 100 < holdPct;
}

/**
 * SOL a veteran must keep back when buying: rents for the accounts the buy
 * may still create (its token account and per-user PDA are created on the
 * first buy and then stay open), the temporary wrapped-SOL account's rent
 * (returned in the same tx), the slippage margin, fees + tips for a buy, a
 * sell and the final close, and the rent floor the fee payer must stay above.
 */
export function veteranReserveLamports({
    rents = { tokenAta: 2_074_080, accumulator: 1_844_400, wsolAta: 2_039_280 },
    hasTokenAta = false, hasAccumulator = false,
    buyLamports, slippageBps, tipLamports = 5_000, rentFloor = 890_880,
}) {
    const slippageMargin = Math.ceil(Number(buyLamports) * (Number(slippageBps) / 10_000));
    const feesPerTx = 5_000 + tipLamports + 25_000;
    return (hasTokenAta ? 0 : rents.tokenAta)
        + (hasAccumulator ? 0 : rents.accumulator)
        + rents.wsolAta
        + slippageMargin
        + 3 * feesPerTx
        + rentFloor;
}

/**
 * How much the veteran buys this visit: a random size in [minBuy, maxBuy],
 * trimmed to what it can afford above its reserve. 0 means it can no longer
 * make a minimum-size buy and should retire.
 */
export function veteranBuyLamports({ walletLamports, reserveLamports, minBuy, maxBuy, rand = Math.random }) {
    const budget = Number(walletLamports) - Number(reserveLamports);
    if (budget < minBuy) return 0;
    return Math.min(randInt(minBuy, maxBuy, rand), budget);
}
