# Mossbridge Memory Portability

Status: first-version same-format data export/import.

This path is for validating an existing Mossbridge/Home-shaped memory warehouse
inside a fresh Mossbridge deployment. It copies memory data into a portable
bundle, then imports that bundle into a separate `MOSSBRIDGE_DATA_ROOT`.

It does not copy WeChat accounts, QR login state, runtime sessions, context
tokens, control ledgers, credentials, OAuth material, or private external
executors.

## What Moves

Default export includes the local brain data that Mossbridge can use directly:

- warm memory
- ongoing tracks and archive
- notebook / 小事记
- observation journal
- episode journal
- case index
- solitude journal
- memory tree, truth layer, and memory versions
- stickers under `storage/stickers`
- conversation cache and hot context
- wakeup and pending calendar cache

Deferred or operational layers are opt-in:

- `--include-deferred`: Notion staging, app daily captures, raw transcript caches
- `--include-operational`: dreaming mutation logs

For a clean WeChat validation, prefer the default export first. It brings enough
memory material for recall, dreaming source records, wakeups, and sticker tools
without carrying old runtime state.

## Export

Export from an existing same-format data root:

```bash
npm run memory:export -- \
  --source-data-root /absolute/path/to/HomeOrMossbridgeData \
  --out /private/tmp/mossbridge-memory-bundle \
  --replace-output \
  --source-user-id owner \
  --source-realm-id default \
  --source-agent-id moss
```

If the source identity is already visible in the data paths and JSON records, the
exporter also reports detected ids. Passing `--source-*` is still recommended for
private migrations because it makes identity remapping explicit.

If the source deployment kept stickers outside its data root, add:

```bash
--source-stickers-dir /absolute/path/to/stickers
```

The exporter will place that catalog into the bundle as `storage/stickers`, which
is the standard Mossbridge data-root location.

## Dry-Run Import

Point the target at a fresh Mossbridge state/data pair:

```bash
MOSSBRIDGE_STATE_DIR=/private/tmp/mossbridge-wechat-state \
MOSSBRIDGE_DATA_ROOT=/private/tmp/mossbridge-wechat-data \
MOSSBRIDGE_WORKSPACE_ROOT=/private/tmp/mossbridge-wechat-workspace \
npm run memory:import -- \
  --bundle /private/tmp/mossbridge-memory-bundle
```

The `/private/tmp` paths above are disposable migration-smoke paths. For an
ongoing QR deployment or any service install/takeover, choose persistent target
paths first.

Import is dry-run by default. The output shows:

- source identity
- target identity
- identity mapping
- replace roots
- planned file count
- conflicts

## Apply Import

Only apply into an isolated target data root:

```bash
MOSSBRIDGE_STATE_DIR=/private/tmp/mossbridge-wechat-state \
MOSSBRIDGE_DATA_ROOT=/private/tmp/mossbridge-wechat-data \
MOSSBRIDGE_WORKSPACE_ROOT=/private/tmp/mossbridge-wechat-workspace \
npm run memory:import -- \
  --bundle /private/tmp/mossbridge-memory-bundle \
  --apply \
  --replace
```

`--replace` removes only the bundle-owned memory paths in the target data root
before copying. It should not be used on a stable personal warehouse unless the
operator intentionally wants to replace those layers.

Target identity defaults to the current Mossbridge env:

```dotenv
MOSSBRIDGE_IDENTITY_USER_ID=owner
MOSSBRIDGE_IDENTITY_REALM_ID=default
MOSSBRIDGE_IDENTITY_AGENT_ID=moss
```

The importer rewrites same-format identity fields and scoped path names so the
fresh Mossbridge runtime can recall the imported data through its configured
identity. This is the check that the user information is externalized enough:
if a migrated bundle recalls under a new target identity, the brain is no longer
secretly coupled to one private Home path.

## After Import

Run local checks against the imported target:

```bash
MOSSBRIDGE_STATE_DIR=/private/tmp/mossbridge-wechat-state \
MOSSBRIDGE_DATA_ROOT=/private/tmp/mossbridge-wechat-data \
MOSSBRIDGE_WORKSPACE_ROOT=/private/tmp/mossbridge-wechat-workspace \
npm run smoke:memory-empty

MOSSBRIDGE_STATE_DIR=/private/tmp/mossbridge-wechat-state \
MOSSBRIDGE_DATA_ROOT=/private/tmp/mossbridge-wechat-data \
MOSSBRIDGE_WORKSPACE_ROOT=/private/tmp/mossbridge-wechat-workspace \
npm run smoke:memory-chain
```

Then start QR/WeChat validation only from the isolated target state/data pair.
For disposable validation, the `/private/tmp` target can be deleted afterwards;
for ongoing use, apply the bundle to persistent target paths before QR login or
service install.
The test goal is:

- WeChat bind and first Codex-backed reply work.
- Imported warm/ongoing/case/episode data can be recalled.
- Dreaming can use imported conversation cache as source material.
- Wakeups carry short identity and memory context.
- Sticker tools can see the imported catalog.

Do not point this validation at a live private state dir or a mother memory
warehouse. The bundle is the copy boundary.
