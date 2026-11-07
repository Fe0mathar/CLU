#!/usr/bin/env node
/**
 * Explicitly promote the sealed v10 documentation candidate after P2 and live acceptance.
 *
 * This is deliberately not ratification. It coordinates the selected pack identity with the
 * tracked-document registration in clue.config.yaml, then leaves mission bootstrap, Creator
 * ratification and successor epoch sealing as separate governed acts.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const selector = join(repoRoot, 'config', 'documentation-pack.json');
const candidate = join(repoRoot, 'config', 'documentation-pack.v10.json');
const configuration = join(repoRoot, 'config', 'clue.config.yaml');
const seal = join(repoRoot, 'SHA256SUMS_v10.txt');

const trackedDocumentUpgrades = Object.freeze([
  ['CLUE_AI_Utilization_v9.md', 'CLUE_AI_Utilization_v10.md'],
  ['CLUE_Git_Integration_v9.md', 'CLUE_Git_Integration_v10.md'],
  ['CLUE_Status_Contract_v9.md', 'CLUE_Status_Contract_v10.md'],
  ['CLUE_Q1_System_Navigator_v9.md', 'CLUE_Q1_System_Navigator_v10.md'],
  ['CLUE_Architecture_v9.md', 'CLUE_Architecture_v10.md'],
  ['CLUE_Execution_Model_v9.md', 'CLUE_Execution_Model_v10.md'],
  ['CLUE_Interface_Design_v9.md', 'CLUE_Interface_Design_v10.md'],
  ['CLUE_Project_Directory_v9.md', 'CLUE_Project_Directory_v10.md'],
]);

function replacementCount(text, needle) {
  return text.split(needle).length - 1;
}

export function promotedTrackedDocumentConfiguration(source) {
  let next = source;
  for (const [before, after] of trackedDocumentUpgrades) {
    const needle = `"${before}"`;
    const replacement = `"${after}"`;
    const count = replacementCount(next, needle);
    if (count !== 1) {
      throw new Error(
        `Expected exactly one tracked-document registration for ${before}; found ${String(count)}.`,
      );
    }
    next = next.replace(needle, replacement);
  }
  return next;
}

function restore(path, bytes, existed) {
  if (existed) writeFileSync(path, bytes);
  else rmSync(path, { force: true });
}

if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
  process.stderr.write(
    'v10 documentation promotion is an interactive Creator act; non-interactive input is refused.\n',
  );
  process.exit(1);
}
if (!existsSync(candidate) || !existsSync(seal) || !existsSync(configuration)) {
  process.stderr.write(
    'The v10 selector candidate, SHA256SUMS_v10.txt or config/clue.config.yaml is absent.\n',
  );
  process.exit(1);
}
const verification = spawnSync(
  process.execPath,
  ['tools/project-profiles-docs-verify.mjs', '--json'],
  { cwd: repoRoot, encoding: 'utf8', shell: false },
);
if (verification.status !== 0) {
  process.stderr.write('The v10 documentation candidate failed verification; promotion refused.\n');
  process.stderr.write(verification.stderr || verification.stdout);
  process.exit(1);
}

let candidateSelector;
try {
  candidateSelector = JSON.parse(readFileSync(candidate, 'utf8'));
} catch (error) {
  process.stderr.write(`The v10 selector candidate is invalid JSON: ${error.message}\n`);
  process.exit(1);
}
if (
  candidateSelector?.sealFile !== 'SHA256SUMS_v10.txt' ||
  candidateSelector?.manifestFile !== 'DOCUMENTATION_MANIFEST_v10.json'
) {
  process.stderr.write('The v10 selector candidate does not name the sealed v10 pack.\n');
  process.exit(1);
}

const originalConfiguration = readFileSync(configuration);
const originalSelectorExists = existsSync(selector);
const originalSelector = originalSelectorExists ? readFileSync(selector) : Buffer.alloc(0);
let promotedConfiguration;
try {
  promotedConfiguration = Buffer.from(
    promotedTrackedDocumentConfiguration(originalConfiguration.toString('utf8')),
    'utf8',
  );
} catch (error) {
  process.stderr.write(`${error.message}\nPromotion refused before any write.\n`);
  process.exit(1);
}

const sealSha = createHash('sha256').update(readFileSync(seal)).digest('hex');
const configurationSha = createHash('sha256').update(promotedConfiguration).digest('hex');
const phrase = `PROMOTE V10 ${sealSha.slice(0, 12)} ${configurationSha.slice(0, 12)}`;
process.stdout.write('This coordinates two installed-authority inputs:\n');
process.stdout.write('  1. config/documentation-pack.json selects the sealed v10 pack;\n');
process.stdout.write('  2. config/clue.config.yaml registers the eight v10 owner documents.\n');
process.stdout.write('It does not ratify the pack, seal an epoch, migrate a workspace or close P2.\n');
process.stdout.write(`v10 seal: ${sealSha}\n`);
process.stdout.write(`promoted configuration: ${configurationSha}\n`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question(`Type exactly \`${phrase}\` to continue: `)).trim();
rl.close();
if (answer !== phrase) {
  process.stdout.write('Aborted — selector and configuration unchanged.\n');
  process.exit(1);
}

const backupDirectory = join(repoRoot, 'config', 'backups');
mkdirSync(backupDirectory, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const selectorBackup = join(backupDirectory, `documentation-pack.${stamp}.json`);
const configurationBackup = join(backupDirectory, `clue.config.${stamp}.yaml`);
if (originalSelectorExists) copyFileSync(selector, selectorBackup);
copyFileSync(configuration, configurationBackup);

const configurationTemporary = `${configuration}.tmp-${process.pid}`;
const selectorTemporary = `${selector}.tmp-${process.pid}`;
try {
  writeFileSync(configurationTemporary, promotedConfiguration);
  writeFileSync(selectorTemporary, readFileSync(candidate));

  // Configuration first, selector last. A process crash between these renames fails closed under
  // the still-selected v9 seal; ordinary exceptions are rolled back below.
  renameSync(configurationTemporary, configuration);
  renameSync(selectorTemporary, selector);
} catch (error) {
  rmSync(configurationTemporary, { force: true });
  rmSync(selectorTemporary, { force: true });
  try {
    restore(configuration, originalConfiguration, true);
    restore(selector, originalSelector, originalSelectorExists);
  } catch (rollbackError) {
    process.stderr.write(
      `Promotion failed and rollback also failed: ${error.message}; rollback: ${rollbackError.message}\n`,
    );
    process.exit(2);
  }
  process.stderr.write(`Promotion failed; both installed inputs were restored: ${error.message}\n`);
  process.exit(1);
}

process.stdout.write('v10 documentation selector and tracked-document registration installed.\n');
process.stdout.write(`Backups: ${configurationBackup}${originalSelectorExists ? ` and ${selectorBackup}` : ''}\n`);
process.stdout.write(
  'Next: restart/bootstrap the mission, inspect governed drift, then perform the separate Creator ratification and successor epoch acts.\n',
);
