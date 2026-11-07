# ADR-0013 — governed Model Gateway and `aiOrchestration`; Status wire 5.5.0

**Status:** implementation candidate for Creator ratification  
**Date:** 2026-08-13  
**Owner:** Model Gateway / Status wire / DEV-P2-09

## Decision

CLU-E has one governed Model Gateway boundary. Installation policy, routing, provider-price
identity, budget admission, request identity, provider receipts and call outcomes are all
explicit and independently inspectable. The gateway never reads a credential from a file or
from persisted state: configuration records only the environment-variable name, and the value
exists in process memory for the duration of a provider operation.

Production ships **implemented but disabled**. `config/policies/routing.yaml` contains a strict
row for every governed task type, but every row is disabled and has `model: null` and
`pricing: null`; `budget.yaml` keeps daily and monthly hard caps at zero; and
`config.gateway.enabled` remains false. Copying this patch therefore cannot create network
traffic or cost. Activation is a separate Creator policy act requiring concrete model IDs,
price identities, caps and routes.

## Authority choreography

Provider I/O must not hold the event-log writer lock for its network duration. One invocation
therefore has three phases:

1. **short writer phase** — validate the current mission, strict request, routing and budget;
   record either `gateway.call_refused` or `gateway.call_started`;
2. **unlocked provider phase** — execute the Responses request or submit/poll the Batch request;
3. **short writer phase** — verify mission continuity and append one terminal or pending receipt.

The event log remains the state-transition authority. SQLite table `gateway_calls` is a
rebuildable projection only. Projection schema advances from 6 to 7.

## Provider surface

The provider-neutral application service currently has one adapter implementation, OpenAI.
The adapter supports:

- interactive Responses requests with `store: false`;
- bounded request time and response bytes;
- exact JSON media/UTF-8 parsing and typed HTTP/provider failures;
- Batch JSONL upload, submission, polling and result reconciliation;
- no automatic re-submission of an unknown or timed-out batch;
- cancellation-in-progress as pending rather than terminal;
- provider request/batch/file identities as receipts, never as verdict authority.

Model identifiers and their exact price schedule live in `routing.yaml`, not in code. The
budget governor records cached input separately and applies the configured Batch discount only
to Batch-mode accounting.

## Budget and routing

Every task belongs to one named lane and has one strict route row. Admission evaluates:

- route enabled/model/pricing completeness;
- per-task ceiling;
- daily reserve, soft/degradation and hard caps;
- monthly hard cap;
- permitted interactive task types;
- one explicit credential environment-variable name.

A refusal is a durable gateway event but is not counted as a submitted provider call. A
submitted call is always exactly one of completed, failed or pending. Status consistency
re-evaluates this equation and refuses invented readiness or orphaned reserved spend.

## Secrets and persisted evidence

The API-key value is never written to:

- configuration;
- event payloads;
- artifacts;
- Status;
- CLI output;
- error text.

Strict request input, instructions and metadata are checked against the registered secret set
before persistence. Provider response/receipt bytes are checked again before artifact storage.
Status exposes only `apiKeyEnv` and the boolean `apiKeyPresent`.

## Status 5.5.0

`aiOrchestration` moves from `unsupported` to a typed, backed branch. It reports:

- configured/enabled/provider state;
- credential environment-variable name and presence boolean;
- operational-readiness result and named policy problems;
- budget/routing hashes and price-schedule identity;
- enabled route count and default mode;
- submitted/completed/failed/refused/pending counts;
- actual daily/monthly spend, reserved estimate and hard caps;
- active degradation action;
- latest projected call identity and freshness.

A configured but disabled gateway is a valid backed state. It is not `unsupported`, and it is
not falsely `operationallyReady`.

## Consequences

- Status schema becomes `5.5.0`.
- Projection schema becomes `7`; an existing workspace rebuilds derived projections.
- `aiOrchestration` enters `BACKED_BRANCHES` and leaves the unsupported census.
- CLI gains `gateway status`, `gateway invoke` and `gateway reconcile` under command authority.
- `doctor --deep` validates the exact budget/routing identities and never prints a secret value.
- Production remains offline-safe until the Creator supplies D4 policy inputs.
- Formal Directory registration and ratification remain part of the later P2 governance ZIP.

## Acceptance

1. typecheck and production build are green;
2. the shipped policy set is strict, complete and fail-closed;
3. disabled production choreography performs zero fetches and records an honest refusal;
4. enabled isolated fixtures prove interactive and Batch paths, bounded I/O, typed failures,
   exact cost accounting, cadence and timeout behavior;
5. a real event/projection replay reconstructs identical gateway call state;
6. schema-6 workspaces migrate to schema 7 with `gateway_calls` present;
7. Status 5.5.0 backs `aiOrchestration`, reader failure becomes `unavailable`, and the State
   Seal cross-checks accounting/readiness coherence;
8. the complete self-test suite and dashboard/component verification remain green;
9. the browser smoke reports the intended safe disabled production state without exposing a key.
