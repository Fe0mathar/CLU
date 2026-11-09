# CLU-E P2 benchmark repair for review

## Windows evidence

The released 0.1.0 benchmark ran on Windows x64 and Node 22.16.0 under the qualified
production supervisor. It produced nine of thirteen required signals. Offline npm
installation passed with 48 verified packages and the SQLite prebuild.

SCN-005 failed because the aggregate doctor command required an OpenAI credential.
SCN-006 reported 148 file failures and zero passing tests. Node's test workers tried
to inspect the drive root, which the supervisor did not admit. The previous
projection rebuild passed in a disposable workspace, where moving the database
aside was safe for that run. Its cleanup could remove the original after a failed
rebuild in the live workspace.

## Changes

- SCN-004 replays verified committed events into a separate scratch projection
  database and compares normalized Status facts at the pinned event head. It opens
  the live database and WAL only as copy inputs.
- SCN-005 uses the chain verifier and its rollback checkpoint guard, independent
  of provider readiness. The log reader preserves UTF-8 code points across read
  boundaries.
- SCN-006 uses the explicit offline suite v1. A direct Node entry runs the selected
  tests in one process under the existing network-denied supervisor. The full
  suite remains a release gate. Missing receipts or incomplete results fail closed
  for proof eligibility.
- The Master Benchmark is version 0.2.0. The gate rules and thresholds are preserved.
  The changed measurements need a fresh opening baseline under the successor
  benchmark. The prior mission and its evidence remain historical.

## Validation and authority

The ZIP rehearses this source repair against the exact released archive in
disposable directories. Windows acceptance for this rehearsal requires all 13
signals, valid receipts and a passing offline dependency install. A one-pass
rehearsal checks execution only. Registering the successor on the live installation
requires Creator review and the normal mission and proof authorization.
