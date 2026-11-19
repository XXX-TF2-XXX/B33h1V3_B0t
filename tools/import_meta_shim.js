// Injected by esbuild into the one-file bundle. The source uses
// import.meta.url to find files that live next to it (recovery ledger, logs,
// lookup-table registry). Inside the single executable those files live next
// to the .exe, so point import.meta.url there.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isSea } from 'node:sea';

const baseDir = isSea() ? path.dirname(process.execPath) : process.cwd();
export const importMetaUrl = pathToFileURL(path.join(baseDir, 'b33h1v3-core.js')).href;
