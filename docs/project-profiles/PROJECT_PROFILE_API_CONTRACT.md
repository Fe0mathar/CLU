# CLU-E Project Profiles — Backend API Contract

**Document class:** forward contract for the Backend API batch  
**Status:** normative HTTP design; Batch 2 internal activation/runtime contract implemented, endpoints remain pending  
**Authority:** backend, never browser form state

## 1. Scope and versioning

The API controls versioned `clue-project-profile/1` records. Batch 1 implements the schemas, store and registry used by this contract. A later batch must expose the routes without weakening any server-side invariant.

All JSON request/response objects are strict. Unknown fields are rejected. Mutations use optimistic concurrency and must never silently normalize or rename an existing Project ID.

## 2. Identity envelope

Project-scoped operations carry or resolve the canonical governed identity:

```json
{
  "projectId": "clu",
  "targetRootIdentity": "path:v1:win32:<sha256>",
  "projectProfileHash": "profile:v1:<sha256>"
}
```

A stale or mismatched envelope fails before the requested operation runs. Important later commands may extend this object but must not redefine these three fields.

## 3. Credential policy

Requests may submit only credential references. Responses return at most the reference and readiness metadata; they never return secret bytes. Example:

```json
{
  "source": "project-override",
  "defaultKey": "gateway.credential",
  "value": "env:OPENAI_API_KEY"
}
```

A raw key, authorization header, password, cookie, private key or token is rejected and must not enter logs, events, Great Book or evidence.

## 4. Resource routes

### `GET /api/projects`

Returns metadata only and must not open every target workspace:

```json
{
  "profiles": [
    {
      "projectId": "clu",
      "displayName": "CLU-E",
      "targetRoot": "F:/CLU/CLU",
      "targetRootIdentity": "path:v1:win32:<sha256>",
      "projectProfileHash": "profile:v1:<sha256>",
      "generation": 1,
      "updatedAt": "2026-08-14T12:00:00.000Z",
      "profilePath": "profiles/clu.json"
    }
  ],
  "activeProjectId": "clu"
}
```

### `GET /api/projects/:id`

Returns the exact canonical profile record and its generation/hash. It does not resolve secrets or return transient process handles.

### `POST /api/projects`

Request:

```json
{
  "profile": { "profileVersion": "clue-project-profile/1" },
  "actor": "creator",
  "reason": "register target"
}
```

The complete profile is required. Server canonicalizes, validates physical path authority, checks Project ID and Target Root uniqueness, computes the hash, creates generation 1, updates the registry and appends evidence through one recoverable transaction.

### `PUT /api/projects/:id`

Request:

```json
{
  "expectedGeneration": 3,
  "profile": { "profileVersion": "clue-project-profile/1" },
  "actor": "creator",
  "reason": "update benchmark binding"
}
```

Path `:id` must equal `profile.projectId`. A generation conflict returns the current generation; it never overwrites.

### `DELETE /api/projects/:id`

Request:

```json
{
  "expectedGeneration": 3,
  "confirmationProjectId": "clu",
  "actor": "creator",
  "reason": "remove profile registration"
}
```

Deletes only CLU-E-owned profile registration data. It never deletes the target repository or project workspace.

### `POST /api/projects/:id/activate`

Request includes actor/reason and, once runtime switching exists, the current operation identity or expected registry generation. Activation is an atomic runtime transition through `ProjectRuntimeManager`; a direct `active.json` mutation is detected as a contradiction and is not sufficient to publish runtime state. The HTTP route remains assigned to the Backend API batch.

### `POST /api/projects/:id/validate`

Returns structural, physical-path, authority and operation-specific findings. Validation failure is durable evidence but does not mutate profile generation unless the Creator saves a changed profile.

### Integration/readiness routes

```text
POST /api/projects/:id/test-host
POST /api/projects/:id/test-git
POST /api/projects/:id/test-chrome
POST /api/projects/:id/test-gpt
GET  /api/projects/:id/readiness
```

These routes belong to later batches. Each test must bind the exact project identity and expose a sanitized result. `NO_REMOTE_YET` must be represented as valid local-only capability state, not as an invalid profile.

## 5. Error contract

Recommended stable codes include:

```text
PROJECT_ALREADY_REGISTERED
PROJECT_NOT_REGISTERED
TARGET_ROOT_ALREADY_REGISTERED
PROFILE_GENERATION_CONFLICT
PROFILE_PATH_AUTHORITY_INVALID
PROFILE_SCHEMA_INCOMPATIBLE
PROFILE_HASH_MISMATCH
PROJECT_OPERATION_IDENTITY_MISMATCH
REGISTRY_INCONSISTENT
REGISTRY_LOCKED
AUTHORITY_CHANGED
AUTHORITY_CONFLICT
SECRET_MATERIAL_FORBIDDEN
DELETE_CONFIRMATION_REQUIRED
```

`TARGET_ROOT_ALREADY_REGISTERED` must name the existing Project ID. Errors may include safe field paths and current generations/hashes, but never secret-bearing request fragments.

## 6. Mutation response

A successful mutation returns the exact durable record and relevant control-plane generation:

```json
{
  "record": {
    "recordVersion": "clue-project-profile-record/1",
    "generation": 4,
    "projectProfileHash": "profile:v1:<sha256>",
    "createdAt": "...",
    "updatedAt": "...",
    "profile": {}
  },
  "registryGeneration": 9,
  "active": null
}
```

The response is emitted only after the transaction after-state cross-check succeeds. A transport failure after commit may be retried safely using generation and idempotence semantics; clients must re-read rather than assume failure means no durable change.

## 7. Frontend rule

The Configuration UI is a draft editor and control surface. It may perform convenience validation, but only backend responses establish persisted validity, uniqueness, active identity, readiness and profile hash.
