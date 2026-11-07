# Architecture

The Great Book Improvement Field is split into four layers:

1. **Metric / Great Book contracts** — metric IDs, contribution records, normalization profiles.
2. **Projection layer** — converts Great Book entries plus metric metadata into a 10×10 field projection.
3. **Transport / client layer** — loads the projection from JSON or SSE.
4. **Render / HUD layer** — WebGPU floor + bars, with DOM labels and inspectors.

The render layer never invents values. It only consumes the projection.
