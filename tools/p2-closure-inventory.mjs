#!/usr/bin/env node
/** Build secret-free, read-only P2 closure inventory and authority manifests. */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readlinkSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { externalReportPath, writeExternalReport } from './verification-support.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputValue = argument('--output-dir');
if (outputValue === null) {
  process.stderr.write('Usage: node tools/p2-closure-inventory.mjs --output-dir <directory>\n');
  process.exit(2);
}
const outputDir = resolve(repoRoot, outputValue);
const inventoryName = 'P2_FINAL_TREE_INVENTORY.json';
const activeManifestName = 'P2_ACTIVE_AUTHORITY_MANIFEST.json';
const deferredManifestName = 'P2_DEFERRED_POST_P2_AUTHORITY_MANIFEST.json';
const contextName = 'P2_CLOSURE_CONTEXT.json';
for (const name of [inventoryName, activeManifestName, deferredManifestName, contextName]) {
  externalReportPath(repoRoot, join(outputDir, name));
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const normalize = (path) => path.replace(/\\/gu, '/');

function argument(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function readYaml(path) {
  return parseYaml(readFileSync(path, 'utf8'));
}

function documentationPack() {
  const selectorPath = join(repoRoot, 'config', 'documentation-pack.json');
  if (!existsSync(selectorPath)) {
    return { releaseName: 'CLU-E RPI Documentation Pack v9', releaseVersion: '9.0', sealFile: 'SHA256SUMS_v9.txt', manifestFile: 'DOCUMENTATION_MANIFEST_v9.json', source: 'legacy-default' };
  }
  const parsed = JSON.parse(readFileSync(selectorPath, 'utf8'));
  const safe = (value, label) => {
    if (typeof value !== 'string' || value.trim() === '' || value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value) || value.includes('..')) {
      throw new Error(`config/documentation-pack.json has unsafe ${label}`);
    }
    return value.replace(/\\/gu, '/');
  };
  return {
    releaseName: String(parsed.releaseName ?? ''),
    releaseVersion: String(parsed.releaseVersion ?? ''),
    sealFile: safe(parsed.sealFile, 'sealFile'),
    manifestFile: safe(parsed.manifestFile, 'manifestFile'),
    source: 'selector',
  };
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function shouldSkip(relativePath) {
  const top = relativePath.split('/')[0];
  if (['.git', 'node_modules', 'dist', 'workspace', 'release'].includes(top)) return true;
  if (relativePath.startsWith('config/backups/')) return true;
  if (relativePath.endsWith('.runtime.json')) return true;
  return false;
}

function inventoryFiles(directory = repoRoot, prefix = '') {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))) {
    const rel = normalize(join(prefix, entry.name));
    if (shouldSkip(rel)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      result.push({ path: rel, kind: 'symlink', target: normalize(readFileLink(absolute)) });
      continue;
    }
    if (entry.isDirectory()) result.push(...inventoryFiles(absolute, rel));
    if (entry.isFile()) {
      const bytes = readFileSync(absolute);
      result.push({ path: rel, kind: 'file', bytes: bytes.length, sha256: sha256(bytes) });
    }
  }
  return result;
}

function readFileLink(path) {
  try {
    return normalize(readlinkSync(path));
  } catch {
    return '<unreadable>';
  }
}

function parseSeal(path) {
  const declared = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    const match = /^([0-9a-f]{64})  (.+)$/u.exec(line);
    if (match === null) throw new Error(`Invalid seal line in ${path}: ${line}`);
    declared.push({ path: match[2], sha256: match[1] });
  }
  return declared;
}

function fileBinding(path, role, activeForP2Proof) {
  const absolute = join(repoRoot, ...path.split('/'));
  return {
    path,
    role,
    activeForP2Proof,
    exists: existsSync(absolute),
    bytes: existsSync(absolute) ? statSync(absolute).size : null,
    sha256: existsSync(absolute) ? sha256(readFileSync(absolute)) : null,
  };
}

const configPath = join(repoRoot, 'config', 'clue.config.yaml');
const config = readYaml(configPath);
const activeDocs = Array.isArray(config?.constitution?.tracked_documents)
  ? config.constitution.tracked_documents
  : [];
const pack = documentationPack();
const sealPath = join(repoRoot, ...pack.sealFile.split('/'));
const sealed = existsSync(sealPath) ? parseSeal(sealPath) : [];
const sealByPath = new Map(sealed.map((item) => [item.path, item.sha256]));
const activeAuthority = activeDocs.map((path) => {
  const binding = fileBinding(path, path === config.constitution.file ? 'constitution' : 'tracked-authority', true);
  return { ...binding, sealedSha256: sealByPath.get(path) ?? null, sealMatches: binding.sha256 !== null && binding.sha256 === sealByPath.get(path) };
});
const deferredPaths = [
  'docs/source-authority/CLUE_CONFIGURATION_PROJECT_PROFILES_SUPPLEMENT_2026-08-14.md',
  'DOCUMENTATION_MANIFEST_v10.json',
  'SHA256SUMS_v10.txt',
  'docs/source-authority/CLUE_P2_AND_PROJECT_PROFILES_FILE_BY_FILE_COMPLETION_STRATEGY_2026-08-14.md',
];

const routing = readYaml(join(repoRoot, config.gateway.routing_file));
const models = [...new Set(Object.values(routing.routes ?? {}).filter((route) => route?.enabled).map((route) => route.model).filter(Boolean))];
const budget = readYaml(join(repoRoot, config.gateway.budget_policy_file));
const tree = inventoryFiles();
const treePayload = {
  schemaVersion: 'clue-p2-final-tree-inventory/1',
  generatedAt: new Date().toISOString(),
  repoRoot: normalize(repoRoot),
  git: {
    head: git(['rev-parse', 'HEAD']),
    branch: git(['branch', '--show-current']),
    statusPorcelain: git(['status', '--porcelain=v1']),
  },
  exclusions: ['.git', 'node_modules', 'dist', 'workspace', 'release', 'config/backups'],
  fileCount: tree.filter((item) => item.kind === 'file').length,
  files: tree,
};
const activeManifest = {
  schemaVersion: 'clue-p2-active-authority-manifest/1',
  generatedAt: treePayload.generatedAt,
  documentationPack: pack,
  seal: fileBinding(pack.sealFile, 'active-pack-seal', true),
  manifest: fileBinding(pack.manifestFile, 'active-pack-manifest', true),
  constitution: config.constitution.file,
  documents: activeAuthority,
  complete: activeAuthority.length > 0 && activeAuthority.every((item) => item.exists && item.sealMatches),
};
const deferredManifest = {
  schemaVersion: 'clue-p2-deferred-authority-manifest/1',
  generatedAt: treePayload.generatedAt,
  scope: 'post-P2',
  implementationRequiredForP2Closure: false,
  activeForP2Proof: false,
  documents: deferredPaths.map((path) => fileBinding(path, 'deferred-post-P2-authority', false)),
};
const context = {
  schemaVersion: 'clue-p2-closure-context/1',
  generatedAt: treePayload.generatedAt,
  project: {
    targetRootConfigured: config?.project?.active_target ?? null,
    workspaceRoot: config?.workspace?.root ?? null,
    shadowRoot: config?.shadow?.root ?? null,
    projectProfilesSelectorPresent: existsSync(join(repoRoot, 'config', 'project-profiles.yaml')),
  },
  publication: {
    expectedState: 'NO_REMOTE_YET',
    localOnly: true,
    publicationPermitted: false,
  },
  gateway: {
    provider: config?.gateway?.provider ?? null,
    requestedModels: models,
    apiKeyReference: config?.gateway?.api_key_env ? `env:${config.gateway.api_key_env}` : null,
    apiKeyPresent: Boolean(config?.gateway?.api_key_env && process.env[config.gateway.api_key_env]),
    spendAuthority: budget?.spend_authority ?? null,
    secretIncluded: false,
  },
  authority: {
    activeManifestFile: activeManifestName,
    deferredManifestFile: deferredManifestName,
  },
  finalTree: {
    inventoryFile: inventoryName,
    inventorySha256: null,
  },
};

const inventoryPath = writeExternalReport(repoRoot, join(outputDir, inventoryName), treePayload);
const inventorySha = sha256(readFileSync(inventoryPath));
writeExternalReport(repoRoot, join(outputDir, activeManifestName), activeManifest);
writeExternalReport(repoRoot, join(outputDir, deferredManifestName), deferredManifest);
writeExternalReport(repoRoot, join(outputDir, contextName), { ...context, finalTree: { ...context.finalTree, inventorySha256: inventorySha } });
process.stdout.write(`P2 closure inventory written to ${outputDir}\n`);
process.stdout.write(`  files: ${treePayload.fileCount}\n`);
process.stdout.write(`  active authority complete: ${String(activeManifest.complete)}\n`);
process.stdout.write(`  OPENAI_API_KEY present: ${String(context.gateway.apiKeyPresent)}\n`);
