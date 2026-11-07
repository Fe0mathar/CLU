# Project Profiles v10 Release Candidate

## Release contents

The v10 pack updates only owner documents whose contracts changed and carries forward unchanged constitutional, methodology and Metric Catalogue authority without semantic edits. The pack is sealed by `SHA256SUMS_v10.txt` and described by `DOCUMENTATION_MANIFEST_v10.json`.

## Why it is not active on extraction

Project Profiles are post-P2 architecture. Activating v10 before P2 closure would change the authority basis used for the closure ceremony and risk making ratification/epoch evidence stale. Therefore this batch installs a verifiable candidate but leaves active v9 tracked-document registration unchanged.

## Promotion sequence

```text
P2 machine closure
→ immutable P2 receipt
→ Creator P2 approval
→ Project Profiles authoritative Windows acceptance
→ v10 seal/manifest verification
→ governed selector + tracked-document cutover (`npm run project-profiles:promote-v10`)
→ Creator v10 ratification
→ POST-P2-PROJECT-PROFILES epoch
→ two-profile representative operations
→ Creator Project Profiles acceptance
```

## Verification

```powershell
npm run project-profiles:docs-verify
```

The verifier checks path safety, duplicates, existence, SHA-256, byte/line/word metadata, manifest membership and exact manifest binding by the seal.
