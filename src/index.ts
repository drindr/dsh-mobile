/**
 * Host-side half of dsh-mobile. The browser half adapts the stock GUI to
 * phones; this half supplies the PWA chrome the mobile experience needs but
 * the stock harness does not ship, WITHOUT patching harness files:
 *
 *   - `/plugins/@dsh-external/dsh-mobile/manifest.webmanifest` — a served
 *     web manifest (display: standalone, dark background/theme, the plugin's
 *     PNG icon). The stock manifest either misses standalone or points at
 *     assets the stock dist cannot serve; serving our own keeps the mobile
 *     PWA's install-time chrome under the plugin's control (reinstalling the
 *     harness cannot regress it).
 *   - `/plugins/@dsh-external/dsh-mobile/icon.png` — the raster PNG
 *     home-screen icon (iOS refuses SVG/data-URI icons).
 *   - an index.html tap (webServer.tapIndex) that points the manifest link,
 *     the apple-touch-icon, and the status-bar meta at the plugin-owned
 *     URLs above, replacing any stock/patch values in place.
 *
 * Everything is official harness surface (webServer.register /
 * webServer.tapIndex) — no harness file is touched. Route paths live under
 * the plugin's own `/plugins/<id>/` prefix so they can never collide with
 * harness routes; the plugin id is the stable npm-scoped package name.
 */
import { readFile } from 'node:fs/promises'
import type { Context } from 'cordis'

export const name = 'dsh-mobile'
export const inject = ['webServer'] as const

/** The plugin's stable web path prefix (scoped package id, URL-safe). */
const PLUGIN_ID = '@dsh-external/dsh-mobile'
const BASE = `/plugins/${PLUGIN_ID}`
const ICON_PATH = `${BASE}/icon.png`
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
  icons: [
    { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
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

/** The plugin package root (lib/index.js → package root; icon.png lives there). */
const ICON_FILE = new URL('../icon.png', import.meta.url)

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

  web.register({
    kind: 'exact',
    path: ICON_PATH,
    handler: async (req, res) => {
      if (!getOnly(req)) {
        res.writeHead(405)
        res.end()
        return
      }
      try {
        send(res, 200, await readFile(ICON_FILE), 'image/png')
      } catch {
        res.writeHead(404)
        res.end()
      }
    },
  })

  // ---- index.html tap -----------------------------------------------------
  // Replace-in-place (idempotent with or without harness patches): the
  // manifest link, the apple-touch-icon, and the status-bar style all point
  // at the plugin-owned URLs. Inserted into <head> when absent.
  const MANIFEST_TAG = `<link rel="manifest" href="${MANIFEST_PATH}">`
  const ICON_TAG = `<link rel="apple-touch-icon" href="${ICON_PATH}">`
  const ICON_PRECOMPOSED_TAG = `<link rel="apple-touch-icon-precomposed" href="${ICON_PATH}">`
  const STATUS_TAG = `<meta name="apple-mobile-web-app-status-bar-style" content="black">`

  const replaceOrInsert = (html: string, pattern: RegExp, tag: string): string => {
    if (pattern.test(html)) return html.replace(pattern, tag)
    return html.replace('</head>', `${tag}</head>`)
  }

  web.tapIndex((html) => {
    let out = replaceOrInsert(html, /<link[^>]*rel=["']manifest["'][^>]*>/i, MANIFEST_TAG)
    // Exact rel values only, so apple-touch-icon-precomposed stays its own
    // variant (a broad substring match collapsed both into one tag).
    out = replaceOrInsert(out, /<link[^>]*rel=["']apple-touch-icon["'][^>]*>/gi, ICON_TAG)
    out = replaceOrInsert(out, /<link[^>]*rel=["']apple-touch-icon-precomposed["'][^>]*>/gi, ICON_PRECOMPOSED_TAG)
    out = replaceOrInsert(out, /<meta[^>]*name=["']apple-mobile-web-app-status-bar-style["'][^>]*>/i, STATUS_TAG)
    return out
  })
}
