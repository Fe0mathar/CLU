# CLU-E Patch 05N2 — WFP drop attribution

## Why

The 05N1 run on Windows build 26200.9711 read back sublayer weight 65534 after requesting 65535. Verification stopped with `WFP_SUBLAYER_WEIGHT_0x0000FFFE` before releasing the filtered workload. Independent cleanup reported success. The MXC control reached bind in all four cases and later failed to deliver loopback traffic.

## Changes

- Request sublayer weight 65534 and require an exact native readback. Record the verified weight and six runtime filter IDs. Keep the token identity, gate, exact filter verification, dynamic lifetime and independent cleanup checks.
- Compare the bind outcomes for IPv4 and IPv6 over TCP and UDP. Count matching WFP classify-drop events from the already available Windows event stream. An attributed bind requires the exact resource-assignment filter ID, loopback address and protocol.
- When the WFP stream cannot attribute every bind, look for already recorded Security event 5159 with the same bind filter ID, address and protocol within the filtered run's time window. Observation reads existing Windows telemetry with existing audit and collection settings. The JSON contains counts and the ephemeral filter IDs.
- Report whether the bind contrast and attribution were complete, partial or unproven. Keep deadline cleanup evidence separate from attribution.

## Acceptance

The diagnostic supports the tested mechanism when the host loopback controls deliver, the MXC control reaches bind, the filtered fixture reports all four binds denied, `wfpAttribution.state` is `ALL_BIND_DROPS_ATTRIBUTED`, and `canaryReport.wfp.leaseLifecycle` is true. If Windows supplies no matching drop evidence, treat attribution as open and reassess the mechanism before another retry.

The diagnostic uses disposable fixtures and sets `proofAuthorization` to false. Qualification for the production proof path remains a separate step.

## Validation

The Node parser and host-control logic were exercised with portable fixtures. Live filter installation, PowerShell event queries and WFP callback delivery require the Windows run.
