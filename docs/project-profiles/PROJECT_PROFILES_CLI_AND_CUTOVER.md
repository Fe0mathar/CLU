# CLU-E Project Profiles CLI and Configuration-v3 Cutover

## Operating rule

Do not edit the profile registry, profile record, active pointer, workspace identity or
`config/project-profiles.yaml` by hand. Use the typed CLI so generation checks, atomic writes,
events and rollback remain intact.

## Safe preparation sequence

After all implementation batches are installed and the Windows preflight is green:

```text
1. clue project migrate-legacy --confirmation "MIGRATE LEGACY ACTIVE TARGET"
2. inspect the returned Project Profile and exact next-step phrase
3. clue project validate <projectId>
4. clue project adopt-legacy <projectId> --confirmation "ADOPT LEGACY WORKSPACE ..."
5. run the explicit Host/Git/Chrome/GPT readiness commands as required
6. clue project cutover-v3 <projectId> --confirmation "CUTOVER ..."
7. restart and verify `clue project active`
```

Migration, workspace adoption and startup cutover are deliberately separate. A profile may be
created and reviewed without claiming ownership of an existing workspace, and a workspace may be
adopted without changing startup authority.

## Rollback

```text
clue project rollback-v3 --confirmation "DISABLE PROJECT PROFILE STARTUP"
```

This restores configuration-v2 startup selection by removing the selector only. Profile records,
registry history, workspace identity and the byte-exact configuration backup remain available for
inspection and a later governed cutover.

## Credential handling

Do not put `OPENAI_API_KEY` bytes into a JSON profile draft or command argument. Configure the OS
environment/credential store separately and bind only its reference in the profile.
