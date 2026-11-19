// Veteran-wallet helpers — pure, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    randInt, intSetting, parseVeteranConfig, decideHold, veteranReserveLamports, veteranBuyLamports,
} from '../veteran.js';

test('randInt stays inside [min, max] and hits both ends', () => {
    assert.equal(randInt(3, 8, () => 0), 3);
    assert.equal(randInt(3, 8, () => 0.9999999), 8);
    assert.equal(randInt(8, 3, () => 0), 3); // swapped bounds tolerated
    for (let i = 0; i < 500; i++) { const v = randInt(5, 7); assert.ok(v >= 5 && v <= 7); }
});

test('intSetting: blank -> default, 0 stays 0, garbage -> default', () => {
    assert.equal(intSetting('', 3), 3);
    assert.equal(intSetting(undefined, 3), 3);
    assert.equal(intSetting('0', 3), 0);
    assert.equal(intSetting('2.9', 3), 2);
    assert.equal(intSetting('abc', 3), 3);
});

test('parseVeteranConfig defaults and clamps', () => {
    assert.deepEqual(parseVeteranConfig({}), { count: 1, minTrades: 3, maxTrades: 8, holdPct: 50, waitMin: 10, waitMax: 60 });
    const c = parseVeteranConfig({ VETERAN_WALLETS: '99', VETERAN_MIN_TRADES: '9', VETERAN_MAX_TRADES: '2', VETERAN_HOLD_PCT: '150', VETERAN_WAIT_MIN: '30', VETERAN_WAIT_MAX: '5' });
    assert.equal(c.count, 10);
    assert.equal(c.minTrades, 9);
    assert.equal(c.maxTrades, 9);   // max raised to min
    assert.equal(c.holdPct, 100);
    assert.equal(c.waitMax, 30);    // max raised to min
    assert.equal(parseVeteranConfig({ VETERAN_WALLETS: '0' }).count, 0);
});

test('decideHold never holds on the last visit and follows the percentage otherwise', () => {
    assert.equal(decideHold({ visit: 5, life: 5, holdPct: 100 }), false);
    assert.equal(decideHold({ visit: 1, life: 5, holdPct: 100 }), true);
    assert.equal(decideHold({ visit: 1, life: 5, holdPct: 0 }), false);
    assert.equal(decideHold({ visit: 1, life: 5, holdPct: 50, rand: () => 0.49 }), true);
    assert.equal(decideHold({ visit: 1, life: 5, holdPct: 50, rand: () => 0.51 }), false);
});

test('reserve drops by the rents of accounts that already exist', () => {
    const base = { buyLamports: 8_000_000, slippageBps: 700, tipLamports: 5_000, rentFloor: 650_240 };
    const fresh = veteranReserveLamports(base);
    const opened = veteranReserveLamports({ ...base, hasTokenAta: true, hasAccumulator: true });
    assert.equal(fresh - opened, 2_074_080 + 1_844_400);
    // slippage margin 560,000 + wsol 2,039,280 + 3 x 35,000 fees + floor
    assert.equal(opened, 2_039_280 + 560_000 + 105_000 + 650_240);
});

test('veteranBuyLamports trims to budget and signals retirement below the minimum', () => {
    const top = () => 0.99999999999;
    assert.equal(veteranBuyLamports({ walletLamports: 20_000_000, reserveLamports: 6_000_000, minBuy: 5_000_000, maxBuy: 8_000_000, rand: top }), 8_000_000);
    assert.equal(veteranBuyLamports({ walletLamports: 12_000_000, reserveLamports: 6_000_000, minBuy: 5_000_000, maxBuy: 8_000_000, rand: top }), 6_000_000);
    assert.equal(veteranBuyLamports({ walletLamports: 10_000_000, reserveLamports: 6_000_000, minBuy: 5_000_000, maxBuy: 8_000_000 }), 0);
});
