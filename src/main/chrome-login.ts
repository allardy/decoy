import { app, session, type Session } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

// The real-Chrome login escape hatch. Google rejects sign-in inside Chromium-embedded windows AND on
// any Chrome with a remote-debugging port open ("this browser or app may not be secure"), so neither
// spoofing nor a debug-port Chrome can sign in. Instead we run two passes against a persistent,
// per-profile Chrome user-data-dir:
//   1. LOGIN  — launch Chrome with NO debug port (Google is happy); the user signs in by hand.
//   2. HARVEST — once they close it, relaunch the SAME profile headless WITH a debug port (it opens
//                about:blank, never a Google page, so the block doesn't fire) and mirror its cookies
//                into the profile's Electron partition. A later recording in the webview is then
//                already authenticated. The user-data-dir is keyed by partition, so re-selecting the
//                profile reopens the same already-logged-in Chrome.

interface CdpCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  session: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Candidate Chrome/Chromium executable paths for the current OS, in preference order. */
function chromeCandidates(): string[] {
  if (process.platform === 'win32') {
    return [
      process.env['PROGRAMFILES'] && join(process.env['PROGRAMFILES'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env['PROGRAMFILES(X86)'] &&
        join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env['LOCALAPPDATA'] && join(process.env['LOCALAPPDATA'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ].filter((p): p is string => Boolean(p))
  }

  if (process.platform === 'darwin') {
    const home = process.env['HOME'] ?? ''

    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      home && join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ].filter((p): p is string => Boolean(p))
  }

  // Linux (and other unix): well-known install paths, plus every Chrome/Chromium name on PATH.
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
  const onPath = (process.env['PATH'] ?? '')
    .split(':')
    .filter(Boolean)
    .flatMap((dir) => names.map((n) => join(dir, n)))

  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    ...onPath,
  ]
}

/** Locate the user's installed Chrome/Chromium for the current OS, or null if none is found. */
function findChromeExe(): string | null {
  return chromeCandidates().find((p) => existsSync(p)) ?? null
}

/** A filesystem-safe slug for a partition name (e.g. "persist:decoy-work" -> "persist-decoy-work"). */
function slugPartition(partition: string): string {
  return partition.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'default'
}

/** The persistent Chrome user-data-dir for a partition (one logged-in Chrome session per profile). */
function chromeUserDataDir(partition: string): string {
  return join(app.getPath('userData'), 'chrome-login', slugPartition(partition))
}

/** Has this profile ever been logged into via Chrome? (Its user-data-dir exists on disk.) */
export function hasChromeSession(partition: string): boolean {
  return existsSync(chromeUserDataDir(partition))
}

/** Delete a profile's Chrome session dir (called when the profile itself is deleted). */
export function removeChromeSession(partition: string): void {
  rmSync(chromeUserDataDir(partition), { recursive: true, force: true })
}

/** Chrome writes its actual debugging port to <user-data-dir>/DevToolsActivePort once it's up. */
async function waitForDevToolsPort(userDataDir: string): Promise<number> {
  const file = join(userDataDir, 'DevToolsActivePort')

  for (let i = 0; i < 60; i++) {
    try {
      const txt = await readFile(file, 'utf8')
      const port = Number.parseInt(txt.split('\n')[0]?.trim() ?? '', 10)

      if (port > 0) {
        return port
      }
    } catch {
      // not written yet
    }

    await delay(250)
  }

  throw new Error('Chrome DevTools port never appeared')
}

/** Pull all cookies from the running Chrome via the browser-level CDP endpoint. */
async function fetchCookiesViaCdp(port: number): Promise<CdpCookie[]> {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`)
  const info = (await res.json()) as { webSocketDebuggerUrl?: string }
  const wsUrl = info.webSocketDebuggerUrl

  if (!wsUrl || typeof WebSocket === 'undefined') {
    throw new Error('CDP WebSocket endpoint unavailable')
  }

  return new Promise<CdpCookie[]>((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('CDP cookie fetch timed out'))
    }, 5000)

    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Storage.getCookies' })))
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('CDP WebSocket error'))
    })
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: { cookies?: CdpCookie[] } }

      if (msg.id === 1) {
        clearTimeout(timer)
        ws.close()
        resolve(msg.result?.cookies ?? [])
      }
    })
  })
}

function mapSameSite(s: CdpCookie['sameSite']): 'unspecified' | 'no_restriction' | 'lax' | 'strict' {
  if (s === 'Strict') {
    return 'strict'
  }

  if (s === 'Lax') {
    return 'lax'
  }

  if (s === 'None') {
    return 'no_restriction'
  }

  return 'unspecified'
}

/** Copy Chrome's cookies into the Electron profile partition so a later recording is authenticated. */
async function syncCookies(port: number, ses: Session): Promise<number> {
  const cookies = await fetchCookiesViaCdp(port)
  let count = 0

  for (const c of cookies) {
    const host = c.domain.replace(/^\./, '')
    const url = `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`

    try {
      await ses.cookies.set({
        url,
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        expirationDate: !c.session && c.expires > 0 ? c.expires : undefined,
        sameSite: mapSameSite(c.sameSite),
      })
      count++
    } catch {
      // Chrome stores some host-only / __Host- cookies that don't round-trip cleanly; skip them.
    }
  }

  return count
}

export interface LaunchLoginChromeOptions {
  startUrl: string
  /** Electron partition to copy the login cookies into; undefined = a throwaway session (not saved). */
  partition?: string
}

/**
 * Launch real Chrome for sign-in and mirror its cookies into the profile partition. Chrome runs with
 * a persistent per-profile user-data-dir (so the login survives across launches) and a remote
 * debugging port; while it's open we poll its cookies into the Electron partition every few seconds,
 * so by the time the user finishes login and switches to Record, the partition is authenticated.
 */
export function launchLoginChrome(opts: LaunchLoginChromeOptions): { ok: boolean; error?: string } {
  const exe = findChromeExe()

  if (!exe) {
    return { ok: false, error: 'Could not find an installed Chrome or Chromium on this machine.' }
  }

  const partition = opts.partition ?? 'login-ephemeral'
  const userDataDir = chromeUserDataDir(partition)
  const ses = session.fromPartition(partition)

  // Phase 1 — LOGIN: launch Chrome with NO debugging port. Google rejects sign-in ("this browser
  // or app may not be secure") on any Chrome with remote debugging open, so we keep it off here.
  // Persistent user-data-dir means the login is written to that profile's cookie store on disk.
  const login = spawn(
    exe,
    [`--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check', opts.startUrl],
    { stdio: 'ignore' },
  )

  // Phase 2 — HARVEST: once the user closes the login window, relaunch the SAME profile headless WITH
  // a debugging port (it opens about:blank, never a Google sign-in page, so the block doesn't fire)
  // and mirror its cookies into the Electron partition. Delay lets Chrome release the profile lock.
  login.on('exit', () => {
    setTimeout(() => {
      void harvestCookies(exe, userDataDir, ses, partition).catch((err) =>
        console.error('[chrome-login] cookie harvest failed:', err),
      )
    }, 1500)
  })

  return { ok: true }
}

/** Re-open the logged-in profile headless with a debugging port, copy its cookies, then quit. */
async function harvestCookies(exe: string, userDataDir: string, ses: Session, partition: string): Promise<void> {
  // Drop any stale port file so we wait for THIS launch's value, not a previous run's dead port.
  await rm(join(userDataDir, 'DevToolsActivePort'), { force: true })

  const harvester = spawn(
    exe,
    [
      `--user-data-dir=${userDataDir}`,
      '--headless=new',
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    const port = await waitForDevToolsPort(userDataDir)
    const n = await syncCookies(port, ses)

    console.log(`[chrome-login] synced ${n} cookies into ${partition}`)
  } finally {
    harvester.kill()
  }
}
