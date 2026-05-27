import { describe, expect, it } from 'vitest'

import { shouldCapture } from './filters.js'

describe('shouldCapture', () => {
  it('captures everything when captureAll is on', () => {
    expect(shouldCapture('Image', 'https://x.com/a.png', true)).toBe(true)
    expect(shouldCapture('Script', 'https://google-analytics.com/x', true)).toBe(true)
  })

  it('skips static asset resource types by default', () => {
    for (const t of ['Image', 'Font', 'Stylesheet', 'Media', 'Script']) {
      expect(shouldCapture(t, 'https://x.com/a', false)).toBe(false)
    }
  })

  it('keeps XHR/Fetch/Document', () => {
    expect(shouldCapture('XHR', 'https://api.x.com/users', false)).toBe(true)
    expect(shouldCapture('Fetch', 'https://api.x.com/users', false)).toBe(true)
    expect(shouldCapture('Document', 'https://x.com/', false)).toBe(true)
  })

  it('drops known analytics hosts', () => {
    expect(shouldCapture('XHR', 'https://api.segment.io/v1/t', false)).toBe(false)
    expect(shouldCapture('Fetch', 'https://sentry.io/api/1/envelope', false)).toBe(false)
  })

  it('captures unparseable (but non-data/blob) urls rather than dropping them', () => {
    expect(shouldCapture('XHR', 'weird-scheme:thing', false)).toBe(true)
  })

  it('drops data: and blob: urls by default', () => {
    expect(shouldCapture('Image', 'data:image/png;base64,AAAA', false)).toBe(false)
    expect(shouldCapture('XHR', 'blob:https://x.com/abc', false)).toBe(false)
  })

  it('still captures data:/blob: when captureAll is on', () => {
    expect(shouldCapture('XHR', 'blob:https://x.com/abc', true)).toBe(true)
  })

  it('honors a custom filter config', () => {
    const filters = { skipResourceTypes: ['Document'], blockHosts: ['ads.example.com'] }

    // custom skip list: Document now dropped, Script (a default) now kept
    expect(shouldCapture('Document', 'https://x.com/', false, filters)).toBe(false)
    expect(shouldCapture('Script', 'https://x.com/app.js', false, filters)).toBe(true)
    // custom block host
    expect(shouldCapture('XHR', 'https://ads.example.com/t', false, filters)).toBe(false)
    // a default-blocked host is no longer blocked under the custom list
    expect(shouldCapture('XHR', 'https://api.segment.io/v1/t', false, filters)).toBe(true)
  })

  it('with empty filters, keeps everything except data:/blob', () => {
    const empty = { skipResourceTypes: [], blockHosts: [] }

    expect(shouldCapture('Image', 'https://x.com/a.png', false, empty)).toBe(true)
    expect(shouldCapture('Image', 'data:image/png;base64,AAAA', false, empty)).toBe(false)
  })
})
