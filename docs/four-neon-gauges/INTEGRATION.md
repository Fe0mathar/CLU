# Integration

The Dashboard receives one `FourNeonGaugesView` branch containing exactly four projections. The projector accepts an authoritative gauge branch or emits four honest UNKNOWN placeholders.

Recommended producer path:

```text
Measurement Catalogue
+ Great Book
+ normalization profiles
+ certificates
+ current scope
→ gauge projector
→ ConsoleSnapshot.dashboard.gauges
→ <clue-four-neon-gauges>
```
