# Limitations and Next Steps

This is an initial implementation, not the completed CLU-E Dashboard.

## Implemented now

- exact redacted transport mirroring;
- PowerShell host and CDP integration patches;
- event store, projection, server, WebGPU/DOM console, demo, tests.

## Requires future operational systems

- GPT Gateway integration;
- Benchmark/Proof Engine integration;
- Custodian and Great Book integration;
- CLU-E Status JSON endpoint and button handler;
- dashboard shell integration;
- durable retention/rotation policy;
- syntax-highlighting tokenizer beyond format labels;
- WebGPU target-host visual calibration and device-loss recovery policy;
- accessibility review and keyboard navigation.

## Performance

The current server rereads the bounded NDJSON stream while polling. This is acceptable for initial use. Before high-volume production traffic, add an indexed tail reader and governed retention/rotation.

## Security

The redactor is defense in depth, not permission to send secrets unnecessarily. Transport payloads should exclude secrets by construction whenever possible.
