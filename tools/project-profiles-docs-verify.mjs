#!/usr/bin/env node
/** Verify the unratified v10 Project Profiles documentation release candidate. */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sealName = 'SHA256SUMS_v10.txt';
const manifestName = 'DOCUMENTATION_MANIFEST_v10.json';
const jsonOnly = process.argv.includes('--json');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const lineCount = (text) => (text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
const wordCount = (text) => text.trim() === '' ? 0 : text.trim().split(/\s+/u).length;

function safePath(relativePath) {
  if (isAbsolute(relativePath)) return false;
  const canonical = normalize(relativePath).replace(/\\/gu, '/');
  if (canonical === '..' || canonical.startsWith('../') || canonical.includes('/../')) return false;
  const absolute = resolve(repoRoot, relativePath);
  const back = relative(repoRoot, absolute).replace(/\\/gu, '/');
  return back !== '..' && !back.startsWith('../');
}

function parseSeal(text) {
  const entries = new Map();
  const problems = [];
  for (const raw of text.split(/\r?\n/u)) {
    if (raw.trim() === '') continue;
    const match = /^([0-9a-f]{64})  (.+)$/u.exec(raw);
    if (match === null) {
      problems.push(`unparseable seal line: ${JSON.stringify(raw.slice(0, 100))}`);
      continue;
    }
    const [, hash, path] = match;
    if (entries.has(path)) problems.push(`duplicate seal path: ${path}`);
    if (!safePath(path)) problems.push(`unsafe seal path: ${path}`);
    entries.set(path, hash);
  }
  if (entries.size === 0) problems.push('seal declares no files');
  return { entries, problems };
}

const checks = [];
const problems = [];
const sealPath = join(repoRoot, sealName);
const manifestPath = join(repoRoot, manifestName);

if (!existsSync(sealPath)) problems.push(`${sealName} is absent`);
if (!existsSync(manifestPath)) problems.push(`${manifestName} is absent`);

let sealEntries = new Map();
if (existsSync(sealPath)) {
  const parsed = parseSeal(readFileSync(sealPath, 'utf8'));
  sealEntries = parsed.entries;
  problems.push(...parsed.problems);
  for (const [path, expected] of sealEntries) {
    const absolute = join(repoRoot, ...path.split('/'));
    if (!existsSync(absolute)) {
      problems.push(`${path}: absent`);
      continue;
    }
    const actual = sha256(readFileSync(absolute));
    checks.push({ path, expectedSha256: expected, actualSha256: actual, pass: actual === expected });
    if (actual !== expected) problems.push(`${path}: SHA-256 mismatch`);
  }
}

let manifest = null;
if (existsSync(manifestPath)) {
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    problems.push(`${manifestName}: invalid JSON: ${error.message}`);
  }
}

if (manifest !== null) {
  if (manifest.manifestVersion !== '3.0.0') problems.push('manifestVersion must be 3.0.0');
  if (manifest.releaseVersion !== '10.0-rc1') problems.push('releaseVersion must be 10.0-rc1');
  if (manifest.status !== 'release-candidate-not-ratified') {
    problems.push('manifest status must explicitly remain release-candidate-not-ratified');
  }
  if (!Array.isArray(manifest.files)) {
    problems.push('manifest files must be an array');
  } else {
    const manifestPaths = new Set();
    for (const item of manifest.files) {
      if (item === null || typeof item !== 'object' || typeof item.path !== 'string') {
        problems.push('manifest contains a malformed file entry');
        continue;
      }
      if (manifestPaths.has(item.path)) problems.push(`manifest duplicate path: ${item.path}`);
      manifestPaths.add(item.path);
      if (!safePath(item.path)) problems.push(`manifest unsafe path: ${item.path}`);
      const absolute = join(repoRoot, ...item.path.split('/'));
      if (!existsSync(absolute)) {
        problems.push(`manifest file absent: ${item.path}`);
        continue;
      }
      const bytes = readFileSync(absolute);
      const text = bytes.toString('utf8');
      const expectedSeal = sealEntries.get(item.path);
      if (expectedSeal === undefined) problems.push(`${item.path}: not declared by ${sealName}`);
      if (item.sha256 !== sha256(bytes)) problems.push(`${item.path}: manifest SHA-256 mismatch`);
      if (item.bytes !== statSync(absolute).size) problems.push(`${item.path}: manifest byte count mismatch`);
      if (item.lines !== lineCount(text)) problems.push(`${item.path}: manifest line count mismatch`);
      if (item.words !== wordCount(text)) problems.push(`${item.path}: manifest word count mismatch`);
    }
    for (const path of sealEntries.keys()) {
      if (path === manifestName) continue;
      if (!manifestPaths.has(path)) problems.push(`${path}: sealed but absent from manifest files`);
    }
  }
  if (sealEntries.get(manifestName) !== sha256(readFileSync(manifestPath))) {
    problems.push(`${manifestName}: seal does not bind the exact manifest bytes`);
  }
}

const result = Object.freeze({
  schemaVersion: 'clue-project-profiles-docs-verification/1',
  releaseVersion: manifest?.releaseVersion ?? null,
  status: problems.length === 0 ? 'PASS' : 'FAIL',
  ratified: false,
  seal: sealName,
  manifest: manifestName,
  declaredFiles: sealEntries.size,
  checkedFiles: checks.length,
  problems,
});

if (jsonOnly) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  process.stdout.write(`Project Profiles v10 documentation candidate: ${result.status}\n`);
  process.stdout.write(`  declared: ${result.declaredFiles}\n`);
  process.stdout.write(`  checked:  ${result.checkedFiles}\n`);
  process.stdout.write('  ratified: no (Creator act remains separate)\n');
  for (const problem of problems) process.stdout.write(`  FAIL: ${problem}\n`);
}
process.exitCode = problems.length === 0 ? 0 : 1;
