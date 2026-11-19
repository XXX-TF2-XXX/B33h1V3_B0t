# B33h1V3_B0t 🐝

**An open-source Solana volume bot that never keeps your money.**

Every trading wallet it makes signs and pays for its own trades, is saved to a
local recovery file the moment it is created, and is **drained to exactly zero
and retired** when it is done. There is no developer fee, no hidden recipient,
no telemetry and no paid service required. Read the code — that is the point
of publishing it.

---

## Where your SOL goes (read this first)

Every SOL movement in the code, found by auditing every transfer and account
close (`SystemProgram.transfer`, `createCloseAccountInstruction`):

| From | To | When | Code |
|---|---|---|---|
| Your main wallet | A trading wallet the bot just created | Funding a trade (buy amount + a buffer that comes back) | `solUtils.js` `fundWalletFromMain` |
| Your main wallet | A trading wallet | Gas top-up so a stuck wallet can still sell (comes back on the sweep) | `solUtils.js` `topUpFromMain` |
| Trading wallet | **Your main wallet** | Final sweep — every last lamport | `solUtils.js` `buildCloseSweep` |
| Trading wallet's token / wrapped-SOL accounts | **Your main wallet** | Account rent when the accounts are closed | `solUtils.js` `buildCloseSweep` |
| Trading wallet | The DEX (pump.fun curve, PumpSwap, or a Jupiter route) | The swap itself. The venue charges its own trading fee (pump.fun: 1.25 %/side) | `pumpswap.js`, `solUtils.js` `buildJupiterSwap` |
| Trading wallet | A Helius Sender tip account | **Only if you turn Helius Sender on** (off by default): 0.000005 SOL per tx | `landing.js` `SENDER_TIP_ACCOUNTS` |
| Solana network | — | Normal transaction fees (~0.000005 SOL + a tiny priority fee) | — |

That is the complete list. The only hard-coded third-party addresses in the
code are Helius' published Sender tip accounts (used only when Sender is on).

**Outside services it talks to:** your own RPC endpoint (any Solana RPC, free
ones included), Jupiter's swap API (quotes and swap instructions; free tier),
and Helius Sender only if you switch it on. Nothing else, and nothing about you
or your wallet is sent anywhere else.

**Your keys stay on your computer.** Your main wallet key lives only in your
local `.env` file (never committed — see `.gitignore`). The temporary trading
wallets' keys live in `active_wallets.json` on your computer only while they
hold funds, so the bot (or you) can always recover them.

---

## What it does

Two kinds of trading wallet run side by side:

- **Recyclers** — a brand-new wallet for every trade: fund → buy → sell →
  close everything → sweep to zero → retire.
- **Veterans** — funded once, then trade several times with random waits
  (each visit is a buy + sell, a buy held until the next visit, or the sale of
  what it held), then drained to zero and retired and replaced.

It picks the cheapest, fastest route automatically: the **direct PumpSwap
engine** for graduated pump.fun tokens, **Jupiter** for everything else, and it
**switches by itself** if your token graduates mid-session.

Every transaction is **simulated first for free** (a trade that would fail
costs nothing), priced with a dynamic priority fee under your cap, sent, and
re-sent until it lands.

## Safety features

- **Crash-safe recovery file.** Written atomically; a damaged file is never
  treated as empty (a copy is kept and every readable key is salvaged).
- **Recovery everywhere.** Leftover wallets from a crash are recovered at the
  next start; a cleanup pass re-drains any failed wallet every 90 s; Stop
  drains everything before exiting; the **Recover Funds** button does it on
  demand.
- **Sell retries** with a fresh quote and gradually wider slippage (capped at
  25 %) so a fast-moving price can't trap tokens.
- **Pre-flight check.** It won't fund a single wallet if the token can't be
  traded right now.
- **Failure brake.** 5 failed buys in a row pause the bot for 60 s instead of
  paying fees on cycles that can't trade.
- **Shared rate limiter** for Jupiter so many wallets don't trip its free-tier
  limit.
- **Session report + saved logs.** At stop: swaps, volume, network fees and the
  exact change in your main wallet. Every run is saved to `logs/`.

## What it costs (measured)

Measured live on 2026-11-18/19 on a pump.fun bonding-curve token (Jupiter path)
and on a PumpSwap token (direct engine), with the default settings:

- **≈ 2.2–2.3 % of each buy** per round trip (≈ 1.2–1.3 % of total volume) —
  almost all of it pump.fun's own 1.25 %-per-side trading fee, which no bot
  can avoid.
- **Network fees ≈ 0.000005 SOL per transaction** (low priority, Sender off);
  every test transaction landed on the first try in ≈ 1 s.
- Rents for token accounts and pump.fun / PumpSwap per-user accounts are all
  reclaimed: net zero.

So **1 SOL spent buys roughly 80–90 SOL of volume**. Your settings only decide
how *fast* you spend it (buy size × wallets at once ÷ delay).

---

## Quick start (Windows) — download and go

1. Download **`B33h1V3_B0t_V2.4.0_windows.zip`** from the
   [Releases](../../releases) page and unzip it. Nothing else to install —
   no Python, no Node.js.
2. Double-click **`B33h1V3_B0t.exe`** (keep `b33h1v3-core.exe` in the same
   folder). The exes are not code-signed, so Windows may show *"Windows
   protected your PC"* → **More info** → **Run anyway**. Compare the files
   against `SHA256SUMS.txt` on the release page, or build them yourself (below).
3. Fill in **your own** settings:
   - **RPC Endpoint** — free options: a free Helius key
     (`https://mainnet.helius-rpc.com/?api-key=YOUR_KEY`, https://helius.dev)
     or a public RPC such as `https://solana-rpc.publicnode.com`.
   - **Jupiter API Key** — optional; a free key from https://portal.jup.ag/
   - **Private Key** — the base58 key of a **dedicated wallet** holding only
     what you plan to spend (Phantom: Settings → Security & Privacy → Export
     Private Key).
   - **Token to Trade** — the token's mint address.
4. **Start Bot**. Watch **Total Volume** in the *This Run* box.
   **Stop Bot** sells everything and sweeps all SOL back before it exits.

Tested end to end through the release exe on the keyless public RPC
`https://solana-rpc.publicnode.com` (2026-11-19: 20 swaps, every wallet
drained to zero, 2.1 % of volume).

### Run from source instead

Install Node.js LTS and Python 3, then double-click **`Start B33h1V3_B0t.bat`**
(installs the exact package versions from `package-lock.json` on first run).
Command line: edit `.env` (copy `.env.template`), then `node index.js`;
recovery: `node recover.js`.

### Build the exes yourself

The release exes are built from this source by one script, so you can check
that they contain nothing else:

```bash
npm ci
pip install pyinstaller pillow
npm run build:exe        # -> release/B33h1V3_B0t/ + zip + SHA256SUMS.txt
```

`b33h1v3-core.exe` is every `.js` file bundled by esbuild into Node's own
[single executable application](https://nodejs.org/api/single-executable-applications.html)
format; `B33h1V3_B0t.exe` is `gui.py` packed by PyInstaller. See
`tools/build_exe.mjs`.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Min / Max Buy (SOL) | 0.005 / 0.008 | Random buy size per trade |
| Recyclers (at once) | 2 | Fresh-wallet-per-trade workers |
| Veterans (at once) | 1 | Multi-trade wallets |
| Trades each (min / max) | 3 / 8 | Visits per veteran |
| Hold % | 50 | Chance a veteran holds a buy until its next visit |
| Wait between visits (s) | 10 / 60 | Veteran pause range |
| Delay (s) | 2 | Pause between cycles, per worker |
| Wallet Buffer (SOL) | 0.01 | Extra SOL per wallet for rents/fees — all returned |
| Max Slippage (%) | 7 | Swap slippage tolerance |
| Priority Level | low | Cheapest; escalates automatically only if a tx expires |
| Max Priority Fee (SOL) | 0.0005 | Hard cap per transaction |
| Swap Engine | auto | PumpSwap direct when the pool exists, else Jupiter |
| Helius Sender | off | `swqos` adds a 0.000005 SOL tip/tx for faster landing when the network is busy |

Keep at least ~0.1 SOL in the main wallet for the defaults; each live wallet
holds its buy + buffer while it trades, and 0.01 SOL always stays in main.

## Verify it yourself

```bash
npm test                          # 35 unit tests, no network, no SOL
node test_lifecycle.js simulate   # builds a real buy and simulates it on mainnet — free
node test_lifecycle.js            # tiny real fund -> drain -> crash-recovery test
node test_lifecycle.js cycle      # one tiny real cycle, checks the wallet ends at exactly 0
node costs.js YYYY-MM-DD          # read-only on-chain cost report for a day
node reclaim_tables.js            # get back SOL locked in lookup tables of old tokens
```

## Files

```
Start B33h1V3_B0t.bat   run from source (installs packages on first run)
tools/build_exe.mjs     builds the download-and-go release exes
gui.py                  the control window
index.js                bot: recyclers, veterans, cleanup pass, session report
solUtils.js             shared core: swaps, sells, drain-to-zero, recovery file
landing.js              simulate / price / send / confirm every transaction
pumpswap.js             direct PumpSwap engine
pumpfun.js              pump.fun bonding-curve helper (closes its per-user account)
lookupTable.js          one address lookup table per token (direct engine)
veteran.js              veteran-wallet planning (pure functions)
recover.js              drain every wallet in the recovery file
reclaim_tables.js       close old lookup tables, return their rent
costs.js                read-only on-chain cost report
test/ test_lifecycle.js tests
.env.template           every setting, documented
```

## Disclaimer

This software trades real tokens with real money. Volume bots move SOL through
trading fees; run it only with funds you can afford to spend and only where it
is lawful for you to do so. No warranty — see `LICENSE`.

## License & credits

ISC. Originally based on an earlier open-source volume bot by
[t.me/ryptodevc](https://t.me/ryptodevc); rewritten and extended as
B33h1V3_B0t (fresh-wallet recycling, veterans, direct PumpSwap engine, landing
layer, recovery and cost tooling).
