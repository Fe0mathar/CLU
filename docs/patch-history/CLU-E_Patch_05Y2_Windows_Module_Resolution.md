# CLU-E Patch 05Y2 — Windows module resolution

The 05Y1 run admitted both reviewed snapshots on the regular Windows account. The direct Node scratch child, read-only checkout checks, five refusal controls, input verification, and cleanup passed. Each of the 23 test files still reported one failure per side. Both source fingerprints matched the earlier 05W comparison, which passed 183 tests per side on the host.

05Y2 checks access to a pinned harmless ES module and then loads approved test files by their explicit file URLs. It checks the canonical paths against the already verified disposable snapshot. Each file continues to run in its own Node process inside the supervisor. The report separates file access, path resolution, module import, and test results using bounded categories. Raw test output, errors, and host paths stay out of the report.

The first trusted canary tries Node's default resolver. If the exact regular file can be read and verified, and both the ordinary real-path check and module import return an access-denied code, the launcher retries the canary with Node's `--preserve-symlinks` option. The retry uses the same MXC job and roots. The alternate resolver is used for the staged test files only after the trusted canary verifies under it. The report records the trigger and selected mode.

The two read-only snapshots, writable scratch layout, exact request controls, operator review, and cleanup checks remain part of acceptance. The diagnostic retains `proofAuthorization: false`.

[Node.js 22.16 module loader options](https://nodejs.org/download/release/v22.16.0/docs/api/cli.html#--preserve-symlinks)
