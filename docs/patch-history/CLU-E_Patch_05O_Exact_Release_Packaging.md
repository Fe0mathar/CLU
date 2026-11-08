# CLU-E Patch 05O — Exact release packaging

## Why

The independent P2 audit found three package defects on the 05N2 checkout. The release ZIP included the machine-local Project Profiles selector and legacy configuration backups. It omitted two Windows launchers and two operator input templates. The working copy of `MANIFEST.txt` used CRLF while its committed Git blob used LF, so the exact archive binder refused the package even when Git status was clean.

The packaging defect was reproduced on a checkout reconstructed through 05N4. The structural release run reported `archiveBound: false` and named `MANIFEST.txt` as the first mismatch.

## Changes

- The release builder explicitly excludes `config/project-profiles.yaml` and generated `config/backups/clue.config.v2.*.yaml` files. Their installed originals stay outside the release ZIP.
- The archive requires `CLUE-Windows-Supervisor.bat`, `CLUE-Windows-WFP-Diagnostic.bat`, `governed-document.operator-input.template.json` and `project-profile.operator-input.template.json`.
- A scoped Git attribute pins `MANIFEST.txt` to LF on checkout. The installer accepts the known LF and CRLF representations only when the exact LF payload matches the existing Git `HEAD` and index blob. It normalizes the working copy to that LF representation. The archive binder continues comparing each archived entry’s raw bytes to its tracked blob.
- The packaging tests cover local files present on the host, required operator file membership, exact Git binding, and checkout line-ending drift.
- Tests of shipped configuration use the existing legacy configuration loader to avoid reading an installed profile selector. A dedicated regression verifies that normal runtime startup still refuses a foreign registry path.

## Acceptance

Run the structural packaging command on the target Windows checkout and retain the final report with `verdict: UNGATED`, `tree.dirty: false` and `tree.archiveBound: true`. The ZIP must contain all four operator inputs and exclude the machine-local selector and backups. Both documentation seals must verify. Run the full Windows gate for a future `RELEASE` verdict.

The supervisor’s guardian-loss and exact-filter attribution qualification remain separate. Formal P2 closure still requires a governed self-improvement cycle and Creator approval.
