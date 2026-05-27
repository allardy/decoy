# CLAUDE.md

Guidance for Claude Code when working in this repo.

## What Decoy is

A standalone Electron app that **faithfully records browser sessions** via the Chrome
DevTools Protocol, so a downstream LLM/agent (or replay tooling) can reverse-engineer a
site's API from the captured traffic. **Decoy only records** — no replay, codegen, or
extraction lives here. Each run is written to be self-describing (see "Output", below).

## Commands

- `pnpm electron:dev` (or `decoy` / `.\decoy`) — dev: **the main process spawns Vite itself**
  and loads the app once it's reachable. One command; don't run Vite separately.
- `pnpm dev` — Vite renderer only (port 5273), rarely needed alone.
- `pnpm build` — `tsc --noEmit && vite build`. `pnpm dist` — electron-builder package.
- `pnpm test` — Vitest (pure-logic units). `pnpm check` / `pnpm fix` — oxlint + oxfmt.

**Verify before claiming done:** `pnpm exec tsc --noEmit`, `pnpm test`, `pnpm check`. The
GUI capture behaviour can't be unit-tested — verify it by recording (checklist in README).

## Architecture

- `electron.mjs` — main process (plain JS). Uses `tsx/esm/api` `register()` to import the
  **TypeScript engine in `src/main/` directly** at runtime (dev and packaged). Owns windows,
  UA/client-hints spoof, IPC, and spawns Vite in dev.
- `src/main/recording/` — the engine:
  - `recorder.ts` — **multi-target CDP recorder** (the core). Attaches to the site view +
    popups; `Target.setAutoAttach({flatten:true})` surfaces iframes/workers/service-workers
    as child sessions (route events by `sessionId`; pass the owning `sessionId` to
    `getResponseBody`/`getRequestPostData`). Captures wire headers (extra-info), WebSocket
    frames, SSE/streamed bodies, redirects, screenshots, cookies, storage. Has a `paused`
    gate and a DevTools handoff.
  - `window.ts` — `BaseWindow` + dual `WebContentsView` (toolbar + site), popup capture, F12.
  - `filters.ts` (skip-lists + `shouldCapture`), `naming.ts`, `storage.ts`, `har.ts`,
    `graphql.ts`, `nextjs.ts`, `types.ts` (the schema), `session-guide.md`.
- `src/main/config-core.ts` (pure, tested) + `config.ts` (Electron wrapper) — `decoy.json` in
  userData: `{ sessionsRoot, urlHistory, filters }`.
- `src/ui/` — React control panel (lean: no component lib, no RPC). `bridge.ts` types the
  preload `window.decoy`.
- `preload.cjs` (control panel), `popup-preload.cjs` (UA-data spoof for the recorded site),
  `public/recorder-toolbar/` (the REC/Pause/Stop toolbar).

In a **packaged** build there is no server: the renderer is prebuilt to `dist/` and loaded via
`loadFile`. `build.files` must include `src/main/**/*` (incl. `session-guide.md`) so tsx can
load the engine, and `asarUnpack` node_modules so esbuild's binary runs.

## Conventions (enforced — see `.oxlintrc.json` / `.oxfmtrc.json`)

- **No semicolons, single quotes, printWidth 120, sorted imports** (oxfmt). Run `pnpm fix`.
- oxlint: `curly` required (always brace `if`), `eqeqeq`, `no-var`, **`no-duplicate-imports`**
  (merge a value import and `import type` from the same module into one, using inline
  `type` modifiers), and `@stylistic/padding-line-between-statements` (blank line around
  `return`, after declarations, around control-flow). The formatter and linter coexist.
- `src/main/**` imports use **`.js` extensions** (ESM/tsx convention even for `.ts`); the
  renderer uses extensionless imports.
- **Boolean flags:** thread one positively-named flag end-to-end (e.g. `autoRecord`); negate
  once at the boundary (`paused = !autoRecord`). Don't introduce inverted parallel names.

## Output schema (`src/main/recording/types.ts`) — additive-only

A run is `<sessionsRoot>/<runId>/` (`runId` = `YYYY-MM-DD_HHhMM_<label-slug>`):
`CLAUDE.md` (the agent reading guide — copied from `session-guide.md`; **not** this file),
`summary.md`, `manifest.json`, `network.jsonl` (index + pause/resume markers),
`navigation.jsonl`, `session.har`, `cookies.json`, `storage.json`, `requests/`, `websockets/`,
`screenshots/`.

**Treat the schema as additive:** new fields are optional so older readers and existing runs
stay valid. The per-request record carries `context` (kind/pageUrl/pageTitle/sessionId), the
app and wire headers, cookies, `graphqlOperation`, `nextAction` (Next.js Server Action id), the
body (with `bodyNote` explaining empties), bytes/sha256, and timing.

## Gotchas

- One debugger per `webContents`: opening DevTools conflicts with the recorder's debugger, so
  F12 calls `recorder.suspendForDevTools(wc)` before `openDevTools` and resumes on
  `devtools-closed`. Don't attach a second debugger.
- When paused, `Network.*` events are dropped (Target.\* still handled) so exploratory clicking
  isn't recorded; resuming writes a marker to `network.jsonl`.
- GraphQL/Next-Action are extracted into dedicated, unit-tested modules (`graphql.ts`,
  `nextjs.ts`) and surfaced on the record + `network.jsonl` + filename. Mirror that pattern for
  any new "what is this request" hint.

## Design doc

`docs/superpowers/specs/2026-05-26-decoy-session-recorder-design.md`.
