/**
 * SCN-006 offline suite v1. Running this entry as a normal Node program registers
 * the fixed tests in one process and selects Node's TAP reporter. The broker
 * confines the entire workload, including the tests' disposable file fixtures.
 * The full release selftests remain a separate gate.
 */
import { pipeline } from 'node:stream/promises';
import { run } from 'node:test';
import { tap } from 'node:test/reporters';
import { fileURLToPath } from 'node:url';

import { OFFLINE_SUITE_V1_TESTS } from '../src/benchmark/offlineSuiteV1.js';

process.stdout.write('CLU-E_OFFLINE_SUITE_V1\n');
const files = OFFLINE_SUITE_V1_TESTS.map((name) => fileURLToPath(new URL(`./${name}.js`, import.meta.url)));
const suite = run({ files, isolation: 'none', concurrency: 1 });
suite.on('test:fail', () => { process.exitCode = 1; });
await pipeline(suite.compose(tap), process.stdout, { end: false });
