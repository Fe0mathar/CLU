# CLU-E P1 ending patch

This archive contains the final in-tree materials required before the P1 closure ceremony:

```text
selftest/browser-agent-fetch-policy.test.ts
docs/P1_CLOSURE_LEDGER.md
tools/p1-close.ps1
```

## Install

Extract the ZIP over the CLU-E repository root with overwrite enabled. For the current installation, that root is:

```text
F:\CLU\CLU
```

## Run

From PowerShell 7 in the repository root:

```powershell
pwsh -NoProfile -File .\tools\p1-close.ps1
```

The documentation ratification step is intentionally interactive. The command prints a seal-derived phrase in this form:

```text
RATIFY <12 hexadecimal characters>
```

Type the exact phrase shown by the command.

The runner accepts a technically exact `RELEASE_CANDIDATE` when portable gates and native Windows proof pass but clean Git identity is absent. That absence is preserved in the generated receipt. To require a formal Git-backed `RELEASE` instead:

```powershell
pwsh -NoProfile -File .\tools\p1-close.ps1 -RequireFormalRelease
```

## Outputs

A successful run produces or refreshes:

```text
MANIFEST.txt
clue-status.md
p0-acceptance-report.json
release/<exact archive>.zip
release/<exact archive>.report.json
release/<exact archive>.MANIFEST.txt
release/<exact archive>.SHA256SUMS
release/<exact archive>.zip.sha256
release/P1-CLOSURE-RECEIPT.json
release/P1-CLOSURE-RECEIPT.md
```

## Boundary

The runner deliberately does not execute:

```text
clue epoch seal
clue cycle drive
clue cycle close
```

Those commands begin P2 after the final P1 package has been preserved.
