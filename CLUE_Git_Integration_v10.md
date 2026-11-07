# CLU-E Git Integration v10

**Document status:** v10 release candidate — not active authority until explicit Creator ratification  
**Release:** CLU-E RPI Documentation Pack v10.0-rc1  
**Carried-forward basis:** `CLUE_Git_Integration_v9.md`  
**Primary v10 change:** per-project repository/publication identity and local-only semantics  

This file preserves the complete v9 body below and adds the coordinated Project Profiles amendment at the end. Where the carried-forward single-target wording conflicts with the v10 amendment, the v10 amendment controls only after this pack is promoted, resealed, explicitly ratified, and a successor evidence epoch is opened. Until then, the installed v9 pack remains the P2 authority.

---

# Part I — Carried-forward v9 authority

# CLU-E Git Integration
## Full Git Lifecycle, Branch Isolation, Remote Synchronization, and Cloud Publication Contract

**Document status:** permanent normative Git and cloud lifecycle domain contract  
**Revision:** 9.1 (pack release 9.0) — revision 2.0 content preserved at the v9 re-baseline; amended 2026-08-14 under ADR-0017 to define the narrow manual local-first sync boundary while retaining the complete governed Git lifecycle as P4 scope.  
**Language:** English  
**Normative methodology:** `RPI_Core_Methodology_v9.md`  
**Normative companions:** `CLUE_Constitution_v9.md`, `CLUE_Architecture_v9.md`, `CLUE_Execution_Model_v9.md`, `CLUE_Canonical_Measurement_Catalogue_v9.md`, `CLUE_Status_Contract_v9.md`, and `CLUE_Interface_Design_v9.md`  
**Applies to:** local Git repositories, CLU-E-controlled experiment worktrees, accepted source branches, evidence repositories, configured Git remotes, provider review objects, and remote CI/check results  
**Core provider requirement:** standards-compliant Git fetch/push  
**Optional provider extensions:** GitHub, GitLab, Azure DevOps, Bitbucket, or another provider through a registered adapter  
**Intentionally out of scope:** hosting-provider billing, organization-wide identity administration, replacement of the project’s release process, ungoverned shell access, current implementation status, and file-by-file backlog

> **Git preserves and transports project versions. RPI determines whether a version is an improvement.**
>
> **A local edit is not a commit. A commit is not proof. A push is not acceptance. A green remote check is not an RPI verdict. A merge is not post-land verification.**

---

# 1. Purpose

CLU-E must be able to work deeply with a real local project while preserving the Creator’s repository, history, branches, and remote collaboration model.

The Git integration therefore has five purposes:

1. **exact version identity** — bind every recognition result, experiment, benchmark, verdict, and landing to an auditable repository state;
2. **isolated local experimentation** — let CLU-E modify files, create tests, synthesize benchmarks, build, and run candidates without using the Creator’s active working tree as an experiment surface;
3. **governed branch and commit management** — create, update, seal, archive, and publish CLU-E-owned branches and commits through typed capabilities rather than raw shell authority;
4. **remote durability and review** — push accepted or review-ready results to an approved cloud remote and optionally create or update a provider review object;
5. **remote evidence integration** — ingest cloud CI, required checks, review state, and publication receipts as provenance-bound evidence without confusing them with the local RPI verdict.

The feature is called **full Git lifecycle integration** because it covers repository discovery, base selection, worktree creation, branch ownership, local experiment commits, accepted commit sealing, remote synchronization, cloud publication, review, CI evidence, landing, verification, revert, and retention.

---

# 2. Constitutional position

Git is a governed infrastructure dependency of CLU-E, not an epistemic authority.

The authoritative order is:

```text
protected purpose and capability
  → frozen improvement claim and proof contract
  → exact source snapshot and Git state envelope
  → isolated candidate implementation
  → admissible local and/or empirical evidence
  → RPI verdict
  → policy-bound Git publication or landing
  → post-land verification
  → Great Book and durable remote publication
```

The following distinctions are permanent:

```text
repository discovered        ≠ repository registered
branch created               ≠ experiment valid
files modified               ≠ change set classified
change committed             ≠ commit sealed
commit sealed                ≠ improvement proved
branch pushed                ≠ cloud publication complete
review opened                ≠ change accepted
remote checks green          ≠ RPI verdict positive
remote merge completed       ≠ canonical state verified
local repository current     ≠ remote state reconciled
Git object reachable         ≠ evidence artifact retained
cloud copy available         ≠ source of truth transferred
```

The append-only CLU-E event log and content-addressed artifact store remain the durable truth for CLU-E’s reasoning, proof, and receipts. Git and provider records are linked projections and transport identities.

---

# 3. Scope and operating assumptions

The reference implementation supports:

- one or more Git repositories registered to one Target Program;
- one primary repository and optional linked repositories;
- local branches and remote-tracking branches;
- ordinary repositories, monorepositories, submodules, Git LFS, and sparse checkout when explicitly registered;
- clean and dirty Creator working trees;
- concurrent CLU-E experiments through isolated worktrees;
- generic Git remotes;
- optional provider-specific pull-request or merge-request integration;
- local and remote CI/check evidence;
- separate target-source and CLU-E-evidence repositories;
- local-only, branch-publication, review-first, and protected-landing policies.

The reference implementation does not assume that:

- the default branch is named `main`;
- `origin` is the authoritative remote;
- the Creator’s current branch is the landing branch;
- the remote is reachable during every experiment;
- a project has only one repository;
- a clean worktree is always available;
- provider CI reproduces the local proof environment;
- large evidence artifacts belong in ordinary Git objects;
- the provider API is available or authorized;
- force-push, history rewrite, or automatic merge is acceptable.

---

# 4. Canonical terminology

| Term | Meaning |
|---|---|
| **Repository Registration** | Versioned CLU-E record describing one approved local repository, its role, remotes, protected branches, credentials policy, and Git feature envelope. |
| **Repository Set** | One primary repository plus any linked repositories required to represent the Target Program. |
| **Git State Envelope** | Exact, immutable account of HEAD, tree, index, worktree diff, branch, remotes, submodules, LFS and configuration-relevant state used by an RPI record. |
| **Base Pin** | Immutable reference to the commit and content snapshot from which one experiment or campaign begins. |
| **Creator Working Tree** | The human-controlled local checkout. It is observable but never the ordinary experiment surface. |
| **Experiment Worktree** | CLU-E-controlled isolated checkout used to modify, build, instrument, benchmark, and test a candidate. |
| **Worktree Lease** | Exclusive, time-bounded authority over one experiment worktree and its CLU-E-owned branch. |
| **Experiment Branch** | Local branch owned by one RPI experiment. It may contain provisional commits and may be discarded. |
| **Review Branch** | Remote-publishable branch containing a sealed review candidate and approved durable tests or benchmarks. |
| **Accepted Branch** | Branch containing the exact accepted tree and structured landing commit produced after a positive verdict. |
| **Evidence Repository** | Git repository used for durable, cloud-synchronized CLU-E documents, manifests, Great Book records, status snapshots, receipts, and small evidence. |
| **Change-Set Partition** | Classification of every changed path/hunk under the canonical A14 partition: candidate implementation, ephemeral or durable proof instrument, regression protection, generated artifact, dependency-lock update, documentation, evidence pointer, unrelated Creator change, incidental tool mutation, forbidden surface, or unknown. |
| **Sealed Commit** | Commit whose tree, parent, metadata manifest, diff hash, and linked RPI records are immutable and verified. |
| **Publication** | Audited push of a declared ref and/or evidence manifest to an approved remote. |
| **Review Object** | Provider pull request, merge request, or equivalent object linked to one sealed branch head. |
| **Remote Check** | Provider CI, required check, policy check, or external build result tied to one exact commit. |
| **Reconciliation** | Comparison of local refs, remote refs, provider state, receipts, and durable CLU-E records after interruption or concurrent change. |

---

# 5. Repository model

## 5.1 Two-repository default

The preferred deployment uses two independent repositories:

```text
Target Source Repository
  contains the project being improved
  carries review and accepted source branches
  remains governed by the project’s normal branch protections

CLU-E Evidence Repository
  contains CLU-E code, founding documents, policies, Great Book,
  status history, small receipts, evidence manifests, and release records
  has its own private remote and retention policy
```

The separation prevents experiment metadata and large proof history from polluting the target’s product history while still allowing accepted tests and source changes to travel with the target.

## 5.2 Multi-repository Target Programs

A Target Program may span multiple repositories. Each repository registration declares:

- role: `PRIMARY`, `DEPENDENCY_SOURCE`, `INFRASTRUCTURE`, `DATA_SCHEMA`, `DOCUMENTATION`, `TEST_HARNESS`, or custom;
- required or optional participation;
- base branch and remote policy;
- whether CLU-E may create local worktrees;
- whether CLU-E may publish branches;
- whether a coordinated multi-repository verdict is permitted;
- synchronization constraints between repository versions.

A multi-repository improvement is not atomic merely because CLU-E describes it as one capability. The proof and landing plan must declare the commit set, order, compatibility window, and recovery path for every repository.

## 5.3 Repository identity

A local path is not a durable repository identity. Registration binds:

```text
repository registration ID
+ normalized local root
+ Git common directory identity
+ object-format and repository-format versions
+ configured remote identities
+ primary remote fingerprint
+ provider/repository identity when available
+ trust and ownership result
```

Remote URLs are normalized and redacted before persistence. Credentials embedded in URLs are prohibited.

---

# 6. Authority and capability model

## 6.1 No raw Git shell for AI workers

AI sessions, analyzers, benchmark authors, UI components, and ordinary workers never receive an unrestricted shell or generic `git` capability.

They request typed operations through the Git Integration Service. Every operation is:

- schema-validated;
- repository-bound;
- actor-bound;
- policy-evaluated;
- auditable before execution;
- receipted after execution;
- denied by default.

## 6.2 Capability classes

### Read capabilities

```text
GIT_DISCOVER_REPOSITORY
GIT_READ_STATE
GIT_READ_DIFF
GIT_READ_LOG
GIT_READ_OBJECT
GIT_READ_BLAME
GIT_LIST_REFS
GIT_LIST_REMOTES
GIT_READ_PROVIDER_STATE
```

### Controlled non-canonical write capabilities

```text
GIT_FETCH_APPROVED_REMOTE
GIT_CREATE_EXPERIMENT_WORKTREE
GIT_CREATE_EXPERIMENT_BRANCH
GIT_APPLY_EXPERIMENT_CHANGESET
GIT_COMMIT_EXPERIMENT_STATE
GIT_DELETE_EXPIRED_EXPERIMENT_WORKTREE
GIT_ARCHIVE_EXPERIMENT_BRANCH
```

These operations may affect only CLU-E-owned branches and worktrees.

### Publication capabilities

```text
GIT_PUSH_REVIEW_BRANCH
GIT_PUSH_ACCEPTED_BRANCH
GIT_PUBLISH_EVIDENCE_REF
GIT_CREATE_OR_UPDATE_REVIEW
GIT_REQUEST_REMOTE_CHECKS
GIT_READ_REMOTE_CHECKS
GIT_CLOSE_OR_ARCHIVE_REVIEW
```

### Custodian-only capabilities

```text
GIT_SEAL_ACCEPTED_COMMIT
GIT_LAND_ACCEPTED_CHANGE
GIT_REQUEST_PROTECTED_REMOTE_MERGE
GIT_REVERT_OWN_LANDING
GIT_PUBLISH_LANDING_RECEIPT
```

## 6.3 Creator authority

The Creator controls:

- repository registration;
- allowed remotes and providers;
- protected branches;
- publication and review policy;
- whether remote checks are mandatory;
- whether automatic provider merge is ever allowed;
- commit identity and signing requirements;
- evidence-classification and cloud-publication policy;
- exceptional conflict resolution;
- deletion and retention policy.

CLU-E may surface a required decision, but it cannot infer permission from repository access alone.

---

# 7. Git State Envelope

Every source-dependent CLU-E record binds to a `GitStateEnvelope` when the target is Git-backed.

Minimum fields:

```yaml
git_state_envelope_id: GSE-...
repository_id: GITR-...
captured_at: timestamp
head_oid: object-id
head_tree_oid: object-id
head_ref: refs/heads/...
detached_head: false
upstream_ref: refs/remotes/origin/...
index_tree_oid: object-id
worktree_diff_hash: sha256
staged_diff_hash: sha256
untracked_manifest_hash: sha256
ignored_material_manifest_hash: optional
clean: true | false
shallow: true | false
sparse_checkout: true | false
object_format: sha1 | sha256
submodule_state_hash: optional
lfs_pointer_manifest_hash: optional
attributes_hash: optional
relevant_config_hash: sha256
remote_ref_snapshot_hash: optional
source_snapshot_id: SNP-...
envelope_hash: sha256
```

## 7.1 Commit identity is not sufficient

A commit OID identifies a committed tree and parent history. It does not identify:

- staged changes;
- unstaged changes;
- untracked files;
- generated files used by a benchmark;
- submodule working-tree state;
- missing Git LFS objects;
- sparse-checkout omissions;
- relevant local configuration.

Therefore CLU-E continues to use content snapshots as the primary identity of analyzed bytes. Git metadata provides version graph, transport, collaboration, and recovery context.

## 7.2 Dirty Creator state

CLU-E may recognize and benchmark a dirty Creator working tree if policy allows, but it must not pretend that the state is remotely reproducible.

Allowed dispositions:

- `CAPTURE_ONLY` — analyze exact bytes, no branch publication or landing;
- `PRIVATE_ANCHOR` — reproduce the dirty state in a CLU-E-owned private worktree and create a sealed synthetic base commit, without modifying the Creator branch;
- `REQUIRE_CREATOR_COMMIT` — block experiment publication until the Creator establishes an ordinary base commit;
- `EXCLUDE_DIRTY_PATHS` — permitted only when the excluded paths are proved irrelevant to the claim.

A synthetic anchor commit is a transport device. The original content snapshot and dirty-state envelope remain the authority.

---

# 8. Local isolation and worktree model

## 8.1 Creator tree protection

The Creator working tree is read-only to ordinary CLU-E operations. CLU-E may observe status and changes, but it may not use `checkout`, `reset`, `clean`, `stash`, `commit`, `merge`, `rebase`, or direct file writes there.

## 8.2 Worktree Pool

The persistent shadow clone evolves into a managed **Git Worktree Pool**:

```text
workspace/git/worktrees/
  <repository-id>/
    <campaign-id>/
      <experiment-id>/
```

Each worktree:

- is created from one Base Pin;
- owns one CLU-E branch or detached private experiment ref;
- has an exclusive Worktree Lease;
- receives only approved candidate and instrument changes;
- records toolchain, dependency, submodule, LFS, and build state;
- is never silently reused for a different base;
- is quarantined after unknown mutation or failed cleanup.

## 8.3 Concurrent experiments

Multiple experiments may run concurrently when they have separate worktrees and leases. Shared caches may be used only when content identity and concurrency safety are established.

Two experiments may not publish to the same CLU-E-owned branch without an ordered branch lease. A lease expiry does not authorize takeover until reconciliation proves that no live process or unrecorded commit remains.

## 8.4 Worktree lifecycle

```text
REQUESTED
  → BASE_VALIDATED
  → CREATED
  → DEPENDENCIES_READY
  → INSTRUMENTED
  → CANDIDATE_APPLIED
  → TESTED
  → COMMITTED_OR_DISCARDED
  → ARCHIVED
  → PRUNED
```

Any unexpected state becomes `QUARANTINED` until reconciled.

---

# 9. Branch model

## 9.1 Branch namespaces

Default namespaces:

```text
clue/experiment/<campaign-id>/<experiment-id>
clue/review/<improvement-id>
clue/accepted/<landing-id>
clue/recovery/<incident-id>
clue/archive/<year>/<campaign-id>
```

The namespace is configurable but must be reserved and collision-checked.

## 9.2 Branch ownership

Every CLU-E branch records:

- owner service and lease;
- purpose and campaign;
- base commit and source snapshot;
- current head;
- local-only or publishable status;
- mutable experiment or sealed review/accepted status;
- remote publication status;
- retention deadline;
- associated evidence and verdict IDs.

## 9.3 Protected branches

The registered canonical branch and all provider-protected branches are never experiment branches.

CLU-E must not:

- force-push a protected or shared branch;
- rewrite user-authored history;
- delete a non-CLU-E branch;
- bypass required review or checks;
- infer merge permission from write permission;
- resolve a semantic conflict automatically under a stale proof.

## 9.4 Mutable and immutable branch phases

An experiment branch may be rewritten locally while its work is provisional. Once published for review or bound to a verdict, its sealed head is immutable.

Further changes create:

- a new commit with a new candidate identity before verdict; or
- a new review revision and mandatory proof invalidation after verdict.

No silent force-update is allowed after a branch head has entered a durable RPI record.

---

# 10. Change-Set Partition

CLU-E modifies files for several reasons. Those reasons must not be conflated.

Every changed path and, where practical, every changed hunk is classified as:

```text
CANDIDATE_IMPLEMENTATION
PROOF_INSTRUMENT_EPHEMERAL
PROOF_INSTRUMENT_DURABLE
REGRESSION_PROTECTION
GENERATED_ARTIFACT
DEPENDENCY_LOCK_UPDATE
DOCUMENTATION
EVIDENCE_POINTER
UNRELATED_CREATOR_CHANGE
INCIDENTAL_TOOL_MUTATION
FORBIDDEN_SURFACE
UNKNOWN
```

## 10.1 Ephemeral proof instrumentation

Ephemeral benchmark hooks, temporary logs, tracing probes, generated fixtures, and one-run harness changes:

- may exist in the experiment worktree;
- are hashed and stored as evidence;
- must be excluded from the accepted source diff unless separately justified;
- must be removed before sealed candidate comparison when they alter the measured path beyond the frozen instrument contract.

## 10.2 Durable proof instruments

A new benchmark, test, fixture, assertion, or telemetry surface may be accepted into the project when it becomes durable regression protection.

It must receive its own purpose, maintenance cost, determinism, environment, and validity assessment. CLU-E must not permanently add expensive or brittle tests merely to justify one patch.

## 10.3 Unknown change

An unknown, unrelated Creator, or incidental tool change blocks sealing. Examples include:

- lockfile drift not explained by the candidate;
- formatter changes outside scope;
- generated files modified by a build;
- IDE metadata;
- timestamps or caches;
- a human edit made inside a leased worktree.

The change must be attributed, reverted, accepted into scope with a new contract, or cause experiment invalidation.

---

# 11. Commit model

## 11.1 Provisional experiment commits

CLU-E may create local provisional commits to checkpoint work, bisect candidates, or isolate benchmark and implementation changes. These commits:

- remain on an experiment branch;
- are not improvements;
- may be superseded before proof;
- cannot be landed directly;
- must preserve exact links to the worktree lease and experiment.

## 11.2 Sealed review commit

A review branch head is sealed when:

- the intended tree is known;
- the Change-Set Partition is complete;
- the diff and tree hashes match the candidate tested under the proof contract;
- no forbidden or unknown change remains;
- required durable tests are included;
- the base is current under policy;
- the commit metadata manifest is generated;
- the commit is signed when policy requires it.

## 11.3 Accepted landing commit

The canonical landing remains one structured, revertible commit even when the experiment branch used multiple provisional commits.

The Custodian constructs the accepted commit from the exact proved tree and approved parent. It does not perform an interpretive squash. The resulting tree and diff must match the sealed accepted manifest byte-for-byte.

## 11.4 Commit metadata and trailers

The default commit message contains a concise human title and machine trailers:

```text
perf(render): reuse visibility scratch buffer

Reduces repeated per-frame allocation under the frozen visibility benchmark.

CLU-E-Improvement: IMP-000241
CLU-E-Campaign: CYC-2026-08-02-001
CLU-E-Experiment: EXP-...
CLU-E-Proof-Contract: sha256:...
CLU-E-Verdict: sha256:...
CLU-E-Base-Commit: <oid>
CLU-E-Base-Snapshot: SNP-...
CLU-E-Diff-SHA256: sha256:...
CLU-E-Evidence-Manifest: sha256:...
CLU-E-RPI-Level: L5
```

Commit messages never contain secrets, full prompts, unredacted runtime output, or unverifiable savings claims.

## 11.5 Author and signer identity

CLU-E must not impersonate the Creator.

The configured policy declares:

- author identity for machine-produced commits;
- committer identity for Custodian actions;
- optional `Co-authored-by` or provider attribution rules;
- signing mode: `DISABLED`, `OPTIONAL`, or `REQUIRED`;
- accepted signature types and keys;
- failure behavior when signing is unavailable.

Commit OIDs are transport identities. The RPI record continues to bind the tree, diff, parent, metadata manifest, and evidence hashes independently.

---

# 12. End-to-end Git experiment lifecycle

```text
1. Register and validate repository
2. Fetch approved remote when policy requires freshness
3. Capture Git State Envelope
4. Pin base commit and content snapshot
5. Create leased experiment worktree and branch
6. Apply or synthesize proof instrument
7. Capture baseline in the isolated base state
8. Apply candidate changes
9. Classify the complete change set
10. Run local proof and protective gates
11. Create provisional checkpoints as needed
12. Issue RPI verdict
13. If negative: retain evidence, archive or delete branch by policy
14. If positive: build exact sealed review/accepted tree
15. Recheck base freshness and remote divergence
16. Publish branch and evidence when configured
17. Ingest remote checks and review state
18. Land only through the selected custody flow
19. Run post-land verification on the exact landed commit
20. Publish Great Book, status, receipt, and revert information
21. Re-recognize from the accepted state
22. Retain or prune worktree and branches under policy
```

A fetch, rebase, merge, provider edit, regenerated lockfile, or manual branch modification after proof changes the candidate identity and invalidates landing eligibility until exact equivalence and required re-proof are established.

---

# 13. Landing and publication flows

Git publication and canonical landing are orthogonal policies.

## 13.1 Publication modes

```text
LOCAL_ONLY
PUSH_REVIEW_BRANCH
CREATE_DRAFT_REVIEW
REQUIRE_REVIEW
PUBLISH_ACCEPTED_BRANCH
```

## 13.2 Landing transports

```text
LOCAL_FAST_FORWARD
LOCAL_APPLY_EXACT_COMMIT
PROVIDER_MERGE_AFTER_APPROVAL
CREATOR_APPLY
OUTBOX_ONLY
```

## 13.3 Recommended default

For an actively developed personal repository:

```text
publication_mode: CREATE_DRAFT_REVIEW
landing_transport: CREATOR_APPLY or LOCAL_FAST_FORWARD
force_push: DENIED
required_remote_checks: project-defined
post_land_verification: REQUIRED
```

This gives the Creator cloud visibility and a reviewable branch while preserving the existing CLU-E custody rules.

## 13.4 Provider merge

Provider-side merge is permitted only when:

- the review head is the exact sealed commit;
- required approvals and checks are satisfied;
- branch protection is not bypassed;
- the selected merge method preserves the accepted tree and traceable parent relationship;
- the resulting commit is observed and mapped to the verdict;
- post-merge verification runs against the resulting canonical commit.

A provider-generated merge commit, squash commit, or rebase changes identity. The policy must explicitly support that merge mode and verify resulting tree equivalence. Otherwise the merge is deferred to the Creator.

---

# 14. Remote synchronization

## 14.1 Approved remotes

Every remote operation is limited to a registered remote and ref namespace. The service validates:

- normalized remote identity;
- transport and host allowlist;
- repository match;
- credential source;
- destination ref;
- non-fast-forward risk;
- branch ownership;
- expected remote old OID when pushing;
- data-classification policy.

## 14.2 Fetch policy

Fetch is read-only with respect to the working tree but changes remote-tracking refs and may download untrusted objects. It is therefore typed and audited.

The policy declares whether fetch is required:

- before campaign start;
- before proof freeze;
- before branch publication;
- before landing;
- after remote check completion;
- during reconciliation.

## 14.3 Push policy

Push uses an explicit lease on the expected remote old OID. Blind force-push is prohibited.

Allowed push targets are normally limited to:

```text
refs/heads/clue/review/*
refs/heads/clue/accepted/*
configured evidence refs
```

Tags require a separate policy. Pushing directly to the canonical branch is denied unless the selected protected landing transport explicitly authorizes it.

## 14.4 Offline operation

Remote unavailability does not invalidate a valid local experiment. It produces:

```text
PROOF_STATE: COMPLETE
PUBLICATION_STATE: PENDING_REMOTE
LANDING_ELIGIBILITY: policy-dependent
```

The publication queue remains durable and idempotent. Reconnection triggers reconciliation before retry.

---

# 15. Cloud provider adapters

## 15.1 Core and extension boundary

Generic Git fetch and push are the core feature. Provider-specific behavior is delivered by versioned adapters.

An adapter may support:

- repository identity and default branch discovery;
- branch-protection inspection;
- draft pull/merge request creation;
- title, description, labels, and reviewers;
- update of an existing review object;
- required-check discovery;
- check-run and workflow status ingestion;
- review decision and mergeability state;
- comment or status publication;
- artifact links;
- merge request under explicit policy.

An adapter may not silently expand Git or provider authority.

## 15.2 Review body

The generated review description includes:

```text
Protected intent and capability
Observed implementation and current method
Improvement claim
Exact base and candidate commits
Change summary and affected environments
Proof contract and authority
Baseline/candidate result summary
Protective gates
Known trade-offs and residual uncertainty
Remote check requirements
Reversal plan
Great Book and evidence-manifest links
CLU-E status seal
```

Forecast savings are labeled `FORECAST`. Human-perceptual results are labeled with their evaluation scope. No confidential raw evidence is embedded unless publication policy allows it.

## 15.3 Review updates

A review object is updated only when its tracked head and CLU-E publication record reconcile. A human modification to the review text may be preserved as a provider-side annotation, but machine-owned sections are updated through explicit markers rather than destructive replacement.

---

# 16. Remote CI and check evidence

## 16.1 Remote checks are external instruments

A cloud pipeline result is admissible only when CLU-E can identify:

- exact commit OID;
- workflow or pipeline definition and revision;
- provider run ID;
- environment image/runner identity when available;
- commands and test selection;
- input artifacts and caches where material;
- start/end time and conclusion;
- raw log/artifact references and hashes when retrievable;
- trust class and provenance;
- whether the check was required, optional, or advisory.

## 16.2 Relationship to the frozen proof contract

Remote CI may:

- reproduce the local proof;
- provide an additional platform envelope;
- execute required project checks;
- expose a regression not seen locally;
- validate packaging or deployment behavior.

It may not retroactively replace the primary metric, threshold, workload, or protected gate after the candidate result is known.

## 16.3 Green is not sufficient

A green check means only that the registered check concluded successfully for its exact commit and environment. CLU-E must still decide whether:

- the check is representative;
- the result belongs to the accepted candidate;
- the check covers the claimed behavior;
- required local or human evidence exists;
- all RPI gates remain satisfied.

## 16.4 Failed or stale checks

A required failed check blocks landing. A stale check tied to an old commit has no authority over the new head. A cancelled, skipped, neutral, or timed-out check is represented honestly and handled by policy.

---

# 17. Cloud publication of CLU-E results

## 17.1 Publication layers

CLU-E may publish three layers:

### Source layer

- review branch;
- accepted branch;
- accepted tests and benchmark code;
- structured commit metadata.

### Evidence-summary layer

- Great Book entry;
- status snapshot and seal;
- proof-contract summary;
- benchmark summary;
- landing and revert receipts;
- evidence manifest with hashes;
- value forecast and realized-value updates.

### Large-artifact layer

- traces;
- screenshots or recordings;
- full benchmark raw data;
- browser profiles or dumps when policy permits;
- build artifacts;
- provider CI artifacts.

Large artifacts normally live in the content-addressed store, approved object storage, or provider artifact service. Git stores signed/hash-linked manifests rather than unbounded binaries.

## 17.2 Publication classification

Every artifact receives:

```text
LOCAL_ONLY
PRIVATE_REMOTE
PROJECT_REMOTE
REVIEW_VISIBLE
PUBLIC
PROHIBITED
```

The default is `LOCAL_ONLY` until policy or the Creator classifies it otherwise.

## 17.3 Evidence repository commits

Small durable records may be committed to the CLU-E evidence repository after:

- every terminal verdict;
- every branch publication;
- every landing or revert;
- every equilibrium certificate or invalidation;
- every documentation authority update.

The evidence repository may use a linear append-oriented branch or review-based policy. Hash-chain continuity remains independently verifiable from the CLU-E event log.

## 17.4 Cloud durability is not truth transfer

A remote copy improves resilience and collaboration. It does not replace the local event log and artifact identities as the authority for historical CLU-E records. Restoration from cloud must verify hashes and chain continuity before records become active.

---

# 18. Divergence and reconciliation

## 18.1 Divergence classes

```text
LOCAL_BASE_STALE
CANONICAL_BRANCH_ADVANCED
REMOTE_BRANCH_ADVANCED
REMOTE_BRANCH_REWRITTEN
REVIEW_HEAD_CHANGED
PROVIDER_MERGE_RESULT_DIFFERENT
WORKTREE_DIRTY_UNKNOWN
EVIDENCE_PUBLICATION_PARTIAL
REMOTE_CHECK_SET_CHANGED
REMOTE_DELETED
```

## 18.2 No blind rebase after proof

A candidate proved against base `B` cannot be silently rebased onto base `B2` and retain the same verdict.

The allowed paths are:

- exact fast-forward with unchanged candidate diff and proof compatibility established;
- a new application receipt and targeted re-proof;
- a new experiment and full proof;
- Creator-led conflict resolution producing a new candidate identity.

The Custodian never resolves semantic conflicts.

## 18.3 Reconciliation protocol

```text
READ DURABLE EXPECTATION
  → READ LOCAL REFS AND WORKTREES
  → FETCH APPROVED REMOTES WHEN AVAILABLE
  → READ PROVIDER REVIEW/CHECK STATE
  → COMPARE EXPECTED AND OBSERVED OIDS
  → VERIFY BRANCH OWNERSHIP AND LEASES
  → VERIFY EVIDENCE PUBLICATION RECEIPTS
  → CLASSIFY DIVERGENCE
  → RESUME, DEFER, RE-PROVE, QUARANTINE, OR ESCALATE
```

Reconciliation itself is read-mostly. Any repair write requires the appropriate typed capability and receipt.

---

# 19. Submodules, Git LFS, sparse checkout, and generated content

## 19.1 Submodules

Submodule commits are part of the Git State Envelope. CLU-E records:

- expected superproject gitlink OID;
- observed submodule HEAD;
- dirty state;
- remote identity;
- initialization state;
- policy for recursion and publication.

A submodule update is a multi-repository change and requires explicit proof and landing order.

## 19.2 Git LFS

CLU-E verifies that required LFS objects are present before proof. Pointer-file equality without object availability is insufficient.

LFS upload is a publication operation with separate credentials, quota, classification, and receipt.

## 19.3 Sparse checkout and partial clones

A sparse or partial checkout must declare the omitted surface. Global recognition or equilibrium is prohibited when material required paths or objects are unavailable.

## 19.4 Generated content

Generated files are classified by source-of-truth policy:

- committed and authoritative;
- committed projection requiring regeneration check;
- build-only and ignored;
- forbidden in accepted diff.

CLU-E compares generated outputs only under the registered generation contract.

---

# 20. Security and trust

## 20.1 Credentials

Git and provider credentials:

- live in Git Credential Manager, SSH agent, OS secret storage, or an approved host secret facility;
- are referenced by identity, never stored in YAML or model context;
- have least-privilege repository and operation scopes;
- are redacted from URLs, logs, events, commit messages, and UI;
- are independently revocable;
- are never exposed to browser code.

## 20.2 Untrusted repository behavior

A Git repository may contain executable or configuration surfaces including:

- hooks;
- smudge/clean filters;
- custom diff and merge drivers;
- submodule URLs;
- aliases;
- `include` or `includeIf` configuration;
- LFS filters;
- worktree configuration;
- attributes affecting checkout and hashing.

CLU-E treats these as untrusted until approved.

The Git Integration Service uses a hardened invocation profile:

- fixed executable path;
- fixed argv schemas;
- no shell interpolation;
- controlled environment;
- controlled or disabled hooks for experiment operations;
- prohibited `protocol.ext` and unregistered transports;
- repository ownership and `safe.directory` validation;
- explicit submodule and LFS policy;
- bounded output and timeouts;
- config provenance capture.

Project-required hooks may be executed as registered proof or landing commands, not inherited invisibly.

## 20.3 Remote trust

Fetching remote objects does not make their contents trusted. Remote code, workflows, generated artifacts, review text, and logs remain untrusted inputs subject to the same prompt-injection and tool-boundary rules as local source.

## 20.4 History safety

Default prohibitions:

```text
force push to shared refs
history rewrite after publication
automatic deletion of non-CLU-E refs
automatic conflict resolution
automatic bypass of provider protection
credential-bearing remote URLs
unsigned accepted commits when signing is REQUIRED
publication of unclassified evidence
```

---

# 21. Failure and recovery

## 21.1 Local Git process interruption

The operation receipt remains `STARTED` without `COMPLETED`. Reconciliation reads refs, index, worktree, lock files, and process state before retry.

## 21.2 Worktree corruption

The worktree is quarantined. The exact change set is captured when safe, then the experiment is reconstructed from Base Pin and sealed artifacts in a new worktree.

## 21.3 Remote authentication failure

Local proof remains intact. Publication becomes `AUTH_BLOCKED`; credentials are never requested through an AI prompt. The operator receives the exact missing credential capability.

## 21.4 Remote outage

Publication remains queued. No repeated push storm is allowed. Backoff and idempotency keys apply.

## 21.5 Branch protection rejection

The operation is recorded as policy-conformant remote refusal. CLU-E adapts through review-first or Creator-led flow; it does not bypass protection.

## 21.6 Remote branch rewritten or deleted

The publication record becomes divergent. CLU-E does not silently recreate or force-update the ref until branch ownership, expected old OID, and retention policy are re-established.

## 21.7 Provider review or CI API loss

Generic Git state remains usable. Provider-specific state becomes `UNAVAILABLE`, never guessed. Landing proceeds only if policy does not require that state.

## 21.8 Post-land failure

The Custodian reverts only its own landing under the existing permit and records:

- failed exact commit;
- post-land evidence;
- revert commit;
- remote publication result;
- review/check update;
- AUTO suspension when required;
- recovery verification.

## 21.9 Evidence remote loss

The local append-only truth and artifact store remain authoritative. A replacement remote is registered through explicit migration, then history and manifests are pushed after hash-chain verification.

---

# 22. Persistent records

The implementation must support at least the following records.

## 22.1 GitRepositoryRegistration

```yaml
repository_id: GITR-...
target_project_id: TGT-...
role: PRIMARY
local_root: registered-path-id
git_common_dir_fingerprint: sha256
object_format: sha1
primary_remote_id: GREM-...
allowed_remote_ids: [GREM-...]
base_branch: refs/heads/main
protected_ref_patterns: [refs/heads/main, refs/heads/release/*]
clue_namespace: refs/heads/clue/
worktree_policy_hash: sha256
publication_policy_hash: sha256
credential_policy_id: SEC-...
provider_adapter_id: optional
signing_policy_id: optional
registration_hash: sha256
```

## 22.2 GitRemoteRecord

```yaml
remote_id: GREM-...
repository_id: GITR-...
name: origin
normalized_identity_hash: sha256
transport: ssh | https | local
host_classification: approved
fetch_refspec_hash: sha256
push_refspec_policy_hash: sha256
provider_repository_id: optional
credential_reference: secret-reference-id
```

## 22.3 GitBasePin

```yaml
base_pin_id: GBP-...
repository_id: GITR-...
commit_oid: object-id
tree_oid: object-id
source_snapshot_id: SNP-...
git_state_envelope_id: GSE-...
remote_reachability: reachable | local_only | unknown
captured_remote_ref_snapshot_hash: optional
pin_hash: sha256
```

## 22.4 GitWorktreeLease

```yaml
lease_id: GWL-...
repository_id: GITR-...
worktree_path_id: path-id
experiment_id: EXP-...
branch_ref: refs/heads/clue/experiment/...
base_pin_id: GBP-...
owner_worker_id: WRK-...
issued_at: timestamp
expires_at: timestamp
state: ACTIVE | QUARANTINED | RELEASED | EXPIRED
last_reconciled_at: timestamp
lease_hash: sha256
```

## 22.5 GitChangeSetPartition

```yaml
partition_id: GCP-...
experiment_id: EXP-...
base_tree_oid: object-id
candidate_tree_oid: object-id
entries:
  - path: src/...
    blob_before: object-id
    blob_after: object-id
    class: CANDIDATE_IMPLEMENTATION
    rationale_artifact: sha256
complete: true
unknown_count: 0
forbidden_count: 0
partition_hash: sha256
```

## 22.6 GitCommitReceipt

```yaml
commit_receipt_id: GCR-...
repository_id: GITR-...
operation: EXPERIMENT_CHECKPOINT | REVIEW_SEAL | ACCEPTED_SEAL | REVERT
parent_oids: [object-id]
tree_oid: object-id
commit_oid: object-id
diff_hash: sha256
metadata_manifest_hash: sha256
signature_state: VALID | NOT_REQUIRED | INVALID | UNAVAILABLE
actor_id: service-or-custodian
operation_event_id: EVT-...
receipt_hash: sha256
```

## 22.7 GitPublicationReceipt

```yaml
publication_id: GPU-...
repository_id: GITR-...
remote_id: GREM-...
local_ref: refs/heads/clue/review/...
remote_ref: refs/heads/clue/review/...
expected_remote_old_oid: optional
published_oid: object-id
provider_review_id: optional
started_at: timestamp
completed_at: timestamp
result: PUSHED | ALREADY_PRESENT | REJECTED | FAILED | PENDING
remote_response_artifact: sha256
receipt_hash: sha256
```

## 22.8 GitReviewRecord

```yaml
review_record_id: GRV-...
provider_adapter_id: GPA-...
provider_review_id: string
repository_id: GITR-...
head_oid: object-id
base_ref: refs/heads/main
state: DRAFT | OPEN | APPROVED | CHANGES_REQUESTED | MERGED | CLOSED | UNKNOWN
mergeability: CLEAN | CONFLICTING | BLOCKED | UNKNOWN
required_approvals: integer
observed_approvals: integer
url_reference: redacted-provider-reference
last_observed_at: timestamp
record_hash: sha256
```

## 22.9 RemoteCheckRun

```yaml
remote_check_id: RCK-...
provider_run_id: string
repository_id: GITR-...
commit_oid: object-id
check_name: string
workflow_revision: string
required: true
status: QUEUED | RUNNING | COMPLETED
conclusion: SUCCESS | FAILURE | CANCELLED | SKIPPED | NEUTRAL | TIMED_OUT | UNKNOWN
environment_envelope_hash: optional
log_artifact_hash: optional
result_artifact_hash: optional
trust_class: CONTROLLED | EXTERNAL | UNTRUSTED
observed_at: timestamp
record_hash: sha256
```

## 22.10 GitReconciliationRecord

```yaml
reconciliation_id: GRC-...
repository_id: GITR-...
expected_state_hash: sha256
observed_local_state_hash: sha256
observed_remote_state_hash: optional
provider_state_hash: optional
divergences: [code]
disposition: RESUME | DEFER | REPROVE | QUARANTINE | CREATOR_ACTION
performed_at: timestamp
record_hash: sha256
```

---

# 23. Event protocol and audit

Git operations produce ordered operational events. Recommended event kinds:

```text
git.repository.discovered
git.repository.registered
git.state.captured
git.remote.fetch.started
git.remote.fetch.completed
git.worktree.requested
git.worktree.created
git.worktree.quarantined
git.branch.created
git.changeset.classified
git.commit.created
git.commit.sealed
git.push.started
git.push.completed
git.review.created
git.review.updated
git.check.observed
git.divergence.detected
git.reconciliation.completed
git.landing.completed
git.revert.completed
git.evidence.published
git.branch.archived
git.worktree.pruned
```

Each event carries source record IDs, actor, capability, repository, expected state, observed result, duration, redaction state, and raw receipt artifact.

The Operational Console renders these events on the `GIT / CLOUD` channel. It does not animate an operation before the corresponding backend event exists.

---

# 24. Configuration contract

```yaml
git:
  enabled: true
  executable: "C:/Program Files/Git/cmd/git.exe"
  repository_mode: WORKTREE_POOL
  require_repository_registration: true
  allow_dirty_creator_state: CAPTURE_ONLY
  clue_branch_namespace: "clue"
  force_push: DENY
  history_rewrite_after_publication: DENY
  fetch:
    before_campaign: true
    before_publication: true
    before_landing: true
    prune: false
  worktrees:
    root: "F:/CLU/workspace/git/worktrees"
    max_concurrent_per_repository: 4
    quarantine_root: "F:/CLU/workspace/git/quarantine"
    retention_days: 14
  commits:
    machine_author_name: "CLU-E"
    machine_author_email: "clue@local.invalid"
    signing: OPTIONAL
    one_commit_canonical_landing: true
  remotes:
    primary: origin
    allowed: [origin]
    review_push: true
    accepted_push: true
  publication:
    mode: CREATE_DRAFT_REVIEW
    evidence_repository_remote: origin
    evidence_class_default: LOCAL_ONLY
    publish_great_book: true
    publish_status_seal: true
    publish_raw_artifacts: false
  provider:
    kind: GENERIC_GIT
    adapter: null
    credential_reference: null
    create_review: false
    request_remote_checks: false
  landing:
    transport: CREATOR_APPLY
    require_remote_checks: false
    require_review_approval: false
    post_land_verification: true
  security:
    hooks: CONTROLLED
    allow_submodules: REGISTERED_ONLY
    allow_lfs: REGISTERED_ONLY
    allow_protocols: [ssh, https]
    redact_remote_identity: true
```

Provider-specific settings live under the registered adapter schema and never contain raw secrets.

---

# 25. CLI surface

Read and validation:

```text
clue git discover
clue git register --repository <path>
clue git doctor
clue git status [--repository <id>]
clue git refs [--repository <id>]
clue git diff --experiment <id>
clue git reconcile [--repository <id>]
```

Experiment operations:

```text
clue git worktree create --experiment <id>
clue git worktree list
clue git worktree quarantine --experiment <id>
clue git worktree release --experiment <id>
clue git branch seal-review --improvement <id>
```

Publication:

```text
clue git publish review --improvement <id>
clue git publish accepted --landing <id>
clue git publish evidence --cycle <id>
clue git review open --improvement <id>
clue git review status --improvement <id>
clue git checks show --commit <oid>
```

Maintenance:

```text
clue git archive --campaign <id>
clue git prune --dry-run
clue git prune --apply --permit <id>
```

The CLI is a thin client over services. It does not invoke arbitrary Git arguments.

---

# 26. Service API

Minimum read endpoints:

```text
GET /api/git/repositories
GET /api/git/repositories/:id/state
GET /api/git/worktrees
GET /api/git/branches
GET /api/git/publications
GET /api/git/reviews
GET /api/git/checks
GET /api/git/reconciliation/current
```

Mutation endpoints accept typed requests and return operation IDs:

```text
POST /api/git/fetch
POST /api/git/worktrees
POST /api/git/review-branches/:improvementId/seal
POST /api/git/publications
POST /api/git/reviews
POST /api/git/reconciliation
POST /api/git/archive
```

Custodian endpoints remain separate and require a LandingPermit:

```text
POST /api/custodian/git/accepted-commit
POST /api/custodian/git/land
POST /api/custodian/git/revert
```

Every response exposes durable receipt IDs and never returns credentials.

---

# 27. Status and interface projection

`CLU-E Status` exposes one `versionControl` branch containing:

```text
registered repositories
current Git State Envelope
base pin
Creator working-tree state
active worktrees and leases
experiment, review, accepted, and recovery branches
sealed commits and diff hashes
local/remote ahead-behind state
remote reachability and authentication health
review object and approval state
remote required checks
publication queue and receipts
evidence-repository synchronization
branch/worktree retention and quarantine
divergence and reconciliation disposition
Git/cloud capability readiness
```

The interface shows:

- current branch and short commit;
- clean/dirty and snapshot-alignment state;
- base branch and remote;
- ahead/behind and last fetch;
- active CLU-E worktree and experiment branch;
- proof head versus published head;
- review URL reference and state;
- required remote checks;
- evidence publication state;
- landing and revert readiness;
- exact blocking reason.

No UI button executes a raw Git command. It requests a governed operation and renders its receipt.

---

# 28. Measurement and equilibrium integration

Git integration uses the existing canonical Measurement Catalogue rather than introducing a fifth family or changing the fixed 10 × 10 coordinates.

Primary canonical measures include:

```text
MF03  Supply-chain and provenance integrity
MF06  Auditability, accountability, and policy conformance
ME06  Reversibility and rollback
MG01  Compatibility and interoperability
MG02  Backward and forward compatibility
MG05  Deployability and operability
MI04  Coverage completeness
MI05  Causal attribution
MI09  Reproducibility and replicability
MI11  Scope-of-claim integrity and residual unknowns
MJ05  Evidence Admissibility
MJ07  Reversibility and Recovery
MK10  Mission continuity
MK11  Custody safety
MK18  Status fidelity
```

Target-specific indicators may include:

```text
I.GIT.REPOSITORY_COVERAGE
I.GIT.BASE_REACHABILITY
I.GIT.WORKTREE_ISOLATION
I.GIT.CHANGESET_ATTRIBUTION
I.GIT.REMOTE_SYNC
I.GIT.REVIEW_PUBLICATION
I.GIT.REMOTE_CHECK_COMPLETENESS
I.GIT.REVERSIBILITY
I.GIT.EVIDENCE_CLOUD_DURABILITY
I.GIT.CREDENTIAL_SAFETY
```

Git publication does not create a new equilibrium dimension. However, an unresolved required repository, stale base, divergent remote, missing required check, or unpublished mandatory evidence blocks project-level RPI equilibrium under an envelope that requires remote durability or review.

---

# 29. Retention and cleanup

The retention engine distinguishes:

```text
worktree files
local experiment branches
published review branches
accepted branches
provider review objects
remote CI artifacts
evidence manifests
landing and revert records
```

Default behavior:

- terminal negative experiment worktrees are retained briefly, then pruned after evidence capture;
- experiment branches are archived or deleted only after no durable record depends on an unreachable object;
- published review branches remain until review closure and retention expiry;
- accepted branch deletion is deferred until canonical reachability and evidence manifests are verified;
- landing and revert commits, Great Book records, and receipts are never pruned from CLU-E memory;
- remote deletion is a separate governed operation;
- cleanup always supports `dry-run` and produces a receipt.

Git garbage collection must not make required evidence unreachable before artifact retention and reachability checks complete.

---

# 30. Implementation architecture

Recommended module boundary:

```text
src/integration/git/
  repositoryRegistry.ts
  gitStateReader.ts
  gitCommandRegistry.ts
  gitOperationPolicy.ts
  worktreeManager.ts
  branchManager.ts
  changeSetPartitioner.ts
  commitSealer.ts
  remoteSynchronizer.ts
  publicationController.ts
  providerAdapter.ts
  remoteCheckCollector.ts
  reconciliationService.ts
  retentionService.ts
  records.ts
  schemas.ts

src/control/
  gitLifecycleOrchestrator.ts

src/experiment/
  gitExperimentBridge.ts

src/custodian/
  gitCustodian.ts

src/ui/
  versionControlProjection.ts
```

Recommended process ownership:

```text
clue-git-agent
  owns typed Git operations, worktree pool, fetch/push, provider adapters,
  remote checks, reconciliation, and retention

clue-custodian
  owns accepted commit sealing, canonical landing, protected merge request,
  and revert under a valid permit
```

The Git agent may mutate CLU-E-owned worktrees and refs. It may not mutate the canonical branch. The Custodian may mutate canonical state only after verdict and policy gates.

---

# 31. Implementation ownership

The stable module ownership for this domain is defined in `CLUE_Project_Directory_v9.md`. Current delivery increments, open source files, and implementation status belong to the external dynamic backlog. The Git domain itself remains governed by the lifecycle, records, APIs, security rules, and acceptance gates in this document.

---

# 32. Acceptance gates

Full Git lifecycle integration is operational only when:

1. every target repository is explicitly registered or explicitly unsupported;
2. the same repository state reproduces the same Git State Envelope and source snapshot;
3. the Creator working tree cannot be modified by ordinary CLU-E capabilities;
4. two concurrent experiments cannot acquire the same branch/worktree lease;
5. every worktree is pinned to one exact base and quarantined on unknown mutation;
6. every changed path is classified before a branch can be sealed;
7. ephemeral instrumentation is excluded from the accepted diff unless separately accepted;
8. experiment commits cannot be mistaken for accepted commits;
9. the exact proved tree and diff are preserved in the sealed review/accepted commit;
10. canonical landing remains permit-bound, one-commit, receipted, and reversible;
11. force-push and history rewrite are denied for protected/shared refs;
12. every push validates expected remote old OID, namespace, and remote allowlist;
13. offline publication queues survive restart and reconcile before retry;
14. a remote branch rewrite or review-head change invalidates stale landing readiness;
15. provider reviews bind to one exact head commit and expose residual uncertainty and proof scope;
16. remote checks are ingested with exact commit, workflow, environment, and trust provenance;
17. a green remote check cannot independently create a positive RPI verdict;
18. required failed or stale checks block landing under policy;
19. no raw credential enters config, model context, logs, UI, or commit messages;
20. hooks, filters, submodules, LFS, and untrusted Git configuration follow explicit policies;
21. cloud evidence publication applies classification, redaction, hashing, and retention rules;
22. the target source repository and evidence repository can be restored and reconciled from remote copies without changing historical hashes;
23. status, CLI, API, Operational Console, provider state, and receipts agree on repository, branch, commit, publication, and check identities;
24. worktree/branch cleanup cannot make required evidence unreachable;
25. an end-to-end pilot proves local experiment, branch sealing, cloud publication, remote check ingestion, landing, post-land verification, Great Book publication, and automatic or Creator-led recovery.

---

# 33. Conformance statement

Documentation conformance and executable conformance are separate. An implementation may claim full Git lifecycle integration only after the acceptance gates in Section 32 have been demonstrated against real or controlled repositories, host boundaries, remotes, provider fixtures, crash recovery, and protected landing/revert flows. Current maturity is reported only in the external dynamic backlog.

---

# 34. Final contract

> **CLU-E integrates with Git by treating every local and remote version transition as a governed, receipted state change. It may modify and commit freely only inside leased CLU-E experiment worktrees; it may publish only declared CLU-E refs and classified evidence to approved remotes; it may land only the exact proved tree through the Custodian; it treats review and remote CI as provenance-bound collaboration and evidence surfaces rather than verdict authorities; and it preserves enough local and cloud-linked history to reproduce, inspect, reverse, and continue every RPI cycle.**

```text
Git supplies version graph, isolation, collaboration, transport, and recovery.
RPI supplies purpose, claim, proof, verdict, value, and equilibrium.
CLU-E binds the two without allowing either to impersonate the other.
```

---

# 35. 2026-08-14 executable-alignment amendment — local-first manual sync boundary

P2 exposes one manual `SYNC GIT` operator convenience beside `START CLU-E`. The two actions are
independent: Start, proof, ACCEPT and cycle closure never trigger Git synchronization.

The P2 action is deliberately narrower than the full lifecycle in this document. With
`NO_REMOTE_YET`, it refuses without contacting Git. With a later registered remote, it requires a
clean attached branch, fetches first, reports unchanged state, fast-forwards behind-only state,
pushes ahead-only state and refuses divergence. It provides no merge, rebase, force push, stash,
semantic conflict resolution, protected-ref authority or proof-to-commit binding. Credentials remain
with the host Git credential helper or SSH agent.

This action does not satisfy Section 32 and does not populate the governed `versionControl` Status
branch. The complete repository registration, worktree lease, sealed candidate commit, remote
checks, landing, publication receipt and automatic recovery lifecycle remains P4 scope.

---

# Part II — v10 Project Profiles amendment

## A. Per-project Git binding

Every profile binds Repository Root, remote, provider, default branch, protected/landing policy, current Base Pin and publication mode. Repository identity must match the profile Target Root. Git state from another project is invalid evidence.

## B. Local-only operation

`NO_REMOTE_YET` is a valid explicit state. It permits local recognition, analysis, benchmark, proof and Great Book work while Git publication and Custodian landing remain unavailable. Overall readiness may therefore be `READY_LOCAL_ONLY`.

## C. Explicit synchronization

`START CLU-E` never performs fetch, pull, push or remote discovery. `SYNC GIT` is a separate operator action and remains blocked when no remote is configured. Connection tests must distinguish absent remote from an invalid repository.

## D. Switching

Project switching changes repository root, base pin and publication state with the rest of the active context. A stale Project A Git receipt cannot authorize Project B publication. Failure to validate successor Git state blocks only operations that require publication when local-only work remains otherwise valid.
