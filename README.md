# Decoy

The **one master browser-session recorder**. Decoy opens a real, logged-in browser
window and faithfully records _everything_ needed to later reverse-engineer, replay, or
extract from a site's API — across the main page, popups, child windows, iframes, and
workers:

- every **request/response** with full bodies, app headers **and** on-the-wire headers
  (`requestWillBeSentExtraInfo` / `responseReceivedExtraInfo`), sent cookies + `Set-Cookie`,
  initiator/stack, ResourceTiming, byte size + sha256;
- **WebSocket** connections and every frame (sent/received);
- **Server-Sent Events / streaming** bodies (assembled from `dataReceived` chunks);
- **cookies** (filtered to visited hosts), **localStorage/sessionStorage**, and **screenshots**;
- a standard **HAR 1.2** export (`session.har`) alongside the raw JSON.

Decoy only **records**. The recordings are written to be read by an **LLM/agent** that opens a
run and reconstructs the API from the captured traffic — so capture is implemented _once_,
completely, instead of being re-derived for every site. Replay and extraction are separate
tools built on top of a run's output.

## Run

```bash
pnpm install
pnpm dev               # control panel + recorder (electron-vite dev, HMR)
decoy                  # shortcut for `pnpm dev` (cmd; use .\decoy in PowerShell)
pnpm test              # unit tests (naming, filters, config, HAR, rename)
pnpm build             # bundle main + preloads + renderer to out/
pnpm package           # build + package the app (electron-builder → release/)
```

**Auto-record vs. pause.** New recordings start capturing immediately. Untick **Auto-record**
to open the browser paused (navigate/log in without noise, then hit **Record** in the toolbar).
The toolbar **Pause/Resume** button toggles capture anytime — handy when you're just clicking
around searching and don't want it in the run.

**Capture filters.** Settings → _Capture filters → Edit…_ opens a modal to choose which
resource types (Image, Script, …) and URL substrings (analytics hosts, …) are skipped. Reset
restores the defaults; **Capture all** on a recording overrides the filters entirely. Stored in
`decoy.json` and applied to each new recording.

**`pnpm dev` is the only command you need in development.** electron-vite serves the control
panel with HMR on an ephemeral port and launches Electron with that URL injected — no fixed
port to collide with other apps, nothing to start by hand.

In a **packaged** build there is no server at all: the renderer is pre-built and loaded from
disk (`loadFile`), and the recording engine is bundled into the Electron main process as plain
JS. So the packaged app starts everything by itself — no runtime transpiler.

## What a recording contains

A run lands in `<sessionsRoot>/<runId>/`, where `runId` is `YYYY-MM-DD_HHhMM_<label-slug>`
and `sessionsRoot` is configurable in **Settings** (default `Documents/Decoy/sessions`):

```
CLAUDE.md                # agent guide: how to read THIS run (auto-written into every run)
summary.md               # orientation: pages visited, top API hosts/endpoints, resource-type counts
manifest.json            # label, startUrl, counts, hostCounts (API surface), schemaVersion, generator
network.jsonl            # one line per request — index (pageTitle, graphqlOperation, pause/resume markers)
navigation.jsonl         # the page-by-page journey (url + title + screenshot per step)
session.har              # standard HAR 1.2 (optional, on by default)
cookies.json             # cookies filtered to visited hosts
storage.json             # localStorage + sessionStorage per visited origin
requests/NNNN_METHOD_host_path.json
websockets/NNNN_host_path.json
screenshots/NNNN_<safe-url>.png
```

Every run includes a **`CLAUDE.md`** that briefs an agent on how to interpret these files
(where auth lives, how to find a request, how to replay it, what an empty body means, etc.).
The full schema is documented inline in `src/main/recording/types.ts` and in
`docs/superpowers/specs/2026-05-26-decoy-session-recorder-design.md`.

## Consuming a recording

Point any downstream tool — or an agent — at the run folder. Because each run carries its own
`CLAUDE.md`, opening a session in Claude Code auto-loads instructions for reading it. Set the
output folder once in **Settings**; anything that reads from that folder consumes Decoy runs.

## DevTools while recording

Press **F12** (or Ctrl+Shift+I) in the recorder window to open DevTools on the site view.
Electron allows only one debugger per page, so Decoy detaches its capture debugger from that
view while DevTools is open and re-attaches automatically when you close it. Other contexts
(popups, workers) keep recording throughout.

## Manual verification checklist

Runtime capture behavior is verified by recording, not unit tests:

- [ ] Record a site that opens a **popup** → popup requests appear in `requests/`.
- [ ] Record a **service-worker-backed SPA** → worker/SW requests captured (check `context`).
- [ ] Record a page with a **WebSocket** → a file in `websockets/` with frames.
- [ ] Record an **SSE** endpoint → its body is present (`response.streamed: true`).
- [ ] Open **F12** mid-recording, close it → capture resumes; counts keep climbing.
- [ ] `cookies.json`, `storage.json`, `screenshots/`, `session.har`, `CLAUDE.md` all written.

## Architecture

Bundled by **electron-vite** into `out/{main,preload,renderer}` — packaged as plain JS, no
runtime transpiler.

- `src/main/index.ts` — main process: window lifecycle, UA/client-hints spoof, IPC, config.
- `src/main/config*.ts` — configurable sessions root (pure core + Electron wrapper).
- `src/main/recording/recorder.ts` — multi-target CDP recorder (the core).
- `src/main/recording/window.ts` — `BaseWindow` + toolbar/site views, popup capture, F12 handoff.
- `src/main/recording/{filters,naming,storage,types,har}.ts` — supporting modules.
- `src/main/recording/session-guide.md` — inlined (`?raw`) and written as `CLAUDE.md` into each run.
- `src/preload/{index,popup,toolbar}.ts` — contextBridge surfaces (built to `out/preload/*.mjs`).
- `src/renderer/` — React control panel + `recorder-toolbar/` (New recording / Recordings / Settings).
