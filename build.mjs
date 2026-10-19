// Bundles everything into one self-contained ppl-tracker.html.
// The app is plain ES modules to stay readable, but saved to the iPhone's Files
// app (no server, offline at the gym) it has to be a single file.
//
//   node build.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');

// dependency order, each module only uses the ones above it
const MODULES = [
  'js/normalize.js',
  'js/curation.js',
  'js/parser.js',
  'js/sets.js',
  'js/technique.js',
  'js/calc.js',
  'js/volume.js',
  'js/mainlift.js',
  'js/program.js',
  'js/db.js',
  'js/ppl.js',
  'js/sync.js',
  'js/icons.js',
  'js/names.js',
  'js/app.js',
];

// everything ends up in one scope, so imports/exports just go away
function stripModuleSyntax(src) {
  return src
    .replace(/^\s*import\s+[^;]*?from\s*['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*export\s+(const|let|function|class|async function)\s/gm, '$1 ')
    .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '')
    .replace(/^\s*export\s+default\s+/gm, 'const __default = ');
}

const css = read('styles.css');

// `import { x as y }` aliases don't exist once everything shares a scope. The
// build itself succeeds and the page dies at runtime, somewhere random.
const ALIASES = `
const setsTonnage = tonnage;
`;

const js = ALIASES + MODULES.map((m) => `\n/* ===== ${m} ===== */\n${stripModuleSyntax(read(m))}`).join('\n');

// replacer as a function: normalize.js has `$&` in a regex and a string
// replacement would expand it
const html = read('index.html')
  .replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${css}\n</style>`)
  .replace('<link rel="manifest" href="manifest.json">', '')
  .replace(
    '<script type="module" src="js/app.js"></script>',
    () => `<script>\n(function(){\n'use strict';\n${js}\n})();\n</script>`
  );

const out = join(root, 'ppl-tracker.html');
writeFileSync(out, html, 'utf8');

const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(0);
console.log(`ppl-tracker.html  ${kb} KB`);

const leftovers = [
  [/src\s*=\s*["'](?!data:)[^"']+["']/g, 'external script/img'],
  [/href\s*=\s*["'](?!#|data:)[^"']+\.(css|js|json)["']/g, 'external link'],
  // (?<!\.) because db.import(...) is a method, not a dynamic import
  [/(?<![.\w])import\s*\(/g, 'dynamic import'],
  [/^\s*import\s+[\w{*]/gm, 'static import'],
];
let bad = 0;
for (const [re, label] of leftovers) {
  const hits = html.match(re);
  if (hits) { bad++; console.log(`  WARN ${label}: ${hits.slice(0, 3).join(', ')}`); }
}
console.log(bad === 0 ? '  self-contained: ok' : `  ${bad} problem(s)`);
