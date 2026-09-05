/**
 * Host-side half of dsh-mobile. The browser half adapts the stock GUI to
 * phones; this half supplies the PWA chrome the mobile experience needs but
 * the stock harness does not ship, WITHOUT patching harness files:
 *
 *   - `/plugins/@dsh-external/dsh-mobile/manifest.webmanifest` — a served
 *     web manifest (display: standalone, dark background/theme, the plugin's
 *     opaque PNG icon). The stock manifest either misses standalone or
 *     points at assets the stock dist cannot serve; serving our own keeps
 *     the mobile PWA's install-time chrome under the plugin's control
 *     (reinstalling the harness cannot regress it).
 *   - `/plugins/@dsh-external/dsh-mobile/icon.png` — the 180×180 raster
 *     PNG home-screen icon (iOS refuses SVG/data-URI icons).
 *   - `/plugins/@dsh-external/dsh-mobile/icon-512.png` and
 *     `icon-1024.png` — the high-resolution manifest/Dock icons. macOS
 *     builds Dock and Command-Tab switcher icons from these; an 180 px
 *     source looks soft there.
 *   - `/plugins/@dsh-external/dsh-mobile/icon-dark*.png` — the matching
 *     dark variants advertised through `media="(prefers-color-scheme:
 *     dark)"` for clients that evaluate icon link media queries.
 *   - an index.html tap (webServer.tapIndex) that points the manifest link,
 *     the apple-touch-icons, and the status-bar meta at the plugin-owned
 *     URLs above, replacing any stock/patch values in place.
 *
 * Everything is official harness surface (webServer.register /
 * webServer.tapIndex) — no harness file is touched. Route paths live under
 * the plugin's own `/plugins/<id>/` prefix so they can never collide with
 * harness routes; the plugin id is the stable npm-scoped package name.
 */
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-mobile'
export const inject = ['webServer'] as const

/** The plugin's stable web path prefix (scoped package id, URL-safe). */
const PLUGIN_ID = '@dsh-external/dsh-mobile'
const BASE = `/plugins/${PLUGIN_ID}`
const ICON_PATH = `${BASE}/icon.png`
const ICON_LARGE_PATH = `${BASE}/icon-512.png`
const ICON_XLARGE_PATH = `${BASE}/icon-1024.png`
const ICON_DARK_PATH = `${BASE}/icon-dark.png`
const ICON_DARK_LARGE_PATH = `${BASE}/icon-dark-512.png`
const ICON_DARK_XLARGE_PATH = `${BASE}/icon-dark-1024.png`
const MANIFEST_PATH = `${BASE}/manifest.webmanifest`

/** The served manifest mirrors the stock one, with the plugin-owned icon and
 *  standalone display (the mobile PWA must not run in fullscreen on iOS —
 *  iOS 27 regressed the fullscreen status bar, see WebKit bug 317153). */
const MANIFEST_JSON = JSON.stringify({
  id: '/',
  name: 'DeepSeek Harness',
  short_name: 'DSH',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  // Keep only the opaque PNG here: manifest icons cannot switch on
  // prefers-color-scheme, and macOS Safari's Add to Dock reads these first.
  // The adaptive transparent /favicon.svg would render as a white glyph on
  // the Dock icon's light backing in dark mode.
  icons: [
    { src: ICON_XLARGE_PATH, sizes: '1024x1024', type: 'image/png', purpose: 'any' },
    { src: ICON_LARGE_PATH, sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: ICON_PATH, sizes: '180x180', type: 'image/png', purpose: 'any' },
  ],
  background_color: '#151517',
  theme_color: '#151517',
})

/** Minimal structural faces of the harness services (no type dependency). */
interface WebServerLike {
  tapIndex(transform: (html: string) => string): () => void
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
  }): () => void
}

/** The plugin package root (lib/index.js → package root; the icons live there). */
const ICON_FILES = new Map([
  [ICON_PATH, new URL('../icon.png', import.meta.url)],
  [ICON_LARGE_PATH, new URL('../icon-512.png', import.meta.url)],
  [ICON_XLARGE_PATH, new URL('../icon-1024.png', import.meta.url)],
  [ICON_DARK_PATH, new URL('../icon-dark.png', import.meta.url)],
  [ICON_DARK_LARGE_PATH, new URL('../icon-dark-512.png', import.meta.url)],
  [ICON_DARK_XLARGE_PATH, new URL('../icon-dark-1024.png', import.meta.url)],
])

const send = (res: import('node:http').ServerResponse, status: number, body: Buffer, type: string): void => {
  res.writeHead(status, {
    'content-type': type,
    'content-length': body.length,
    'cache-control': 'no-cache',
  })
  res.end(body)
}

const getOnly = (req: import('node:http').IncomingMessage): boolean =>
  req.method === 'GET' || req.method === 'HEAD'

export function apply(ctx: Context): void {
  // cordis resolves `inject: ['webServer']` at runtime; the framework's
  // Context type carries no webServer member, so narrow through an assert.
  const web = (ctx as unknown as { webServer: WebServerLike }).webServer

  // ---- routes -------------------------------------------------------------
  const manifestBody = Buffer.from(MANIFEST_JSON, 'utf8')
  web.register({
    kind: 'exact',
    path: MANIFEST_PATH,
    handler: (req, res) => {
      if (!getOnly(req)) {
        res.writeHead(405)
        res.end()
        return
      }
      send(res, 200, manifestBody, 'application/manifest+json')
    },
  })

  for (const [iconPath, iconFile] of ICON_FILES) {
    web.register({
      kind: 'exact',
      path: iconPath,
      handler: async (req, res) => {
        if (!getOnly(req)) {
          res.writeHead(405)
          res.end()
          return
        }
        try {
          send(res, 200, await readFile(iconFile), 'image/png')
        } catch {
          res.writeHead(404)
          res.end()
        }
      },
    })
  }

  // ---- index.html tap -----------------------------------------------------
  // Replace-in-place (idempotent with or without harness patches): the
  // manifest link, the apple-touch-icon links, and the status-bar style all
  // point at the plugin-owned URLs. Inserted into <head> when absent.
  const MANIFEST_TAG = `<link rel="manifest" href="${MANIFEST_PATH}">`
  // The unqualified link is the fallback for clients that ignore `media` on
  // icon links; the dark link overrides it under prefers-color-scheme: dark.
  const ICON_TAGS = [
    `<link rel="apple-touch-icon" sizes="1024x1024" href="${ICON_XLARGE_PATH}">`,
    `<link rel="apple-touch-icon" sizes="1024x1024" href="${ICON_DARK_XLARGE_PATH}" media="(prefers-color-scheme: dark)">`,
    `<link rel="apple-touch-icon" sizes="512x512" href="${ICON_LARGE_PATH}">`,
    `<link rel="apple-touch-icon" sizes="512x512" href="${ICON_DARK_LARGE_PATH}" media="(prefers-color-scheme: dark)">`,
    `<link rel="apple-touch-icon" sizes="180x180" href="${ICON_PATH}">`,
    `<link rel="apple-touch-icon" sizes="180x180" href="${ICON_DARK_PATH}" media="(prefers-color-scheme: dark)">`,
  ].join('')
  const ICON_PRECOMPOSED_TAGS = [
    `<link rel="apple-touch-icon-precomposed" sizes="1024x1024" href="${ICON_XLARGE_PATH}">`,
    `<link rel="apple-touch-icon-precomposed" sizes="1024x1024" href="${ICON_DARK_XLARGE_PATH}" media="(prefers-color-scheme: dark)">`,
    `<link rel="apple-touch-icon-precomposed" sizes="512x512" href="${ICON_LARGE_PATH}">`,
    `<link rel="apple-touch-icon-precomposed" sizes="512x512" href="${ICON_DARK_LARGE_PATH}" media="(prefers-color-scheme: dark)">`,
    `<link rel="apple-touch-icon-precomposed" sizes="180x180" href="${ICON_PATH}">`,
    `<link rel="apple-touch-icon-precomposed" sizes="180x180" href="${ICON_DARK_PATH}" media="(prefers-color-scheme: dark)">`,
  ].join('')
  const STATUS_TAG = `<meta name="apple-mobile-web-app-status-bar-style" content="black">`

  const replaceOrInsert = (html: string, pattern: RegExp, tag: string): string => {
    // Always run the matcher in global mode: one injected tag (or tag group)
    // replaces every existing link of that rel, keeping the tap idempotent
    // even when a harness patch already emitted light and dark variants.
    const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`)
    if (!global.test(html)) return html.replace('</head>', `${tag}</head>`)
    global.lastIndex = 0
    let first = true
    return html.replace(global, () => first ? (first = false, tag) : '')
  }

  web.tapIndex((html) => {
    let out = replaceOrInsert(html, /<link[^>]*rel=["']manifest["'][^>]*>/i, MANIFEST_TAG)
    // Exact rel values only, so apple-touch-icon-precomposed stays its own
    // variant (a broad substring match collapsed both into one tag).
    out = replaceOrInsert(out, /<link[^>]*rel=["']apple-touch-icon["'][^>]*>/gi, ICON_TAGS)
    out = replaceOrInsert(out, /<link[^>]*rel=["']apple-touch-icon-precomposed["'][^>]*>/gi, ICON_PRECOMPOSED_TAGS)
    out = replaceOrInsert(out, /<meta[^>]*name=["']apple-mobile-web-app-status-bar-style["'][^>]*>/i, STATUS_TAG)
    return out
  })
}
