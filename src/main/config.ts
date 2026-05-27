import { app } from 'electron'
import { join } from 'node:path'

import { pushHistory, readConfig, writeConfig, type DecoyConfig } from './config-core.js'
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
