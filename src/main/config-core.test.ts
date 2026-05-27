import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseConfig, pushHistory, readConfig, writeConfig } from './config-core.js'
import { defaultFilters } from './recording/filters.js'

const FALLBACK = '/default/sessions'

describe('parseConfig', () => {
  it('keeps a valid sessionsRoot and history, defaulting filters', () => {
    expect(parseConfig('{"sessionsRoot":"/x/y","urlHistory":["https://a"]}', FALLBACK)).toEqual({
      sessionsRoot: '/x/y',
      urlHistory: ['https://a'],
      filters: defaultFilters(),
    })
  })

  it('parses custom filters and respects an empty skip list', () => {
    const cfg = parseConfig('{"filters":{"skipResourceTypes":[],"blockHosts":["x.com"]}}', FALLBACK)

    expect(cfg.filters).toEqual({ skipResourceTypes: [], blockHosts: ['x.com'] })
  })

  it('falls back to default filters when malformed', () => {
    expect(parseConfig('{"filters":"nope"}', FALLBACK).filters).toEqual(defaultFilters())
    expect(parseConfig('{"filters":{"blockHosts":42}}', FALLBACK).filters.blockHosts).toEqual(
      defaultFilters().blockHosts,
    )
  })

  it('defaults everything when fields are missing or blank', () => {
    expect(parseConfig('{}', FALLBACK)).toEqual({ sessionsRoot: FALLBACK, urlHistory: [], filters: defaultFilters() })
  })

  it('falls back on corrupt JSON', () => {
    expect(parseConfig('{not json', FALLBACK)).toEqual({
      sessionsRoot: FALLBACK,
      urlHistory: [],
      filters: defaultFilters(),
    })
  })
})

describe('pushHistory', () => {
  it('adds the newest url to the front', () => {
    expect(pushHistory(['a'], 'b')).toEqual(['b', 'a'])
  })

  it('de-duplicates by moving an existing url to the front', () => {
    expect(pushHistory(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b'])
  })

  it('caps the list length', () => {
    expect(pushHistory(['a', 'b', 'c'], 'd', 2)).toEqual(['d', 'a'])
  })

  it('ignores blank urls', () => {
    expect(pushHistory(['a'], '   ')).toEqual(['a'])
  })
})

describe('readConfig / writeConfig', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'decoy-cfg-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns defaults when no file exists', async () => {
    expect(await readConfig(dir, FALLBACK)).toEqual({
      sessionsRoot: FALLBACK,
      urlHistory: [],
      filters: defaultFilters(),
    })
  })

  it('round-trips a written config', async () => {
    const cfg = { sessionsRoot: '/captured/here', urlHistory: ['https://x'], filters: defaultFilters() }

    await writeConfig(dir, cfg)
    expect(await readConfig(dir, FALLBACK)).toEqual(cfg)
  })

  it('falls back when the stored file is corrupt', async () => {
    await writeFile(join(dir, 'decoy.json'), '{ broken', 'utf8')
    expect(await readConfig(dir, FALLBACK)).toEqual({
      sessionsRoot: FALLBACK,
      urlHistory: [],
      filters: defaultFilters(),
    })
  })
})
