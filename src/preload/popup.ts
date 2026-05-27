// Runs in the main world of the recorder site view and every popup before any page JS.
// Overrides navigator.userAgentData so client-hints-sniffing services (Slack, etc.) see
// "Google Chrome 140" instead of Electron's "Chromium" / "Not=A?Brand" brand list. The UA
// string itself is spoofed at the session level; this fills in the Client Hints API the same
// way real Chrome does to clear Chrome-only browser sniffers.
//
// Keep brand versions in sync with USER_AGENT and the Sec-Ch-Ua header in src/main/index.ts.

const VERSION = '140'
const FULL_VERSION = '140.0.7339.81'

const brands = [
  { brand: 'Not(A:Brand', version: '24' },
  { brand: 'Chromium', version: VERSION },
  { brand: 'Google Chrome', version: VERSION },
]

const fullVersionList = [
  { brand: 'Not(A:Brand', version: '24.0.0.0' },
  { brand: 'Chromium', version: FULL_VERSION },
  { brand: 'Google Chrome', version: FULL_VERSION },
]

const highEntropy: Record<string, unknown> = {
  architecture: 'x86',
  bitness: '64',
  brands,
  fullVersionList,
  mobile: false,
  model: '',
  platform: 'Windows',
  platformVersion: '15.0.0',
  uaFullVersion: FULL_VERSION,
  wow64: false,
}

const base = () => ({ brands, mobile: false, platform: 'Windows' })

const fakeUserAgentData = {
  brands,
  mobile: false,
  platform: 'Windows',
  getHighEntropyValues(requested: string[]): Promise<unknown> {
    if (!Array.isArray(requested) || requested.length === 0) {
      return Promise.resolve(base())
    }

    const out: Record<string, unknown> = base()

    for (const key of requested) {
      if (key in highEntropy) {
        out[key] = highEntropy[key]
      }
    }

    return Promise.resolve(out)
  },
  toJSON() {
    return base()
  },
}

const define = (target: object): void => {
  try {
    Object.defineProperty(target, 'userAgentData', {
      configurable: true,
      enumerable: true,
      get() {
        return fakeUserAgentData
      },
    })
  } catch {
    // Some Chromium builds lock the property; the session-level UA string and Sec-Ch-Ua
    // headers already pass most sniffers, so this is best-effort.
  }
}

define(Navigator.prototype)
define(navigator)
