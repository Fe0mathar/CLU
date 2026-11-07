# Project Browser Execution Runtime

**Status:** implemented foundation; operator endpoints and CLI arrive in Batch 6  
**Scope:** deterministic browser identity, target selection, project switching and durable evidence

## Runtime boundary

The analysis plane attaches to one pre-authorized DevTools page. It never discovers authority from
ordinary desktop windows and never launches Chrome itself. The host-owned PowerShell launcher
creates or reuses one dedicated process only after its profile, port, target URL, allowed origin and
Project Profile generation match the durable browser state file.

## Identity chain

```text
Project Profile record
  -> Project Operation Identity + profileGeneration
  -> Chrome Instance ID
  -> Browser Session ID
  -> Target/Page ID
  -> Browser Execution ID
  -> immutable request/response evidence
```

Every transition validates the complete predecessor identity. Page title or URL alone is not an
identity.

## Target resolution

A pinned Page ID is authoritative while present. Its disappearance produces
`TARGET DISCONNECTED` and requires explicit re-resolution. Without a pin, one exact configured URL
may be selected. If no exact URL matches, exactly one page under an allowed origin may be selected.
Two eligible pages produce `TARGET AMBIGUOUS`; CLU-E does not choose the first.

## Session lifecycle

```text
registered -> active -> parked -> active
                         \-> released/closed
```

A parked or closed session cannot execute. An active registration cannot be silently replaced. A
project switch parks the predecessor before activating the successor and restores the predecessor
on rollback.

## Evidence layout

Each execution directory contains:

```text
request.json
receipt.json
response.json   # only after terminal completion
```

`receipt.json` binds the request and optional response hashes. Reads re-validate schemas, project
identity, generation and file hashes. A crash between durable steps yields explicit invalid or
non-terminal evidence; it cannot yield a fabricated successful response.

Command text is represented only by `commandSha256`. Result summaries and external evidence
references are bounded and secret-scanned before persistence.

## Live acceptance gate

On Windows, the operator must prove:

1. dedicated Chrome executable/profile/port launch;
2. unrelated endpoint refusal;
3. two matching tabs produce `TARGET AMBIGUOUS`;
4. wrong origin is refused;
5. closing the selected page produces `TARGET DISCONNECTED`;
6. one governed command creates one valid request/response pair;
7. Project A can never remain executable after Project B is active.
