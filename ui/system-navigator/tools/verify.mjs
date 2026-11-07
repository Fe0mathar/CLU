#!/usr/bin/env node
/**
 * CLUE System Navigator — subtree verifier (rev 2).
 *
 * Gate 1 — syntax: every .js/.mjs module in the subtree parses (node --check).
 * Gate 2 — module graph: the static ESM import graph resolves. Every relative
 *   specifier must point at an existing file (browsers do no extension
 *   guessing), named imports must exist in their source module, and
 *   browser-facing modules (src/, demo/) may use no bare or node: specifiers —
 *   the dashboard ships without an import map or bundler.
 * Gate 3 — dashboard wiring: demo/index.html loads a module script that
 *   resolves, and hosts the exact custom-element tag src/index.js registers.
 *
 * Rev 2 rationale (D-009): on-disk layout drift — src/adapter vs src/adapters,
 * index__navigator.js vs index.js — passed per-file syntax while the browser
 * module graph was broken. Per-file syntax is necessary but not sufficient;
 * the verifier must prove the graph. A real browser boot (WebGPU render)
 * remains a host gate in Chrome and is deliberately not simulated here.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const FOLDERS = ['src', 'demo', 'integration', 'tools', 'test'];
// Browser-facing = loaded by the dashboard without a bundler. Convention in this
// subtree: browser modules are .js under src/ and demo/; Node-run scripts are
// .mjs (demo/serve.mjs, integration/, tools/, test/).
const BROWSER_FOLDERS = new Set(['src', 'demo']);

function collect(dir, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (/\.(mjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = FOLDERS.flatMap((folder) => collect(join(root, folder))).sort();
const failures = [];
const rel = (file) => relative(root, file).split('\\').join('/');

/* ---------------------------------------------------------------- gate 1 */
let parsed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    parsed += 1;
  } catch (error) {
    const detail = String(error.stderr ?? error.message).trim().split('\n')[0];
    failures.push(`FAIL ${rel(file)}: syntax — ${detail}`);
  }
}

/* ---------------------------------------------------------------- gate 2 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
}

/** Names a module statically exports; '*' marks a wildcard re-export. */
function exportedNames(text) {
  const names = new Set();
  const code = stripComments(text);
  for (const m of code.matchAll(/export\s+(?:async\s+)?(?:class|function\*?|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  if (/export\s+default\b/.test(code)) names.add('default');
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const raw of m[1].split(',')) {
      const token = raw.trim();
      if (!token) continue;
      const parts = token.split(/\s+as\s+/);
      names.add(parts[parts.length - 1].trim());
    }
  }
  if (/export\s*\*\s*from/.test(code)) names.add('*');
  return names;
}

/** Static import/re-export/dynamic-literal edges of a module. */
function importEdges(text) {
  const code = stripComments(text);
  const edges = [];
  // Static statements are anchored to line start so string literals that merely
  // mention import/export (e.g. this verifier's own failure messages) never
  // register as edges. Dynamic import('...') stays unanchored by design.
  const pattern =
    /(?<=^[ \t]*)import\s+([^'";]+?)\s+from\s*['"]([^'"]+)['"]|(?<=^[ \t]*)import\s*['"]([^'"]+)['"]|(?<=^[ \t]*)export\s*(\{[^}]*\}|\*)\s*from\s*['"]([^'"]+)['"]|(?<![\w$@.])import\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;
  for (const m of code.matchAll(pattern)) {
    if (m[2]) edges.push({ spec: m[2], bindings: m[1] });
    else if (m[3]) edges.push({ spec: m[3], bindings: null });
    else if (m[5]) edges.push({ spec: m[5], bindings: m[4] === '*' ? null : m[4] });
    else if (m[6]) edges.push({ spec: m[6], bindings: null });
  }
  return edges;
}

/** Source-module names an import/re-export binding list requires. */
function requiredNames(bindings) {
  if (!bindings) return [];
  const names = [];
  const braced = bindings.match(/\{([^}]*)\}/);
  if (braced) {
    for (const raw of braced[1].split(',')) {
      const token = raw.trim();
      if (!token) continue;
      names.push(token.split(/\s+as\s+/)[0].trim());
    }
  }
  const outside = bindings.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
  if (outside && !outside.startsWith('*')) names.push('default');
  return names.filter(Boolean);
}

const exportCache = new Map();
function exportsOf(file) {
  if (!exportCache.has(file)) {
    exportCache.set(file, exportedNames(readFileSync(file, 'utf8')));
  }
  return exportCache.get(file);
}

let edgeCount = 0;
for (const file of files) {
  const folder = rel(file).split('/')[0];
  const browser = BROWSER_FOLDERS.has(folder) && file.endsWith('.js');
  for (const edge of importEdges(readFileSync(file, 'utf8'))) {
    edgeCount += 1;
    const spec = edge.spec;
    if (spec.startsWith('.')) {
      const target = resolve(dirname(file), spec);
      let stats = null;
      try {
        stats = statSync(target);
      } catch {
        /* missing */
      }
      if (!stats || !stats.isFile()) {
        failures.push(`FAIL ${rel(file)}: unresolved import '${spec}'`);
        continue;
      }
      const wanted = requiredNames(edge.bindings);
      if (wanted.length > 0) {
        const provided = exportsOf(target);
        if (!provided.has('*')) {
          for (const name of wanted) {
            if (!provided.has(name)) {
              failures.push(`FAIL ${rel(file)}: '${spec}' does not export '${name}'`);
            }
          }
        }
      }
    } else if (spec.startsWith('node:')) {
      if (browser) {
        failures.push(`FAIL ${rel(file)}: browser module uses node builtin '${spec}'`);
      }
    } else {
      failures.push(`FAIL ${rel(file)}: bare specifier '${spec}' (subtree has no dependencies and no import map)`);
    }
  }
}

/* ---------------------------------------------------------------- gate 3 */
try {
  const html = readFileSync(join(root, 'demo', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  if (scripts.length === 0) {
    failures.push('FAIL demo/index.html: no module script tag');
  }
  for (const src of scripts) {
    let ok = false;
    try {
      ok = statSync(resolve(join(root, 'demo'), src)).isFile();
    } catch {
      /* missing */
    }
    if (!ok) failures.push(`FAIL demo/index.html: module script '${src}' does not resolve`);
  }
  const entry = readFileSync(join(root, 'src', 'index.js'), 'utf8');
  const tag = entry.match(/customElements\.define\(\s*['"]([\w-]+)['"]/);
  if (!tag) {
    failures.push('FAIL src/index.js: no customElements.define');
  } else if (!new RegExp(`<${tag[1]}[\\s>]`).test(html)) {
    failures.push(`FAIL demo/index.html: does not host <${tag[1]}>`);
  }
} catch (error) {
  failures.push(`FAIL dashboard wiring: ${error.message}`);
}

/* ----------------------------------------------------------------- report */
if (failures.length > 0) {
  for (const line of failures) console.error(line);
  console.error(`Verification failed: ${failures.length} problem(s).`);
  process.exit(1);
}
console.log(`Syntax verified: ${parsed}/${files.length} modules.`);
console.log(`Import graph verified: ${files.length} modules, ${edgeCount} edges resolved.`);
console.log('Dashboard wiring verified: module script resolves and the registered element is hosted.');
