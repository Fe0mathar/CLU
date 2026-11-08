# CLU-E Patch 05Z2 — Windows CLI entry point

05Z1 passed the offline install, typecheck, build, and native SQLite query on Windows. Both `clue init` and `clue doctor --deep` returned exit code zero, with no verification lines and no staged event log or database.

The CLI decides whether to dispatch by resolving the invoked script path and its module path. It catches resolution errors and skips dispatch. 05Y2 had already observed `EPERM` from the ordinary real-path lookup on staged Windows files that could be read and resolved through the native API. A local fault simulation reproduced the silent zero exit.

On Windows, the CLI now uses `fs.realpathSync.native` for both identities. It still compares the resolved paths before dispatch, including when a launcher shim is involved. A library import continues to load the module without dispatching a command. The governed diagnostic exercises the direct production CLI entry point and requires the existing event-log, artifact, and staged workspace checks.

[Node.js 22.16 native real-path API](https://nodejs.org/download/release/v22.16.0/docs/api/fs.html#fsrealpathsyncnativepath-options)
