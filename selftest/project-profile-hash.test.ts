/** PP-04 — deterministic Project Profile and active-authority hashes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hashText } from '../src/shared/ids.js';
import { computeProjectAuthorityHash, computeProjectProfileHash } from '../src/control/projectProfiles/profileHash.js';
import { ProfileCanonicalizationError } from '../src/control/projectProfiles/profileCanonicalization.js';
import { makeProjectProfileFixture } from './project-profile-fixture.js';

function withProfile(work: (profile: ReturnType<typeof makeProjectProfileFixture>['profile']) => void): void {
  const fixture = makeProjectProfileFixture();
  try { work(fixture.profile); } finally { fixture.dispose(); }
}

test('PP-04 set-like recognition order and display-only changes do not move behavior identity', () => {
  withProfile((profile) => {
    const reordered = {
      ...profile,
      displayName: 'Another label',
      recognition: {
        ...profile.recognition,
        sourceRoots: [...profile.recognition.sourceRoots].reverse(),
        excludedPaths: [...profile.recognition.excludedPaths].reverse(),
        adapters: [...profile.recognition.adapters].reverse(),
      },
    };
    assert.equal(computeProjectProfileHash(profile), computeProjectProfileHash(reordered));
  });
});

test('PP-04 behavior, credential reference and governed bytes move identity', () => {
  withProfile((profile) => {
    const baseline = computeProjectProfileHash(profile);
    assert.notEqual(baseline, computeProjectProfileHash({
      ...profile,
      benchmarkRuntime: { ...profile.benchmarkRuntime, repetitions: profile.benchmarkRuntime.repetitions + 1 },
    }));
    assert.notEqual(baseline, computeProjectProfileHash({
      ...profile,
      integrations: {
        ...profile.integrations,
        gpt: {
          ...profile.integrations.gpt,
          credential: { source: 'project-override', defaultKey: 'gateway.credential', value: 'env:OPENAI_SECONDARY_KEY' },
        },
      },
    }));
    const benchmark = profile.authority.masterBenchmark;
    assert.ok(benchmark !== null);
    const changed = { ...profile, authority: { ...profile.authority, masterBenchmark: { ...benchmark, sha256: hashText('changed') } } };
    assert.notEqual(computeProjectAuthorityHash(profile), computeProjectAuthorityHash(changed));
    assert.notEqual(baseline, computeProjectProfileHash(changed));
  });
});

test('PP-04 document enumeration order is canonical and disabled bytes stay outside active authority', () => {
  withProfile((profile) => {
    const benchmark = profile.authority.masterBenchmark;
    assert.ok(benchmark !== null);
    const {
      benchmarkId: _benchmarkId,
      benchmarkVersion: _benchmarkVersion,
      ...governedDocument
    } = benchmark;
    const a = { ...governedDocument, bindingId: 'a', kind: 'additional' as const, role: 'architecture' as const, order: 100, enabled: false, canonicalPath: `${profile.targetRoot}/a.md`, path: 'a.md' };
    const b = { ...governedDocument, bindingId: 'b', kind: 'additional' as const, role: 'security' as const, order: 101, enabled: false, canonicalPath: `${profile.targetRoot}/b.md`, path: 'b.md' };
    const left = { ...profile, authority: { ...profile.authority, additionalDocuments: [a, b] } };
    const right = { ...profile, authority: { ...profile.authority, additionalDocuments: [b, a] } };
    assert.equal(computeProjectProfileHash(left), computeProjectProfileHash(right));
    const changedDisabled = { ...left, authority: { ...left.authority, additionalDocuments: [{ ...a, sha256: hashText('v2') }, b] } };
    assert.equal(computeProjectAuthorityHash(left), computeProjectAuthorityHash(changedDisabled));
    assert.notEqual(computeProjectProfileHash(left), computeProjectProfileHash(changedDisabled));
  });
});

test('PP-04 raw secret material is rejected rather than omitted from hashing', () => {
  withProfile((profile) => {
    assert.throws(() => computeProjectProfileHash({
      ...profile,
      integrations: {
        ...profile.integrations,
        gpt: {
          ...profile.integrations.gpt,
          credential: { source: 'project-override', defaultKey: 'gateway.credential', value: 'api_key=raw-secret-value' },
        },
      },
    }), (error: unknown) => error instanceof ProfileCanonicalizationError);
  });
});
