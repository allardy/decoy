import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { defaultFilters } from './recording/filters.js'
import type { FilterConfig } from './recording/types.js'

// Pure config logic, decoupled from Electron so it unit-tests without an app.
// The Electron wrapper (config.ts) supplies the real userData dir + default root.

/** A named persistent browser session. `id` is the partition slug; `label` is shown to the user. */
export interface Profile {
  id: string
  label: string
  /**
   * When true, this profile signs in via the user's REAL external Chrome (the escape hatch for
   * Google-gated sign-in, which rejects Chromium-embedded/debug-port browsers). Its cookies are
   * mirrored into the Electron partition. Recording itself still happens in the webview.
   */
  chromeLogin?: boolean
}

export interface DecoyConfig {
  /** Folder Decoy writes recordings into (the last folder the user picked). */
  sessionsRoot: string
  /** Recently used start URLs, most-recent-first, for autocomplete. */
  urlHistory: string[]
  /** Capture filter — which resource types / hosts to skip. */
  filters: FilterConfig
  /** Custom profiles only — "Default" and "Fresh" are built-in selections, not stored here. */
  profiles: Profile[]
  /** Remembered profile selection: "fresh" | "default" | a custom profile id. */
  lastProfileId: string
  /** Whether the built-in Default profile uses the real-Chrome login escape hatch (see Profile). */
  defaultChromeLogin: boolean
}

const FILE = 'decoy.json'
const HISTORY_MAX = 25

// Built-in selections that can't be used as custom profile ids.
export const RESERVED_PROFILE_IDS = new Set(['default', 'fresh'])

function defaults(fallbackRoot: string): DecoyConfig {
  return {
    sessionsRoot: fallbackRoot,
    urlHistory: [],
    filters: defaultFilters(),
    profiles: [],
    lastProfileId: 'default',
    defaultChromeLogin: false,
  }
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.filter((x: unknown): x is string => typeof x === 'string') : fallback
}

function parseFilters(raw: unknown): FilterConfig {
  const d = defaultFilters()

  if (!raw || typeof raw !== 'object') {
    return d
  }

  const r = raw as { skipResourceTypes?: unknown; blockHosts?: unknown }

  return {
    skipResourceTypes: asStringArray(r.skipResourceTypes, d.skipResourceTypes),
    blockHosts: asStringArray(r.blockHosts, d.blockHosts),
  }
}

function parseProfiles(raw: unknown): Profile[] {
  if (!Array.isArray(raw)) {
    return []
  }

  return raw
    .filter(
      (p): p is Profile =>
        !!p &&
        typeof p === 'object' &&
        typeof (p as Profile).id === 'string' &&
        typeof (p as Profile).label === 'string',
    )
    .map((p) => ({ id: p.id, label: p.label, chromeLogin: (p as { chromeLogin?: unknown }).chromeLogin === true }))
}

export function parseConfig(raw: string, fallbackRoot: string): DecoyConfig {
  try {
    const parsed = JSON.parse(raw)
    const sessionsRoot =
      typeof parsed?.sessionsRoot === 'string' && parsed.sessionsRoot.trim() ? parsed.sessionsRoot : fallbackRoot
    const urlHistory = asStringArray(parsed?.urlHistory, [])
    const lastProfileId =
      typeof parsed?.lastProfileId === 'string' && parsed.lastProfileId.trim() ? parsed.lastProfileId : 'default'

    return {
      sessionsRoot,
      urlHistory,
      filters: parseFilters(parsed?.filters),
      profiles: parseProfiles(parsed?.profiles),
      lastProfileId,
      defaultChromeLogin: parsed?.defaultChromeLogin === true,
    }
  } catch {
    return defaults(fallbackRoot)
  }
}

/** Turn a display label into a partition-safe slug: lowercase, non-alphanumerics → single dash. */
export function slugifyProfile(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Append a new profile, deriving a unique id from the label. Throws on an empty/reserved name.
 * Collisions get a numeric suffix (`work`, `work-2`, …). Returns the new list and the created id.
 */
export function addProfile(
  profiles: Profile[],
  label: string,
  chromeLogin = false,
): { profiles: Profile[]; id: string } {
  const trimmed = label.trim()
  const base = slugifyProfile(trimmed)

  if (!base || RESERVED_PROFILE_IDS.has(base)) {
    throw new Error(`"${trimmed}" is not a valid profile name`)
  }

  const taken = new Set(profiles.map((p) => p.id))
  let id = base
  let n = 2

  while (taken.has(id)) {
    id = `${base}-${n}`
    n += 1
  }

  return { profiles: [...profiles, { id, label: trimmed, chromeLogin }], id }
}

/** Drop a profile by id (no-op if absent). */
export function removeProfile(profiles: Profile[], id: string): Profile[] {
  return profiles.filter((p) => p.id !== id)
}

/** Flip a custom profile's chrome-login flag (no-op if absent). */
export function setProfileChromeLogin(profiles: Profile[], id: string, value: boolean): Profile[] {
  return profiles.map((p) => (p.id === id ? { ...p, chromeLogin: value } : p))
}

/** Add a URL to the front of the history, de-duplicated and capped. */
export function pushHistory(history: string[], url: string, max = HISTORY_MAX): string[] {
  const u = url.trim()

  if (!u) {
    return history
  }

  return [u, ...history.filter((h) => h !== u)].slice(0, max)
}

export async function readConfig(configDir: string, fallbackRoot: string): Promise<DecoyConfig> {
  try {
    const raw = await readFile(join(configDir, FILE), 'utf8')

    return parseConfig(raw, fallbackRoot)
  } catch {
    // missing file → defaults
    return defaults(fallbackRoot)
  }
}

export async function writeConfig(configDir: string, config: DecoyConfig): Promise<void> {
  await mkdir(configDir, { recursive: true })
  await writeFile(join(configDir, FILE), JSON.stringify(config, null, 2), 'utf8')
}
