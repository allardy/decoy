# Decoy — session profiles + copy-folder-path

**Date:** 2026-06-10
**Status:** Design (approved, pending spec review)

## Context

Decoy records browser sessions for reverse-engineering. Today the only session control is a
**"Reuse session"** checkbox in the start form (`src/renderer/App.tsx`):

- ON → persistent partition `persist:decoy` (logins survive across recordings)
- OFF → ephemeral partition `recording-<runId>` (clean session per run)

The user wants to keep **multiple independent logged-in sessions** — one per tool/service they're
reverse-engineering — and switch between them, instead of a single shared `persist:decoy`. This lets
them stay signed into several targets at once and test login/processes in isolation.

Separately: the per-recording row in the recordings list has an **Open folder** button. The user
routinely opens the folder only to copy its path, so we add a **Copy path** button beside it.

## Goals

1. Choose which profile (persistent session) a recording uses, create new profiles, and delete them.
2. Preserve the existing `persist:decoy` logins as an implicit **Default** profile (nothing lost).
3. One-click copy of a recording's absolute folder path.

Non-goals (YAGNI): renaming profiles, per-profile filters/settings, importing cookies, profile export.

## Model

A **profile** is a named persistent Electron session partition. A start-form selection is one of
three kinds:

| Selection                      | Partition                | Persists? | Notes                                  |
| ------------------------------ | ------------------------ | --------- | -------------------------------------- |
| **Fresh session (no profile)** | `recording-<runId>`      | No        | Reproduces the old "Reuse session OFF" |
| **Default**                    | `persist:decoy`          | Yes       | The current shared session, untouched  |
| **Custom** (e.g. "Work")       | `persist:decoy-<slug>`   | Yes       | Isolated cookies/storage per profile   |

- **Default** is implicit (not stored in the profiles list), undeletable, and always points at the
  existing `persist:decoy` constant so current logins are preserved.
- **Fresh** is not a profile — it is a special selection that yields a per-run ephemeral partition.
- The **"Reuse session" checkbox is removed**; the profile selector subsumes it.

## Data (`decoy.json` via `config-core.ts`)

`DecoyConfig` gains two fields (additive; missing → defaults, consistent with existing parsing):

```jsonc
{
  "sessionsRoot": "...",
  "urlHistory": [...],
  "filters": {...},
  "profiles": [{ "id": "work", "label": "Work" }],  // CUSTOM profiles only
  "lastProfileId": "default"                          // "fresh" | "default" | <custom id>
}
```

- `profiles` holds custom profiles only. `id` is the slug used in the partition name; `label` is the
  display name.
- `lastProfileId` remembers the last selection to pre-select it on next launch. Defaults to
  `"default"`. If it references a deleted profile, the renderer falls back to `"default"`.

### Pure helpers (in `config-core.ts`, unit-tested)

- `slugifyProfile(label): string` — lowercase, non-alphanumeric → `-`, collapse repeats, trim `-`.
- `addProfile(profiles, label): { profiles, id }` — slugify, reject empty / reserved (`default`,
  `fresh`) by throwing, dedupe `id` with a numeric suffix (`work`, `work-2`, …). Returns the new
  list and the created `id`. Label is stored as the user typed it (trimmed).
- `removeProfile(profiles, id): profiles` — returns the list without `id` (no-op if absent).

## Partition resolution (in `src/main/index.ts`)

A single helper owns the mapping, so the renderer never sees partition strings:

```
resolvePartition(profileId, runId):
  "fresh"   → `recording-${runId}`
  "default" → REUSE_PARTITION   // "persist:decoy"
  <id>      → `persist:decoy-${id}`   // only if id is a known custom profile, else treat as default
```

`index.ts` resolves the partition and passes the **resolved `partition` string** into
`createRecorderWindow`. `CreateRecorderOptions.reuseSession` is replaced by `partition: string`;
the `REUSE_PARTITION` constant stays in `window.ts` (or moves to a shared spot) for the Default case.

## IPC / bridge API

Replace `StartPayload.reuseSession: boolean` with `profileId: string`.

New IPC handlers (registered in `index.ts`, exposed via `preload/index.ts`, typed in `bridge.ts`):

| Channel                   | Args            | Returns                | Behavior                                                                 |
| ------------------------- | --------------- | ---------------------- | ------------------------------------------------------------------------ |
| `profiles:create`         | `label: string` | updated `DecoyConfig`  | `addProfile` + persist; sets `lastProfileId` to the new id.              |
| `profiles:delete`         | `id: string`    | updated `DecoyConfig`  | Block if it's the active recording's profile (throw). `removeProfile` + persist + `session.fromPartition(`persist:decoy-${id}`).clearStorageData()`. If it was `lastProfileId`, reset to `"default"`. |
| `recording:copy-path`     | `runId: string` | `{ path: string }`     | Validate `runId` (same guard as `open-folder`). `clipboard.writeText(join(sessionsRoot, runId))`. |

Profiles are read through the existing `config:get` (which now includes `profiles`/`lastProfileId`),
so no separate list endpoint is needed. `lastProfileId` is persisted on recording start (alongside
`addUrlToHistory`) and on create/delete.

## UI changes (`App.tsx` + new `ProfilesModal.tsx`)

**Start form:** remove the "Reuse session" checkbox. Add a `Profile:` `<select>`:

```
Fresh session (no profile)
Default
──────────────
Work
Personal
──────────────
Manage profiles…        ← opens ProfilesModal (does not change selection)
```

- Pre-selected from `lastProfileId`.
- A small **Manage** button next to the select also opens `ProfilesModal` (redundant entry point is
  fine; pick whichever reads cleaner during implementation).

**`ProfilesModal.tsx`** (mirrors the existing `FiltersModal.tsx` structure): lists custom profiles
with a delete (×) per row + a confirm (reuse the native `recording:confirm-delete`-style dialog or a
simple inline confirm), and a "New profile" name input + Add button. Default/Fresh are not listed
(not manageable). Closing refreshes the form's profile list.

**Recordings list:** add a **Copy path** button beside the existing **Open folder** button on each
row. On click, calls `recording:copy-path` and shows a brief "Copied" affordance (e.g. transient
label swap), matching the panel's existing lightweight feedback style.

## Edge cases

- Deleting the **active recording's** profile is blocked (throws; surfaced as a disabled button or
  error toast).
- Deleting wipes the partition's storage so a recreated same-name profile starts clean.
- `default` / `fresh` are reserved: rejected as custom profile names.
- `lastProfileId` pointing at a deleted profile → renderer falls back to `"default"`.
- Slug collision → numeric suffix.

## Testing

- **Unit (vitest, `config-core.test.ts`):** `slugifyProfile`, `addProfile` (dedupe, reserved-name
  rejection, label preservation), `removeProfile`, and `parseConfig` round-trip with the new fields
  (including missing-field defaults).
- **Manual (per project convention — GUI capture isn't unit-tested):** create a profile, log into a
  site, switch to Default and confirm isolation, delete a profile and confirm storage cleared, Copy
  path puts the correct absolute path on the clipboard.

## Files

- `src/main/config-core.ts` — schema + pure helpers (+ tests in `config-core.test.ts`)
- `src/main/config.ts` — wrappers for create/delete/lastProfileId
- `src/main/index.ts` — IPC handlers, `resolvePartition`, clipboard + clearStorageData
- `src/main/recording/window.ts` — `CreateRecorderOptions.partition` replaces `reuseSession`
- `src/preload/index.ts` — bridge methods
- `src/renderer/bridge.ts` — `StartPayload.profileId`, `DecoyConfig` fields, new methods
- `src/renderer/App.tsx` — profile `<select>` + Manage + Copy path button
- `src/renderer/ProfilesModal.tsx` — new (create + delete)
