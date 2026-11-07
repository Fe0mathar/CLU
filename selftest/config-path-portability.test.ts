/**
 * DEV-P1-35 — a configured root absolute under another platform's rules must be refused, not
 * silently re-rooted.
 *
 * Spec: `CLUE_Project_Directory_v9.md` §22 — the workspace is the durable home of the event log,
 *       the artifact store and the projections. Which directory that is cannot be decided by
 *       accident.
 *       `CLUE_Architecture_v9.md` — the event log is the sole authority; the projections are
 *       rebuildable from it. That asymmetry is what makes this defect severe rather than
 *       cosmetic, and it is the reason this file exists.
 *
 * Backlog: DEV-P1-35 (new item; found by running the binary, not from the backlog).
 *
 *          `resolveConfigPaths` asked `node:path`'s `isAbsolute`, which answers for the
 *          *running* platform. On Linux `isAbsolute('F:/CLU/workspace/clue')` is `false` — not
 *          "absolute elsewhere", simply false — so the shipped Windows configuration fell
 *          through to the relative branch and was joined to the repository root. CLU-E then
 *          created a directory literally named `F:` inside its own source tree and opened a new,
 *          empty log, blob store and database in it.
 *
 * ## Why this needs a test and not just the fix
 *
 * The defect did not fork the system's behaviour. It forked its *evidence*. A relocated
 * workspace reports no mission, no snapshots and no claims — and every one of those readings is
 * true of the tree being read. There is no wrong answer anywhere to notice, only a right answer
 * about the wrong place, which is the failure mode this project's whole epistemic discipline is
 * built to make impossible.
 *
 * It also survived a green suite indefinitely, and would have survived this one too if the test
 * were written the obvious way. **Every existing test supplies its own roots**, built from
 * `mkdtempSync`, and so is native-absolute by construction — the shipped configuration is the
 * one input no test uses. That is why the cases below assert on the *classification of a path
 * string* rather than on a working runtime: the property has to be checked where it can be
 * stated, not where it happens to be exercised.
 *
 * ## What is deliberately not asserted
 *
 * That the error is a `RuntimeError` carrying `CONFIG_PATH_FOREIGN` **is** asserted, because
 * callers dispatch on the code and a thrown generic `Error` would be a silent contract break.
 * The prose of the message is not asserted beyond two load-bearing substrings: the offending key
 * and the path that would otherwise have been created. Pinning more would make this a change
 * detector for wording rather than a guard on behaviour.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { clueConfigSchema, type ClueConfig } from '../src/shared/schemas.js';
import { readProtectedPolicy, resolveConfigPaths, RuntimeError } from '../src/control/runtime.js';

/* ------------------------------------------------------------------------- */
/* Fixture                                                                    */
/* ------------------------------------------------------------------------- */

interface Roots {
  readonly project: string;
  readonly workspace: string;
  readonly shadow: string;
  readonly profile: string;
}

/**
 * A schema-valid configuration with the four roots under test made explicit.
 *
 * Built through `clueConfigSchema.parse` rather than cast, so a field the schema later requires
 * fails here rather than being silently absent. Everything outside the four roots is inert
 * filler chosen only to satisfy the schema.
 */
function makeConfig(roots: Roots, projectId: string, policyFile = 'config/policies/patching.yaml'): ClueConfig {
  return clueConfigSchema.parse({
    version: 2,
    project: {
      id: projectId,
      root: roots.project,
      main_branch: 'main',
      source_roots: ['src'],
      document_roots: ['.'],
      exclude: ['node_modules'],
    },
    workspace: { root: roots.workspace },
    shadow: {
      root: roots.shadow,
      clone_mode: 'local',
      persistent: true,
      install_on_lockfile_change: true,
      install_command: 'npm ci',
    },
    constitution: { file: 'CLUE.md', tracked_documents: ['CLUE.md'] },
    runtime: {
      package_manager: 'npm',
      scripts: { typecheck: 'npm run typecheck', build: 'npm run build' },
    },
    browser: {
      executable: join(roots.profile, 'chrome.exe'),
      remote_debugging_port: 9222,
      profile_dir: roots.profile,
      allowed_origins: ['http://localhost:*'],
      require_webgpu: true,
    },
    powershell: { executable: 'pwsh.exe', autonomous_profile: 'restricted' },
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
      mode: 'NOTIFY',
      policy_file: policyFile,
      landing_branch_prefix: 'clue/accepted/',
      merge_strategy: 'fast_forward_only',
      post_land_verify: ['typecheck'],
      auto_revert_on_post_land_failure: true,
    },
    notifications: { status_document: true, windows_toast: false, webhook_url_env: null },
    gateway: {
      enabled: false,
      provider: 'openai',
      api_key_env: 'OPENAI_API_KEY',
      default_mode: 'batch',
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
  });
}

/** A native-absolute, physically present set of roots that resolves cleanly on any host. */
function nativeRoots(): { roots: Roots; repoRoot: string; projectId: string } {
  const base = mkdtempSync(join(tmpdir(), 'clue-portability-'));
  const project = join(base, 'target');
  mkdirSync(join(project, 'src'), { recursive: true });
  const repoRoot = join(base, 'repo');
  mkdirSync(repoRoot, { recursive: true });
  return {
    roots: {
      project,
      workspace: join(base, 'workspace'),
      shadow: join(base, 'shadow'),
      profile: join(base, 'profile'),
    },
    repoRoot,
    // Matches the project root's basename, so `normalizeTargetIdentity` has nothing to correct
    // and writes nothing to stderr. An identity warning here would be noise about a different
    // property.
    projectId: 'target',
  };
}

/**
 * The three shapes that are absolute on Windows and not on POSIX.
 *
 * `\\\\srv\\share` and `\\clue` are included even though the observed defect was a drive letter,
 * because all three reach the same branch by the same route: `isAbsolute` says no, and the old
 * code read that as "relative". A fix that only knew about drive letters would leave two doors
 * open, and nothing in the failure mode would tell anyone which door was used.
 */
const FOREIGN_FORMS: ReadonlyArray<{ readonly label: string; readonly value: string }> = [
  { label: 'drive letter, forward slashes', value: 'F:/CLU/workspace/clue' },
  { label: 'drive letter, backslashes', value: 'F:\\CLU\\workspace\\clue' },
  { label: 'UNC share', value: '\\\\build-01\\clue\\workspace' },
  { label: 'root-relative backslash', value: '\\CLU\\workspace' },
];

/** The four configuration keys that name a root, with a setter for each. */
const ROOT_KEYS: ReadonlyArray<{
  readonly key: string;
  readonly apply: (roots: Roots, value: string) => Roots;
}> = [
  { key: 'project.root', apply: (r, v) => ({ ...r, project: v }) },
  { key: 'workspace.root', apply: (r, v) => ({ ...r, workspace: v }) },
  { key: 'shadow.root', apply: (r, v) => ({ ...r, shadow: v }) },
  { key: 'browser.profile_dir', apply: (r, v) => ({ ...r, profile: v }) },
];

/* ------------------------------------------------------------------------- */
/* The refusal                                                                */
/* ------------------------------------------------------------------------- */

/**
 * The two tests below are POSIX-only, and the same one reason covers both.
 *
 * Every form in {@link FOREIGN_FORMS} is a Windows-native path. On win32 they are not foreign,
 * they are correct, and `resolveConfigPaths` accepts them exactly as it should — so there is
 * nothing on that host for a refusal test to assert. The asymmetry is real and not an omission
 * in the implementation: `foreignAbsoluteForm` in `src/control/runtime.ts` writes out a
 * `posix-root` branch and states in its own comment that the branch is unreachable, because
 * Windows' `isAbsolute` already accepts a rooted POSIX path. There is no win32 counterpart to
 * write.
 *
 * Backlog: DEV-P1-48 — the guard used to live inline in the first test only, and its sibling
 * asserted the same win32-native path would throw. On POSIX both passed; on win32 the first
 * skipped and the second failed with `Missing expected exception (RuntimeError)`. A shared
 * predicate is the fix rather than a second copy of the condition: two tests governed by one
 * fact should not each carry their own statement of it, which is how they came apart.
 */
const POSIX_ONLY =
  'these forms are natively absolute on win32; the defect is POSIX-side by construction';

/** True when the running host cannot exhibit the defect these tests guard. */
function skipOnWindows(t: { skip: (reason: string) => void }): boolean {
  if (process.platform !== 'win32') return false;
  t.skip(POSIX_ONLY);
  return true;
}

test('DEV-P1-35: every foreign-absolute form is refused, on every root key, by code', (t) => {
  if (skipOnWindows(t)) return;

  for (const { key, apply } of ROOT_KEYS) {
    for (const form of FOREIGN_FORMS) {
      const { roots, repoRoot, projectId } = nativeRoots();
      const config = makeConfig(apply(roots, form.value), projectId);

      assert.throws(
        () => resolveConfigPaths(config, repoRoot),
        (error: unknown) => {
          assert.ok(
            error instanceof RuntimeError,
            `${key} / ${form.label}: expected a RuntimeError, got ${String(error)}`,
          );
          assert.equal(
            error.code,
            'CONFIG_PATH_FOREIGN',
            `${key} / ${form.label}: callers dispatch on the code, not the message`,
          );
          assert.ok(
            error.message.includes(key),
            `${key} / ${form.label}: the message must name the offending key`,
          );
          assert.ok(
            error.message.includes(resolve(repoRoot, form.value)),
            `${key} / ${form.label}: the message must show the path that would have been created`,
          );
          return true;
        },
        `${key} / ${form.label} must be refused`,
      );
    }
  }
});

test('DEV-P1-35: the refusal happens before anything is created', (t) => {
  // The old code did not merely mis-resolve; the directory came into existence as a side effect
  // of opening a workspace there. Resolution is the last point at which nothing has been written
  // yet, which is why the guard lives in `resolveConfigPaths` and not further in.
  //
  // Both assertions below are POSIX-side. The throw is one: `F:/CLU/workspace/clue` is a native
  // absolute path on win32 and is rightly accepted there. So is the second: `resolve(repoRoot,
  // 'F:/CLU/...')` returns `F:\CLU\...` on Windows and does not start with the repository root,
  // which is the very re-rooting this test exists to show cannot happen silently.
  if (skipOnWindows(t)) return;

  const { roots, repoRoot, projectId } = nativeRoots();
  const config = makeConfig({ ...roots, workspace: 'F:/CLU/workspace/clue' }, projectId);

  assert.throws(() => resolveConfigPaths(config, repoRoot), RuntimeError);

  const wouldHaveBeen = resolve(repoRoot, 'F:/CLU/workspace/clue');
  assert.equal(
    existsSync(join(repoRoot, 'F:')),
    false,
    'no part of the foreign path may exist on disk after a refusal',
  );
  assert.equal(
    wouldHaveBeen.startsWith(repoRoot),
    true,
    'the drive letter really does resolve under the repository root on this host — ' +
      'which is the whole defect, and the reason the refusal has to come first',
  );
});

/* ------------------------------------------------------------------------- */
/* What must keep working                                                     */
/* ------------------------------------------------------------------------- */

test('DEV-P1-35: a genuinely relative root still resolves against the repository root', () => {
  const { roots, repoRoot, projectId } = nativeRoots();
  const config = makeConfig({ ...roots, workspace: 'workspace' }, projectId);

  const resolved = resolveConfigPaths(config, repoRoot);

  assert.equal(
    resolved.workspace.root,
    resolve(repoRoot, 'workspace'),
    'relative roots are a supported form and the new check must not have swallowed them',
  );
});

test('DEV-P1-35: a native absolute root passes through unchanged', () => {
  const { roots, repoRoot, projectId } = nativeRoots();
  const config = makeConfig(roots, projectId);

  const resolved = resolveConfigPaths(config, repoRoot);

  assert.equal(resolved.project.root, roots.project);
  assert.equal(resolved.workspace.root, roots.workspace);
  assert.equal(resolved.shadow.root, roots.shadow);
  assert.equal(resolved.browser.profile_dir, roots.profile);
});

test('DEV-P1-35: a path merely containing a colon is not mistaken for a drive letter', () => {
  // The predicate anchors on `^[A-Za-z]:[\\/]`. A colon elsewhere in a path is legal on POSIX and
  // must stay legal — over-refusing would trade a silent failure for a loud one that is wrong.
  const { roots, repoRoot, projectId } = nativeRoots();
  const odd = join(roots.workspace, 'run:2026-08-07');
  const config = makeConfig({ ...roots, workspace: odd }, projectId);

  const resolved = resolveConfigPaths(config, repoRoot);

  assert.equal(resolved.workspace.root, odd);
});

/* ------------------------------------------------------------------------- */
/* DEV-P1-40 — the protected-surface policy, where the same defect failed open */
/* ------------------------------------------------------------------------- */

/**
 * `readProtectedPolicy` resolved its own path with a bare `isAbsolute` — the same pattern as the
 * roots above, forty lines away, and missed when those were fixed.
 *
 * It is separated from the tests above because the consequence is a different kind. A misresolved
 * *root* is quiet: the system runs against a workspace nobody configured and reports, truthfully,
 * that it is empty. A misresolved *policy path* is quiet **and permissive**. The line immediately
 * after the resolution treats absence as legitimate — a missing policy is a valid way of saying
 * nothing can mutate the canonical tree — so a policy that could not be found reported
 * `present: false, rules: []`, indistinguishable from a deliberate declaration that nothing is
 * protected.
 *
 * `DEV-P0-10` chose fail-closed for this surface: a *malformed* policy blocks a patch-capable
 * startup. An *unfindable* one waved it through. These tests exist to keep those two cases from
 * ever converging again.
 */

test('DEV-P1-40: a foreign-absolute protected-policy path is refused, not silently absent', () => {
  if (process.platform === 'win32') return;

  for (const form of FOREIGN_FORMS) {
    const { roots, repoRoot, projectId } = nativeRoots();
    const config = makeConfig(roots, projectId, form.value);

    assert.throws(
      () => readProtectedPolicy(repoRoot, config),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeError, `${form.label}: expected a RuntimeError`);
        assert.equal(error.code, 'CONFIG_PATH_FOREIGN');
        assert.ok(
          error.message.includes('patching.policy_file'),
          `${form.label}: the message must name the key an operator has to edit`,
        );
        return true;
      },
      `${form.label} must be refused rather than resolved into a non-existent path`,
    );
  }
});

test('DEV-P1-40: the refusal is not reachable as an empty policy — the fail-open regression guard', () => {
  if (process.platform === 'win32') return;

  // The precise shape of the old defect: no throw, a well-formed answer, and the answer is that
  // nothing is protected. If this assertion ever passes by returning a state instead of throwing,
  // the guard has been lost and every protected-surface check downstream is passing vacuously.
  const { roots, repoRoot, projectId } = nativeRoots();
  const config = makeConfig(roots, projectId, 'F:/CLU/policies.yaml');

  let state: unknown = null;
  let threw = false;
  try {
    state = readProtectedPolicy(repoRoot, config);
  } catch {
    threw = true;
  }

  assert.equal(
    threw,
    true,
    `an unfindable policy must not resolve to a state; got ${JSON.stringify(state)} — ` +
      'which reads as "nothing is protected" and lets a patch-capable startup proceed',
  );
});

test('DEV-P1-40: a portable policy path still reports absence as absence', () => {
  // The counterpart, and the reason the fix is a refusal on *foreign* paths rather than on
  // missing ones. A relative policy path that simply is not there is a legitimate configuration:
  // it says nothing can mutate the canonical tree. Turning that into an error would break the
  // safest way to run CLU-E.
  const { roots, repoRoot, projectId } = nativeRoots();
  const config = makeConfig(roots, projectId, 'config/policies/patching.yaml');

  const state = readProtectedPolicy(repoRoot, config);

  assert.deepEqual(state, { present: false, malformed: false, rules: [] });
});

test('DEV-P1-40: a policy that exists is read through the same resolver', () => {
  // Without this, the three tests above would all pass against a resolver that refused everything.
  const { roots, repoRoot, projectId } = nativeRoots();
  mkdirSync(join(repoRoot, 'config', 'policies'), { recursive: true });
  writeFileSync(
    join(repoRoot, 'config', 'policies', 'patching.yaml'),
    'protected_surfaces:\n  - match:\n      path_globs: ["src/control/**"]\n',
    'utf8',
  );

  const state = readProtectedPolicy(repoRoot, makeConfig(roots, projectId));

  assert.equal(state.present, true, 'a policy that exists is found');
  assert.equal(state.malformed, false, 'and parses');
  assert.equal(state.rules.length, 1, 'and its one declared surface survived resolution');
});
