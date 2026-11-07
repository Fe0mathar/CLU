# Operational Console Event Protocol

## Schema

Current schema version:

```text
1.0.0
```

Machine schemas:

```text
schemas/operational-console-event.schema.json
schemas/operational-console-projection.schema.json
```

The authoritative runtime schema is the Zod contract in:

```text
src/observability/operationalConsole/contract.ts
```

## Channels

```text
CLUE_CORE
RECOGNITION
GPT
BENCHMARK
POWERSHELL
CHROME_CDP
PROOF
CUSTODIAN
GREAT_BOOK
STATUS
```

## Three-layer transaction

One logical exchange normally produces:

```text
OUTBOUND  command/request/code
INBOUND   response/result/error
INTERNAL  summary
```

The three records share `exchangeId` and `requestId`.

## Validation states

```text
pending
received
schema_validated
policy_accepted
evidence_admissible
evidence_rejected
not_applicable
```

Receiving a response is not the same as validating it. Validation is not the same as admitting it as evidence.

## Payload preservation

Every payload contains:

- redacted preview;
- format;
- complete/incomplete flag;
- redacted byte length;
- artifact hash;
- redaction count.

## Source IDs

Events should carry all durable identities available at the boundary, including:

```text
task
logical session
physical call
run
benchmark
proof contract
patch
landing
snapshot or source artifact in sourceIds
```
