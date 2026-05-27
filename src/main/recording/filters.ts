import type { FilterConfig } from './types.js'

// Decides whether a captured request is worth persisting. With "Capture all" on,
// nothing is filtered. Otherwise we drop data:/blob URIs, the configured noisy
// resource types, and any host matching a configured blocked substring. The
// lists below are the defaults; they're user-editable and stored in config.

export const DEFAULT_SKIP_RESOURCE_TYPES = ['Image', 'Font', 'Stylesheet', 'Media', 'Script']

export const DEFAULT_BLOCK_HOSTS = [
  'google-analytics.com',
  'googletagmanager.com',
  'segment.io',
  'mixpanel.com',
  'sentry.io',
  'datadoghq.com',
  'intercom.io',
  'intercom.com',
  'fullstory.com',
  'hotjar.com',
  'amplitude.com',
  'posthog.com',
  'cloudflareinsights.com',
]

export function defaultFilters(): FilterConfig {
  return { skipResourceTypes: [...DEFAULT_SKIP_RESOURCE_TYPES], blockHosts: [...DEFAULT_BLOCK_HOSTS] }
}

export function shouldCapture(resourceType: string, url: string, captureAll: boolean, filters?: FilterConfig): boolean {
  if (captureAll) {
    return true
  }

  // Inline data: URIs and blob: object URLs carry no network call worth replaying.
  if (url.startsWith('data:') || url.startsWith('blob:')) {
    return false
  }

  const skip = filters?.skipResourceTypes ?? DEFAULT_SKIP_RESOURCE_TYPES

  if (skip.includes(resourceType)) {
    return false
  }

  let host: string

  try {
    host = new URL(url).host
  } catch {
    return true
  }

  const blocked = filters?.blockHosts ?? DEFAULT_BLOCK_HOSTS

  return !blocked.some((entry) => host.includes(entry))
}
