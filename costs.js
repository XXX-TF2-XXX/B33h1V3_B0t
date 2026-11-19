/**
 * costs.js — read-only per-cycle cost report, straight from the chain.
 *
 *   node costs.js 2026-08-28
 *
 * Finds every fresh wallet the main wallet funded on that day, pulls each
 * wallet's transactions, and reports where the SOL went: network + priority
 * fees, Sender tips, the swap round trip, failed transactions, and anything
 * left behind. This is how the pump.fun accumulator rent leak was found
 * (49/49 wallets each abandoning 0.00184 SOL). Costs nothing; only reads.
 *
 * Notes: "swap round-trip" here includes token-account rent paid in the buy
 * and returned in the sweep, which shows up again as a negative
 * "unexplained/rent" line — read the NET COST line and the fee lines.
 */
import fs from 'fs';
import { PublicKey, LAMPORTS_PER_SOL, SystemProgram } from '@solana/web3.js';
import { createContext } from './solUtils.js';
import { SENDER_TIP_ACCOUNTS } from './landing.js';
const env = {};
for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/); if (m) env[m[1]] = m[2].trim(); }
const ctx = createContext(env); const conn = ctx.connection; const main = ctx.mainWallet.publicKey;
const sol = (l) => (l / LAMPORTS_PER_SOL).toFixed(6);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TIPS = new Set(SENDER_TIP_ACCOUNTS);
const PROG = { 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'jupiter', 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': 'pumpswap', '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pumpfun-curve', '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'raydium-v4', 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': 'raydium-cpmm', 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'meteora-dlmm', 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'orca' };
const dayOf = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const DAY = process.argv[2] || new Date().toISOString().slice(0, 10);

// 1. fresh wallets funded by main on DAY
const sigs = await conn.getSignaturesForAddress(main, { limit: 1000 });
const daySigs = sigs.filter(s => dayOf(s.blockTime) === DAY);
const fresh = new Map();
for (let i = 0; i < daySigs.length; i += 5) {
  const b = daySigs.slice(i, i + 5);
  const txs = await Promise.all(b.map(s => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null)));
  for (const tx of txs) {
    if (!tx || !tx.meta) continue; const keys = tx.transaction.message.staticAccountKeys;
    if (!keys[0].equals(main)) continue;
    const progs = tx.transaction.message.compiledInstructions.map(ix => keys[ix.programIdIndex].toBase58());
    if (!progs.every(p => p === SystemProgram.programId.toBase58() || p === 'ComputeBudget111111111111111111111111111111')) continue;
    for (let k = 1; k < keys.length; k++) { const d = tx.meta.postBalances[k] - tx.meta.preBalances[k]; if (d > 0 && !TIPS.has(keys[k].toBase58())) fresh.set(keys[k].toBase58(), { funded: d, t: tx.blockTime }); }
  }
  await sleep(200);
}
console.log(DAY, 'fresh wallets funded by main:', fresh.size);

// 2. per-wallet tx breakdown
const tot = { cycles: 0, funded: 0, returned: 0, fees: 0, tips: 0, failed: 0, failedFees: 0, txs: 0, buySol: 0, sellSol: 0, buys: 0, sells: 0 };
const venues = {}; const feeHist = [];
let shown = 0;
for (const [w, info] of fresh) {
  const pk = new PublicKey(w);
  const ws = await conn.getSignaturesForAddress(pk, { limit: 50 });
  if (ws.length > 60) { console.log("SKIP non-bot wallet", w, ws.length + " txs"); continue; }
  const txs = [];
  for (let i = 0; i < ws.length; i += 5) { const b = ws.slice(i, i + 5); txs.push(...await Promise.all(b.map(s => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null)))); await sleep(200); }
  const c = { w: w.slice(0, 8), funded: info.funded, returned: 0, fees: 0, tips: 0, failed: 0, buySol: 0, sellSol: 0, txs: 0, kinds: [] };
  for (const tx of txs.filter(Boolean).reverse()) {
    const msg = tx.transaction.message;
    const keys = [...msg.staticAccountKeys, ...(tx.meta.loadedAddresses ? tx.meta.loadedAddresses.writable : []), ...(tx.meta.loadedAddresses ? tx.meta.loadedAddresses.readonly : [])];
    const wi = keys.findIndex(k => k.equals(pk)); const mi = keys.findIndex(k => k.equals(main));
    const payer = wi === 0;
    const inner = (tx.meta.innerInstructions || []).flatMap(x => x.instructions.map(ix => keys[ix.programIdIndex] && keys[ix.programIdIndex].toBase58()));
    const progs = new Set([...msg.compiledInstructions.map(ix => keys[ix.programIdIndex] && keys[ix.programIdIndex].toBase58()), ...inner]);
    const venue = [...progs].map(p => PROG[p]).filter(Boolean);
    let tip = 0; keys.forEach((k, i) => { if (TIPS.has(k.toBase58())) tip += Math.max(0, tx.meta.postBalances[i] - tx.meta.preBalances[i]); });
    const pre = (tx.meta.preTokenBalances || []).filter(b => b.owner === w).reduce((s, b) => s + Number(b.uiTokenAmount.amount), 0);
    const post = (tx.meta.postTokenBalances || []).filter(b => b.owner === w).reduce((s, b) => s + Number(b.uiTokenAmount.amount), 0);
    const wd = wi >= 0 ? tx.meta.postBalances[wi] - tx.meta.preBalances[wi] : 0;
    let kind = 'fund-in';
    if (payer) {
      if (tx.meta.err) kind = 'FAILED';
      else if (post > pre) { kind = 'buy'; c.buySol += -(wd) - tx.meta.fee - tip; }
      else if (post < pre) { kind = 'sell'; c.sellSol += wd + tx.meta.fee + tip; }
      else if (mi >= 0 && tx.meta.postBalances[mi] > tx.meta.preBalances[mi]) kind = 'sweep';
      else kind = 'other';
      c.fees += tx.meta.fee; c.tips += tip; c.txs++; feeHist.push(tx.meta.fee);
      if (tx.meta.err) { c.failed++; tot.failedFees += tx.meta.fee + tip; }
      for (const v of venue) venues[v] = (venues[v] || 0) + 1;
      if (mi >= 0) c.returned += Math.max(0, tx.meta.postBalances[mi] - tx.meta.preBalances[mi]);
    }
    c.kinds.push(kind + (tx.meta.err ? '!' : '') + ':fee' + tx.meta.fee + (tip ? '+tip' + tip : '') + (venue.length ? '[' + venue.join(',') + ']' : ''));
  }
  tot.cycles++; tot.funded += c.funded; tot.returned += c.returned; tot.fees += c.fees; tot.tips += c.tips; tot.failed += c.failed; tot.txs += c.txs; tot.buySol += c.buySol; tot.sellSol += c.sellSol;
  if (c.buySol) tot.buys++; if (c.sellSol) tot.sells++;
  if (shown++ < 5 || c.failed || c.returned === 0) console.log(c.w, 'funded', sol(c.funded), 'returned', sol(c.returned), 'cost', sol(c.funded - c.returned), '| fees', c.fees, 'tips', c.tips, '| buy', sol(c.buySol), 'sell', sol(c.sellSol), '|', c.kinds.join(' '));
}
const cost = tot.funded - tot.returned; const swapLoss = tot.buySol - tot.sellSol;
feeHist.sort((a, b) => a - b);
console.log('\n=== ' + DAY + ' SESSION TOTALS ===');
console.log('cycles', tot.cycles, '| txs paid by fresh wallets', tot.txs, '| failed', tot.failed, '(fees burned on failures', sol(tot.failedFees) + ')');
console.log('funded', sol(tot.funded), '| returned', sol(tot.returned), '| NET COST', sol(cost), 'SOL =', sol(cost / tot.cycles), 'per cycle');
console.log('  base+priority fees', sol(tot.fees), '(' + (100 * tot.fees / cost).toFixed(0) + '%)', '| per tx: median', feeHist[Math.floor(feeHist.length / 2)], 'p90', feeHist[Math.floor(feeHist.length * 0.9)], 'max', feeHist[feeHist.length - 1], 'lamports');
console.log('  sender tips       ', sol(tot.tips), '(' + (100 * tot.tips / cost).toFixed(0) + '%)');
console.log('  swap round-trip   ', sol(swapLoss), '(' + (100 * swapLoss / cost).toFixed(0) + '%)', '| SOL into buys', sol(tot.buySol), '-> out of sells', sol(tot.sellSol), '| avg buy', sol(tot.buySol / Math.max(1, tot.buys)), '| round-trip loss', (100 * swapLoss / Math.max(1, tot.buySol)).toFixed(2) + '% of buy size');
console.log('  unexplained/rent  ', sol(cost - tot.fees - tot.tips - swapLoss));
console.log('swap venues seen:', venues);
const times = [...fresh.values()].map(v => v.t).sort((a, b) => a - b); const g = times.slice(1).map((t, i) => t - times[i]).filter(x => x < 600).sort((a, b) => a - b);
console.log('session', new Date(times[0] * 1000).toISOString(), '->', new Date(times[times.length - 1] * 1000).toISOString(), '| median gap between fundings', g[Math.floor(g.length / 2)], 's | p90', g[Math.floor(g.length * .9)], 's');
