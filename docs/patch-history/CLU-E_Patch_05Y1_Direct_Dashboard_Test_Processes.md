# CLU-E Patch 05Y1 — Direct dashboard test processes

The first 05Y run on the regular Windows account admitted both reviewed snapshots. All five invalid requests were refused before launch. The direct Node scratch check, checkout write denial, protected inputs, and cleanup passed on both sides. The suite reported 23 failures on each side, matching its 23 test files. The aggregate counts identify a shared file-level failure. The original report contains no underlying error output.

05Y launched one Node test runner per snapshot. Node's default process isolation then launched another process for each file. 05Y1 launches each approved test file in its own direct Node process. That runner executes the file in its own process and skips the extra worker launch. This keeps per-file process separation and the existing MXC job, read-only snapshots, scratch layout, request controls, and operator review.

The harness verifies the full approved file list, records bounded outcomes, and requires both sides to pass every file with comparable test totals. Raw TAP and stderr stay inside the diagnostic. The result still records `proofAuthorization: false`.

[Node.js 22.16 test runner execution model](https://nodejs.org/download/release/v22.16.0/docs/api/test.html#test-runner-execution-model)
