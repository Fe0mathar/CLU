# CLU-E Patch 06A — Windows broker request conformance

05Z2 passed offline install, build, native SQLite, and the SCN-005 workspace check through a pinned inline bootstrap. The Windows proof broker sends direct Node and npm arguments. This patch tests representative direct requests against the native parser in the same governed diagnostic.

- The candidate submits the installed npm CLI with `run typecheck` after preparation. The baseline submits the built CLU-E CLI with `doctor --deep` after workspace initialization. Both use the existing Windows request schema and disposable roots.
- The native parser accepts only those exact direct argument vectors in the pinned governed stage. It reads the adapter from the trusted read-only root, verifies its compiled SHA-256 pin, and maps each vector to a fixed adapter operation. The adapter applies the existing scratch and resolver handling inside MXC. Altered direct arguments must be refused before the adapter starts.
- The host checks the direct operations, their filesystem markers, the source and prepared tree, and the baseline event-log receipt. Typecheck may update `dist/.tsbuildinfo`. All other prepared outputs must retain their exact identities. The report includes both direct results alongside the governed workload evidence.

The governed report keeps `proofAuthorization: false`. Full production admission and network fault qualification remain release gates. This test exercises two approved direct request forms on the regular Windows account.
