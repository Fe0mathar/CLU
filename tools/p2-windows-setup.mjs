#!/usr/bin/env node
/** Local setup primitives for the visible legacy P2 launcher. */

import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveConfigPaths } from '../dist/src/control/runtime.js';
import { P2_EXACT_OPENAI_MODELS, readP2ClosurePolicy } from '../dist/src/control/p2ClosurePolicy.js';
import { assessGatewayPolicy, loadGatewayPolicies } from '../dist/src/ai/gateway/policy.js';
import { OpenAiGatewayError, OpenAiResponsesAdapter } from '../dist/src/ai/gateway/openaiAdapter.js';
import { resolveWindowsSupervisor } from '../dist/src/benchmark/windowsExecutionSupervisor.js';
import { requireWindowsSupervisorQualification } from '../dist/src/benchmark/windowsSupervisorQualification.js';
import { writeExternalReport } from './verification-support.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const selector = join(root, 'config', 'project-profiles.yaml');

function isWithin(parent, child) {
  const delta = relative(parent, child);
  return delta === '' || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${sep}`));
}

function localDirectory(configured, label, allowMissing = false) {
  const path = configured.replaceAll('/', '\\');
  const { root: drive } = parse(path);
  if (!/^[A-Z]:\\$/iu.test(drive) || path === drive || path.slice(drive.length).split(sep).some(
    (part) => part === '' || /[<>:"|?*\u0000-\u001f]|[ .]$/u.test(part),
  )) throw new Error(`${label} must be an ordinary local directory below a drive root.`);

  let ancestor = path;
  while (lstatSync(ancestor, { throwIfNoEntry: false }) === undefined) {
    if (!allowMissing || ancestor === drive) throw new Error(`${label} is missing.`);
    ancestor = dirname(ancestor);
  }
  if (!statSync(ancestor).isDirectory() || relative(ancestor, realpathSync.native(ancestor)) !== '') {
    throw new Error(`${label} must use a physical directory without junctions, links, or aliases.`);
  }
  return path;
}

function separate(label, path, roots) {
  if (roots.some((entry) => isWithin(entry, path) || isWithin(path, entry))) {
    throw new Error(`${label} overlaps the installation, target, workspace, or shadow.`);
  }
}

function legacyConfig() {
  if (lstatSync(selector, { throwIfNoEntry: false }) !== undefined) {
    throw new Error('This P2 setup requires legacy-v2 startup. Use the active Project Profile controls for Configuration-v3.');
  }
  const config = resolveConfigPaths(loadConfig(root), root);
  if (config.gateway.api_key_env !== 'OPENAI_API_KEY') throw new Error('Legacy P2 setup requires the configured OPENAI_API_KEY reference.');
  return config;
}

function prepare(config) {
  const target = localDirectory(config.project.root, 'Target Root');
  const workspace = localDirectory(config.workspace.root, 'Workspace Root');
  const shadow = localDirectory(config.shadow.root, 'Shadow Root', true);
  separate('Shadow Root', shadow, [realpathSync.native(root), target, workspace]);

  const evidence = localDirectory(join(dirname(root), 'release-evidence'), 'Evidence directory', true);
  separate('Evidence directory', evidence, [realpathSync.native(root), target, workspace, shadow]);
  mkdirSync(shadow, { recursive: true });
  localDirectory(shadow, 'Shadow Root');
  mkdirSync(evidence, { recursive: true });
  localDirectory(evidence, 'Evidence directory');
  console.log(`Shadow ready at ${shadow}`);
  console.log(`Reports directory ${evidence}`);
}

async function checkGateway(config, output) {
  const decision = readP2ClosurePolicy(root).policy.gateway;
  const approvedModel = decision.model;
  const policies = loadGatewayPolicies(root, config);
  const assessment = assessGatewayPolicy(config, policies);
  const base = {
    schemaVersion: 'clue-p2-legacy-gateway-check/1',
    checkedAt: new Date().toISOString(),
    targetId: config.project.id,
    provider: config.gateway.provider,
    requestedModel: approvedModel,
    credentialPresent: assessment.apiKeyPresent,
    fallbackUsed: false,
    evidenceScope: 'MODEL_METADATA_ACCESS',
  };
  let state = 'POLICY_MISMATCH';
  let effectiveModel = null;
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!assessment.apiKeyPresent) {
    state = 'CREDENTIAL_MISSING';
  } else if (key && decision.decision === 'OPERATIONAL' && P2_EXACT_OPENAI_MODELS.includes(approvedModel) &&
      assessment.operationallyReady && assessment.spendAuthority === 'openai_platform' &&
      assessment.preferredModel === approvedModel &&
      policies.routing.api.base_url.replace(/\/+$/u, '') === 'https://api.openai.com/v1' &&
      policies.routing.api.models_path === '/models') {
    try {
      const adapter = new OpenAiResponsesAdapter({
        apiKey: key,
        routing: policies.routing,
        fetchImpl: (url, options) => fetch(url, { ...options, redirect: 'error' }),
      });
      const model = await adapter.probeModel(approvedModel);
      effectiveModel = model.id;
      state = 'PASS';
    } catch (error) {
      state = error instanceof OpenAiGatewayError && /^[A-Z0-9_]+$/u.test(error.code) ? error.code : 'PROVIDER_CHECK_FAILED';
    }
  }
  const report = { ...base, state, effectiveModel };
  writeExternalReport(root, output, report);
  console.log(`Legacy OpenAI model access ${state}${effectiveModel === null ? '' : ` (${effectiveModel})`}`);
  if (state !== 'PASS') process.exitCode = 1;
}

try {
  if (process.platform !== 'win32') throw new Error('Windows P2 setup requires a native Windows host.');
  const [action, output, ...extra] = process.argv.slice(2);
  if (extra.length !== 0) throw new Error('Unexpected setup arguments.');
  const config = legacyConfig();
  if (action === 'prepare' && output === undefined) {
    prepare(config);
  } else if (['pin', 'receipt'].includes(action) && output === undefined) {
    const supervisor = resolveWindowsSupervisor();
    const zones = [root, config.project.root, config.workspace.root, config.shadow.root].map((entry) => realpathSync.native(entry));
    if (zones.some((entry) => isWithin(entry, supervisor.command))) {
      throw new Error('Install the supervisor outside the installation, target, workspace, and shadow roots.');
    }
    if (action === 'receipt') {
      requireWindowsSupervisorQualification(supervisor, process.env, zones);
      console.log('Native supervisor qualification receipt verified.');
    } else {
      console.log('Supervisor SHA-256 pin verified.');
    }
  } else if (action === 'gateway' && output !== undefined) {
    await checkGateway(config, output);
  } else {
    throw new Error('Usage: p2-windows-setup.mjs prepare | pin | receipt | gateway <external report>');
  }
} catch (error) {
  console.error(`Windows setup blocked. ${error instanceof Error ? error.message : 'Setup failed.'}`);
  process.exitCode = 1;
}
