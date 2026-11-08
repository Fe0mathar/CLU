# CLU-E Patch 06D — Scoped WFP enforcement on the installed governed path

06C observed the installed governed workload. 06B3 observed policy-owner loss in a separate WFP fixture. 06D joins the installed governed path to the privileged policy boundary on a single Windows PC.

The elevated installer compiles the pinned native sources and installs a run-bound supervisor with the verified Microsoft MXC sidecar under Program Files. The elevated guardian manages one temporary, package-scoped WFP lease. The installed supervisor, MXC and the governed npm workload run from the regular Windows session. The guardian authenticates the exact installed peer and verifies the workload's Job Object and AppContainer identity before arming its policy.

The fixed direct `npm run typecheck` request pauses inside the pinned bootstrap. The same live process measures IPv4 and IPv6 TCP and UDP loopback operations before and after the lease is installed. The controller requires successful controls, verified policy readback and four access-denied results before releasing npm. It keeps the lease through the workload and verifies its removal after the job drains. The report keeps the installed image evidence and the private lifecycle receipt separate.

The protected native installation remains available as an audit anchor. The run-bound native admission pin points to the disposable workload stage. The report records stage cleanup and keeps `proofAuthorization: false`, `offHostLan: NOT_TESTED` and `bfeRestartQualified: false`. This step establishes the combined execution and policy path. Owner-loss injection in that combined path is the follow-up.
