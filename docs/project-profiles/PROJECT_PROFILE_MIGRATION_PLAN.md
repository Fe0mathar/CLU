# Project Profile Migration Plan

**Programme:** post-P2 Project Profiles  
**Schema target:** `clue-project-profile/1`  
**Batch:** 1 — foundation and profile core  
**Status:** implementation baseline; activation remains deferred to Batch 2

## 1. Purpose

The current installation selects one target through:

```text
config/clue.config.yaml
  project.active_target

targets/<active_target>/profile.yaml
```

The Project Profile control plane replaces that selector-only arrangement with one durable,
versioned profile per target. Migration must preserve the current CLU-E operating history exactly;
it must not move, recreate, truncate, or reinterpret `F:\CLU\workspace\clue`.

Migration is **explicit**. Importing this batch does not run migration, create `F:\CLU\profiles`,
or change the active runtime target.

## 2. Authoritative migration inputs

One migration attempt binds the exact bytes of:

1. `config/clue.config.yaml`;
2. `targets/<active_target>/profile.yaml`;
3. each registered target authority document referenced by the legacy profile;
4. the enabled OpenAI route model identities in the configured routing policy.

The resulting profile records:

```text
sourceConfigPath
sourceConfigHash
sourceProfilePath
sourceProfileHash
migratedAt
preservedWorkspaceRoot
```

The source hashes are byte hashes. Comments, whitespace and line endings therefore remain visible
as source-history changes even when parsed YAML meaning is unchanged.

## 3. Preconditions

Migration fails closed unless all of the following hold:

- `project.active_target` exists and is already a canonical Project ID;
- the selected legacy profile exists, validates, and declares the same ID;
- target, workspace and shadow roots exist as directories on the current host;
- target, workspace and shadow roots are physically disjoint after realpath/junction resolution;
- the target root identity supplied to the new profile matches the real filesystem;
- registered Target Description and Master Benchmark files exist as readable files;
- the routing policy resolves to one exact enabled OpenAI model identity;
- a target without a remote has an explicit `NO_REMOTE_YET` authority decision;
- the new registry has no conflicting Project ID or physical Target Root.

A Windows drive path presented to a non-Windows host is a platform mismatch, not a relative path.
It is refused rather than resolved under the repository.

## 4. Field mapping

| Legacy source | `clue-project-profile/1` destination |
|---|---|
| `project.active_target` / profile `id` | `projectId` |
| profile `name` | `displayName` |
| profile `root` | canonical `targetRoot` + `targetRootIdentity` |
| `workspace.root` | `workspaceRoot` and project state bindings |
| `shadow.root` | `shadowRoot` |
| profile `inputs.description` | `authority.targetDescription` |
| profile `inputs.benchmark` | `authority.masterBenchmark` |
| profile `source_roots` / `exclude` | `recognition` |
| profile remote decision | `integrations.git.publicationMode` |
| browser installation settings | Chrome global-default references plus project browser profile |
| `powershell.executable` | PowerShell global-default reference |
| `gateway.api_key_env` | `env:<VARIABLE>` credential reference only |
| enabled route model | exact `integrations.gpt.modelId` |

No API key value is read or persisted. `OPENAI_API_KEY` becomes only the reference
`env:OPENAI_API_KEY`.

## 5. Existing state mapping

Batch 1 records the existing workspace in place. It does not split or copy its data:

```text
workspace/db/clue.db          database, Great Book and cycle projection binding
workspace/events              existing event log
workspace/blobs               existing content-addressed artifacts and proof evidence
workspace/snapshots           recognition and snapshot binding
workspace/proof-contracts     proof binding
```

This describes current storage truth. Later batches may introduce more explicit scoped services,
but no later migration may claim that existing history was originally stored elsewhere.

Earlier migration records may name `workspace/artifacts` even when the v2 artifact store is
`workspace/blobs`. If adoption or startup reports this mismatch, review the exact saved profile
generation and update `state.artifactStoreRoot` to the existing `blobs` directory through the
normal profile update command. The correction preserves the original evidence bytes in place.

## 6. Idempotency

An identical migration may be invoked again. It returns `unchanged` only when:

- source config hash is unchanged;
- source legacy profile hash is unchanged;
- preserved workspace root is unchanged;
- the existing durable profile has the same behavior hash;
- the registered Project ID and target identity still agree.

Any difference returns `MIGRATION_CONFLICT`. The migrator never overwrites an existing profile to
make a rerun appear idempotent.

## 7. Failure and rollback

A failed migration leaves legacy files and the external workspace untouched. Registry/profile
writes use a crash-recovery transaction journal. Recovery may complete a committed profile create
or profile-only delete, but it never modifies the target repository or project workspace.

Before Batch 2 activation, rollback consists only of deleting the CLU-E-owned profile record through
an exact profile-only confirmation. Do not delete the target root, workspace root or shadow root.

Once new project-scoped events or proof work exist, rollback requires a separately governed
migration; deletion is no longer an acceptable substitute.

## 8. Acceptance evidence

Automated coverage is in:

```text
selftest/project-profile-migration.test.ts
```

It proves workspace preservation, exact source hashes, one exact model, secret-free credential
reference, idempotent rerun, changed-source conflict, identity mismatch refusal, missing authority
refusal and ambiguous publication refusal.
