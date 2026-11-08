# CLU-E Patch 05V1 — Windows host input identity

05V reported `HOST_TEST_SCOPE_CHANGED_DURING_READ` during preflight on Windows build 26200 with Node 22.16.0. The reader compared a path metadata snapshot directly to an open file's metadata. On affected Windows libuv versions those APIs can report different volume IDs for the same file. [libuv change history](https://github.com/libuv/libuv/blob/v1.x/ChangeLog) · [Node 22.16.0 reproduction](https://github.com/chatboxai/chatbox/issues/3957)

The reader now compares path snapshots with path snapshots and uses open-handle snapshots to check the identity and stability of the file being read. It checks the path's final opened handle against the original handle, using BigInt metadata to preserve exact file IDs and timestamps. The reader retains the regular file, canonical path, single-link, size, and source fingerprint checks.

The portable regression reproduced the old false refusal with a simulated volume-ID mismatch and verified that the new check accepts stable files and rejects mutation and replacement. A native Windows run is the remaining acceptance step.
