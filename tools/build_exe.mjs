// Build the "download and go" Windows release from this source tree.
//
//   npm run build:exe
//
// Produces release/B33h1V3_B0t/ with:
//   B33h1V3_B0t.exe     the control window (gui.py packed by PyInstaller)
//   b33h1v3-core.exe    the bot engine (every .js file + packages bundled by
//                       esbuild, inside Node's own single-executable format)
// plus release/B33h1V3_B0t_V<version>_windows.zip and SHA256SUMS.txt.
//
// Nobody can read an .exe, so this script IS the proof of what is inside:
// anyone can rebuild from the public source and compare the checksums.
// Needs (build machine only): Node 22+, Python 3 with PyInstaller.

import { build } from 'esbuild';
import { inject } from 'postject';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const rel = path.join(root, 'release');
const work = path.join(rel, '_work');
const out = path.join(rel, 'B33h1V3_B0t');
const step = (m) => console.log(`\n== ${m}`);

fs.rmSync(rel, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(out, { recursive: true });

// 1. One CommonJS file with every module and package inside.
step('Bundling the bot engine (esbuild)');
const bundle = path.join(work, 'b33h1v3-core.cjs');
await build({
    entryPoints: [path.join(root, 'tools', 'core_entry.js')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    define: { 'import.meta.url': 'importMetaUrl' },
    inject: [path.join(root, 'tools', 'import_meta_shim.js')],
    // Optional native speed-ups; each package falls back to pure JS without them.
    external: ['bufferutil', 'utf-8-validate', 'bindings'],
    logLevel: 'warning',
    legalComments: 'inline',
});
console.log(`bundle: ${(fs.statSync(bundle).size / 1e6).toFixed(1)} MB`);

// 2. Node single executable application (SEA): copy node.exe, inject the bundle.
step('Building b33h1v3-core.exe (Node single executable)');
const seaConfig = path.join(work, 'sea-config.json');
const blob = path.join(work, 'sea-prep.blob');
fs.writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false }));
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });
const coreExe = path.join(out, 'b33h1v3-core.exe');
fs.copyFileSync(process.execPath, coreExe);
await inject(coreExe, 'NODE_SEA_BLOB', fs.readFileSync(blob), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
});

// 3. The control window.
step('Building B33h1V3_B0t.exe (PyInstaller)');
const python = process.env.PYTHON || 'python';
const icon = path.join(work, 'b33h1v3.ico');
execFileSync(python, [path.join(root, 'tools', 'make_icon.py'), icon], { stdio: 'inherit' });
execFileSync(python, ['-m', 'PyInstaller', '--noconfirm', '--clean', '--onefile', '--noconsole',
    '--name', 'B33h1V3_B0t', '--icon', icon,
    '--distpath', out, '--workpath', path.join(work, 'pyi'), '--specpath', work,
    path.join(root, 'gui.py')], { stdio: 'inherit' });

// 4. Docs that travel with the exe.
for (const f of ['LICENSE', '.env.template']) fs.copyFileSync(path.join(root, f), path.join(out, f));
fs.writeFileSync(path.join(out, 'READ ME FIRST.txt'), [
    'B33h1V3_B0t - open-source Solana volume bot',
    '',
    '1. Double-click B33h1V3_B0t.exe  (nothing else to install).',
    '   Windows may say "Windows protected your PC" because the exe is not code-signed:',
    '   click "More info" -> "Run anyway". Keep b33h1v3-core.exe in the same folder.',
    '2. Fill in YOUR OWN RPC endpoint (free: https://helius.dev or https://solana-rpc.publicnode.com),',
    '   the private key of a dedicated wallet holding only what you plan to spend,',
    '   and the token mint. Jupiter API key is optional (free at https://portal.jup.ag).',
    '3. Start Bot. Stop Bot sells everything and sweeps all SOL back before exiting.',
    '   Recover Funds cleans up after a crash.',
    '',
    'Every trading wallet is saved to active_wallets.json in this folder while it holds',
    'funds and is drained to exactly zero when done. No developer fee, no telemetry.',
    'Source code, cost measurements and the full "where your SOL goes" audit:',
    'https://github.com/XXX-TF2-XXX/B33h1V3_B0t',
    '',
].join('\r\n'));

// 5. Zip + checksums.
step('Packing the release zip');
const zipName = `B33h1V3_B0t_V${pkg.version}_windows.zip`;
const zip = path.join(rel, zipName);
// Windows' built-in tar (bsdtar) writes a standard zip with forward-slash
// paths (PowerShell's Compress-Archive writes backslashes some tools reject).
const winTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
execFileSync(winTar, ['-a', '-c', '-f', zip, '-C', rel, path.basename(out)], { stdio: 'inherit' });
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const sums = [path.join(out, 'B33h1V3_B0t.exe'), coreExe, zip]
    .map(f => `${sha(f)}  ${path.basename(f)}`).join('\n') + '\n';
fs.writeFileSync(path.join(rel, 'SHA256SUMS.txt'), sums);
fs.rmSync(work, { recursive: true, force: true });
console.log(`\nDone: ${zip}\n${sums}`);
