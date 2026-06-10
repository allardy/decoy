import { app } from 'electron'
import { join } from 'node:path'

import {
  addProfile,
  pushHistory,
  readConfig,
  removeProfile,
  setProfileChromeLogin,
  writeConfig,
  type DecoyConfig,
} from './config-core.js'
import { defaultFilters } from './recording/filters.js'
import type { FilterConfig } from './recording/types.js'

function defaultSessionsRoot(): string {
  return join(app.getPath('documents'), 'Decoy', 'sessions')
}

let cached: DecoyConfig | null = null

async function load(): Promise<DecoyConfig> {
  if (!cached) {
    cached = await readConfig(app.getPath('userData'), defaultSessionsRoot())
  }

  return cached
}

async function persist(next: DecoyConfig): Promise<DecoyConfig> {
  cached = next
  await writeConfig(app.getPath('userData'), next)

  return next
}

export async function getConfig(): Promise<DecoyConfig> {
  return load()
}

export async function getSessionsRoot(): Promise<string> {
  return (await load()).sessionsRoot
}

export async function setSessionsRoot(root: string): Promise<DecoyConfig> {
  const cur = await load()

  return persist({ ...cur, sessionsRoot: root?.trim() || defaultSessionsRoot() })
}

export async function addUrlToHistory(url: string): Promise<DecoyConfig> {
  const cur = await load()

  return persist({ ...cur, urlHistory: pushHistory(cur.urlHistory, url) })
}

export async function clearUrlHistory(): Promise<DecoyConfig> {
  const cur = await load()

  return persist({ ...cur, urlHistory: [] })
}

export async function getFilters(): Promise<FilterConfig> {
  return (await load()).filters
}

export async function setFilters(filters: FilterConfig): Promise<DecoyConfig> {
  const cur = await load()

  return persist({ ...cur, filters })
}

export async function resetFilters(): Promise<DecoyConfig> {
  const cur = await load()

  return persist({ ...cur, filters: defaultFilters() })
}

/** Create a custom profile and select it. Throws on an empty/reserved name. */
export async function createProfile(label: string, chromeLogin = false): Promise<{ config: DecoyConfig; id: string }> {
  const cur = await load()
  const { profiles, id } = addProfile(cur.profiles, label, chromeLogin)
  const config = await persist({ ...cur, profiles, lastProfileId: id })

  return { config, id }
}

/** Toggle a profile's chrome-login flag. `id === 'default'` targets the built-in Default profile. */
export async function setChromeLogin(id: string, value: boolean): Promise<DecoyConfig> {
  const cur = await load()

  if (id === 'default') {
    return persist({ ...cur, defaultChromeLogin: value })
  }

  return persist({ ...cur, profiles: setProfileChromeLogin(cur.profiles, id, value) })
}

/** Remove a custom profile; if it was the remembered selection, fall back to Default. */
export async function deleteProfile(id: string): Promise<DecoyConfig> {
  const cur = await load()
  const lastProfileId = cur.lastProfileId === id ? 'default' : cur.lastProfileId

  return persist({ ...cur, profiles: removeProfile(cur.profiles, id), lastProfileId })
}

/** Remember the last-selected profile so it pre-selects next launch. */
export async function setLastProfileId(id: string): Promise<DecoyConfig> {
  const cur = await load()

  return persist({ ...cur, lastProfileId: id })
}
