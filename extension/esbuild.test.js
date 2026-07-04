const esbuild = require('esbuild');
const glob = require('fs').readdirSync('src/discovery').filter(f => f.endsWith('.test.ts'));
esbuild.build({
    entryPoints: glob.map(f => `src/discovery/${f}`),
    outdir: 'out-test',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    sourcemap: false,
}).catch(() => process.exit(1));
