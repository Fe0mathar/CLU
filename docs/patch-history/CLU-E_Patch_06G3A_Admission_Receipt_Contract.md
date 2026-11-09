# CLU-E Patch 06G3A — Admission receipt contract

The 06G3 build report `CLU-E_WINDOWS_PRODUCTION_ADMISSION_20261109-071742-049-fdbb5adf.json` showed that the rebuilt supervisor reached protected ready state. Admission exited before launching a native fixture. The protected builder emitted `clue-proof-production-installed-image/2` with the build revision and operator PID. The admission runner still required `/1` and rejected the new receipt before checking the installed pair.

The runner now validates the six fields emitted by the 06G3 builder. It checks the revision, wrapper and engine digests, and the guardian and operator process identifiers. Setup pins the runner and includes a bounded code in the outer report when the runner rejects a preflight step before validating the installed image.

This is a launcher compatibility fix. The protected native sources and mandatory admission and qualification tests carry forward from 06G3. Apply the patch and run `CLUE-Windows-Proof-Supervisor.bat` from a regular Windows session. Setup creates a new protected session and, after admission succeeds, runs qualification against the same supervisor.
