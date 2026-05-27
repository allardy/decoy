import type { Session, WebContents } from 'electron'
import { createHash } from 'node:crypto'

import { shouldCapture } from './filters.js'
import { extractGraphqlOperation } from './graphql.js'
import { screenshotFileName } from './naming.js'
import { extractNextAction } from './nextjs.js'
import {
  appendNavigationLog,
  appendNetworkLog,
  appendNetworkMarker,
  writeCookies,
  writeManifest,
  writeRequestFile,
  writeRunSummary,
  writeScreenshot,
  writeSessionGuide,
  writeStorageSnapshot,
  writeWebSocketFile,
} from './storage.js'
import {
  SCHEMA_VERSION,
  type CaptureContext,
  type ContextKind,
  type FilterConfig,
  type RecordedRequest,
  type RecordedWebSocket,
  type RecordingManifest,
} from './types.js'

// CDP gives us request ids that are unique only within a single session, so we
// key every pending entry by (webContents id | session id | request id).
function pendingKey(wcId: number, sessionId: string, requestId: string): string {
  return `${wcId}|${sessionId}|${requestId}`
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function mapTargetType(type: string): ContextKind {
  switch (type) {
    case 'iframe':
      return 'iframe'
    case 'worker':
    case 'shared_worker':
      return 'worker'
    case 'service_worker':
      return 'service_worker'
    default:
      return 'page'
  }
}

function isTextLike(mimeType: string): boolean {
  return /json|text|xml|javascript|event-stream|x-www-form-urlencoded/i.test(mimeType)
}

interface Pending {
  wcId: number
  sessionId: string
  kind: ContextKind
  targetUrl?: string
  pageUrl?: string
  pageTitle?: string
  // request
  url: string
  method: string
  requestHeaders: Record<string, string>
  postData: string | null
  hasPostData: boolean
  type: string
  requestSentMs: number
  initiator?: unknown
  frameId?: string
  // request extra-info (wire)
  wireReqHeaders?: Record<string, string>
  cookies?: Array<{ name: string; value: string; domain?: string; path?: string }>
  // response
  status?: number
  statusText?: string
  respHeaders?: Record<string, string>
  mimeType?: string
  remoteIPAddress?: string
  protocol?: string
  fromDiskCache?: boolean
  fromServiceWorker?: boolean
  resourceTiming?: unknown
  responseReceivedMs?: number
  // response extra-info (wire)
  wireRespHeaders?: Record<string, string>
  setCookie?: string[]
  // streaming
  streamed: boolean
  streamChunks: Buffer[]
}

interface WsPending {
  index: number
  wcId: number
  sessionId: string
  kind: ContextKind
  ws: RecordedWebSocket
}

interface Attachment {
  wc: WebContents
  kind: ContextKind
  /** child-session id -> {kind,url}, learned via Target.attachedToTarget */
  sessionKinds: Map<string, { kind: ContextKind; url?: string }>
  /** Latest top-document URL/title, stamped onto requests for grouping. */
  currentUrl: string
  currentTitle: string
  onMessage: (event: unknown, method: string, params: any, sessionId?: string) => void
  onNavigate: (event: unknown, url: string) => void
  onWillNavigate: (event: unknown, url: string) => void
  onTitleUpdated: (event: unknown, title: string) => void
  suspended: boolean
}

export interface RecorderOptions {
  runDir: string
  captureAll: boolean
  /** User-editable skip-list; undefined falls back to built-in defaults. */
  filters?: FilterConfig
  /** Begin capturing immediately. When false, the recorder starts paused. */
  autoRecord?: boolean
  onProgress: (counts: { requests: number; websockets: number }) => void
}

export class Recorder {
  private runDir: string
  private captureAll: boolean
  private filters?: FilterConfig
  private onProgress: (counts: { requests: number; websockets: number }) => void

  private attachments = new Map<number, Attachment>()
  private pending = new Map<string, Pending>()
  private wsPending = new Map<string, WsPending>()

  private index = 0
  private wsIndex = 0
  private requestCount = 0
  private webSocketCount = 0
  private navigationCount = 0
  private origins = new Set<string>()
  private hostCounts: Record<string, number> = {}
  private storageSnapshots = new Map<
    string,
    { localStorage: Record<string, string>; sessionStorage: Record<string, string> }
  >()
  private hadErrors = false
  private startedAt = new Date()
  // When paused, all network/WebSocket events are ignored so exploratory
  // clicking (search-as-you-type, browsing) doesn't bury the useful calls.
  private paused = false
  // Accumulated for summary.md.
  private pages = new Map<string, string>()
  private typeCounts: Record<string, number> = {}
  private endpoints = new Map<string, { count: number; lastStatus: number }>()

  private session: Session | null = null
  private mainWc: WebContents | null = null

  constructor(opts: RecorderOptions) {
    this.runDir = opts.runDir
    this.captureAll = opts.captureAll
    this.filters = opts.filters
    this.onProgress = opts.onProgress
    // "Auto-record" off ⇒ open paused; the user resumes from the toolbar.
    this.paused = !(opts.autoRecord ?? true)
  }

  /** Toggle capture on/off mid-recording. Pausing drops anything in flight. */
  setPaused(paused: boolean): void {
    if (this.paused === paused) {
      return
    }

    this.paused = paused

    if (paused) {
      // Drop half-captured requests so they aren't written when they finish.
      this.pending.clear()
    }

    // Mark the boundary in the timeline so an agent can tell deliberate action
    // (after a resume) from earlier exploratory clicking.
    void appendNetworkMarker(this.runDir, paused ? 'pause' : 'resume').catch(() => {})
  }

  isPaused(): boolean {
    return this.paused
  }

  // --- public API -----------------------------------------------------------

  /** Attach capture to a webContents (the site view, or a popup/child window). */
  attachTo(wc: WebContents, kind: ContextKind): void {
    if (wc.isDestroyed() || this.attachments.has(wc.id)) {
      return
    }

    if (!this.mainWc) {
      this.mainWc = wc
      this.session = wc.session
    }

    const attachment: Attachment = {
      wc,
      kind,
      sessionKinds: new Map(),
      currentUrl: wc.getURL(),
      currentTitle: wc.getTitle(),
      suspended: false,
      onMessage: (_e, method, params, sessionId) => this.onMessage(wc.id, method, params, sessionId ?? ''),
      onNavigate: (_e, url) => this.onNavigate(wc, kind, url),
      onWillNavigate: (_e, _url) => this.onWillNavigate(wc),
      onTitleUpdated: (_e, title) => {
        const a = this.attachments.get(wc.id)

        if (a) {
          a.currentTitle = title
        }
      },
    }

    this.attachments.set(wc.id, attachment)

    this.openDebugger(attachment)

    wc.on('did-navigate', attachment.onNavigate)
    wc.on('did-navigate-in-page', attachment.onNavigate)
    wc.on('will-navigate', attachment.onWillNavigate)
    wc.on('page-title-updated', attachment.onTitleUpdated)
    wc.once('destroyed', () => this.detach(wc.id))
    // When DevTools closes on this contents, resume capture (see suspendForDevTools).
    wc.on('devtools-closed', () => this.resume(wc.id))
  }

  /**
   * Yield the debugger so DevTools can attach to `wc` (Electron allows only one
   * debugger per webContents). Call this right before openDevTools(); capture
   * for this contents pauses and auto-resumes on the 'devtools-closed' event.
   */
  suspendForDevTools(wc: WebContents): void {
    const a = this.attachments.get(wc.id)

    if (!a || a.suspended) {
      return
    }

    a.suspended = true

    try {
      const dbg = a.wc.debugger

      if (dbg.isAttached()) {
        dbg.off('message', a.onMessage)
        dbg.detach()
      }
    } catch {
      // already detached
    }
  }

  private resume(wcId: number): void {
    const a = this.attachments.get(wcId)

    if (!a || !a.suspended || a.wc.isDestroyed()) {
      return
    }

    a.suspended = false
    a.sessionKinds.clear()
    this.openDebugger(a)
  }

  async stop(opts: { label: string; startUrl: string; partition: string }): Promise<RecordingManifest> {
    // Flush still-open streamed responses (e.g. long-lived SSE) as partial records.
    for (const [key, p] of this.pending) {
      if (p.streamed) {
        await this.writeRecord(key, p, true)
      }
    }

    // Finalize any WebSockets that never emitted a close event. finishWebSocket
    // deletes the current key only, which is safe during live Map iteration.
    for (const key of this.wsPending.keys()) {
      await this.finishWebSocket(key)
    }

    for (const a of this.attachments.values()) {
      try {
        const dbg = a.wc.debugger

        if (dbg.isAttached()) {
          dbg.off('message', a.onMessage)
          dbg.detach()
        }
      } catch {
        // already detached
      }

      if (!a.wc.isDestroyed()) {
        a.wc.off('did-navigate', a.onNavigate)
        a.wc.off('did-navigate-in-page', a.onNavigate)
        a.wc.off('will-navigate', a.onWillNavigate)
        a.wc.off('page-title-updated', a.onTitleUpdated)
      }
    }

    await this.dumpStorage()
    await this.dumpCookies()
    // Drop an agent-oriented reading guide into the run so any LLM pointed at
    // the folder knows how to interpret the captured data.
    await writeSessionGuide(this.runDir)

    const manifest: RecordingManifest = {
      runId: this.runDir.split(/[/\\]/).pop()!,
      label: opts.label,
      startUrl: opts.startUrl,
      partition: opts.partition,
      captureAll: this.captureAll,
      startedAt: this.startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      requestCount: this.requestCount,
      navigationCount: this.navigationCount,
      schemaVersion: SCHEMA_VERSION,
      generator: 'decoy@0.1.0',
      webSocketCount: this.webSocketCount,
      contextsAttached: this.attachments.size,
      hostCounts: this.hostCounts,
      hadErrors: this.hadErrors,
    }

    await writeManifest(this.runDir, manifest)
    await writeRunSummary(this.runDir, this.buildSummaryMarkdown(manifest)).catch((err) =>
      this.warn('summary write failed', err),
    )

    return manifest
  }

  // --- debugger wiring ------------------------------------------------------

  private openDebugger(a: Attachment): void {
    const dbg = a.wc.debugger

    try {
      if (!dbg.isAttached()) {
        dbg.attach('1.3')
      }
    } catch (err) {
      // Most likely DevTools owns the debugger. We'll attach on devtools-closed.
      this.warn('attach failed', err)

      return
    }

    dbg.on('message', a.onMessage)
    void this.send(a.wc, 'Network.enable', {
      maxResourceBufferSize: 100 * 1024 * 1024,
      maxTotalBufferSize: 500 * 1024 * 1024,
    })
    // Surface out-of-process iframes, dedicated/shared workers and service
    // workers through this same connection (flattened, with their own sessionId).
    void this.send(a.wc, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    })
  }

  private detach(wcId: number): void {
    const a = this.attachments.get(wcId)

    if (!a) {
      return
    }

    try {
      const dbg = a.wc.debugger

      if (dbg.isAttached()) {
        dbg.off('message', a.onMessage)
        dbg.detach()
      }
    } catch {
      // ignore
    }

    this.attachments.delete(wcId)
  }

  private send(wc: WebContents, method: string, params?: object, sessionId?: string): Promise<any> {
    return wc.debugger.sendCommand(method, params ?? {}, sessionId || undefined)
  }

  // --- CDP message handling -------------------------------------------------

  private contextFor(wcId: number, sessionId: string): CaptureContext {
    const a = this.attachments.get(wcId)

    if (sessionId && a) {
      const sk = a.sessionKinds.get(sessionId)

      if (sk) {
        return { kind: sk.kind, targetUrl: sk.url, sessionId }
      }
    }

    return { kind: a?.kind ?? 'page', sessionId: sessionId || undefined }
  }

  private onMessage(wcId: number, method: string, params: any, sessionId: string): void {
    // While paused, ignore all traffic but keep handling Target.* so the
    // session topology (iframes/workers) stays correct for when we resume.
    if (this.paused && method.startsWith('Network.')) {
      return
    }

    try {
      switch (method) {
        case 'Target.attachedToTarget':
          this.onTargetAttached(wcId, params, sessionId)

          return
        case 'Target.detachedFromTarget': {
          const a = this.attachments.get(wcId)

          a?.sessionKinds.delete(params?.sessionId)

          return
        }
        case 'Network.requestWillBeSent':
          this.onRequestWillBeSent(wcId, sessionId, params)

          return
        case 'Network.requestWillBeSentExtraInfo':
          this.onRequestExtraInfo(wcId, sessionId, params)

          return
        case 'Network.responseReceived':
          this.onResponseReceived(wcId, sessionId, params)

          return
        case 'Network.responseReceivedExtraInfo':
          this.onResponseExtraInfo(wcId, sessionId, params)

          return
        case 'Network.dataReceived':
          this.onDataReceived(wcId, sessionId, params)

          return
        case 'Network.loadingFinished':
          void this.finish(wcId, sessionId, params.requestId)

          return
        case 'Network.loadingFailed':
          this.pending.delete(pendingKey(wcId, sessionId, params.requestId))

          return
        // WebSockets
        case 'Network.webSocketCreated':
          this.onWsCreated(wcId, sessionId, params)

          return
        case 'Network.webSocketWillSendHandshakeRequest':
          this.withWs(wcId, sessionId, params.requestId, (w) => {
            w.ws.requestHeaders = params.request?.headers ?? {}
          })

          return
        case 'Network.webSocketHandshakeResponseReceived':
          this.withWs(wcId, sessionId, params.requestId, (w) => {
            w.ws.responseHeaders = params.response?.headers ?? {}
          })

          return
        case 'Network.webSocketFrameSent':
          this.onWsFrame(wcId, sessionId, params, 'sent')

          return
        case 'Network.webSocketFrameReceived':
          this.onWsFrame(wcId, sessionId, params, 'received')

          return
        case 'Network.webSocketFrameError':
          this.hadErrors = true

          return
        case 'Network.webSocketClosed':
          this.withWs(wcId, sessionId, params.requestId, (w) => {
            w.ws.closedAt = new Date().toISOString()
          })
          void this.finishWebSocket(pendingKey(wcId, sessionId, params.requestId))

          return
        default:
          return
      }
    } catch (err) {
      this.hadErrors = true
      this.warn(`handler ${method} threw`, err)
    }
  }

  private onTargetAttached(wcId: number, params: any, parentSessionId: string): void {
    const a = this.attachments.get(wcId)

    if (!a) {
      return
    }

    const childSession: string = params?.sessionId
    const info = params?.targetInfo ?? {}

    a.sessionKinds.set(childSession, { kind: mapTargetType(info.type ?? ''), url: info.url })
    // Enable network on the child session and cascade auto-attach for nesting.
    void this.send(a.wc, 'Network.enable', {}, childSession)
    void this.send(
      a.wc,
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      childSession,
    )

    if (params?.waitingForDebugger) {
      void this.send(a.wc, 'Runtime.runIfWaitingForDebugger', {}, childSession)
    }

    void parentSessionId
  }

  private onRequestWillBeSent(wcId: number, sessionId: string, params: any): void {
    const key = pendingKey(wcId, sessionId, params.requestId)

    // A redirect reuses the same requestId — finalize the previous hop first.
    if (params.redirectResponse) {
      const prev = this.pending.get(key)

      if (prev) {
        prev.status = params.redirectResponse.status
        prev.statusText = params.redirectResponse.statusText
        prev.respHeaders = params.redirectResponse.headers ?? {}
        prev.mimeType = params.redirectResponse.mimeType ?? ''
        prev.responseReceivedMs = Date.now()
        void this.writeRecord(key, prev, false)
        this.pending.delete(key)
      }
    }

    const existingExtra = this.pending.get(key)
    const req = params.request ?? {}
    const ctx = this.contextFor(wcId, sessionId)
    const owner = this.attachments.get(wcId)

    this.pending.set(key, {
      wcId,
      sessionId,
      kind: ctx.kind,
      targetUrl: ctx.targetUrl,
      pageUrl: owner?.currentUrl,
      pageTitle: owner?.currentTitle,
      url: req.url ?? '',
      method: req.method ?? 'GET',
      requestHeaders: req.headers ?? {},
      postData: req.postData ?? null,
      hasPostData: Boolean(req.hasPostData),
      type: params.type ?? 'Other',
      requestSentMs: params.timestamp ? params.timestamp * 1000 : Date.now(),
      initiator: params.initiator,
      frameId: params.frameId,
      // carry over extra-info that may have arrived first
      wireReqHeaders: existingExtra?.wireReqHeaders,
      cookies: existingExtra?.cookies,
      streamed: false,
      streamChunks: [],
    })
  }

  private onRequestExtraInfo(wcId: number, sessionId: string, params: any): void {
    const key = pendingKey(wcId, sessionId, params.requestId)
    const p = this.pending.get(key)
    const cookies = (params.associatedCookies ?? [])
      .filter((c: any) => !c.blockedReasons || c.blockedReasons.length === 0)
      .map((c: any) => ({
        name: c.cookie?.name,
        value: c.cookie?.value,
        domain: c.cookie?.domain,
        path: c.cookie?.path,
      }))

    if (p) {
      p.wireReqHeaders = params.headers ?? {}
      p.cookies = cookies
    } else {
      // arrived before requestWillBeSent — stash a stub to merge later
      this.pending.set(key, {
        wcId,
        sessionId,
        kind: this.contextFor(wcId, sessionId).kind,
        url: '',
        method: 'GET',
        requestHeaders: {},
        postData: null,
        hasPostData: false,
        type: 'Other',
        requestSentMs: Date.now(),
        wireReqHeaders: params.headers ?? {},
        cookies,
        streamed: false,
        streamChunks: [],
      })
    }
  }

  private onResponseReceived(wcId: number, sessionId: string, params: any): void {
    const key = pendingKey(wcId, sessionId, params.requestId)
    const p = this.pending.get(key)

    if (!p) {
      return
    }

    const r = params.response ?? {}

    p.status = r.status ?? 0
    p.statusText = r.statusText
    p.respHeaders = r.headers ?? {}
    p.mimeType = r.mimeType ?? ''
    p.remoteIPAddress = r.remoteIPAddress
    p.protocol = r.protocol
    p.fromDiskCache = r.fromDiskCache
    p.fromServiceWorker = r.fromServiceWorker
    p.resourceTiming = r.timing
    p.responseReceivedMs = params.timestamp ? params.timestamp * 1000 : Date.now()

    if (params.type) {
      p.type = params.type
    }

    // For server-sent events / streaming responses, getResponseBody won't
    // resolve until the stream ends (which may be never). Switch to streamed
    // capture so we accumulate chunks via dataReceived instead.
    if (/event-stream/i.test(p.mimeType ?? '') || p.type === 'EventSource') {
      p.streamed = true
      void this.startStreaming(wcId, sessionId, params.requestId, p)
    }
  }

  private async startStreaming(wcId: number, sessionId: string, requestId: string, p: Pending): Promise<void> {
    const a = this.attachments.get(wcId)

    if (!a) {
      return
    }

    try {
      const res = await this.send(a.wc, 'Network.streamResourceContent', { requestId }, sessionId)

      if (res?.bufferedData) {
        p.streamChunks.push(Buffer.from(res.bufferedData, 'base64'))
      }
    } catch (err) {
      // streamResourceContent unsupported / request already gone — best effort.
      this.warn('streamResourceContent failed', err)
    }
  }

  private onResponseExtraInfo(wcId: number, sessionId: string, params: any): void {
    const key = pendingKey(wcId, sessionId, params.requestId)
    const p = this.pending.get(key)

    if (!p) {
      return
    }

    p.wireRespHeaders = params.headers ?? {}
    const sc = params.headers?.['set-cookie'] ?? params.headers?.['Set-Cookie']

    if (sc) {
      p.setCookie = String(sc).split('\n')
    }
  }

  private onDataReceived(wcId: number, sessionId: string, params: any): void {
    const key = pendingKey(wcId, sessionId, params.requestId)
    const p = this.pending.get(key)

    if (!p || !p.streamed) {
      return
    }

    if (typeof params.data === 'string') {
      p.streamChunks.push(Buffer.from(params.data, 'base64'))
    }
  }

  private async finish(wcId: number, sessionId: string, requestId: string): Promise<void> {
    const key = pendingKey(wcId, sessionId, requestId)
    const p = this.pending.get(key)

    if (!p) {
      return
    }

    this.pending.delete(key)
    await this.writeRecord(key, p, false)
  }

  private async writeRecord(key: string, p: Pending, partialStream: boolean): Promise<void> {
    if (!shouldCapture(p.type, p.url, this.captureAll, this.filters)) {
      return
    }

    // Lazily fetch a large POST body the inline event didn't include.
    let postData = p.postData
    let bodyTruncated = false

    if (p.hasPostData && (postData === null || postData === '')) {
      try {
        const res = await this.send(
          this.attachments.get(p.wcId)!.wc,
          'Network.getRequestPostData',
          { requestId: key.split('|').pop() },
          p.sessionId,
        )

        postData = res?.postData ?? null
      } catch {
        bodyTruncated = true
      }
    }

    const graphqlOperation = extractGraphqlOperation(postData)
    const nextAction = extractNextAction(p.wireReqHeaders) ?? extractNextAction(p.requestHeaders)
    // One label for the summary/endpoint grouping: GraphQL op, else Server Action.
    const opLabel = graphqlOperation ?? (nextAction ? `action ${nextAction.slice(0, 8)}` : undefined)

    // Resolve the response body.
    let body = ''
    let base64Encoded = false
    let bodyNote: string | undefined

    if (p.streamed) {
      const buf = Buffer.concat(p.streamChunks)

      if (isTextLike(p.mimeType ?? '')) {
        body = buf.toString('utf8')
      } else {
        body = buf.toString('base64')
        base64Encoded = true
      }

      if (partialStream) {
        bodyNote = 'stream still open when recording stopped — body is partial'
      }
    } else if (p.status !== undefined) {
      try {
        const a = this.attachments.get(p.wcId)

        if (a) {
          const res = await this.send(a.wc, 'Network.getResponseBody', { requestId: key.split('|').pop() }, p.sessionId)

          body = res?.body ?? ''
          base64Encoded = Boolean(res?.base64Encoded)
        }
      } catch {
        bodyNote =
          'response body unavailable from the browser (served from cache, empty, or the connection closed before it was read)'
      }
    }

    if (!body && !bodyNote && p.fromDiskCache) {
      bodyNote = 'empty body — response was served from disk cache'
    }

    const rawBytes = base64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8')

    this.index += 1
    const idx = this.index

    const record: RecordedRequest = {
      index: idx,
      timestamp: new Date().toISOString(),
      type: p.type,
      context: {
        kind: p.kind,
        targetUrl: p.targetUrl,
        pageUrl: p.pageUrl,
        pageTitle: p.pageTitle,
        sessionId: p.sessionId || undefined,
      },
      frameId: p.frameId,
      request: {
        url: p.url,
        method: p.method,
        headers: p.requestHeaders,
        body: postData,
        wireHeaders: p.wireReqHeaders,
        cookies: p.cookies,
        bodyTruncated: bodyTruncated || undefined,
        graphqlOperation,
        nextAction,
        initiator: p.initiator,
      },
      response: {
        status: p.status ?? 0,
        headers: p.respHeaders ?? {},
        body,
        mimeType: p.mimeType ?? '',
        base64Encoded,
        statusText: p.statusText,
        wireHeaders: p.wireRespHeaders,
        setCookieHeaders: p.setCookie,
        bodyBytes: rawBytes.length,
        bodySha256: rawBytes.length ? sha256Hex(rawBytes) : undefined,
        remoteIPAddress: p.remoteIPAddress,
        protocol: p.protocol,
        fromDiskCache: p.fromDiskCache,
        fromServiceWorker: p.fromServiceWorker,
        streamed: p.streamed || undefined,
        bodyNote,
      },
      timing: {
        requestSentMs: p.requestSentMs,
        responseReceivedMs: p.responseReceivedMs ?? Date.now(),
        durationMs: Math.max(0, Math.round((p.responseReceivedMs ?? Date.now()) - p.requestSentMs)),
        resourceTiming: p.resourceTiming,
      },
    }

    try {
      await writeRequestFile(this.runDir, record)
      this.requestCount += 1
      this.countHost(p.url)
      this.tallyForSummary(p, record.response.status, opLabel)
      await appendNetworkLog(this.runDir, {
        index: idx,
        ts: record.timestamp,
        method: p.method,
        url: p.url,
        status: record.response.status,
        type: p.type,
        bytes: rawBytes.length,
        durationMs: Math.max(0, Math.round(record.timing.responseReceivedMs - p.requestSentMs)),
        context: p.kind,
        pageTitle: p.pageTitle,
        graphqlOperation,
        nextAction,
      })
      this.onProgress({ requests: this.requestCount, websockets: this.webSocketCount })
    } catch (err) {
      this.hadErrors = true
      this.warn('failed to write request file', err)
    }
  }

  // --- WebSockets -----------------------------------------------------------

  private onWsCreated(wcId: number, sessionId: string, params: any): void {
    const key = pendingKey(wcId, sessionId, params.requestId)

    this.wsIndex += 1
    const ctx = this.contextFor(wcId, sessionId)

    this.wsPending.set(key, {
      index: this.wsIndex,
      wcId,
      sessionId,
      kind: ctx.kind,
      ws: {
        index: this.wsIndex,
        url: params.url ?? '',
        context: ctx,
        openedAt: new Date().toISOString(),
        frames: [],
      },
    })
  }

  private withWs(wcId: number, sessionId: string, requestId: string, fn: (w: WsPending) => void): void {
    const w = this.wsPending.get(pendingKey(wcId, sessionId, requestId))

    if (w) {
      fn(w)
    }
  }

  private onWsFrame(wcId: number, sessionId: string, params: any, direction: 'sent' | 'received'): void {
    this.withWs(wcId, sessionId, params.requestId, (w) => {
      const opcode = params.response?.opcode ?? 1

      w.ws.frames.push({
        ts: new Date().toISOString(),
        direction,
        opcode,
        payload: params.response?.payloadData ?? '',
        base64Encoded: opcode === 2,
      })
    })
  }

  private async finishWebSocket(key: string): Promise<void> {
    const w = this.wsPending.get(key)

    if (!w) {
      return
    }

    this.wsPending.delete(key)

    if (!w.ws.closedAt) {
      w.ws.closedAt = new Date().toISOString()
    }

    try {
      await writeWebSocketFile(this.runDir, w.ws)
      this.webSocketCount += 1
      this.onProgress({ requests: this.requestCount, websockets: this.webSocketCount })
    } catch (err) {
      this.hadErrors = true
      this.warn('failed to write websocket file', err)
    }
  }

  // --- navigation side channels --------------------------------------------

  private onNavigate(wc: WebContents, kind: ContextKind, url: string): void {
    this.navigationCount += 1

    try {
      this.origins.add(new URL(url).origin)
    } catch {
      // ignore non-http urls
    }

    const a = this.attachments.get(wc.id)
    let title = ''

    try {
      title = wc.getTitle()
    } catch {
      // title unavailable
    }

    if (a) {
      a.currentUrl = url

      if (title) {
        a.currentTitle = title
      }
    }

    if (kind === 'page' || kind === 'popup') {
      this.pages.set(url, a?.currentTitle ?? title)
      void this.captureScreenshot(wc, url)
      void appendNavigationLog(this.runDir, {
        index: this.navigationCount,
        ts: new Date().toISOString(),
        url,
        title: a?.currentTitle ?? title,
        screenshot: screenshotFileName(this.navigationCount, url),
        context: kind,
      }).catch((err) => this.warn('navigation log failed', err))
    }
  }

  private onWillNavigate(wc: WebContents): void {
    try {
      const fromOrigin = new URL(wc.getURL()).origin

      void this.snapshotOrigin(wc, fromOrigin)
    } catch {
      // ignore
    }
  }

  private async captureScreenshot(wc: WebContents, url: string): Promise<void> {
    try {
      if (wc.isDestroyed()) {
        return
      }

      const image = await wc.capturePage()

      await writeScreenshot(this.runDir, this.navigationCount, url, image.toPNG())
    } catch (err) {
      this.warn('screenshot failed', err)
    }
  }

  private async snapshotOrigin(wc: WebContents, origin: string): Promise<void> {
    try {
      if (wc.isDestroyed()) {
        return
      }

      const result = (await wc.executeJavaScript(
        `(() => {
          if (location.origin !== ${JSON.stringify(origin)}) return null
          return {
            localStorage: Object.fromEntries(Object.entries(localStorage)),
            sessionStorage: Object.fromEntries(Object.entries(sessionStorage))
          }
        })()`,
      )) as { localStorage: Record<string, string>; sessionStorage: Record<string, string> } | null

      if (result) {
        this.storageSnapshots.set(origin, result)
      }
    } catch {
      // origin not currently loaded / worker context — skip
    }
  }

  private async dumpStorage(): Promise<void> {
    for (const a of this.attachments.values()) {
      if (a.kind !== 'page' && a.kind !== 'popup') {
        continue
      }

      try {
        const origin = new URL(a.wc.getURL()).origin

        await this.snapshotOrigin(a.wc, origin)
      } catch {
        // ignore
      }
    }

    const snapshot: Record<string, unknown> = {}

    for (const [origin, data] of this.storageSnapshots) {
      snapshot[origin] = data
    }

    try {
      await writeStorageSnapshot(this.runDir, snapshot)
    } catch (err) {
      this.warn('storage dump failed', err)
    }
  }

  private async dumpCookies(): Promise<void> {
    if (!this.session) {
      return
    }

    try {
      const cookies = await this.session.cookies.get({})
      const visitedHosts = new Set<string>()

      for (const origin of this.origins) {
        try {
          visitedHosts.add(new URL(origin).hostname)
        } catch {
          // skip
        }
      }

      const filtered = cookies.filter((c) => {
        const dom = c.domain?.replace(/^\./, '') ?? ''

        if (!dom) {
          return false
        }

        for (const host of visitedHosts) {
          if (host === dom || host.endsWith(`.${dom}`)) {
            return true
          }
        }

        return false
      })

      await writeCookies(this.runDir, filtered)
    } catch (err) {
      this.warn('cookie dump failed', err)
    }
  }

  private countHost(url: string): void {
    try {
      const host = new URL(url).host

      this.hostCounts[host] = (this.hostCounts[host] ?? 0) + 1
    } catch {
      // ignore
    }
  }

  private tallyForSummary(p: Pending, status: number, opLabel?: string): void {
    this.typeCounts[p.type] = (this.typeCounts[p.type] ?? 0) + 1

    if (p.type !== 'XHR' && p.type !== 'Fetch' && p.type !== 'EventSource') {
      return
    }

    try {
      const u = new URL(p.url)
      const suffix = opLabel ? ` (${opLabel})` : ''
      const key = `${p.method} ${u.host}${u.pathname}${suffix}`
      const e = this.endpoints.get(key)

      if (e) {
        e.count += 1
        e.lastStatus = status
      } else if (this.endpoints.size < 300) {
        this.endpoints.set(key, { count: 1, lastStatus: status })
      }
    } catch {
      // ignore unparseable url
    }
  }

  private buildSummaryMarkdown(manifest: RecordingManifest): string {
    const lines: string[] = [`# ${manifest.label} — Decoy run summary`, '']

    lines.push(`- Recorded: ${manifest.startedAt} → ${manifest.endedAt}`)
    lines.push(
      `- Requests: ${manifest.requestCount} · WebSockets: ${manifest.webSocketCount ?? 0} · Navigations: ${manifest.navigationCount}`,
    )
    lines.push(`- Start URL: ${manifest.startUrl}`)

    if (manifest.hadErrors) {
      lines.push('- ⚠ Some capture steps errored — this run may be incomplete.')
    }

    lines.push('', 'Read `AGENTS.md` in this folder for how to interpret the files.', '')

    if (this.pages.size) {
      lines.push('## Pages visited', '')

      for (const [url, title] of this.pages) {
        lines.push(`- ${title || '(untitled)'} — ${url}`)
      }

      lines.push('')
    }

    const hosts = Object.entries(this.hostCounts).sort((a, b) => b[1] - a[1])

    if (hosts.length) {
      lines.push('## API hosts (requests per host)', '')

      for (const [host, n] of hosts.slice(0, 30)) {
        lines.push(`- ${host} — ${n}`)
      }

      lines.push('')
    }

    const endpoints = [...this.endpoints.entries()].sort((a, b) => b[1].count - a[1].count)

    if (endpoints.length) {
      lines.push('## Endpoints (XHR / Fetch / SSE)', '')

      for (const [key, e] of endpoints.slice(0, 50)) {
        lines.push(`- ${key} — ${e.count}× (last ${e.lastStatus})`)
      }

      lines.push('')
    }

    const types = Object.entries(this.typeCounts).sort((a, b) => b[1] - a[1])

    if (types.length) {
      lines.push('## Resource types', '')

      for (const [t, n] of types) {
        lines.push(`- ${t}: ${n}`)
      }

      lines.push('')
    }

    return lines.join('\n')
  }

  private warn(msg: string, err?: unknown): void {
    console.error(`[recorder] ${msg}:`, err instanceof Error ? err.message : err)
  }
}
