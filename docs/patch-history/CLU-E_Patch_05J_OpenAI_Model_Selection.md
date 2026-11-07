# CLU-E Patch 05J — OpenAI model selection

**Applies to** the CLU-E tree through Patch 05I. Apply the archive as a complete overlay.

## What changed

| Scope | Change | Reason |
|---|---|---|
| Saved Project Profile | The GPT configuration loads OpenAI's model catalogue using the selected saved profile's credential. The model picker edits the profile draft. Save persists the exact model ID. | The available IDs depend on the API project and credential. The browser receives model IDs and status only. |
| Profile-bound runtime | The selected exact ID is used in enabled routes under the installation's OpenAI Platform budget policy. Task lanes, limits and approval boundaries remain in force. | The choice must apply to readiness and execution without silent model substitution. |
| Legacy `clu` P2 | ADR-0020 proposes the explicit `gpt-5.6-sol` ID for every legacy route. The D4 policy, setup check, preflight and v9 candidate seal agree. | The original `gpt-5.6` lookup returned HTTP 404. The key's model catalogue included `gpt-5.6-sol`. |

The candidate pack remains at v9 release `9.0`. Its document revisions and seal reflect the proposed amendment. The deferred v10 pack and previous evidence retain their original bytes and identities. Creator ratification remains an interactive act. A changed authority basis requires a new current evidence epoch before formal P2 proof.

## Install and verify

1. Stop the dashboard and any proof or benchmark. Review the legacy model proposal, then extract the ZIP contents directly into `F:\CLU\CLU`. Review and commit the patch files to preserve a clean Git baseline. Preserve the archive's exact line endings on sealed documents.
2. Run `CLUE-Windows-Setup.bat` for legacy `clu`. Enter the key only in the masked local prompt. The gateway report should show `state: PASS`, matching requested and effective `gpt-5.6-sol`, and `fallbackUsed: false`. This is a live model metadata check. Actual inference has its own exact response identity check.
3. Open **Configuration → GPT API Key** in a saved profile. Use the profile's key or its configured inherited reference. Click **Load Available Models**, select the exact ID, save, and click **Test Connection**. The list shows supported GPT text model IDs returned for this credential, including the eight IDs observed in the diagnostic. Catalogue visibility and connection verification are separate. The saved choice takes effect for execution when that profile generation is active.
4. Retain the two generated Windows readiness and legacy gateway JSON reports outside the checkout. The separately supplied and qualified native Windows supervisor is still required for proof. Follow the [P2 closure runbook](../p2/P2_CLOSURE_RUNBOOK.md) for release freeze, ratification and the evidence epoch.

## Verification

TypeScript build, portable Project Profiles acceptance, 182 dashboard tests, focused catalogue/readiness/closure tests and both documentation seals passed. A mocked provider integration also exercised exact-model inference using a scratch SQLite compatibility hook. Live OpenAI access and the normal Windows-native runtime remain to be verified on the installation host.

## Rollback

Restore the entire 05I file set from Git and remove the additions listed below. Keep saved profile changes and external evidence. If reverting a selected profile model as well, choose its previous exact ID and save that profile explicitly.

## File inventory

| Project-relative path | Action | Before SHA-256 | After SHA-256 |
|---|---|---|---|
| `CLUE_AI_Utilization_v9.md` | Replaced | `f4235bfc4803bdcd69fb88ba90e24166625767de53c0b7372ab71aefb9dc928b` | `89c71e65ea9b465050d56e65226246dfb6a80d7e8a1d9c6c3af54c66bcedf578` |
| `CLUE_Interface_Design_v9.md` | Replaced | `a0645082b46ffba34e2e4cd579d9e0b612f5f9c6829b06cb533e51e0bef9df37` | `fbf73e1fc9de85338982135edfa2a9d78d90c7e871df06180530fb2c42d51ab8` |
| `DOCUMENTATION_GOVERNANCE_v9.md` | Replaced | `33047a84d009fdd703f93bd50a1b4445ffd2072b5b84b13e5c7e79e4344b0408` | `a6e36d8317fe2cd67bc8986e6edc63c74a490d7ee239f562f5a6e3f4d78092ce` |
| `DOCUMENTATION_MANIFEST_v9.json` | Replaced | `1518e6afa3ac1bc3edabfc3346dcc0354e775a10998f6f8c00a3d4a108aca185` | `ec027cb591415a65c6e83e0c9f137706005b8c62f468a1fc72f289cf087e2322` |
| `README_v9.md` | Replaced | `55d039b90b7dd152016e23aa9832b693309d6ab9dc248300ce9d266525531e6b` | `31b40d0a0aff270078c36bfb33b85077f328fc882fcaf2b5ac01cfdcffa80049` |
| `SHA256SUMS_v9.txt` | Replaced | `13f6ba045caec4871cc4cd602df0a2189b27bd23eb32cf7edfbb4f69f56b6159` | `7b62c8e3a84457f173b5bec4d63b9b417b277990d93e2949bafb5decc6e918ca` |
| `VALIDATION_REPORT_v9.md` | Replaced | `86e179bb7c300a84f588c60c79e91a579e87cd3ec1c8f5b526d9e4aa1ccbd445` | `3beab61cfb932ee84084c46ad3cf3514887517e90ebb7a099078c791037da321` |
| `config/policies/p2-closure.yaml` | Replaced | `21f4ad91b4b7cd8b4a978e939ec10b457bed0ca6aac54d13cd6d6a5f092662b5` | `9ddbc5da464151c3fc48ac704934775d1a8dfbace6c6fc952249e148609dc913` |
| `config/policies/routing.yaml` | Replaced | `239a40bdc80d6f24c9fbc56af0f5a3ed76e8f656b6a359be14e878fa9dfa948e` | `4066e2554705967f7ef7adc423100e0a3713e40915fb89e70024f3353d72402d` |
| `docs/P2_CLOSURE_RUNBOOK.md` | Replaced | `460189286c72d4ffd89b0c080166aa17651153bf476129819b93108df9d5cceb` | `53dd174d2d76d9f658a10cad55b014ccba70921332c058abc1c5116f5ca53528` |
| `docs/architecture-decisions/ADR-0020-p2-explicit-openai-sol-model.md` | Added | `—` | `c83ca4e9aa7d31d938ece48f4934c27857d531051d6b3836cbaa2d30a47c8187` |
| `docs/p2/P2_CLOSURE_CHECKLIST.md` | Replaced | `12a69c75a5ba8f325e0e58828ec1725cfcb6c32041113255af5db11a8b577282` | `1108e9d75cd8ede2d7dc94b766850db5f05053a2294578805e0f79e0cb476f42` |
| `docs/p2/P2_CLOSURE_RUNBOOK.md` | Replaced | `55724e0b7ba451c360458077f3f2246c7944d037ca58b6f6397a51f0b4d64ed5` | `80e77238b1da31759b8bbf96911e778ef791edecb471952981f23f8b74ee9ecd` |
| `selftest/gateway.test.ts` | Replaced | `71a1d15810bedf4df58da6dacb8f6a0a638850334ae314c3507b34ff51d93781` | `9cb29f076fa98c4645324284f353fa5bded5af62baf8981a72e617bd40866284` |
| `selftest/p2-closure-assessment.test.ts` | Replaced | `21e01a232c91e26ed37c9cd65fcc0bd77c0aab0a6e963829305c19a4f48139c9` | `ddbef99977ffd22aa287d91c81b9d2a455b4db52d84c1780642d3603463a48b7` |
| `selftest/project-gateway-readiness.test.ts` | Replaced | `c5d5734d5b9a80721be974f4c36be68772bc250d89722ca5eeeeec5cae6dd686` | `116e019e49ddd32051991d1ef9725710b557f15ba6996883a71c232fec21eb56` |
| `selftest/project-gpt-model-catalogue.test.ts` | Added | `—` | `1450f8d137238d3b5222ce0ce437ccb223513f7706a8922426e34380470b4176` |
| `src/ai/gateway/modelGateway.ts` | Replaced | `56e0e1787b58c22ca8e6b38420ec5a439050de4a6cc743a30540600324b92fd3` | `28e0f45614b7d7c7e82be1b030d750a8fa68a799444119c0b83463f99665efb2` |
| `src/ai/gateway/openaiAdapter.ts` | Replaced | `0a4e6de4fa36b9a9e47356c609db4aeb45a43cf306460e7e240cbca1e47de0a8` | `c4ba7bafa233d63e5006e9154871a36ffbad9d2a17cdfc7eed378ac0d83c519f` |
| `src/ai/gateway/openaiModelCatalogue.ts` | Added | `—` | `052e94ceca75bb4dfe2bf276c75b8057e40b7b2cab977e90473d1420c4c49624` |
| `src/ai/gateway/policy.ts` | Replaced | `24d9166a98783f621d8f3d22b7a2e7cf6bfd9bb65c563f8d3aa28eb37b522435` | `56022f1d859d0dd2a2bfb1bbf9e3d1e29fec0295f87baf9ce82afad5ba12c8bf` |
| `src/closure/p2ClosureAssessment.ts` | Replaced | `98a087964beb6df6658cbf9eac029ed6fe95749e3251568bd071c2748dea7c0c` | `1a7bc37cb2cd5fa8cca1c7ecd13b3f07ee555129364a0e1fd91256c21699d0e5` |
| `src/control/p2ClosurePolicy.ts` | Replaced | `fe62b0aedc6af29230cd37a5005103933d045f39456189cdffe4693cc80b7fff` | `0c2125ed4d1072d3aa249669ce20ebfcc182a87b78981996c916867869b43be5` |
| `src/control/projectProfiles/gatewayReadiness.ts` | Replaced | `5bdd3230f1a57ab52e63d76f6c9e1c5518a2a1512d100f0c2cb0426d6e7001b8` | `b092f4f2c07e5418daa7b0fdbaf17ec3293479ecb2330f24f0a5913de226222c` |
| `src/daemon/projectProfilesApi.ts` | Replaced | `e31e9769a99be79ce60a158dc4e1fe47a980125136b7552506985f138f7e846d` | `b686175ea5798b629f9403619f192d70c01209eecb243217b94e038edddf766a` |
| `templates/p2-closure/P2_CLOSURE_CONTEXT.template.json` | Replaced | `da9f8e55cb12e0e9628465bded06e326533ba54da7e09e7093f90d9b953f335d` | `9e6de35f0d0ac2e34551658a096fde51a9e1433b0bfb5ff2024a40a51f3a20b5` |
| `tools/p2-closure-preflight.mjs` | Replaced | `bf11907a6eb78d8e673938d1194fcb5af47c2d21c97c7d4b8d64df295f962a73` | `3785d4bee1aff0f5c41b9b53ca00b4d44d971618dec9f712e410b539ca04c897` |
| `tools/p2-windows-readiness-probe.mjs` | Replaced | `5e967fc0402527bac5a73d9528b5c74e0ca764f071a1f754abd25a03f708a367` | `92ee98f931134695ae8887f6ffe91261af64306045aad6bb29f74df7853812c7` |
| `tools/p2-windows-setup.mjs` | Replaced | `87e0a4e5679a614bdfd53de0174c2c0a00b1a0c75a76f95c7c9587af77046be4` | `9d3b045b8dd78ed2f0e5785de8c86f7c3f59e2668cd73011ec0b1a9d07604c96` |
| `ui/clue-dashboard/configuration/actionContracts.js` | Replaced | `1d01a46830bb70ef5bed0b6e83cd1ce53f6b13041e7284b8f309d5f7c9c231f9` | `e2ad5a0e024c31b7026813e1fb4fece6eec3b291e1badbc4466b756cc54648ec` |
| `ui/clue-dashboard/configuration/configurationPanel.js` | Replaced | `b258cfba8b6ab8d2176728fb7db49fe2e0d01d8452815956b8aaa688e4841901` | `83caf8654012e21e94f5c94ab71c3fdd95abb70454a888adcd1ee4146a82d91e` |
| `ui/clue-dashboard/configuration/configurationState.js` | Replaced | `51f094dda4fffc330b53b29cc31eaa5f1282bc4b6ab0a4b856e9d45c71f8acb1` | `45eae8ae0c25cd99dd4cee6879efc2cbea7334b78727bed2f5bcf38df1fbf8dc` |
| `ui/clue-dashboard/configuration/gatewayEditor.js` | Replaced | `8d06a86edc26a6a0861d0ca65dd5b23224c4aff14a8fe04aa7c861e0051ac75b` | `3af9ea0416c9dc6eb3095057dfcaf5d630c3f84fa07b6eaeeb475a8c29cd0b0c` |
| `ui/clue-dashboard/test/gatewayModels.test.mjs` | Added | `—` | `2eeb5b7aecf2b2d7dc5f59845fd34e1a22745cf5392ffef95665f38d2ad4e568` |

The patch-history manifest is also added. Its own hash is excluded from the table.
