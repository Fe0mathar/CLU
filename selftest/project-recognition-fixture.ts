/** Shared target/runtime fixture for Project Profile recognition acceptance tests. */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify as toYaml } from 'yaml';

import { openRuntime, type Runtime } from '../src/control/runtime.js';
import type { ProjectProfileRecord } from '../src/shared/schemas.js';

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

/** Writes only installation-level v2 configuration; a supplied profile remains target authority. */
export function writeProfileRuntimeInstallation(root: string): void {
  const legacyTarget = join(root, 'legacy-target');
  const legacyWorkspace = join(root, 'legacy-workspace');
  const legacyShadow = join(root, 'legacy-shadow');
  for (const path of [
    legacyTarget,
    join(legacyTarget, 'src'),
    legacyWorkspace,
    legacyShadow,
    join(root, 'legacy-browser'),
    join(root, 'config'),
  ]) {
    mkdirSync(path, { recursive: true });
  }
  for (const name of ['CLUE.md', 'CLUE_implementation.md', 'CLUE_Implementation_Strategy.md']) {
    write(join(root, name), `# ${name}\n`);
  }

  const config = {
    version: 2,
    project: {
      id: 'legacy',
      name: 'Legacy installation target',
      root: legacyTarget,
      main_branch: 'main',
      source_roots: ['src'],
      document_roots: ['.'],
      exclude: ['node_modules', 'dist'],
      remote: null,
      credential_env: null,
      remote_decision: { state: 'UNRECORDED' },
      inputs: { description: null, benchmark: null },
      active_target: null,
    },
    workspace: { root: legacyWorkspace },
    shadow: {
      root: legacyShadow,
      clone_mode: 'local',
      persistent: true,
      install_on_lockfile_change: true,
      install_command: 'npm ci',
    },
    constitution: {
      file: 'CLUE.md',
      tracked_documents: [
        'CLUE.md',
        'CLUE_implementation.md',
        'CLUE_Implementation_Strategy.md',
      ],
    },
    runtime: {
      package_manager: 'npm',
      scripts: { typecheck: 'npm run typecheck', build: 'npm run build' },
    },
    browser: {
      executable: process.execPath,
      remote_debugging_port: 9222,
      profile_dir: join(root, 'legacy-browser'),
      allowed_origins: ['http://127.0.0.1:*'],
      require_webgpu: false,
    },
    powershell: { executable: process.execPath, autonomous_profile: 'restricted' },
    analysis: {
      max_context_tokens: 120000,
      reserve_output_tokens: 20000,
      dynamic_edge_confidence_threshold: 0.75,
      monodependency_percentile: 0.35,
    },
    proof: {
      require_frozen_contract: true,
      inconclusive_counts_as_improvement: false,
      require_baseline: true,
      require_guardrails: true,
    },
    certification: { clean_passes: 3, invalidate_on_dependency_change: true },
    equilibrium: { evaluation_cycles: 3, policy_file: 'config/policies/equilibrium.yaml' },
    patching: {
      mode: 'OUTBOX',
      policy_file: 'config/policies/patching.yaml',
      landing_branch_prefix: 'clue/accepted/',
      merge_strategy: 'fast_forward_only',
      post_land_verify: ['typecheck'],
      auto_revert_on_post_land_failure: true,
    },
    notifications: { status_document: false, windows_toast: false, webhook_url_env: null },
    gateway: {
      enabled: false,
      provider: 'openai',
      api_key_env: 'OPENAI_API_KEY',
      default_mode: 'interactive',
      batch_poll_interval_seconds: 300,
      prompt_cache: { enabled: true, stable_prefix_sections: ['constitution_excerpt'] },
      budget_policy_file: 'config/policies/budget.yaml',
      routing_file: 'config/policies/routing.yaml',
    },
    backup: {
      remote: 'origin',
      push_on_verdict: true,
      push_on_landing: true,
      max_remote_staleness_hours: 24,
    },
    security: {
      canonical_source_writes: 'denied',
      real_settlement: 'denied',
      redact_environment: true,
    },
    logging: { level: 'info' },
  };
  write(join(root, 'config', 'clue.config.yaml'), toYaml(config));
}

/** Creates a small deterministic TypeScript program under the profile Target Root. */
export function writeRecognitionTarget(target: string, marker: string): void {
  write(
    join(target, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          noEmit: true,
        },
        include: ['src'],
      },
      null,
      2,
    ) + '\n',
  );
  write(join(target, 'src', 'value.ts'), `export const ${marker} = 41;\n`);
  write(
    join(target, 'src', 'use.ts'),
    `import { ${marker} } from './value';\nexport const result = ${marker} + 1;\n`,
  );
  write(
    join(target, 'package-lock.json'),
    JSON.stringify({ name: marker, lockfileVersion: 3, packages: {} }) + '\n',
  );
  write(join(target, 'README.md'), `# ${marker}\n`);
}

export function openRecognitionProfileRuntime(
  repoRoot: string,
  record: ProjectProfileRecord,
  onMissing: 'reject' | 'initialize-new' = 'reject',
): Runtime {
  return openRuntime({
    repoRoot,
    withLog: true,
    projectProfile: record,
    workspaceIdentityOnMissing: onMissing,
  });
}
