// Entry point of b33h1v3-core.exe (the bot engine as one executable).
//   b33h1v3-core.exe            -> run the bot      (same as: node index.js)
//   b33h1v3-core.exe recover    -> recover funds    (same as: node recover.js)
const mode = String(process.argv[2] || 'run').toLowerCase();
const job = mode === 'recover' ? import('../recover.js') : import('../index.js');
job.catch((e) => {
    console.error(`[ERROR] ${e?.stack || e}`);
    process.exit(1);
});
