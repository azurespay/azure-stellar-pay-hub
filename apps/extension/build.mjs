import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const opts = {
  entryPoints: ['popup.ts', 'background.ts', 'options.ts'],
  bundle: true,
  outdir: '.',
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build(opts);
  console.log('Extension built successfully.');
}
