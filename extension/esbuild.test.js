const esbuild = require('esbuild');
const fs = require('fs');
const glob = [
    ...fs.readdirSync('src').filter(f => f.endsWith('.test.ts')).map(f => `src/${f}`),
    ...fs.readdirSync('src/discovery').filter(f => f.endsWith('.test.ts')).map(f => `src/discovery/${f}`),
];
esbuild.build({
    entryPoints: glob,
    outdir: 'out-test',
    entryNames: '[name]', // flatten so `node --test out-test/*.test.js` finds every suite
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    sourcemap: false,
}).catch(() => process.exit(1));
