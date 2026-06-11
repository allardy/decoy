# CLAUDE.md

Guidance for Claude Code when working in this repo.

## What Decoy is

A standalone Electron app that **faithfully records browser sessions** via the Chrome
DevTools Protocol, so a downstream LLM/agent (or replay tooling) can reverse-engineer a
site's API from the captured traffic. **Decoy only records** — no replay, codegen, or
extraction lives here. Each run is written to be self-describing (see "Output", below).

## Commands

- `pnpm dev` (or `decoy` / `.\decoy`) — electron-vite dev: builds main/preload, serves the
  renderer with HMR on an **ephemeral port**, and launches Electron with the renderer URL
  injected via `ELECTRON_RENDERER_URL`. One command.
- `pnpm build` — `electron-vite build` (bundles main + preloads + renderer to `out/`).
- `pnpm package` — `build` + electron-builder → installer in `release/`.
- `pnpm test` — Vitest (pure-logic units). `pnpm check` (format + lint + typecheck) / `pnpm fix`.

**Verify before claiming done:** `pnpm check`, `pnpm test`. The GUI capture behaviour can't be
unit-tested — verify it by building (`pnpm package`) and recording (checklist in README).

## Architecture

Bundled by **electron-vite** (`electron.vite.config.ts`) into `out/{main,preload,renderer}` —
no runtime transpiler; `package.json` `main` is `out/main/index.js`.

- `src/main/index.ts` — main process. Imports the **TypeScript engine in `src/main/` directly**
  (bundled at build time). Owns windows, UA/client-hints spoof, IPC. In dev it loads
  `ELECTRON_RENDERER_URL`; packaged it `loadFile`s `out/renderer/index.html`.
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
- `src/renderer/` — React control panel (lean: no component lib, no RPC; `bridge.ts` types the
  preload `window.decoy`) + `recorder-toolbar/index.html` (the REC/Pause/Stop toolbar, a static
  second renderer entry).
- `src/preload/{index,popup,toolbar}.ts` — control-panel bridge, UA-data spoof for the recorded
  site, and the toolbar bridge. Built to `out/preload/*.mjs` (ESM → loaded with `sandbox:false`);
  referenced from main via `import.meta.dirname`.

In a **packaged** build there is no server: the renderer is prebuilt to `out/renderer/` and
loaded via `loadFile`, and the whole app is plain JS in `out/` — the asar carries no
node_modules and nothing is transpiled or spawned at runtime. `session-guide.md` is inlined
into the main bundle via `?raw`.

## Profiles & login

A **profile** is the persistent Electron session partition a recording runs in
(`src/main/config-core.ts`): `Default` (`persist:decoy`), a custom one (`persist:decoy-<id>`), or
`Fresh` (a throwaway per-run partition). The start-form selector + `ProfilesModal` manage them.

**Chrome-login escape hatch** (`src/main/chrome-login.ts`): Google (and similar) reject sign-in both
inside the embedded `WebContentsView` **and** on any Chrome with a remote-debugging port open ("this
browser or app may not be secure") — spoofing the UA doesn't help; the debug surface is the tell. So
a profile can set **`chromeLogin: true`** (per-profile toggle in `ProfilesModal`; `defaultChromeLogin`
for the built-in Default). Login then happens in the user's **real Chrome** against a persistent,
per-profile `--user-data-dir` at `userData/chrome-login/<partition-slug>`, in two passes:

1. **Login** — Chrome launches with **no** debug port (Google allows the sign-in); the user signs in
   by hand (incl. MFA / security key).
2. **Harvest** — when they close that window, the same profile relaunches **headless with** a debug
   port (it opens `about:blank`, never a Google page, so the block doesn't fire) and mirrors its
   cookies into the Electron partition via CDP `Storage.getCookies`.

Recording itself **always happens in the webview** — Chrome is only the auth escape hatch. The
`Log in (Chrome)` button shows only when the selected profile is chrome-login; re-selecting the
profile reopens the same already-logged-in Chrome dir (re-auth on demand). `recording:start` blocks a
chrome-login profile that has never been logged in.

**Caveat:** only **persistent** cookies survive the harvest — Chrome doesn't persist session-only
cookies, and `localStorage`/token auth isn't carried at all. Fine for cookie-session sites (e.g.
Airbnb); insufficient for token-auth sites. The recording's own `AGENTS.md`
(`session-guide.md` → "Is it cookie auth or token auth?") documents how to detect which a target
uses. The full fix for token-auth targets is to attach the recorder to the real Chrome instead of the
webview — a recorder-transport rewrite, not yet done.

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
`AGENTS.md` (the agent reading guide — copied from `session-guide.md`; **not** this file),
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
