/**
 * B33h1V3_B0t Recovery Script
 *
 * Drains every trading wallet listed in active_wallets.json back to the main
 * wallet (sells leftover tokens, closes token accounts for their rent, sweeps
 * all SOL). Use this if the bot crashed or was force-closed before it could
 * drain a wallet itself.
 *
 * Usage: node recover.js
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { createContext, recoverAll, loadActiveWallets } from './solUtils.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WALLETS_FILE = path.join(__dirname, 'active_wallets.json');

const log = {
    info: (msg) => console.log(`[INFO] ${msg}`),
    success: (msg) => console.log(`[SUCCESS] ${msg}`),
    warn: (msg) => console.warn(`[WARN] ${msg}`),
    error: (msg) => console.error(`[ERROR] ${msg}`),
};

async function recover() {
    console.log('\n##################################################');
    console.log('#         B33H1V3_B0T FUND RECOVERY TOOL           #');
    console.log('##################################################\n');

    const wallets = loadActiveWallets(WALLETS_FILE);
    if (wallets.length === 0) {
        log.info('No active_wallets.json (or it is empty) — nothing to recover.');
        process.exit(0);
    }

    const ctx = createContext(process.env);
    log.info(`Found ${wallets.length} wallet(s) to check`);
    log.info(`Main wallet: ${ctx.mainWallet.publicKey.toBase58()}\n`);

    const totals = await recoverAll(ctx, WALLETS_FILE, (m) => log.info(m));

    console.log('\n##################################################');
    console.log('#           RECOVERY COMPLETE - SUMMARY          #');
    console.log('##################################################\n');
    log.info(`Wallets checked:    ${totals.wallets}`);
    log.info(`Wallets drained:    ${totals.drained}`);
    log.info(`SOL from sales:     ${totals.solFromSale.toFixed(6)} SOL`);
    log.info(`Rent reclaimed:     ${totals.rentReclaimed.toFixed(6)} SOL`);
    log.info(`SOL swept:          ${totals.solSwept.toFixed(6)} SOL`);
    console.log('');
    log.success('================================================');
    log.success(`TOTAL RECOVERED:    ${totals.total.toFixed(6)} SOL`);
    log.success('================================================');
    log.info(`Returned to: ${ctx.mainWallet.publicKey.toBase58()}`);

    const left = loadActiveWallets(WALLETS_FILE);
    if (left.length > 0) {
        log.warn(`${left.length} wallet(s) could not be fully drained — kept in active_wallets.json. Run again to retry.`);
    } else {
        log.success('All wallets drained and retired. active_wallets.json removed.');
    }
}

recover().catch(error => {
    log.error(`Recovery failed: ${error.message}`);
    process.exit(1);
});
