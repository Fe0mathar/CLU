# Operational Console Integration

## Open one writer in the daemon

```ts
import { OperationalConsoleRuntime } from './observability/operationalConsole/index.js';

const consoleRuntime = new OperationalConsoleRuntime({
  workspaceRoot: runtime.workspaceRoot,
});
```

Close it during daemon shutdown.

## Restricted PowerShell host

The included `hostClient.ts` patch adds:

```ts
operationalConsole?: OperationalConsoleRecorder
```

Pass `consoleRuntime.recorder` when creating the client.

## Chrome/CDP

The included `browserAgent.ts` patch adds the same optional recorder to `AttachOptions`.

## Other transports

Use:

```ts
mirrorOperation(recorder, spec)
```

The operation must provide exact request serialization and exact response serialization.

## Read-only UI server

```powershell
npm run console:serve
```

or construct `OperationalConsoleServer` in the daemon.

## Dashboard embedding

The custom element is:

```html
<clue-operational-console endpoint="http://127.0.0.1:47833"></clue-operational-console>
```

In the final four-quadrant Dashboard, size it to the Operational Console quadrant. The component remains usable as a full-screen diagnostic view.
