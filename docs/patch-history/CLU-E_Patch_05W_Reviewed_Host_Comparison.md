# CLU-E Patch 05W — Reviewed host comparison

## Purpose

The 05V1 report established a host baseline against the current dashboard, including local edits. This patch adds a repeatable comparison between two source versions on that same Windows PC. The baseline comes from Git HEAD and the candidate comes from the current checkout. Both sides are prepared together so their test environments are comparable.

## Operation

- The launcher creates fresh temporary copies of the fixed dashboard source scope. It reads committed blobs for the baseline and exact local bytes for the candidate. Both copies contain the same dashboard test files and package metadata. The scope check refuses added inputs, aliases, and edits to the shared tests or metadata.
- The console displays the scoped fingerprints and changed implementation files before asking for approval. When the operator types `COMPARE`, the fixed dashboard suite runs with the current Windows user's permissions. Use it for reviewed, trusted changes.
- Each copy is checked before and after each suite. The run alternates baseline then candidate and candidate then baseline. It records aggregate test outcomes and wall time for each run. The report supplies median timing and the delta when both sides pass with the same test count.
- The report is written outside the checkout and identifies both exact scopes. An empty candidate difference, changed inputs, test failure, or unverified cleanup is reported explicitly. The stage is disposable.

## Evidence limits

The timing measures execution of the dashboard test suite. Live dashboard HTTP transfer and browser rendering have separate measurement paths. A two-round comparison can show a difference and is a small sample. Review repeatability before using that difference to make a performance decision.

The report records `proofAuthorization: false`. This reviewed host route provides comparison evidence. Automated proof for generated changes still needs production admission and fault-containment qualification.

## Verification

Portable checks exercised the complete comparison on Git HEAD and a locally edited dashboard, including scope checks, the 183-test suite, timing output, and tamper detection. The operator's Windows comparison is the native acceptance run.
