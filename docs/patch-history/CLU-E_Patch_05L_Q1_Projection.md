# CLU-E Patch 05L — Q1 projection event routing

**Applies to** CLU-E through Patch 05K.

The Windows Q1 probe captured three `PROJECT_IDENTITY_MISSING` records for `node-added`, `semantic-depth`, and `discovery-complete` on `clue1`, generation 6. The committed scan and browser inventory agreed at 663 files. The bridge was passing these native Navigator notifications into the Project Profile recognition guard and the resulting refusals marked Q1 verification `bad`.

## Changes

- Remove those three subscriptions from the recognition bridge. Native Navigator notifications still reach their existing UI listeners. The recognition bridge continues to validate profile identity and reject stale or identity-free stream inputs once bound.
- Add a regression covering the real bridge with an active generation. It verifies that the three local notifications still reach UI listeners, current recognition events still update inventory, and stale and identity-free events cannot replace it.
- Pin the reviewed dashboard bytes in the Windows readiness probe under the `PATCH_05D_PLUS_05L` source baseline. It still requires an exact match for all six reviewed files.

## Apply and verify

1. Stop the dashboard process. Extract the ZIP contents into `F:\CLU\CLU` and allow replacement of the listed files.
2. Start the same profile-bound dashboard. From CMD in the project directory, the direct launch used for this installation is:

   ```cmd
   node .\dist\src\cli\index.js console dashboard --host 127.0.0.1 --port 47901
   ```

3. Open the main Dashboard at `http://127.0.0.1:47901/` and refresh the page. Let Q1 replay the existing committed graph. Switch **SURF → DIVE → SURF** and run the existing Q1 Projection Probe. This verification uses the completed scan.
4. For the observed run, expect `clue1` generation 6, run `691f7659-3005-440b-8337-7cf7b2ccbade`, 663 of 663 files, and zero projection errors. The Q1 probe should report `NO_ERRORS_RECORDED`. Review and commit the three replacements and this manifest to return to a clean Git worktree.

The regression reproduced all three errors on 05K and passed on 05L. The dashboard suite passed 183 tests and the Navigator suite passed 12 tests. TypeScript type checking passed. The Windows readiness probe matched all reviewed source hashes on the test host. The operator replay above is the remaining Windows browser acceptance check.

## File inventory and rollback

| Project-relative path | Before SHA-256 | After SHA-256 |
| --- | --- | --- |
| `ui/clue-dashboard/app.js` | `41225e60146539e6933f90cca808508bf4c6ca7397276309f666e8472746e103` | `68666bb5a835aa2fc5eb88caaf54d36e406760622d23989c0ab558ae1be657c9` |
| `ui/clue-dashboard/test/q1SurfInterface.test.mjs` | `48137d0537ad431adb77d333918e9500b1e7f96f16585d12cd9fe87a590ea2c6` | `f5ef2a35d26d024e7a3c6aff05b8d53c08988a6d58fa85bd12da1eeaeaff6fc0` |
| `tools/p2-windows-readiness-probe.mjs` | `92ee98f931134695ae8887f6ffe91261af64306045aad6bb29f74df7853812c7` | `c76acba5fdc96369a38eb59b3896efc1ab5037e6c3539ff0197887f8d651ec90` |

This manifest is added. For rollback, restore the three prior files and reload the dashboard.
