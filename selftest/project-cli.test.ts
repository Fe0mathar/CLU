/** Batch 6 — Project Profile CLI surface and authority declarations. */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { Command } from 'commander';

import { buildProgram } from '../src/cli/index.js';
import { authorityFor } from '../src/cli/commandAuthority.js';

const EXPECTED = [
  'activate',
  'active',
  'adopt-legacy',
  'create',
  'cutover-v3',
  'delete',
  'init',
  'list',
  'migrate-legacy',
  'readiness',
  'rollback-v3',
  'show',
  'test-chrome',
  'test-git',
  'test-gpt',
  'test-host',
  'update',
  'validate',
] as const;

function projectGroup(): Command {
  const project = buildProgram().commands.find((command) => command.name() === 'project');
  assert.ok(project !== undefined, 'the project command group must be registered');
  return project;
}

function child(name: string): Command {
  const command = projectGroup().commands.find((candidate) => candidate.name() === name);
  assert.ok(command !== undefined, `project ${name} must exist`);
  return command;
}

function requiredOptions(command: Command): readonly string[] {
  return command.options
    .filter((option) => option.mandatory)
    .map((option) => option.long)
    .filter((value): value is string => value !== undefined)
    .sort();
}

test('Batch 6: the complete non-browser Project Profile control plane is available in CLI', () => {
  assert.deepEqual(
    projectGroup().commands.map((command) => command.name()).sort(),
    [...EXPECTED],
  );
  for (const name of EXPECTED) {
    const authority = authorityFor(`project ${name}`);
    assert.ok(authority !== null, `project ${name} has closed authority`);
    assert.equal(authority.requiresMission, false, `${name} operates before target mission bootstrap`);
  }
});

test('Batch 6: state-changing commands require explicit file, generation or confirmation inputs', () => {
  assert.deepEqual(requiredOptions(child('create')), ['--file']);
  assert.deepEqual(requiredOptions(child('update')), ['--expected-generation', '--file']);
  assert.deepEqual(requiredOptions(child('delete')), ['--confirmation', '--expected-generation']);
  assert.deepEqual(requiredOptions(child('activate')), ['--confirmation']);
  assert.deepEqual(requiredOptions(child('migrate-legacy')), ['--confirmation']);
  assert.deepEqual(requiredOptions(child('adopt-legacy')), ['--confirmation']);
  assert.deepEqual(requiredOptions(child('cutover-v3')), ['--confirmation']);
  assert.deepEqual(requiredOptions(child('rollback-v3')), ['--confirmation']);
  const initialization = child('init');
  assert.ok(initialization.options.some((option) => option.long === '--confirmation'));
  assert.deepEqual(requiredOptions(initialization), [], 'init without confirmation is a preview');
});

test('Batch 6: CLI exposes credential references only, never an API-key value option', () => {
  const optionText = projectGroup().commands
    .flatMap((command) => command.options.map((option) => `${option.flags} ${option.description}`))
    .join('\n');
  assert.doesNotMatch(optionText, /--api[-_]?key|raw credential|secret bytes/iu);
});
