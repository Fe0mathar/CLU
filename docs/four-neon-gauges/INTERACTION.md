# Interaction

The custom element emits:

- `gauge-focus` with `{metricId, slot}` on click;
- `gauge-open-catalogue` with `{metricId, evidenceRef}` on double-click;
- `gauge-device-lost` if WebGPU is lost.

The Dashboard should use `gauge-focus` to focus the same metric in the Great Book Improvement Field.
