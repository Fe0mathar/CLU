# ADR-0020 — Explicit OpenAI Sol model for P2

**Status** Candidate pending Creator ratification  
**Date** 2026-11-07  
**Owner** AI Utilization and legacy P2 Model Gateway

## Proposed decision

Use the exact API model ID `gpt-5.6-sol` for all enabled legacy P2 routes. ADR-0017 originally
recorded `gpt-5.6`. OpenAI describes that ID as an alias that routes requests to `gpt-5.6-sol`.
The explicit ID keeps the route, authenticated provider model lookup and response identity check
on the same model name. The gateway refuses model substitution.

The v9 AI Utilization contract owns the identity. Routing and the P2 closure decision use the same
ID. OpenAI Platform retains budget authority and the existing provider-pause and token-reporting
rules apply. A saved Project Profile retains its own model selection and generation. The model
picker saves an explicit selection, and runtime readiness checks it against routing.

## Acceptance sequence

1. Verify the v9 manifest and seal and verify the separate deferred v10 seal.
2. Build and run the model, routing and closure policy regression checks.
3. Verify provider access to `gpt-5.6-sol` with the intended key. Preserve exact response identity on actual inference.
4. After freezing the release inputs, ratify the installed v9 pack interactively and seal a current `P2-authoritative` epoch.

Prior proof and authority records retain their original identities. The candidate documentation
records the proposed amendment. Creator ratification records the decision on the installed pack.

[OpenAI GPT-5.6 Sol API model documentation](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
