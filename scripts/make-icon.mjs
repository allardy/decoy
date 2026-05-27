// Generates Decoy's app icon — a red record dot wrapped in concentric indigo
// "capture" rings on a dark rounded square. One set of geometry constants drives
// BOTH an SVG (committed as the source of truth + used as the favicon) and the
// rasterized PNGs, so the two can never drift. No native deps: the PNG is drawn
// with signed-distance-field anti-aliasing and encoded with node:zlib.
//
//   node scripts/make-icon.mjs   (or `pnpm icon`)
//
// Outputs:
//   src/renderer/public/decoy-icon.svg — favicon (index.html) + design source
//   build/icon.png                     — electron-builder source (.ico/.icns) + runtime window icon

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// --- geometry / palette (the single source of truth) ----------------------
const SIZE = 1024
const C = SIZE / 2
const RECT_R = 200 // corner radius of the full-bleed rounded square
const AA = 1.4 // SDF anti-alias width, in pixels

const BG_TOP = [0x1f, 0x1f, 0x23] // matches --card
const BG_BOTTOM = [0x14, 0x14, 0x17] // a touch darker than --bg
const INDIGO = [0x81, 0x8c, 0xf8] // --accent
const RED = [0xef, 0x44, 0x44] // --danger / the REC dot

const RINGS = [
  { r: 210, w: 16, a: 0.9 },
  { r: 300, w: 12, a: 0.5 },
  { r: 392, w: 9, a: 0.28 },
]
const DOT_R = 120
const GLOW_OUTER = 205
const GLOW_ALPHA = 0.25

// --- tiny vector helpers ---------------------------------------------------
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

function roundedRectSdf(px, py, half, r) {
  const qx = Math.abs(px) - (half - r)
  const qy = Math.abs(py) - (half - r)

  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r
}

// straight-alpha source-over compositing, channels in 0..1
function over(dr, dg, db, da, sr, sg, sb, sa) {
  const outA = sa + da * (1 - sa)

  if (outA <= 1e-6) {
    return [0, 0, 0, 0]
  }

  const k = da * (1 - sa)

  return [(sr * sa + dr * k) / outA, (sg * sa + dg * k) / outA, (sb * sa + db * k) / outA, outA]
}

// --- rasterize -------------------------------------------------------------
function render() {
  const buf = Buffer.alloc(SIZE * SIZE * 4) // zero = transparent

  for (let y = 0; y < SIZE; y++) {
    const py = y + 0.5
    const t = y / (SIZE - 1)
    const bg = [
      (BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t) / 255,
      (BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t) / 255,
      (BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t) / 255,
    ]

    for (let x = 0; x < SIZE; x++) {
      const px = x + 0.5
      const bgCov = clamp(0.5 - roundedRectSdf(px - C, py - C, C, RECT_R) / AA, 0, 1)

      if (bgCov <= 0) {
        continue // outside the tile — leave transparent
      }

      let [r, g, b, a] = over(0, 0, 0, 0, bg[0], bg[1], bg[2], bgCov)
      const dist = Math.hypot(px - C, py - C)

      for (const ring of RINGS) {
        const sdf = Math.abs(dist - ring.r) - ring.w / 2
        const cov = clamp(0.5 - sdf / AA, 0, 1) * ring.a

        ;[r, g, b, a] = over(r, g, b, a, INDIGO[0] / 255, INDIGO[1] / 255, INDIGO[2] / 255, cov)
      }

      // soft red halo around the dot, brightest just outside it, fading outward
      const glow = GLOW_ALPHA * clamp((GLOW_OUTER - dist) / (GLOW_OUTER - DOT_R), 0, 1)

      ;[r, g, b, a] = over(r, g, b, a, RED[0] / 255, RED[1] / 255, RED[2] / 255, glow)

      const dotCov = clamp(0.5 - (dist - DOT_R) / AA, 0, 1)

      ;[r, g, b, a] = over(r, g, b, a, RED[0] / 255, RED[1] / 255, RED[2] / 255, dotCov)

      const o = (y * SIZE + x) * 4

      buf[o] = Math.round(r * 255)
      buf[o + 1] = Math.round(g * 255)
      buf[o + 2] = Math.round(b * 255)
      buf[o + 3] = Math.round(a * 255)
    }
  }

  return buf
}

// --- PNG encoder (RGBA, 8-bit) ---------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)

  for (let n = 0; n < 256; n++) {
    let c = n

    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }

    t[n] = c >>> 0
  }

  return t
})()

function crc32(buf) {
  let c = 0xffffffff

  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }

  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)

  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)

  crc.writeUInt32BE(crc32(body), 0)

  return Buffer.concat([len, body, crc])
}

function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13)

  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA

  const stride = w * 4
  const raw = Buffer.alloc((stride + 1) * h)

  for (let y = 0; y < h; y++) {
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// --- SVG (mirrors the same geometry) ---------------------------------------
function buildSvg() {
  const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
  const rings = RINGS.map(
    (ring) =>
      `    <circle cx="${C}" cy="${C}" r="${ring.r}" stroke="${hex(INDIGO)}" stroke-opacity="${ring.a}" stroke-width="${ring.w}" />`,
  ).join('\n')

  return `<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${hex(BG_TOP)}" />
      <stop offset="1" stop-color="${hex(BG_BOTTOM)}" />
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="${DOT_R / GLOW_OUTER}" stop-color="${hex(RED)}" stop-opacity="${GLOW_ALPHA}" />
      <stop offset="1" stop-color="${hex(RED)}" stop-opacity="0" />
    </radialGradient>
    <clipPath id="tile"><rect width="${SIZE}" height="${SIZE}" rx="${RECT_R}" /></clipPath>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" rx="${RECT_R}" fill="url(#bg)" />
  <g clip-path="url(#tile)" fill="none">
${rings}
  </g>
  <circle cx="${C}" cy="${C}" r="${GLOW_OUTER}" fill="url(#glow)" />
  <circle cx="${C}" cy="${C}" r="${DOT_R}" fill="${hex(RED)}" />
</svg>
`
}

// --- write -----------------------------------------------------------------
const png = encodePng(render(), SIZE, SIZE)

mkdirSync(join(root, 'build'), { recursive: true })
mkdirSync(join(root, 'src/renderer/public'), { recursive: true })
writeFileSync(join(root, 'src/renderer/public/decoy-icon.svg'), buildSvg())
writeFileSync(join(root, 'build/icon.png'), png)

console.log(`wrote src/renderer/public/decoy-icon.svg, build/icon.png (${SIZE}x${SIZE}, ${png.length} bytes)`)
