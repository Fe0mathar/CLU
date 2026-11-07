# Operational Console Architecture

## Purpose

The console is a read-only projection of actual CLU-E operational traffic. It is not an execution authority and not a source of truth for the operations it displays.

## Data path

```text
real CLU-E transport boundary
→ redact exact outbound payload
→ store full redacted artifact by SHA-256
→ append OUTBOUND event
→ execute real operation
→ redact/store exact response
→ append INBOUND event
→ validate/interpret result
→ append INTERNAL summary
→ project bounded view
→ HTTP/SSE
→ WebGPU + crisp DOM console
```

## Authority separation

- transport executes;
- recorder mirrors;
- artifact store preserves payload;
- event store preserves order and hash chain;
- projector builds UI state;
- server only reads;
- renderer only displays.

No renderer may run PowerShell, call CDP, call GPT, issue a verdict, or mutate a repository.

## Exactness

“Exact” means byte-faithful after mandatory policy redaction. Full redacted content is the artifact. The inline preview may be truncated and is explicitly marked incomplete.

## Event chain

Events are ordered and hash chained:

```text
previousHash → event body → eventHash
```

Tampering or sequence gaps fail replay.

## Current work contract

The active console always reserves semantic space for:

```text
WHAT
WHY
HOW PROVEN
WHO / MODEL
CURRENT STATUS
NEXT
```

The fields may honestly state that no operation is active. They must never be invented to make the console look busy.
