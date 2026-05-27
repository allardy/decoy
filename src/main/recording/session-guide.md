# Reading this recording

This folder is a **faithful capture of a real browser session** — every network
request/response, the cookies and storage that were live, WebSocket frames, and
navigation screenshots. There is **no application source code here**; your job is to
reconstruct how the site's API works _purely from the observed traffic_ and replay or
extract from it.

You are most likely here to answer: **"How do I reproduce request X programmatically?"**
or **"Where does this piece of data come from?"** This guide tells you how.

## File map

```
summary.md        START HERE — pages visited, top API hosts/endpoints, resource-type counts
manifest.json     run metadata: label, startUrl, counts, hostCounts (API surface at a glance), schemaVersion
network.jsonl     ONE LINE PER REQUEST — your index. {index, ts, method, url, status, type, bytes, durationMs, context, pageTitle, graphqlOperation}. Also has {marker:"pause"|"resume"} lines.
navigation.jsonl  the page-by-page journey: {index, ts, url, title, screenshot, context} — links screenshots to moments
requests/         one JSON per request: NNNN_METHOD_host_path[_operation].json  (NNNN = capture order)
websockets/       one JSON per WebSocket connection, with every frame inline
screenshots/      PNG per navigation (NNNN_<host-path>.png) — visual context only
cookies.json      cookies present at stop, filtered to hosts visited in this run
storage.json      localStorage + sessionStorage per origin (often where auth tokens live)
session.har       the same requests as standard HAR 1.2 — import into Postman/Insomnia/Chrome
```

**Start with `summary.md`** for orientation (which pages, which hosts/endpoints), then use
**`network.jsonl`** as your line-by-line index: find the call you care about (by URL, method,
status, or `graphqlOperation`), note the `index`, and open the matching file in `requests/`
(its name starts with that zero-padded index).

A `{"marker":"resume"}` line in `network.jsonl` marks where the user resumed capture after
pausing to click around — **the requests after a `resume` are usually the deliberate action**,
the ones before are exploratory noise.

## Finding the right request

- Grep `network.jsonl` for a path fragment, or grep `requests/*.json` for a value you saw in
  the UI (an id, an email, a label). The response that contains that value is the source.
- Many calls hit the **same URL** (especially GraphQL — usually one endpoint for everything).
  The operation name is extracted for you into `request.graphqlOperation` (and the filename and
  `network.jsonl`); otherwise look for `operationName` / the query inside `request.body`.
- **Next.js Server Actions** look like a `POST` to the page URL — the action id is pulled into
  `request.nextAction` (and the filename / `network.jsonl`). The args are in `request.body`
  (often multipart form-data); the response is an RSC/flight stream (`text/x-component`).
  Initial list data is often server-rendered into the HTML/flight rather than a separate API
  call — interact (paginate/filter/navigate) to surface the client `fetch` or `?_rsc=` request.
- Ignore noise: `type` of `Document`/`Script`/`Stylesheet`/`Image`/`Font` is usually the page
  shell and assets. The API is almost always `type: "XHR"` or `"Fetch"`.
- **Group by page.** Each request carries `context.pageTitle` / `context.pageUrl` — the page
  that was open when it fired. To see what a screen loads behind the scenes, filter by its
  title. `navigation.jsonl` is the ordered journey (url + title + screenshot per step), so you
  can line up a screenshot with the requests that followed it.

## The request record (what matters for replay)

```jsonc
{
  "request": {
    "method": "POST",
    "url": "https://api.example.com/graphql",
    "headers":     { ... },   // headers the app set (what you'd write in code)
    "wireHeaders": { ... },   // EXACT headers on the wire — includes cookie, sec-*, etc.
    "cookies":     [ ... ],   // cookies actually sent
    "body": "{\"query\": ...}"
  },
  "response": {
    "status": 200,
    "headers": { ... },
    "body": "...",            // text, OR base64 when base64Encoded is true
    "base64Encoded": false,
    "mimeType": "application/json",
    "bodyNote": "..."         // ONLY present when body is empty/partial — read it
  },
  "timing": { "durationMs": 42, ... }
}
```

**To mimic a request, prefer `request.wireHeaders`** — it's what the browser actually sent,
including the `cookie` header and `sec-*`/`accept-*` headers some servers require. Use
`request.headers` only if `wireHeaders` is absent. When rebuilding the call:

- **Keep**: `authorization`, `cookie`, `content-type`, and any custom `x-*` headers.
- **Drop / let your client set**: `host`, `content-length`, `connection`, and other
  hop-by-hop headers — they're computed per request.
- Send `request.body` verbatim for the matching `content-type`.

## Where the credentials are

If a request has no obvious `authorization` header, the auth is somewhere else — check, in order:

1. **`request.wireHeaders.cookie`** / `cookies.json` — cookie-based sessions.
2. **`storage.json`** — SPAs frequently keep bearer/JWT/OIDC tokens in `localStorage` or
   `sessionStorage` (look for keys like `access_token`, `id_token`, `oidc.user:*`, `*token*`).
   The app reads them from there and attaches them as `Authorization: Bearer …` per request —
   so the token in `storage.json` is what you replay with.
3. **`response.setCookieHeaders`** on an earlier request — the login/refresh call that minted
   the session.

Tokens and cookies in a recording are **point-in-time and will expire**. Treat them as proof
of the auth _mechanism_, not as durable credentials.

## Special cases

- **`context.kind` is not `"page"`** → the request came from a popup, iframe, or
  `service_worker`/`worker`. If you couldn't find a call on the main page, it likely ran in a
  worker — search across all `requests/` regardless of context.
- **WebSockets** → realtime data is in `websockets/`, not `requests/`. Each file has the
  handshake headers and an ordered `frames[]` (text inline, binary base64).
- **Server-Sent Events / streams** → `response.streamed: true`; the body is the concatenated
  stream. If `bodyNote` says it's partial, the recording stopped mid-stream.
- **Redirects** → a 3xx hop and its destination are separate records (same URL, consecutive
  indices). Follow the `location` response header.
- **Empty `response.body`** → read `bodyNote`. Common reasons: `204/304`, served from cache
  (`fromDiskCache`), binary that wasn't retrievable, or the request was still in flight at
  stop. A `base64Encoded: true` body is binary — decode before reading.

## A reproduce recipe

1. Locate the call in `network.jsonl`; open its `requests/NNNN_*.json`.
2. Copy `method`, `url`, `request.wireHeaders`, `request.body`.
3. Resolve auth (see above) — make sure the token/cookie is included in your headers.
4. Drop hop-by-hop headers; let your HTTP client set `host`/`content-length`.
5. Compare your response to the recorded `response.body` to confirm a faithful replay.

`session.har` is a ready-made version of step 1–2 for any HAR-aware tool.
