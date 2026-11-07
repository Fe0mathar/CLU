# Project Profiles Batch 01 — Foundation and Core

## Scope

This patch implements PP-01 through PP-08:

```text
canonical path identity
project operation identity
strict profile schema
canonicalization and behavior/authority hashes
atomic profile store
registry and physical-root uniqueness
sanitized hash-chained profile events
explicit legacy migration
```

It also adds the six design/acceptance documents required before later runtime and UI work.

## Deliberate non-actions

Applying the ZIP does **not**:

- run migration;
- create `F:\CLU\profiles`;
- alter `config/clue.config.yaml` or `targets/clu/profile.yaml`;
- touch `F:\CLU\workspace\clue` or `F:\CLU\shadow\clue`;
- activate/switch a runtime project;
- add Project Profile HTTP/CLI/UI surfaces;
- change the Metric Catalogue;
- change Q1/SURF interface files;
- perform P2 ratification, epoch opening, proof or closure.

The registry method `setLegacyActivePointer` is intentionally labelled as pointer metadata only. It
must not be treated as an atomic runtime switch; Batch 2 owns that state machine.

## Patch application

Extract the ZIP directly into the CLU repository root:

```text
F:\CLU\CLU
```

The ZIP begins with project-relative paths such as `src/`, `selftest/` and `docs/`; it contains no
extra wrapper directory.

## Validation commands

```powershell
npm run typecheck
npm run build
npm run selftest
npm run dashboard:verify
npm run navigator:verify
```

Focused Batch 1 tests are compiled under `dist/selftest/project-*.test.js` by the normal build.

## Security properties

- persisted profiles accept credential references only;
- raw secret-shaped values and unknown secret fields are rejected;
- event records have no credential field;
- full durable records carry an integrity hash in addition to behavior and authority hashes;
- profile deletion is profile-only and exactly confirmed;
- foreign-platform absolute paths fail closed during migration;
- target aliases collapse through realpath/junction resolution before uniqueness checks.

## Baseline preservation

The final Q1/SURF patch supplied immediately before this batch was used as the working baseline.
Batch 1 contains no Q1 dashboard files, so applying it cannot overwrite that finalized interface.

## Packaging validation

The release candidate was validated against a clean copy of the supplied project baseline plus the
final Q1/SURF patch. The final results are:

```text
TypeScript typecheck                         PASS
production TypeScript build                  PASS
focused PP-01..PP-08 tests                   47/47 PASS
complete repository self-test suite          723 PASS / 0 FAIL / 6 SKIP (729 total)
dashboard tests                              128/128 PASS
System Navigator syntax/import verification  28/28 modules; 59 edges resolved
System Navigator tests                       12/12 PASS
```

The uploaded archive contained a Windows-native `better-sqlite3.node`. For Linux packaging-host
verification only, `node_modules/better-sqlite3` was rebuilt from the installed Node 22.16.0
headers. `node_modules` and all generated `dist/` output are excluded from this patch. The original
Windows-native dependency in the user's project baseline is therefore not replaced.

A final Windows execution remains the installation-specific gate for real drive-letter,
junction/reparse-point, ACL and external-root behavior. The platform-neutral test suite also
simulates Windows slash/case canonicalization and fails closed when a foreign-platform path is
presented to the wrong host.
