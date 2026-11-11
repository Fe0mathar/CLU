# Project Profiles v10 Release Candidate

## Release contents

The v10 pack updates only owner documents whose contracts changed and carries forward unchanged constitutional, methodology and Metric Catalogue authority without semantic edits. The pack is sealed by `SHA256SUMS_v10.txt` and described by `DOCUMENTATION_MANIFEST_v10.json`.

## Installed authority and candidate review

Project Profiles are post-P2 architecture. P2 closed under v9, and the immutable closure receipt and Creator approval preserve that historical authority. The P16 candidate refresh aligns the prospective owner documents with the exact profile-bound OpenAI model, the per-profile Git publication modes and the evidence available from the Windows installation. The installed selector and tracked-document registration continue to use v9 during candidate review.

The Windows P15A dashboard result establishes live A → B → A isolation. It is one input to authoritative Windows acceptance. The refreshed candidate still requires the applicable native and live gate evidence listed in the final acceptance contract.

## Promotion sequence

```text
P2 machine closure
→ immutable P2 receipt
→ Creator P2 approval
→ Project Profiles authoritative Windows acceptance
→ v10 seal/manifest verification
→ Creator selector + tracked-document cutover (`npm run project-profiles:promote-v10`)
→ successor mission bootstrap and review of governed input changes
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
