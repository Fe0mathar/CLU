# CLU-E Patch 06H1

06H stopped at `QUALIFY_CANARY_SOURCE_UNVERIFIED`, before the native canaries ran. The original code grouped several source validation failures under that result.

06H1 supplies a byte-identical copy of the approved 05N2 qualifier alongside the existing tool. The launcher locks that copy for reading and verifies its raw SHA-256 against the exact LF or CRLF form. It reports distinct codes for path, open, size, read and digest failures.

The qualifier retains all seven existing checks. The qualification still uses the 06G2 supervisor named in the exact admission report.
