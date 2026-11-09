# CLU-E Patch 06N — Relocation fixture and P0 policy check

The Windows run for commit `2b4197871910b0cc057b4d6dddf4e99a7be05fd3` verified the source and extracted builds and all 798 files. It recorded 894 passing selftests, 16 skips and one failure. The remaining self-target test had already passed relocation, candidate proof and lease reuse before its last assertion.

- Give the relocation authority test a real change to the target profile's name. The previous fixture rewrote identical bytes and correctly reached the earlier no-change refusal. The revised fixture requires the specific relocation authority refusal and reports the actual stage and reason on failure.
- Validate the active gateway's budget and routing policy with the engine's existing validators. A portable run of the exact 06M archive reproduced a separate P0 failure caused by an assertion that expected the gateway to be disabled. The current governed configuration enables it. P0 checks those local policy inputs without a credential check or provider request.

The focused portable proof check exercised both the real-change and no-change paths. The formal launcher still requires the full native proof suite, Project Profiles acceptance and P0 on Windows.
