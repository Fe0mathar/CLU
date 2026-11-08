/**
 * DEV-P0-13 — the shipped configuration and identity text.
 *
 * The workspace zone previously resolved inside the repository (`workspace.root: "workspace"`), which
 * the resolved-zone check (DEV-P0-08) refuses; it is now an absolute path outside `project.root`, so
 * the four operating zones are disjoint. The product identity is target-neutral CLU-E wording rather
 * than "for Murugan".
 *
 * The full P0-13 acceptance (`clue init` emitting a non-bootstrap mission, `clue doctor --deep` exiting
 * zero) requires the actual Windows installation with all authority files present; this suite covers
 * the parts verifiable from the repository.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { dirname } from 'node:path';
import { assertZonesDisjoint, ConfigZoneError, type ClueConfig } from '../src/shared/schemas.js';
import { loadLegacyConfig } from '../src/control/runtime.js';

const configPath = fileURLToPath(new URL('../../config/clue.config.yaml', import.meta.url));
const packagePath = fileURLToPath(new URL('../../package.json', import.meta.url));

interface ShippedConfig {
  readonly project: { readonly root: string; readonly id: string };
  readonly workspace: { readonly root: string };
  readonly shadow: { readonly root: string };
  readonly browser: { readonly profile_dir: string };
}

/**
 * The legacy loader resolves the shipped installation configuration independently of the
 * machine's Configuration-v3 selector.
 *
 * D1 (2026-08-11) made that distinction load-bearing: `project` is now described by
 * `targets/<id>/profile.yaml` and resolved onto the config at load time, so a hand-parse
 * sees `project.root: undefined` and this suite's zone checks silently test nothing. Using
 * the real loader also means these assertions hold against what the system actually
 * resolves, which is what they were always trying to say.
 */
function loadShippedConfig(): ShippedConfig {
  return loadLegacyConfig(dirname(dirname(configPath))) as unknown as ShippedConfig;
}

const zones = (cfg: ShippedConfig, workspaceRoot: string): ClueConfig =>
  ({
    project: { root: cfg.project.root },
    workspace: { root: workspaceRoot },
    shadow: { root: cfg.shadow.root },
    browser: { profile_dir: cfg.browser.profile_dir },
  } as unknown as ClueConfig);

test('the shipped workspace is an absolute path outside project.root', () => {
  const cfg = loadShippedConfig();
  assert.match(cfg.workspace.root, /^[A-Za-z]:\//, 'workspace.root is an absolute path');
  assert.equal(
    cfg.workspace.root.toLowerCase().startsWith(`${cfg.project.root.toLowerCase()}/`),
    false,
    'workspace is not nested inside project.root',
  );
});

test('the shipped config zones are disjoint, and an in-repo workspace would be refused', () => {
  const cfg = loadShippedConfig();
  assert.doesNotThrow(() => assertZonesDisjoint(zones(cfg, cfg.workspace.root)), 'shipped zones are disjoint');

  const insideProject = `${cfg.project.root.replace(/\/$/, '')}/workspace`;
  assert.throws(() => assertZonesDisjoint(zones(cfg, insideProject)), ConfigZoneError, 'a workspace inside the repo is refused');
});

test('the product identity is target-neutral CLU-E wording', () => {
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as { description: string };
  assert.doesNotMatch(pkg.description, /murugan/i, 'the package description is not tied to a specific target');
  assert.match(pkg.description, /CLU-E/, 'the package description names the product CLU-E');
});
