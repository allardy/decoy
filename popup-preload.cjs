// Runs in the main world of the recorder site view and every popup before any
// page JS. Overrides navigator.userAgentData so client-hints-sniffing services
// (Slack, etc.) see "Google Chrome 140" instead of Electron's "Chromium" /
// "Not=A?Brand" brand list. The UA string itself is spoofed at the session
// level; this fills in the Client Hints API the same way real Chrome does to
// clear Chrome-only browser sniffers.
//
// Keep brand versions in sync with USER_AGENT and the Sec-Ch-Ua header in
// electron.mjs.

const VERSION = '140'
const FULL_VERSION = '140.0.7339.81'

const brands = Object.freeze([
  Object.freeze({ brand: 'Not(A:Brand', version: '24' }),
  Object.freeze({ brand: 'Chromium', version: VERSION }),
  Object.freeze({ brand: 'Google Chrome', version: VERSION }),
])

const fullVersionList = Object.freeze([
  Object.freeze({ brand: 'Not(A:Brand', version: '24.0.0.0' }),
  Object.freeze({ brand: 'Chromium', version: FULL_VERSION }),
  Object.freeze({ brand: 'Google Chrome', version: FULL_VERSION }),
])

const highEntropy = Object.freeze({
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
})

const fakeUserAgentData = Object.freeze({
  brands,
  mobile: false,
  platform: 'Windows',
  getHighEntropyValues(requested) {
    if (!Array.isArray(requested) || requested.length === 0) {
      return Promise.resolve({ brands, mobile: false, platform: 'Windows' })
    }

    const out = { brands, mobile: false, platform: 'Windows' }

    for (const key of requested) {
      if (key in highEntropy) {
        out[key] = highEntropy[key]
      }
    }

    return Promise.resolve(Object.freeze(out))
  },
  toJSON() {
    return { brands, mobile: false, platform: 'Windows' }
  },
})

const define = (target) => {
  try {
    Object.defineProperty(target, 'userAgentData', {
      configurable: true,
      enumerable: true,
      get() {
        return fakeUserAgentData
      },
    })
  } catch {
    // Some Chromium builds lock the property; the session-level UA string and
    // Sec-Ch-Ua headers already pass most sniffers, so this is best-effort.
  }
}

define(Navigator.prototype)
define(navigator)
