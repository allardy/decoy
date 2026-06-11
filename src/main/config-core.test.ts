import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  addProfile,
  parseConfig,
  pushHistory,
  readConfig,
  removeProfile,
  setProfileChromeLogin,
  slugifyProfile,
  writeConfig,
} from './config-core.js'
import { defaultFilters } from './recording/filters.js'

const FALLBACK = '/default/sessions'

describe('parseConfig', () => {
  it('keeps a valid sessionsRoot and history, defaulting filters', () => {
    expect(parseConfig('{"sessionsRoot":"/x/y","urlHistory":["https://a"]}', FALLBACK)).toEqual({
      sessionsRoot: '/x/y',
      urlHistory: ['https://a'],
      filters: defaultFilters(),
      profiles: [],
      lastProfileId: 'default',
      defaultChromeLogin: false,
    })
  })

  it('parses profiles and lastProfileId, dropping malformed entries', () => {
    const cfg = parseConfig(
      '{"profiles":[{"id":"work","label":"Work"},{"id":42},"nope"],"lastProfileId":"work"}',
      FALLBACK,
    )

    expect(cfg.profiles).toEqual([{ id: 'work', label: 'Work', chromeLogin: false }])
    expect(cfg.lastProfileId).toBe('work')
  })

  it('parses chromeLogin on profiles and defaultChromeLogin', () => {
    const cfg = parseConfig(
      '{"profiles":[{"id":"work","label":"Work","chromeLogin":true}],"defaultChromeLogin":true}',
      FALLBACK,
    )

    expect(cfg.profiles).toEqual([{ id: 'work', label: 'Work', chromeLogin: true }])
    expect(cfg.defaultChromeLogin).toBe(true)
  })

  it('defaults profiles to [] and lastProfileId to "default" when absent', () => {
    const cfg = parseConfig('{"sessionsRoot":"/x"}', FALLBACK)

    expect(cfg.profiles).toEqual([])
    expect(cfg.lastProfileId).toBe('default')
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
    expect(parseConfig('{}', FALLBACK)).toEqual({
      sessionsRoot: FALLBACK,
      urlHistory: [],
      filters: defaultFilters(),
      profiles: [],
      lastProfileId: 'default',
      defaultChromeLogin: false,
    })
  })

  it('falls back on corrupt JSON', () => {
    expect(parseConfig('{not json', FALLBACK)).toEqual({
      sessionsRoot: FALLBACK,
      urlHistory: [],
      filters: defaultFilters(),
      profiles: [],
      lastProfileId: 'default',
      defaultChromeLogin: false,
    })
  })
})

describe('slugifyProfile', () => {
  it('lowercases and dashes non-alphanumerics', () => {
    expect(slugifyProfile('  My Work Account! ')).toBe('my-work-account')
  })

  it('collapses runs and trims edge dashes', () => {
    expect(slugifyProfile('a / b -- c')).toBe('a-b-c')
    expect(slugifyProfile('***')).toBe('')
  })
})

describe('addProfile', () => {
  it('adds a profile with a slugged id, trimmed label, and chromeLogin off by default', () => {
    expect(addProfile([], '  Work ')).toEqual({
      profiles: [{ id: 'work', label: 'Work', chromeLogin: false }],
      id: 'work',
    })
  })

  it('stores the chromeLogin flag when requested', () => {
    expect(addProfile([], 'Work', true).profiles).toEqual([{ id: 'work', label: 'Work', chromeLogin: true }])
  })

  it('dedupes the id with a numeric suffix', () => {
    const { profiles, id } = addProfile([{ id: 'work', label: 'Work' }], 'Work')

    expect(id).toBe('work-2')
    expect(profiles).toHaveLength(2)
  })

  it('rejects empty and reserved names', () => {
    expect(() => addProfile([], '   ')).toThrow()
    expect(() => addProfile([], '***')).toThrow()
    expect(() => addProfile([], 'Default')).toThrow()
    expect(() => addProfile([], 'fresh')).toThrow()
  })
})

describe('setProfileChromeLogin', () => {
  it('flips the flag on the matching id only', () => {
    const profiles = [
      { id: 'a', label: 'A', chromeLogin: false },
      { id: 'b', label: 'B', chromeLogin: false },
    ]

    expect(setProfileChromeLogin(profiles, 'a', true)).toEqual([
      { id: 'a', label: 'A', chromeLogin: true },
      { id: 'b', label: 'B', chromeLogin: false },
    ])
  })

  it('is a no-op for an unknown id', () => {
    const profiles = [{ id: 'a', label: 'A', chromeLogin: false }]

    expect(setProfileChromeLogin(profiles, 'zzz', true)).toEqual(profiles)
  })
})

describe('removeProfile', () => {
  it('drops the matching id and is a no-op otherwise', () => {
    const profiles = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ]

    expect(removeProfile(profiles, 'a')).toEqual([{ id: 'b', label: 'B' }])
    expect(removeProfile(profiles, 'zzz')).toEqual(profiles)
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
      profiles: [],
      lastProfileId: 'default',
      defaultChromeLogin: false,
    })
  })

  it('round-trips a written config', async () => {
    const cfg = {
      sessionsRoot: '/captured/here',
      urlHistory: ['https://x'],
      filters: defaultFilters(),
      profiles: [{ id: 'work', label: 'Work', chromeLogin: true }],
      lastProfileId: 'work',
      defaultChromeLogin: true,
    }

    await writeConfig(dir, cfg)
    expect(await readConfig(dir, FALLBACK)).toEqual(cfg)
  })

  it('falls back when the stored file is corrupt', async () => {
    await writeFile(join(dir, 'decoy.json'), '{ broken', 'utf8')
    expect(await readConfig(dir, FALLBACK)).toEqual({
      sessionsRoot: FALLBACK,
      urlHistory: [],
      filters: defaultFilters(),
      profiles: [],
      lastProfileId: 'default',
      defaultChromeLogin: false,
    })
  })
})
