/**
 * pumpfun.js — pump.fun bonding-curve program helpers for B33h1V3_B0t.
 *
 * Every "...pump" token starts on a pump.fun bonding curve (the Jupiter path
 * routes through it until the token graduates to PumpSwap). A buy there makes
 * the program create a per-user "volume accumulator" PDA and charges its rent
 * (137 bytes = 0.0018444 SOL as of 2026-09) to the BUYER. It is a separate
 * account from PumpSwap's accumulator (different program, same idea), and
 * nothing else ever closes it — so a fresh wallet retired after one cycle
 * abandons that rent. Measured on the 2026-08-28 session: 49/49 wallets left
 * one behind, 0.0904 SOL of a 0.1003 SOL total loss (~92% of the cost of
 * every cycle). The wallet's close+sweep now closes it (rent -> wallet ->
 * main), exactly as it already does for the PumpSwap PDA.
 *
 * Only the pieces needed for that live here. Instruction layout is taken from
 * the program's IDL (@pump-fun/pump-sdk 1.36.0, src/idl/pump.json) so there is
 * no extra dependency; the unit test pins the bytes and account order.
 */

import { PublicKey, TransactionInstruction } from '@solana/web3.js';

export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

// Anchor discriminator = sha256("global:close_user_volume_accumulator")[0..8]
export const CLOSE_USER_VOLUME_ACCUMULATOR_DISCRIMINATOR = Uint8Array.from([249, 69, 164, 218, 150, 103, 84, 138]);

/** The wallet's pump.fun per-user volume accumulator PDA. */
export function pumpfunUserVolumeAccumulatorPda(user) {
    return PublicKey.findProgramAddressSync(
        [Buffer.from('user_volume_accumulator'), user.toBuffer()], PUMP_PROGRAM_ID)[0];
}

/** pump.fun's Anchor event authority PDA. */
export function pumpfunEventAuthorityPda() {
    return PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_PROGRAM_ID)[0];
}

/**
 * close_user_volume_accumulator: closes the wallet's PDA and refunds its rent
 * to the wallet. Accounts (IDL order): user (signer, writable),
 * user_volume_accumulator (writable), event_authority, program. No args.
 */
export function closePumpfunUserVolumeAccumulatorInstruction(user) {
    return new TransactionInstruction({
        programId: PUMP_PROGRAM_ID,
        keys: [
            { pubkey: user, isSigner: true, isWritable: true },
            { pubkey: pumpfunUserVolumeAccumulatorPda(user), isSigner: false, isWritable: true },
            { pubkey: pumpfunEventAuthorityPda(), isSigner: false, isWritable: false },
            { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(CLOSE_USER_VOLUME_ACCUMULATOR_DISCRIMINATOR),
    });
}
