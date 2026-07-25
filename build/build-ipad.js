'use strict';
// build-ipad.js — bundle the React iPad app with esbuild (Document.pdf change #4).
// The preview loaded React + Babel + Lucide from a CDN and transpiled JSX in the
// browser (slow, and not local-first). This produces one minified, local bundle.
const path = require('path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [path.join(root, 'ipad', '_app.js')],
  outfile: path.join(root, 'ipad', 'dist', 'app.js'),
  bundle: true,
  format: 'iife',
  target: ['es2019', 'safari13'],          // the room iPad runs Safari
  // our .jsx files use React.createElement (no JSX syntax), but treat .js/.jsx
  // through the jsx loader so esbuild parses them uniformly.
  loader: { '.js': 'jsx', '.jsx': 'jsx' },
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('[build-ipad] watching…');
  } else {
    await esbuild.build(options);
    console.log('[build-ipad] bundled → ipad/dist/app.js');
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
