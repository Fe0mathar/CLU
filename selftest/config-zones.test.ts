/**
 * DEV-P0-08 — operating zones are validated as disjoint on RESOLVED absolute paths.
 *
 * The config schema's parse-time check runs on the raw YAML, where a relative zone root like
 * `workspace: "workspace"` has no base to resolve against and so looks disjoint from an absolute
 * `project.root`. `resolveConfigPaths` makes every zone installation-absolute and then calls
 * `assertZonesDisjoint`, which catches the overlap the raw check cannot — a workspace that resolves
 * INSIDE the project root — and fails closed. The equal / nested / case-variant / traversal matrix is
 * rejected regardless of spelling.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { clueConfigSchema, assertZonesDisjoint, ConfigZoneError, type ClueConfig } from '../src/shared/schemas.js';
import { resolveConfigPaths } from '../src/control/runtime.js';

function makeConfig(projectRoot: string, workspaceRoot: string): ClueConfig {
  const scratch = mkdtempSync(join(tmpdir(), 'clue-zone-scratch-'));
  return clueConfigSchema.parse({
    version: 2,
    project: { id: 'target', root: projectRoot, main_branch: 'main', source_roots: ['src'], document_roots: ['.'], exclude: ['node_modules'] },
    workspace: { root: workspaceRoot },
    shadow: { root: join(scratch, 'shadow'), clone_mode: 'local', persistent: true, install_on_lockfile_change: true, install_command: 'npm ci' },
    constitution: { file: 'CLUE.md', tracked_documents: ['CLUE.md'] },
    runtime: { package_manager: 'npm', scripts: { typecheck: 'npm run typecheck', build: 'npm run build' } },
    browser: { executable: join(scratch, 'chrome.exe'), remote_debugging_port: 9222, profile_dir: join(scratch, 'chrome-profile'), allowed_origins: ['http://localhost:*'], require_webgpu: true },
    powershell: { executable: 'pwsh.exe', autonomous_profile: 'restricted' },
    analysis: { max_context_tokens: 120000, reserve_output_tokens: 20000, dynamic_edge_confidence_threshold: 0.75, monodependency_percentile: 0.35 },
    proof: { require_frozen_contract: true, inconclusive_counts_as_improvement: false, require_baseline: true, require_guardrails: true },
    certification: { clean_passes: 3, invalidate_on_dependency_change: true },
    equilibrium: { evaluation_cycles: 3, policy_file: 'config/policies/equilibrium.yaml' },
    patching: { mode: 'NOTIFY', policy_file: 'config/policies/patching.yaml', landing_branch_prefix: 'clue/accepted/', merge_strategy: 'fast_forward_only', post_land_verify: ['typecheck'], auto_revert_on_post_land_failure: true },
    notifications: { status_document: true, windows_toast: false, webhook_url_env: null },
    gateway: { enabled: false, provider: 'openai', api_key_env: 'OPENAI_API_KEY', default_mode: 'batch', batch_poll_interval_seconds: 300, prompt_cache: { enabled: true, stable_prefix_sections: ['constitution_excerpt'] }, budget_policy_file: 'config/policies/budget.yaml', routing_file: 'config/policies/routing.yaml' },
    backup: { remote: 'origin', push_on_verdict: true, push_on_landing: true, max_remote_staleness_hours: 24 },
    security: { canonical_source_writes: 'denied', real_settlement: 'denied', redact_environment: true },
    logging: { level: 'info' },
  });
}

const zones = (project: string, workspace: string): ClueConfig =>
  ({
    project: { root: project },
    workspace: { root: workspace },
    shadow: { root: '/srv/clue/shadow' },
    browser: { profile_dir: '/srv/clue/profile' },
  } as unknown as ClueConfig);

test('a relative workspace that resolves inside project.root is rejected on resolution', () => {
  const repo = mkdtempSync(join(tmpdir(), 'clue-repo-'));
  const outside = mkdtempSync(join(tmpdir(), 'clue-ws-outside-'));
  try {
    // Shipped-style: project.root absolute (the repo), workspace.root a relative "workspace".
    const shipped = makeConfig(repo, 'workspace');
    assert.equal(shipped.workspace.root, 'workspace', 'the raw config parsed; the parse-time check cannot see the overlap');
    assert.throws(() => resolveConfigPaths(shipped, repo), ConfigZoneError, 'workspace resolves inside project.root and is rejected');

    // Moved outside project.root → accepted, and the workspace is now absolute.
    const moved = resolveConfigPaths(makeConfig(repo, outside), repo);
    assert.equal(moved.workspace.root, outside, 'a workspace outside project.root is accepted');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('the zone overlap matrix fails closed on resolved paths', () => {
  assert.throws(() => assertZonesDisjoint(zones('/srv/app', '/srv/app')), ConfigZoneError, 'equal');
  assert.throws(() => assertZonesDisjoint(zones('/srv/app', '/srv/app/workspace')), ConfigZoneError, 'workspace nested in project');
  assert.throws(() => assertZonesDisjoint(zones('/srv/app/inner', '/srv/app')), ConfigZoneError, 'project nested in workspace');
  assert.throws(() => assertZonesDisjoint(zones('/srv/App', '/srv/app/workspace')), ConfigZoneError, 'case-variant of the same tree');
  assert.throws(() => assertZonesDisjoint(zones('/srv/app', '/srv/app/sub/../nested')), ConfigZoneError, 'traversal resolving inside project');
  assert.doesNotThrow(() => assertZonesDisjoint(zones('/srv/app', '/srv/workspace')), 'genuinely disjoint zones are accepted');
});
