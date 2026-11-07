# Transport Instrumentation

## Non-negotiable rule

The recorder must observe the payload at the real transport boundary, immediately before send and immediately after receive. A later reconstructed approximation is not sufficient.

## PowerShell host

The included patch mirrors:

- exact newline-delimited JSON request written to host stdin;
- exact JSON response line read from host stdout;
- typed decode result;
- host error, timeout, crash, and malformed-response states.

The host remains a closed command registry. The console does not expand its authority.

## Chrome/CDP

The included patch mirrors:

- exact CDP JSON-RPC request sent over the WebSocket;
- exact correlated response frame;
- protocol rejection;
- structural acceptance;
- timeout or socket failure.

CDP event notifications such as console messages continue through the Console Ledger. They are observations rather than correlated request/response exchanges.

## GPT / Batch

When the Model Gateway is implemented, wrap the actual API call with `mirrorOperation()`:

```text
exact redacted task envelope
→ physical API call
→ exact redacted structured response
→ CLU-E validation summary
```

Record logical session ID separately from physical call ID.

## Benchmarks

Mirror both:

1. benchmark source/configuration passed to the runner;
2. raw benchmark result returned by the runner.

Then record a separate interpretation only after instrument health and proof-contract validation.

## Proof, Custodian, Great Book, Status

Each future boundary follows the same pattern. The console channel may differ, but the exact request/response/summary ordering may not.
