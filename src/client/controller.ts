/**
 * DOM-side mobile controller: the non-React half of the plugin. Owns the
 * pieces the frame itself cannot express — the viewport meta upgrade, the
 * safe-area/keyboard CSS variables, and the pager's live state (page mirror,
 * click-to-return). Everything it installs is removed by
 * dispose(), and every rule it depends on is scoped under the
 * [data-dsh-mobile] attribute it sets on <html>.
 *
 * Mobile layout follows PiUI's chat pager: the STOCK AppFrame becomes a
 * horizontal scroll-snap pager whose columns are two pages — an always-open
 * sidebar page and a full-width chat page. The frame's own state is only
 * touched to expand the auto-collapsed sidebar ONCE below the breakpoint
 * (AppFrame collapses it to the rail on narrow viewports); from then on the
 * pager position is fully user-driven: the app starts on the chat page,
 * a click on the exposed chat card flips back to it, and picking a session
 * in the sidebar returns to it. The sidebar column keeps its full content
 * rendered at all times (a swipe is never state-synced, so it never
 * re-renders).
 *
 * A THIRD page to the right of the chat — sidebar | chat | details — is
 * opt-in: a plugin occupying the details slot (ThreadTrail) sets the
 * DETAILS_PAGE_ATTR attribute on <html> and the pager gains a full-width
 * details page revealed by a left swipe from the chat page. AppFrame's
 * computeColumns never opens the details track on narrow viewports (its
 * desktop fit math forces it to 0), but a closed details column is only
 * visually closed, never unmounted — the CSS simply gives the track a page
 * while the opt-in is present. Without the opt-in the details track is
 * dropped and the pager is exactly the classic two pages.
 */

/** The narrow breakpoint the pager keys off (PiUI's 768px). */
export const MOBILE_BREAKPOINT = '(max-width: 768px)'

/** The <html> attribute that mirrors the pager page the frame is resting on. */
export const PAGE_ATTR = 'data-dshm-page'

/** The <html> opt-in attribute for the THIRD pager page: another plugin
 *  (ThreadTrail) sets it to declare "the details column is a mobile page".
 *  While it is present the pager becomes sidebar | chat | details — a left
 *  swipe from the chat page reveals the details page; without it the pager
 *  stays the classic two pages and the details track is dropped. */
export const DETAILS_PAGE_ATTR = 'data-dshm-details-page'

/** Set on <html> while the pager is close enough to the details page that
 *  it must be RENDERED. The details slot can carry a huge always-mounted
 *  panel (ThreadTrail: ~18k DOM nodes); at rest on the chat page it sits
 *  flush against the viewport edge, inside the content-visibility:auto
 *  relevance margin — so "auto" never skips it (measured: 200ms median
 *  full-document layout flush with it rendered, 74ms hidden, desktop CPU).
 *  The CSS keeps it content-visibility:hidden until this attribute lands. */
const NEAR_DETAILS_ATTR = 'data-dshm-near-details'

/** Fraction of a page the pager must move toward the details page before
 *  it starts rendering (early enough to be painted by arrival). */
const DETAILS_REVEAL_FRACTION = 0.08

/** Pager page names (the mirror values of PAGE_ATTR). */
export type MobilePage = 'sidebar' | 'chat' | 'details'

/** Wait after the last scroll event before the pager settles. */
const SCROLL_SETTLE_MS = 200

/** After a session-row tap, wait this long for the app's own onClick to
 *  switch the session before the plugin opens it itself (a tap the browser
 *  swallowed — scroll suppression, drag-gesture disambiguation — must still
 *  switch on the FIRST tap). */
const TAP_SUPPLEMENT_MS = 150

/** Pointer movement (px) above which a pointerup is a swipe, not a tap. */
const TAP_SLOP = 12

/** The smallest height a real iOS keyboard can have. After the keyboard
 *  closes, iOS can leave the visualViewport shrunken by just the accessory
 *  bar (~44px) while the input keeps focus — an inset below this is that
 *  residue, never a real keyboard, so it must be forced to 0. */
const KEYBOARD_MIN_INSET = 60

/** Conversation scroll depth (px) past which the top bar auto-collapses on
 *  scroll-down. */
const HEADER_COLLAPSE_THRESHOLD = 64

/** The top bar re-expands on ANY upward scroll of at least this many pixels
 *  (the standard mobile bar pattern: hide on scroll-down, reveal on
 *  scroll-up). The slop keeps sub-threshold jitter from flipping the bar;
 *  the collapse threshold plus the overflow guard are what prevent the
 *  clamp-to-top twitch. */
const HEADER_EXPAND_SLOP = 12

/** After the header collapses/expands, layout-driven scrollTop noise (clamp,
 *  anchor, re-anchor) is ignored for this long so it cannot flip the state
 *  right back — the flicker loop. */
const HEADER_QUIET_MS = 600

/** Static home-screen icon shipped with the plugin and served by the harness
 *  at /plugins/<id>/<file> — a REAL URL (Firefox ignores data-URI icons).
 *  It is an opaque brand tile, so it is legible as a light or dark fallback
 *  without any prefers-color-scheme handling here. */
const PLUGIN_ICON_URL = '/plugins/@dsh-external/dsh-mobile/icon.png'

/** The sidebar shell's collapse toggle labels (zh / en) — clicking it while
 *  the sidebar is expanded must NOT collapse it to the rail (which would
 *  unload its content); it flips back to the chat page instead. */
const SIDEBAR_COLLAPSE_LABELS = new Set(['收起侧边栏', 'Collapse sidebar'])

/**
 * Viewport meta content: maximum-scale blocks the iOS focus zoom that would
 * otherwise fight the fixed-height mobile layout. No viewport-fit=cover: in
 * standalone PWA iOS keeps the status-bar strip blurred whenever web content
 * extends underneath it, so we stay at the default viewport-fit=auto and let
 * the app letterbox around the unsafe areas (env() insets read 0, the header
 * and composer pad for the system chrome instead).
 */
const VIEWPORT_CONTENT =
  'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no'

/**
 * The AppFrame keeps at least one of its two data attributes in every state
 * (a closed sidebar renders the rail, a closed details column renders zero
 * width), so the union always selects the frame and never a descendant. The
 * attributes identify the frame wherever it sits in the tree — rc.5 wraps
 * the frame in an extra shell div, so no `#root >` child prefix is assumed.
 */
const FRAME_SELECTOR = 'div[data-sidebar-collapsed], div[data-details-collapsed]'

/** The AppFrame element, or null before the layout entry mounts it. */
function findFrame(): HTMLElement | null {
  return document.querySelector<HTMLElement>(FRAME_SELECTOR)
}

/** Measurement cache entry for the chat-page snap position (see #chatPageLeft). */
interface ChatLeftCache {
  /** The frame the measurement belongs to (re-measure when it is replaced). */
  frame: HTMLElement
  /** The measured sidebar column width (px). */
  left: number
  /** The scrollport width (px) — the full-width chat/details page width. */
  pageWidth: number
}

/** Callbacks the controller needs from the apply world. */
export interface MobileControllerOptions {
  /** Toggle the sidebar panel (frame-owned layout action). */
  toggleSidebar: () => void
  /** Open a session by id (the app sessions service). Used to guarantee a
   *  session-row tap switches even when the browser swallows the click. */
  openSession?: (sessionId: string) => void
  /** Resolve the session id whose title appears in a tapped row's text
   *  (title matching against the sessions list snapshot). */
  resolveSessionId?: (rowText: string) => string | undefined
  /** The currently selected session id (sessions list snapshot). */
  currentSessionId?: () => string | undefined
}

/** A session (other than the current one) waiting on the user: approval,
 *  question, or plan review. Surfaces a tappable banner on phones — the
 *  sidebar's 10px pending dot inside a collapsed workspace group is
 *  effectively invisible on a phone screen. */
export interface PendingInteractionInfo {
  /** The waiting session's id. */
  sessionId: string
  /** Human-facing session title. */
  title: string
  /** Interaction kind (drives the banner copy). */
  kind: 'approval' | 'plan-review' | 'question'
  /** Further waiting sessions beyond the first. */
  extraCount: number
}

/** Test-facing surface of the controller (the class keeps everything else private). */
export interface MobileControllerHandle {
  /** True while the frame shows the sidebar expanded (not the rail). */
  isSidebarOpen(): boolean
  /** Return to the chat page (a session picked in the sidebar). */
  returnToChat(): void
  /** Show/hide the pending-interaction banner (a non-current session waiting
   *  for approval/answer). Pass null to hide. */
  setPendingInteraction(info: PendingInteractionInfo | null): void
  /** Install the controller; idempotent. */
  mount(): void
  /** Remove every DOM effect; idempotent. */
  dispose(): void
}

/** The DOM-side controller (see module doc). */
export class MobileController implements MobileControllerHandle {
  readonly #options: MobileControllerOptions
  #html: HTMLElement | null = null
  #mql: MediaQueryList | null = null
  #frameObserver: MutationObserver | null = null
  #rootObserver: MutationObserver | null = null
  #viewportMeta: HTMLMetaElement | null = null
  #viewportOriginal: string | null = null
  /** Injected iOS home-screen tags (removed on dispose). */
  #pwaTags: Array<HTMLLinkElement | HTMLMetaElement> = []
  #keyboardFrame: number | null = null
  /** While the keyboard inset is non-zero, a poll re-checks that the keyboard
   *  is really still up — iOS can keep the input focused and the
   *  visualViewport shrunken after the keyboard closes, stranding the
   *  composer above the bottom without any event to reset it. */
  #keyboardPollTimer: number | null = null
  /** iOS focus/viewport compensations active (mobile only). */
  #iosFocusPatched = false
  /** Original .focus() implementations (restored on uninstall). */
  #iosFocusOriginals: Array<{ proto: { prototype: { focus: Function } }; orig: Function }> = []
  #mountFrame: number | null = null
  /** True while a details-reveal check is scheduled (see #onPagerScroll). */
  #detailsRevealScheduled = false
  #resizeTimer: number | null = null
  #settleTimer: number | null = null
  /** Pointer-down position for tap-vs-swipe discrimination. */
  #pointerDownPos: { x: number; y: number } | null = null
  /** Pending session-open supplement timers (cleared on dispose). */
  #supplementTimers = new Set<number>()
  /** Watches for the approval panel (a tool waiting for permission) mounting
   *  and keeps it in the visible viewport on phones. */
  #approvalObserver: MutationObserver | null = null
  /** The pending-interaction banner element (non-current session waiting). */
  #pendingBanner: HTMLButtonElement | null = null
  /** The composer input element (message box), or null before it mounts. */
  #composerInput: HTMLInputElement | HTMLTextAreaElement | null = null
  /** Composer input value at the last check (send detection). */
  #composerLastValue = ''
  /** Composer value-poll timer; runs only while the input is focused. */
  #composerPollTimer: number | null = null
  /** Picks up composer input mounts (the seat remounts on session switches). */
  #composerObserver: MutationObserver | null = null
  /** The frame the composer observer is bound to (its callback's re-scan root). */
  #frame: HTMLElement | null = null
  /** Measures the floating header's height without forced layout reads. */
  #headerResizeObserver: ResizeObserver | null = null
  /** The header element currently observed (re-observe when it remounts). */
  #observedHeader: HTMLElement | null = null
  /** The conversation's scroll container (top-bar auto-collapse). */
  #conversationScroll: HTMLElement | null = null
  /** Settle timer for the top-bar evaluation (140 ms quiet window). */
  #headerSettleTimer: number | null = null
  /** scrollTop at the last settled evaluation (net-movement baseline). */
  #lastSettledHeaderTop = 0
  /** Layout-induced scroll noise is ignored until this time (see #settleHeader). */
  #headerQuietUntil = 0
  #expandPending = false
  /** Watches <html> for the DETAILS_PAGE_ATTR opt-in landing after this
   *  plugin mounted (plugin load order is not guaranteed). */
  #pageAttrObserver: MutationObserver | null = null
  /** Cached chat-page snap position (measure once per stable layout, never
   *  inside a scroll handler — reading offsetWidth there forces layout). */
  #chatLeftCache: ChatLeftCache | null = null
  #mounted = false
  #disposed = false

  /** @param options - apply-world callbacks. */
  constructor(options: MobileControllerOptions) {
    this.#options = options
  }

  /** True while the frame shows the sidebar expanded (not the rail). */
  isSidebarOpen(): boolean {
    const frame = findFrame()
    return frame !== null && !frame.hasAttribute('data-sidebar-collapsed')
  }

  /** Return to the chat page (a session picked in the sidebar). Pure scroll —
   *  the sidebar state is untouched, so its content stays rendered. The jump
   *  is INSTANT: picking a session re-renders the conversation column on the
   *  main thread, so a smooth scroll would fight that render and jank. */
  returnToChat(): void {
    this.#placeOnChat('auto')
  }

  /** Show or hide the pending-interaction banner. The app's own pending
   *  indicator is a 10px dot on a session row inside a workspace group —
   *  invisible on a phone unless the user happens to expand the right group
   *  and spot the dot. The banner makes a waiting session one tap away. */
  setPendingInteraction(info: PendingInteractionInfo | null): void {
    if (!(this.#mql?.matches ?? false) || info === null || this.#options.openSession === undefined) {
      this.#removePendingBanner()
      return
    }
    if (this.#pendingBanner === null) {
      const banner = document.createElement('button')
      banner.type = 'button'
      banner.dataset.dshmPendingBanner = ''
      banner.addEventListener('click', () => {
        // The keyboard must not be open while jumping to a waiting session:
        // a leftover input focus would cover the approval panel on phones.
        const active = document.activeElement
        if (active instanceof HTMLElement && active.matches('input, textarea, [contenteditable]')) {
          active.blur()
        }
        this.#options.openSession?.(info.sessionId)
      })
      document.body.append(banner)
      this.#pendingBanner = banner
    }
    const kindLabel: Record<PendingInteractionInfo['kind'], string> = {
      approval: '等待审批',
      'plan-review': '等待审阅',
      question: '等待回答',
    }
    const extra = info.extraCount > 0 ? ` · 另有 ${info.extraCount} 个会话等待` : ''
    this.#pendingBanner.textContent = `${kindLabel[info.kind]} · ${info.title}${extra} — 点击查看`
  }

  readonly #removePendingBanner = (): void => {
    this.#pendingBanner?.remove()
    this.#pendingBanner = null
  }

  /** Measure the chat-page snap position and cache it (never cached from the
   *  unsettled fallback — a 0-width pre-layout read must not poison the
   *  cache). */
  readonly #measureChatLeft = (frame: HTMLElement): number => {
    const sidebar = frame.firstElementChild
    if (sidebar instanceof HTMLElement && sidebar.offsetWidth > 0) {
      this.#chatLeftCache = { frame, left: sidebar.offsetWidth, pageWidth: frame.clientWidth }
      return sidebar.offsetWidth
    }
    return frame.clientWidth
  }

  /** The chat-page snap position for the given frame: the cached value while
   *  the frame (and the viewport) is unchanged, a live measurement
   *  otherwise. Scroll handlers must take the cached path exclusively —
   *  layout reads there are the mobile jank source. */
  readonly #chatPageLeft = (frame: HTMLElement): number => {
    const cache = this.#chatLeftCache
    if (cache !== null && cache.frame === frame && cache.left > 0) return cache.left
    return this.#measureChatLeft(frame)
  }

  /** The full-width page width (the scrollport width — chat and details
   *  pages are both 100% tracks). Cached alongside the chat-page position. */
  readonly #pageWidth = (frame: HTMLElement): number => {
    const cache = this.#chatLeftCache
    if (cache !== null && cache.frame === frame && cache.pageWidth > 0) return cache.pageWidth
    return frame.clientWidth
  }

  /** True while the THIRD pager page (details | ThreadTrail) is live: a
   *  plugin opted in via DETAILS_PAGE_ATTR. The frame's
   *  data-details-collapsed attribute is NOT consulted: AppFrame's
   *  computeColumns forces the details track to 0 on narrow viewports (its
   *  desktop three-column fit math), so the attribute never lifts on a
   *  phone — but a closed details column is only visually closed, never
   *  unmounted, so the CSS gives the track a full-width page whenever the
   *  opt-in is present. */
  readonly #detailsPageOpen = (): boolean => {
    return this.#html?.hasAttribute(DETAILS_PAGE_ATTR) ?? false
  }

  /** Drop the cached snap position (viewport reflow / breakpoint crossing);
   *  the next read re-measures from the live layout. */
  readonly #invalidateChatLeft = (): void => {
    this.#chatLeftCache = null
  }

  /** Paint the document canvas with the app's actual background (theme
   *  aware). `--dsw-alias-bg-base` is defined on <body>, so <html> cannot
   *  inherit it via CSS — without this, the browser's white default canvas
   *  shows as a white edge in the PWA's safe-area zones. */
  readonly #syncCanvasBackground = (): void => {
    const html = document.documentElement
    const resolved = getComputedStyle(document.body).backgroundColor
    if (resolved !== '' && resolved !== 'rgba(0, 0, 0, 0)' && resolved !== 'transparent') {
      html.style.backgroundColor = resolved
    }
  }

  /** Pin the shell height to the ACTUAL layout viewport. In Safari PWA
   *  standalone mode the keyboard resizes the layout viewport, and the
   *  `100dvh` unit can fail to re-evaluate after the keyboard closes — the
   *  app stays ~an accessory bar (44px) short and the composer floats up.
   *  Explicit pixels follow `window.innerHeight` wherever it actually is. */
  readonly #pinLayoutHeight = (): void => {
    const body = document.body
    if (body !== null) body.style.height = `${window.innerHeight}px`
  }

  readonly #unpinLayoutHeight = (): void => {
    document.body.style.removeProperty('height')
  }

  /** The overlay header no longer occupies layout space; the scroll body pads
   *  its top by the header's natural height so the first content rests below
   *  the floating bar. Measure it into --dshm-header-h. Only call this at
   *  setup / explicit re-measure points — getBoundingClientRect forces a
   *  synchronous layout, so it must never ride a MutationObserver batch
   *  (that was the streaming jank). Size changes after attach are tracked
   *  by the ResizeObserver in #attachHeaderMeasure (no layout read). */
  readonly #syncHeaderHeight = (): void => {
    const html = this.#html
    if (html === null) return
    const header = document.querySelector<HTMLElement>(
      '[data-phase="active"] header:not([data-composer-seat] *)',
    )
    if (header === null) return
    const h = Math.round(header.getBoundingClientRect().height)
    if (h > 0) html.style.setProperty('--dshm-header-h', `${h}px`)
  }

  /** Filtered frame-structure watcher. Streaming message content mutates
   *  the frame subtree constantly; re-scanning the seats on every batch was
   *  the streaming jank source. Two cheap paths cover every real change:
   *  1. O(1) disconnect check — a session switch REPLACES the seat elements,
   *     so a tracked element going disconnected means "re-scan now".
   *  2. Only while a seat is missing (never found, or just detached), scan
   *     the added nodes for the seat containers themselves. Streaming adds
   *     content INSIDE the containers, never the containers, so streaming
   *     batches are skipped here (a leaf matches/querySelector is cheap). */
  readonly #onFrameStructureMutation = (mutations: MutationRecord[]): void => {
    const frame = this.#frame
    if (frame === null) return
    const inputGone = this.#composerInput !== null && !this.#composerInput.isConnected
    const scrollGone = this.#conversationScroll !== null && !this.#conversationScroll.isConnected
    if (inputGone || scrollGone) {
      // A remount (session switch) also replaces the header — re-measure.
      this.#attachComposerInput(frame)
      this.#attachConversationScroll(frame)
      this.#attachHeaderMeasure()
      return
    }
    if (this.#composerInput !== null && this.#conversationScroll !== null
      && this.#observedHeader !== null) return
    for (const mutation of mutations) {
      const nodes = mutation.addedNodes
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]
        if (node === undefined || node.nodeType !== 1) continue
        const el = node as Element
        if (el.matches?.('[data-composer-seat], [data-conversation-scroll], [data-phase] header') === true
          || el.querySelector?.('[data-composer-seat], [data-conversation-scroll]') != null
          // The input can mount inside an already-present composer seat.
          || el.closest?.('[data-composer-seat]') !== null) {
          this.#attachComposerInput(frame)
          this.#attachConversationScroll(frame)
          this.#attachHeaderMeasure()
          return
        }
      }
    }
  }

  /** Track the floating header's height with a ResizeObserver (async, no
   *  forced layout) instead of measuring it per mutation batch. Re-observes
   *  when the header element is replaced (session switches remount it). */
  readonly #attachHeaderMeasure = (): void => {
    const header = document.querySelector<HTMLElement>(
      '[data-phase="active"] header:not([data-composer-seat] *)',
    )
    if (header === this.#observedHeader) return
    this.#headerResizeObserver?.disconnect()
    this.#observedHeader = header
    if (header === null) return
    if (typeof ResizeObserver !== 'undefined') {
      this.#headerResizeObserver ??= new ResizeObserver((entries) => {
        const h = Math.round(entries[0]?.contentRect.height ?? 0)
        if (h > 0) this.#html?.style.setProperty('--dshm-header-h', `${h}px`)
      })
      this.#headerResizeObserver.observe(header)
    }
    // One explicit initial measure (a single layout read at attach time).
    this.#syncHeaderHeight()
  }

  /** Install the controller. Safe to call once; a second call is a no-op.
   *  The frame may not exist yet (the layout entry mounts after this
   *  plugin's apply), so the observer chain re-finds it when #root gains
   *  its child. */
  mount(): void {
    if (this.#mounted) return
    this.#mounted = true
    const html = document.documentElement
    this.#html = html
    html.dataset.dshMobile = ''

    this.#installViewportMeta()
    this.#syncCanvasBackground()
    // iOS home-screen icon/manifest (async; harmless when it fails).
    void this.#installPwaAssets()

    this.#mql = window.matchMedia(MOBILE_BREAKPOINT)
    this.#mql.addEventListener('change', this.#onBreakpointChange)
    if (this.#mql.matches) this.#installIosFocusCompensations()

    // Keyboard inset: the visual viewport shrinks when the OS keyboard
    // opens; the composer seat pads itself by the difference (rAF-throttled
    // — the resize fires every frame of the keyboard animation). When the
    // focused composer unmounts (e.g. an approval panel replaces it), the
    // keyboard closes WITHOUT a focus event on an input — re-check the inset
    // so a stale value cannot strand the composer seat (and the approval
    // panel inside it) high above the bottom of the phone screen.
    const vv = window.visualViewport
    vv?.addEventListener('resize', this.#requestKeyboard)
    vv?.addEventListener('scroll', this.#requestKeyboard)
    document.addEventListener('focusout', this.#onFocusOut)

    // Keep the active page in place when the viewport width changes within
    // a breakpoint side (rotation / split-screen reflows the page tracks).
    window.addEventListener('resize', this.#onWindowResize)

    // A tap on the exposed chat card (while the pager rests on the sidebar
    // page) returns to the chat page — PiUI's overlay behavior.
    document.addEventListener('click', this.#onDocClickCapture, true)

    // Keep the approval panel visible on phones: it replaces the composer
    // while a tool waits for permission, and a stale keyboard inset or a
    // mid-layout mount can strand it outside the viewport — the user then
    // cannot approve and the command hangs. The observer is filtered to
    // mutations that actually add/remove the panel, so the constant
    // message-streaming mutations never run the panel check.
    this.#approvalObserver = new MutationObserver(this.#onApprovalMutation)
    this.#approvalObserver.observe(document.body, { childList: true, subtree: true })

    const root = document.getElementById('root')
    if (root !== null) {
      this.#rootObserver = new MutationObserver(() => { this.#ensureFrameObserver() })
      this.#rootObserver.observe(root, { childList: true })
    }
    this.#ensureFrameObserver()

    // The third-page opt-in may land AFTER this plugin mounted (plugin load
    // order is not guaranteed): watch <html> for it and expand the details
    // page when it arrives.
    this.#pageAttrObserver = new MutationObserver(() => {
      // The opt-in toggles the page COUNT (the scrollport grows/shrinks by
      // a full page): drop the cached geometry and re-snap onto the page
      // the user is looking at.
      this.#invalidateChatLeft()
      const frame = findFrame()
      if (frame !== null && (this.#mql?.matches ?? false)) {
        frame.scrollTo({ left: this.#nearestPageLeft(frame, frame.scrollLeft), behavior: 'auto' })
        this.#mirrorPage(frame)
        this.#syncDetailsReveal(frame)
      }
    })
    this.#pageAttrObserver.observe(html, { attributes: true, attributeFilter: [DETAILS_PAGE_ATTR] })

    // The always-open phone layout: expand the sidebar once (AppFrame
    // auto-collapses it to the rail on narrow viewports) so its content
    // stays fully rendered, then start on the CHAT page.
    this.#ensureSidebarOpen()
    this.#placeOnChat('auto')
    this.#mountFrame = requestAnimationFrame(() => {
      this.#mountFrame = null
      this.#ensureSidebarOpen()
      this.#placeOnChat('auto')
      // Normalize the window scroll (iOS can restore a stale offset on a
      // resumed PWA), pin the shell height to the real viewport, and
      // re-measure the composer's safe-area shortfall once the layout has
      // settled.
      this.#resetDocumentScroll()
      this.#pinLayoutHeight()
      window.setTimeout(() => { this.#syncComposerSafeShortfall() }, 400)
    })
  }

  /** Remove every DOM effect; safe to call twice. */
  dispose(): void {
    if (!this.#mounted || this.#disposed) return
    this.#disposed = true
    this.#mounted = false
    this.#frameObserver?.disconnect()
    this.#frameObserver = null
    this.#rootObserver?.disconnect()
    this.#rootObserver = null
    this.#pageAttrObserver?.disconnect()
    this.#pageAttrObserver = null
    this.#approvalObserver?.disconnect()
    this.#approvalObserver = null
    this.#composerObserver?.disconnect()
    this.#composerObserver = null
    this.#frame = null
    this.#headerResizeObserver?.disconnect()
    this.#headerResizeObserver = null
    this.#observedHeader = null
    this.#detachComposerInput()
    this.#detachConversationScroll()
    this.#removeIosFocusCompensations()
    this.#mql?.removeEventListener('change', this.#onBreakpointChange)
    this.#mql = null
    window.removeEventListener('resize', this.#onWindowResize)
    document.removeEventListener('focusout', this.#onFocusOut)
    window.visualViewport?.removeEventListener('resize', this.#requestKeyboard)
    window.visualViewport?.removeEventListener('scroll', this.#requestKeyboard)
    document.removeEventListener('click', this.#onDocClickCapture, true)
    for (const timer of [this.#keyboardFrame, this.#mountFrame, this.#resizeTimer, this.#settleTimer, this.#keyboardPollTimer]) {
      if (timer !== null) (timer === this.#keyboardFrame || timer === this.#mountFrame ? cancelAnimationFrame : window.clearTimeout)(timer)
    }
    this.#keyboardPollTimer = null
    for (const timer of this.#supplementTimers) window.clearTimeout(timer)
    this.#supplementTimers.clear()
    this.#removePendingBanner()
    this.#keyboardFrame = null
    this.#mountFrame = null
    this.#resizeTimer = null
    this.#settleTimer = null
    this.#pointerDownPos = null
    const frame = findFrame()
    if (frame !== null) {
      frame.removeEventListener('scroll', this.#onPagerScroll)
      frame.removeEventListener('pointerdown', this.#onPagerPointerDown)
      frame.removeEventListener('pointerup', this.#onPagerPointerUp)
    }
    if (this.#viewportMeta !== null) {
      if (this.#viewportOriginal !== null) this.#viewportMeta.content = this.#viewportOriginal
      else this.#viewportMeta.remove()
      this.#viewportMeta = null
      this.#viewportOriginal = null
    }
    for (const tag of this.#pwaTags) tag.remove()
    this.#pwaTags = []
    const html = this.#html
    if (html !== null) {
      html.removeAttribute('data-dsh-mobile')
      html.removeAttribute(PAGE_ATTR)
      html.removeAttribute(NEAR_DETAILS_ATTR)
      html.removeAttribute('data-dshm-header-collapsed')
      html.style.removeProperty('--dshm-keyboard-inset')
      html.style.removeProperty('--dshm-safe-shortfall')
      html.style.removeProperty('background-color')
    }
    this.#unpinLayoutHeight()
    this.#chatLeftCache = null
    this.#detailsRevealScheduled = false
    this.#expandPending = false
    this.#html = null
  }

  #installViewportMeta(): void {
    const existing = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    if (existing !== null) {
      this.#viewportMeta = existing
      this.#viewportOriginal = existing.content
      existing.content = VIEWPORT_CONTENT
      return
    }
    const meta = document.createElement('meta')
    meta.name = 'viewport'
    meta.content = VIEWPORT_CONTENT
    document.head.append(meta)
    this.#viewportMeta = meta
  }

  /** iOS home-screen icon. In this deployment the server-rendered index
   *  already carries the apple-touch-icon links (including the dark variant)
   *  and the manifest ships the opaque PNG icon, so this early-returns. The
   *  injection below only matters on a stock harness whose index was not
   *  patched: it re-adds the icon and the iOS meta, preferring the plugin's
   *  statically served PNG (a real URL — Firefox/iOS ignore data URIs) with
   *  a runtime-rasterized whale as the standalone fallback. */
  async #installPwaAssets(): Promise<void> {
    const head = document.head
    if (head === null || head.querySelector('link[rel="apple-touch-icon"]') !== null) return
    let iconUrl: string | null = null
    try {
      const probe = await fetch(PLUGIN_ICON_URL, { method: 'HEAD' })
      if (probe.ok) iconUrl = PLUGIN_ICON_URL
    } catch { /* fall through to rasterization */ }
    if (iconUrl === null) {
      try {
        const svg = (await (await fetch('/favicon.svg')).text())
          // Drop the scheme-dependent <style> — the Path2D rasterizer fills
          // the whale itself, so the path's own attributes don't matter.
          .replace(/<style>[\s\S]*?<\/style>/g, '')
        iconUrl = await this.#rasterizeSvg(svg, '#3964fe', '#ffffff')
      } catch {
        iconUrl = this.#drawFallbackIcon('#3964fe', '#ffffff')
      }
    }
    if (iconUrl === null) return
    const icon = document.createElement('link')
    icon.rel = 'apple-touch-icon'
    icon.href = iconUrl
    head.append(icon)
    this.#pwaTags.push(icon)
    const metas: Array<[string, string]> = [
      ['apple-mobile-web-app-capable', 'yes'],
      ['apple-mobile-web-app-status-bar-style', 'black'],
      ['apple-mobile-web-app-title', 'DeepSeek Harness'],
    ]
    for (const [name, content] of metas) {
      if (head.querySelector(`meta[name="${name}"]`) !== null) continue
      const meta = document.createElement('meta')
      meta.name = name
      meta.content = content
      head.append(meta)
      this.#pwaTags.push(meta)
    }
  }

  /** Draw the DSH whale favicon path directly onto the canvas via Path2D.
   *  Loading the SVG as an <img> is unreliable in some Blink/WebKit contexts
   *  (it silently fails and the icon would fall back to a letter), while the
   *  path data in the shipped favicon is stable. The favicon viewBox is
   *  50×50; the whale is drawn padded inside the 180×180 canvas. */
  async #rasterizeSvg(svg: string, background: string, foreground: string): Promise<string> {
    const SIZE = 180
    const pathMatch = /<path[^>]*\bd="([^"]*)"/.exec(svg)
    if (pathMatch === null) throw new Error('no path in favicon')
    const canvas = document.createElement('canvas')
    canvas.width = SIZE
    canvas.height = SIZE
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('canvas 2d unavailable')
    ctx.fillStyle = background
    ctx.fillRect(0, 0, SIZE, SIZE)
    const whale = new Path2D(pathMatch[1])
    const pad = Math.round(SIZE * 0.18)
    ctx.translate(pad, pad)
    ctx.scale((SIZE - pad * 2) / 50, (SIZE - pad * 2) / 50)
    ctx.fillStyle = foreground
    ctx.fill(whale)
    return canvas.toDataURL('image/png')
  }

  /** Opaque tile with the whale fallback letter — used when the favicon
   *  fetch or rasterization fails. */
  #drawFallbackIcon(background: string, foreground: string): string {
    const SIZE = 180
    const canvas = document.createElement('canvas')
    canvas.width = SIZE
    canvas.height = SIZE
    const ctx = canvas.getContext('2d')
    if (ctx === null) return ''
    ctx.fillStyle = background
    ctx.fillRect(0, 0, SIZE, SIZE)
    ctx.fillStyle = foreground
    ctx.font = 'bold 120px system-ui, -apple-system, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('D', SIZE / 2, SIZE / 2 + 6)
    return canvas.toDataURL('image/png')
  }

  /** The always-open phone layout expands the docked sidebar once when the
   *  viewport crosses into the mobile breakpoint (AppFrame auto-collapses
   *  it to the rail there). The request is idempotent: repeated calls while
   *  one expand is still in flight (mount sync pass, rAF pass, late frame)
   *  do not re-toggle. Seeing the frame actually expanded clears the pending
   *  request. A later manual collapse is left alone. */
  readonly #ensureSidebarOpen = (): void => {
    if (!(this.#mql?.matches ?? false)) return
    const frame = findFrame()
    if (frame === null) return
    if (!frame.hasAttribute('data-sidebar-collapsed')) {
      this.#expandPending = false
      return
    }
    if (this.#expandPending) return
    this.#expandPending = true
    this.#options.toggleSidebar()
  }


  /** Scroll the pager to the chat page and mirror the resting page. */
  readonly #placeOnChat = (behavior: ScrollBehavior): void => {
    const frame = findFrame()
    const mobile = this.#mql?.matches ?? false
    if (frame === null || !mobile) return
    const chatLeft = this.#chatPageLeft(frame)
    if (chatLeft <= 0) return
    if (Math.abs(frame.scrollLeft - chatLeft) > 2) {
      frame.scrollTo({ left: chatLeft, behavior })
    }
    this.#mirrorPage(frame, 'chat')
  }

  /** Mirror the page the pager is resting on (scroll position decides),
   *  written at settle/programmatic-jump time only — nothing consumes the
   *  attribute mid-gesture, and per-frame writes would invalidate style on
   *  every scroll frame. The attribute is only written when the value
   *  actually changes: a same-value setAttribute still invalidates style.
   *  With the third page live (DETAILS_PAGE_ATTR + details expanded) the
   *  zones are sidebar | chat | details; otherwise the classic
   *  sidebar | chat. */
  readonly #mirrorPage = (frame: HTMLElement, hint?: MobilePage): void => {
    const html = this.#html
    if (html === null) return
    const chatLeft = this.#chatPageLeft(frame)
    const scrollLeft = frame.scrollLeft
    let page: MobilePage
    if (chatLeft <= 0) {
      page = hint ?? 'chat'
    } else if (scrollLeft < chatLeft / 2) {
      page = 'sidebar'
    } else if (this.#detailsPageOpen()
      && scrollLeft > chatLeft + this.#pageWidth(frame) / 2) {
      page = 'details'
    } else {
      page = 'chat'
    }
    if (html.getAttribute(PAGE_ATTR) !== page) html.setAttribute(PAGE_ATTR, page)
  }

  /** State flips no longer drive the pager (the page is user-driven); an
   *  expand that landed just clears the pending always-open request. */
  readonly #onFrameCollapseChange = (): void => {
    if (!findFrame()?.hasAttribute('data-sidebar-collapsed')) this.#expandPending = false
  }

  readonly #ensureFrameObserver = (): void => {
    if (this.#frameObserver !== null) return
    const frame = findFrame()
    if (frame === null) return
    this.#frameObserver = new MutationObserver(this.#onFrameCollapseChange)
    this.#frameObserver.observe(frame, {
      attributes: true,
      attributeFilter: ['data-sidebar-collapsed', 'data-details-collapsed'],
    })
    // Live pager driving (settle re-snap) rides the frame's own
    // scroll. Pointer tracking backs the one-tap session-switch guarantee
    // (see #onPagerPointerUp).
    frame.addEventListener('scroll', this.#onPagerScroll, { passive: true })
    frame.addEventListener('pointerdown', this.#onPagerPointerDown, { passive: true })
    frame.addEventListener('pointerup', this.#onPagerPointerUp, { passive: true })
    // Composer input + conversation-scroll tracking: the seats remount on
    // session switches. The observer callback is FILTERED (see
    // #onFrameStructureMutation) — an unfiltered re-scan on every frame
    // subtree mutation ran two whole-tree querySelectors plus a forced
    // synchronous layout (getBoundingClientRect) per message-streaming
    // batch: ~2.4s of main-thread time over 6s of light streaming on a
    // DESKTOP CPU, several times worse on a phone (the streaming jank).
    this.#frame = frame
    this.#composerObserver = new MutationObserver(this.#onFrameStructureMutation)
    this.#composerObserver.observe(frame, { childList: true, subtree: true })
    this.#attachComposerInput(frame)
    this.#attachConversationScroll(frame)
    this.#attachHeaderMeasure()
    // A frame that appears after mount (the layout entry loads later) still
    // gets the always-open treatment and starts on the chat page.
    this.#ensureSidebarOpen()
    this.#placeOnChat('auto')
  }

  /** Crossing the breakpoint: entering mobile re-expands the sidebar and
   *  places the pager on the chat page; leaving clears the page mirror so
   *  the desktop layout renders flat. */
  readonly #onBreakpointChange = (): void => {
    const mobile = this.#mql?.matches ?? false
    if (!mobile) {
      this.#removeIosFocusCompensations()
      this.#html?.removeAttribute(PAGE_ATTR)
      this.#html?.removeAttribute(NEAR_DETAILS_ATTR)
      return
    }
    this.#installIosFocusCompensations()
    this.#syncCanvasBackground()
    this.#invalidateChatLeft()
    this.#syncComposerSafeShortfall()
    this.#ensureSidebarOpen()
    this.#placeOnChat('auto')
    const frame = findFrame()
    if (frame !== null) this.#syncDetailsReveal(frame)
  }

  /** Width reflow within one breakpoint side: keep the active page put. */
  readonly #onWindowResize = (): void => {
    if (this.#resizeTimer !== null) return
    this.#resizeTimer = window.setTimeout(() => {
      this.#resizeTimer = null
      const frame = findFrame()
      const mobile = this.#mql?.matches ?? false
      if (frame === null || !mobile) return
      // Follow the layout viewport wherever iOS actually put it (the PWA
      // keyboard resizes it; the dvh unit can lag).
      this.#pinLayoutHeight()
      this.#invalidateChatLeft()
      this.#syncComposerSafeShortfall()
      const chatLeft = this.#chatPageLeft(frame)
      if (chatLeft <= 0) return
      frame.scrollTo({ left: this.#nearestPageLeft(frame, frame.scrollLeft), behavior: 'auto' })
      this.#mirrorPage(frame)
    }, 120)
  }

  /** The snap position of the page nearest to a scroll offset: 0 (sidebar),
   *  chatLeft (chat), and — while the third page is live — chatLeft +
   *  pageWidth (details). */
  readonly #nearestPageLeft = (frame: HTMLElement, left: number): number => {
    const chatLeft = this.#chatPageLeft(frame)
    let best = left < chatLeft / 2 ? 0 : chatLeft
    if (this.#detailsPageOpen()) {
      const detailsLeft = chatLeft + this.#pageWidth(frame)
      if (Math.abs(left - detailsLeft) < Math.abs(left - best)) best = detailsLeft
    }
    return best
  }

  /** Live pager driver: once the scroll settles the pager re-snaps to the
   *  nearest whole page (a short-of-page stop is nudged). The state is
   *  deliberately NOT synced — the sidebar stays expanded (always rendered),
   *  so a swipe merely parks the pager; the sidebar column never re-renders.
   *
   *  The handler does NOTHING per frame by design: an earlier version drove
   *  a PiUI-style card flip (per-frame transform vars on the conversation
   *  column) from here — re-rasterizing a 390×844 card layer every frame
   *  was far too heavy for phone GPUs (iPhone Air). The scroll-snap motion
   *  itself is compositor-free; the page mirror is updated at settle time
   *  (nothing consumes it mid-gesture).
   *
   *  The ONE exception: while the third page is live, a rAF-batched check
   *  flips NEAR_DETAILS_ATTR once the swipe approaches it, so the browser
   *  starts rendering the (potentially huge, content-visibility:hidden)
   *  details panel BEFORE it scrolls into view. Clean-style read, guarded
   *  writes — no layout flush. */
  readonly #onPagerScroll = (): void => {
    if (!(this.#mql?.matches ?? false)) return
    if (!this.#detailsRevealScheduled && this.#detailsPageOpen()) {
      this.#detailsRevealScheduled = true
      requestAnimationFrame(() => {
        this.#detailsRevealScheduled = false
        if (this.#disposed) return
        const frame = findFrame()
        if (frame !== null) this.#syncDetailsReveal(frame)
      })
    }
    if (this.#settleTimer !== null) window.clearTimeout(this.#settleTimer)
    this.#settleTimer = window.setTimeout(() => {
      this.#settleTimer = null
      this.#settlePager()
    }, SCROLL_SETTLE_MS)
  }

  /** Flip NEAR_DETAILS_ATTR on/off from the pager position (see the
   *  attribute's doc). Called from the rAF-batched scroll path and from
   *  settle/opt-in/breakpoint handlers — never with dirty style. */
  readonly #syncDetailsReveal = (frame: HTMLElement): void => {
    const html = this.#html
    if (html === null) return
    const open = (this.#mql?.matches ?? false) && this.#detailsPageOpen()
    const chatLeft = open ? this.#chatPageLeft(frame) : 0
    const near = open && chatLeft > 0
      && frame.scrollLeft > chatLeft + this.#pageWidth(frame) * DETAILS_REVEAL_FRACTION
    const has = html.hasAttribute(NEAR_DETAILS_ATTR)
    if (near && !has) html.setAttribute(NEAR_DETAILS_ATTR, '')
    else if (!near && has) html.removeAttribute(NEAR_DETAILS_ATTR)
  }

  /** Record the pointer-down position so #onPagerPointerUp can tell a tap
   *  from a swipe. Deliberately does NOT touch the scroll position: a
   *  programmatic scroll between pointerdown and pointerup is exactly what
   *  makes browsers suppress the click, so the pager must stay untouched. */
  readonly #onPagerPointerDown = (event: PointerEvent): void => {
    this.#pointerDownPos = { x: event.clientX, y: event.clientY }
  }

  /** Bind the composer input listeners. The input (re)mounts when the
   *  composer seat renders for a session, so this re-finds it whenever the
   *  frame's subtree changes. */
  readonly #attachComposerInput = (frame: HTMLElement): void => {
    const input = frame.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      '[data-composer-seat] input, [data-composer-seat] textarea',
    )
    if (input === this.#composerInput) return
    this.#detachComposerInput()
    this.#composerInput = input
    if (input === null) return
    this.#composerLastValue = input.value
    input.addEventListener('focus', this.#onComposerFocus)
    input.addEventListener('blur', this.#onComposerBlur)
    input.addEventListener('keydown', this.#onComposerKeydown)
    if (document.activeElement === input) this.#onComposerFocus()
    this.#syncComposerSafeShortfall()
  }

  /** The app's composer card already reserves bottom space; compute how much
   *  MORE is needed so the card clears the home indicator with a little
   *  breathing room — instead of app gap + a full safe-bottom (an empty strip
   *  in standalone PWA mode). Keyboard open leaves the measurement alone (the
   *  composer is lifted anyway). */
  readonly #syncComposerSafeShortfall = (): void => {
    const html = this.#html
    if (html === null) return
    const card = document.querySelector<HTMLElement>('[data-composer-card]')
    if (card === null) return
    const appGap = Math.max(0, window.innerHeight - card.getBoundingClientRect().bottom)
    const safeBottom = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--dshm-safe-bottom'),
    ) || 0
    const shortfall = Math.max(0, Math.round(safeBottom + 8 - appGap))
    html.style.setProperty('--dshm-safe-shortfall', `${shortfall}px`)
  }

  readonly #detachComposerInput = (): void => {
    if (this.#composerInput !== null) {
      this.#composerInput.removeEventListener('focus', this.#onComposerFocus)
      this.#composerInput.removeEventListener('blur', this.#onComposerBlur)
      this.#composerInput.removeEventListener('keydown', this.#onComposerKeydown)
      this.#composerInput = null
    }
    this.#stopComposerPoll()
  }

  /** Dismiss the keyboard once a message is sent. The composer input is
   *  cleared by the app on send (Enter, the send button, or a slash-command
   *  submit); a non-empty → empty transition while focused means a send, so
   *  blur the input and reset the keyboard inset. A 250 ms poll while the
   *  input is focused is cheap and catches every send path. */
  readonly #onComposerFocus = (): void => {
    this.#composerLastValue = this.#composerInput?.value ?? ''
    if (this.#composerPollTimer !== null) return
    this.#composerPollTimer = window.setInterval(() => {
      const input = this.#composerInput
      if (input === null || document.activeElement !== input) return
      const value = input.value
      if (this.#composerLastValue !== '' && value === '') {
        this.#dismissComposerKeyboard()
        return
      }
      this.#composerLastValue = value
    }, 250)
  }

  readonly #onComposerBlur = (): void => {
    this.#stopComposerPoll()
  }

  /** Enter (without Shift, and not while IME-composing) sends the message:
   *  blur once the app has processed the submit. */
  readonly #onComposerKeydown = (event: Event): void => {
    const keyEvent = event as KeyboardEvent
    if (keyEvent.key !== 'Enter' || keyEvent.shiftKey || keyEvent.isComposing) return
    window.setTimeout(() => { this.#dismissComposerKeyboard() }, 120)
  }

  /** Blur the composer input (dismiss the keyboard) and clear the inset —
   *  mobile only; desktop focus behavior stays untouched. */
  readonly #dismissComposerKeyboard = (): void => {
    this.#stopComposerPoll()
    if (!(this.#mql?.matches ?? false)) return
    const input = this.#composerInput
    if (input !== null && document.activeElement === input) input.blur()
    this.#html?.style.setProperty('--dshm-keyboard-inset', '0px')
  }

  readonly #stopComposerPoll = (): void => {
    if (this.#composerPollTimer !== null) {
      window.clearInterval(this.#composerPollTimer)
      this.#composerPollTimer = null
    }
  }

  /** Bind the conversation scroll container. It remounts on session switches,
   *  so this re-finds it whenever the frame's subtree changes. */
  readonly #attachConversationScroll = (frame: HTMLElement): void => {
    const scroll = frame.querySelector<HTMLElement>('[data-conversation-scroll]')
    if (scroll === this.#conversationScroll) return
    this.#detachConversationScroll()
    this.#conversationScroll = scroll
    if (scroll === null) return
    this.#lastSettledHeaderTop = scroll.scrollTop
    scroll.addEventListener('scroll', this.#onConversationScroll, { passive: true })
    // Start consistent (a previous session may have left the bar collapsed).
    this.#syncHeaderCollapse()
  }

  readonly #detachConversationScroll = (): void => {
    this.#conversationScroll?.removeEventListener('scroll', this.#onConversationScroll)
    this.#conversationScroll = null
    if (this.#headerSettleTimer !== null) {
      window.clearTimeout(this.#headerSettleTimer)
      this.#headerSettleTimer = null
    }
  }

  /** Auto-collapse the top bar (session title + Chat/Trajectory tabs) while
   *  the user scrolls DOWN through the conversation, and reveal it on the
   *  way back up — the phone gains the header's height for reading. A
   *  same-position event (content reflow while scrolled) must NOT flip the
   *  state: only a strictly decreasing scrollTop expands the bar again. */
  readonly #onConversationScroll = (): void => {
    // Evaluate the top bar only AFTER the scroll settles — per-event flips
    // are what made it twitch (momentum jitter, layout shifts from the
    // collapse itself). A 140 ms quiet window later, the net movement since
    // the last settled position decides collapse vs reveal.
    if (this.#headerSettleTimer !== null) window.clearTimeout(this.#headerSettleTimer)
    this.#headerSettleTimer = window.setTimeout(() => {
      this.#headerSettleTimer = null
      this.#settleHeader()
    }, 140)
  }

  readonly #settleHeader = (): void => {
    const scroll = this.#conversationScroll
    const html = this.#html
    if (scroll === null || html === null) return
    const top = scroll.scrollTop
    const last = this.#lastSettledHeaderTop
    this.#lastSettledHeaderTop = top
    // Quiet window after a state change: collapsing/expanding the header
    // changes the scroll container's height, the browser clamps/anchors
    // scrollTop, and a re-anchor moves it — evaluating during that window
    // reads those layout-induced moves as user scrolls and flips the state
    // right back (the flicker loop). Track the baseline through the quiet
    // period and only evaluate against the settled position.
    if (performance.now() < this.#headerQuietUntil) return
    if (!(this.#mql?.matches ?? false)) {
      html.removeAttribute('data-dshm-header-collapsed')
      return
    }
    // The header floats in its own overlay layer (position: absolute), so
    // collapsing/expanding it never changes the scroll container's height —
    // the visible content stays put by construction.
    const wasCollapsed = html.hasAttribute('data-dshm-header-collapsed')
    let changed = false
    if (wasCollapsed) {
      // Reveal on any net upward scroll (slop-guarded); the collapse
      // threshold + overflow guard below keep it from twitching at the fold.
      if (top < last - HEADER_EXPAND_SLOP) {
        html.removeAttribute('data-dshm-header-collapsed')
        changed = true
      }
    } else if (top > last + HEADER_EXPAND_SLOP && top > HEADER_COLLAPSE_THRESHOLD
      // The content must actually overflow: collapsing a just-fitting
      // conversation clamps scrollTop to 0, which would immediately
      // re-expand and twitch.
      && scroll.scrollHeight > scroll.clientHeight + HEADER_COLLAPSE_THRESHOLD) {
      html.setAttribute('data-dshm-header-collapsed', '')
      changed = true
    }
    if (changed) {
      this.#headerQuietUntil = performance.now() + HEADER_QUIET_MS
    }
  }

  /** One-tap session-switch guarantee. The app's session rows switch on
   *  their own onClick, but on touch the first tap is frequently swallowed
   *  by the browser (click suppression after recent scrolling, or the
   *  draggable row's drag-gesture disambiguation) — the row highlights, the
   *  session does not, and the user has to tap again. When a TAP on a
   *  session row has not switched the session shortly after, this opens it
   *  directly through the sessions service, so one tap always switches. The
   *  app's own click is never duplicated: if it already switched the
   *  session, the check sees the new current and does nothing. */
  readonly #onPagerPointerUp = (event: PointerEvent): void => {
    const pos = this.#pointerDownPos
    this.#pointerDownPos = null
    if (pos === null) return
    // A swipe (or drag-to-scroll) ending over a row must not open it.
    if (Math.hypot(event.clientX - pos.x, event.clientY - pos.y) > TAP_SLOP) return
    const mobile = this.#mql?.matches ?? false
    if (!mobile) return
    const target = event.target
    if (!(target instanceof Element)) return
    const row = target.closest('[role="treeitem"]')
    if (row === null || !(row instanceof HTMLElement)) return
    // Group rows toggle expansion; a row's own actions button opens the row
    // menu — both keep their native behavior.
    if (row.hasAttribute('aria-expanded')) return
    if (!row.hasAttribute('aria-selected')) return
    if (target.closest('button') !== null) return
    const { openSession, resolveSessionId, currentSessionId } = this.#options
    if (openSession === undefined || resolveSessionId === undefined || currentSessionId === undefined) return
    const sessionId = resolveSessionId(row.textContent ?? '')
    if (sessionId === undefined) return
    if (currentSessionId() === sessionId) return
    const timer = window.setTimeout(() => {
      this.#supplementTimers.delete(timer)
      if (this.#disposed) return
      if (currentSessionId() === sessionId) return
      openSession(sessionId)
    }, TAP_SUPPLEMENT_MS)
    this.#supplementTimers.add(timer)
  }

  readonly #settlePager = (): void => {
    const frame = findFrame()
    const mobile = this.#mql?.matches ?? false
    if (frame === null || !mobile) return
    const chatLeft = this.#chatPageLeft(frame)
    if (chatLeft <= 0) return
    const left = frame.scrollLeft
    const target = this.#nearestPageLeft(frame, left)
    if (Math.abs(left - target) > 4) {
      // INSTANT nudge: a smooth re-snap would animate after the gesture and
      // eat the first tap that lands during it (browsers suppress clicks
      // while the page scrolls).
      frame.scrollTo({ left: target, behavior: 'auto' })
    }
    this.#mirrorPage(frame)
    this.#syncDetailsReveal(frame)
  }

  /** A tap on the exposed chat card returns to the chat page (PiUI's
   *  overlay behavior: the exposed chat is not interactive while the
   *  sidebar page is showing). The sidebar's own collapse toggle is
   *  intercepted the same way: collapsing to the rail would unload the
   *  sidebar content, so it flips back to the chat page instead — the
   *  state (expanded) is never touched. */
  readonly #onDocClickCapture = (event: MouseEvent): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const frame = findFrame()
    const mobile = this.#mql?.matches ?? false
    if (frame === null || !mobile) return
    const chatLeft = this.#chatPageLeft(frame)
    if (chatLeft <= 0) return
    const sidebarCol = frame.firstElementChild
    // The sidebar's collapse toggle: stop the rail collapse, return to chat.
    if (sidebarCol instanceof Element && sidebarCol.contains(target)) {
      const btn = target.closest('button')
      if (btn !== null && SIDEBAR_COLLAPSE_LABELS.has(btn.getAttribute('aria-label') ?? '')) {
        event.preventDefault()
        event.stopPropagation()
        this.#placeOnChat('smooth')
        return
      }
    }
    // The exposed chat card: return to chat (only while on the sidebar page).
    if (frame.scrollLeft >= chatLeft / 2) return
    const chatCard = frame.children[1]
    if (chatCard instanceof Element && chatCard.contains(target)) {
      this.#placeOnChat('smooth')
    }
  }

  readonly #requestKeyboard = (): void => {
    if (this.#keyboardFrame !== null) return
    this.#keyboardFrame = requestAnimationFrame(() => {
      this.#keyboardFrame = null
      this.#updateKeyboardInset()
    })
  }

  /** Focus left an input (the composer was replaced by the approval panel,
   *  or the user dismissed the keyboard): the OS keyboard is closing, so the
   *  seat must drop back to the bottom. Re-check immediately and once more
   *  after the keyboard animation settles. */
  readonly #onFocusOut = (): void => {
    if (document.activeElement?.matches('input, textarea, [contenteditable]')) return
    this.#updateKeyboardInset()
    window.setTimeout(() => {
      if (this.#disposed) return
      this.#updateKeyboardInset()
    }, 160)
  }

  readonly #updateKeyboardInset = (): void => {
    const html = this.#html
    if (html === null) return
    // The keyboard only stays up while an editable element holds focus — if
    // nothing editable is focused the inset MUST be 0, no matter what the
    // visualViewport reports (iOS standalone mode can leave the viewport
    // shrunken after the keyboard closes, which otherwise strands the
    // composer high above the bottom).
    const active = document.activeElement
    const editableFocused = active instanceof HTMLElement
      && active.matches('input, textarea, [contenteditable]')
    const vv = window.visualViewport
    let inset = editableFocused && vv !== null && vv.height < window.innerHeight
      ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      : 0
    // Clamp pathological values (a stale half-open keyboard or a broken
    // visualViewport must never strand the composer above the fold).
    inset = Math.min(inset, window.innerHeight * 0.5)
    // An inset below the smallest real keyboard is iOS's accessory-bar
    // residue after the keyboard closed (visualViewport stuck ~44px short
    // while the input keeps focus) — not a keyboard, force it to 0 or the
    // composer floats by exactly that residue.
    if (inset > 0 && inset < KEYBOARD_MIN_INSET) inset = 0
    const previousInset = parseFloat(html.style.getPropertyValue('--dshm-keyboard-inset')) || 0
    html.style.setProperty('--dshm-keyboard-inset', `${inset}px`)
    if (inset > 0) this.#ensureKeyboardPoll()
    else this.#stopKeyboardPoll()
    // The keyboard just closed (inset → 0): blur the focused input to release
    // iOS's "keep the focused element visible" hold (which re-pans the page
    // after any scroll reset), then reset every scroll surface. The layout
    // viewport can take a beat to restore in the PWA — re-pin the shell
    // height after it settles.
    if (previousInset > 0 && inset === 0) {
      this.#blurActiveForm()
      this.#resetDocumentScroll()
      window.setTimeout(() => { this.#pinLayoutHeight() }, 400)
    }
    // iOS scrolls the window to reveal the focused input on keyboard
    // open/close; the shell is fixed-height, so undo it (the composer is
    // lifted by the inset above — no window scroll is needed or wanted).
    this.#resetDocumentScroll()
    // The keyboard opening scrolls the focused input into view (large
    // scrollTop → the top bar collapses); when it closes, the viewport
    // returns and scrollTop drops without a guaranteed scroll event — re-sync
    // the collapse so the bar cannot stay hidden.
    this.#syncHeaderCollapse()
  }

  /** Re-check the keyboard state every 300 ms while the inset is non-zero:
   *  the moment no editable element is focused or the visual viewport is
   *  back to full height, the keyboard is gone — zero the inset even when
   *  iOS never fired a resize (its stale-viewport quirk). */
  readonly #ensureKeyboardPoll = (): void => {
    if (this.#keyboardPollTimer !== null) return
    this.#keyboardPollTimer = window.setInterval(() => {
      const active = document.activeElement
      const editableFocused = active instanceof HTMLElement
        && active.matches('input, textarea, [contenteditable]')
      const vv = window.visualViewport
      const inset = vv !== null ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0
      // Treat an accessory-bar residue (inset below a real keyboard's size)
      // as "keyboard gone" too — the visualViewport can stay ~44px short
      // after the keyboard closes while the input keeps focus.
      if (!editableFocused || vv === null || vv.height >= window.innerHeight - 2 || inset < KEYBOARD_MIN_INSET) {
        this.#stopKeyboardPoll()
        this.#html?.style.setProperty('--dshm-keyboard-inset', '0px')
        this.#resetDocumentScroll()
        this.#syncHeaderCollapse()
      }
    }, 300)
  }

  readonly #stopKeyboardPoll = (): void => {
    if (this.#keyboardPollTimer !== null) {
      window.clearInterval(this.#keyboardPollTimer)
      this.#keyboardPollTimer = null
    }
  }

  /** Reset every document scroll surface. iOS pans the visual viewport when
   *  the keyboard opens/closes and re-scrolls even with `overflow: hidden` —
   *  a single `window.scrollTo(0,0)` is not enough: the pan can also live on
   *  the documentElement/body scrollTop (the ~one-accessory-bar shift). */
  readonly #resetDocumentScroll = (): void => {
    if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0)
    if (document.documentElement.scrollTop !== 0) document.documentElement.scrollTop = 0
    if (document.body.scrollTop !== 0) document.body.scrollTop = 0
  }

  /** iOS PWA viewport compensations (adapted from the well-known
   *  ios-pwa-scrolling-input-focus-fix pattern). iOS auto-scrolls / pans the
   *  document to keep a focused input visible, breaking the fixed-height
   *  shell — and `scrollTo(0,0)` alone does not stick because iOS re-scrolls
   *  while the input is focused. Mobile only: desktop focus behavior stays
   *  untouched. */
  readonly #installIosFocusCompensations = (): void => {
    if (this.#iosFocusPatched) return
    this.#iosFocusPatched = true
    // (2) touchstart capture → pre-focus with preventScroll: the later
    // native focus event sees the element already focused and iOS skips its
    // auto-scroll/pan.
    document.addEventListener('touchstart', this.#onTouchStartFocus, { capture: true, passive: true })
    // (3) prototype patch: every .focus() on form controls uses
    // preventScroll + an explicit centered scrollIntoView, covering all
    // programmatic focus paths.
    const protos = [HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement]
    for (const proto of protos) {
      const original = proto.prototype.focus
      this.#iosFocusOriginals.push({ proto, orig: original })
      proto.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
        const result = original.call(this, { ...options, preventScroll: true })
        requestAnimationFrame(() => { this.scrollIntoView?.({ block: 'center' }) })
        return result
      }
    }
    // (4) background/restore: blur the focused control on hide AND show so
    // iOS releases its "maintain focus visibility" loop and the scroll
    // reset sticks.
    document.addEventListener('visibilitychange', this.#onVisibilityChange)
    window.addEventListener('pagehide', this.#blurActiveForm)
    window.addEventListener('pageshow', this.#onShowReset)
  }

  readonly #removeIosFocusCompensations = (): void => {
    if (!this.#iosFocusPatched) return
    this.#iosFocusPatched = false
    document.removeEventListener('touchstart', this.#onTouchStartFocus, { capture: true })
    for (const { proto, orig } of this.#iosFocusOriginals) proto.prototype.focus = orig
    this.#iosFocusOriginals = []
    document.removeEventListener('visibilitychange', this.#onVisibilityChange)
    window.removeEventListener('pagehide', this.#blurActiveForm)
    window.removeEventListener('pageshow', this.#onShowReset)
  }

  readonly #onTouchStartFocus = (event: TouchEvent): void => {
    const target = event.target
    if (target instanceof Element && target.matches('input, textarea, select')
      && document.activeElement !== target) {
      ;(target as HTMLInputElement).focus({ preventScroll: true })
    }
  }

  readonly #blurActiveForm = (): void => {
    const active = document.activeElement
    if (active instanceof HTMLElement && active.matches('input, textarea, select')) active.blur()
  }

  readonly #onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') this.#blurActiveForm()
    else if (document.visibilityState === 'visible') this.#onShowReset()
  }

  readonly #onShowReset = (): void => {
    this.#blurActiveForm()
    this.#resetDocumentScroll()
    this.#updateKeyboardInset()
  }

  /** Force the top-bar collapse state consistent with the current scroll
   *  position: expanded when the content no longer overflows or the user is
   *  back near the top (the keyboard-close recovery path). */
  readonly #syncHeaderCollapse = (): void => {
    const html = this.#html
    const scroll = this.#conversationScroll
    if (html === null || scroll === null) return
    if (!(this.#mql?.matches ?? false)) {
      html.removeAttribute('data-dshm-header-collapsed')
      return
    }
    const top = scroll.scrollTop
    if (top <= 32
      || scroll.scrollHeight <= scroll.clientHeight + HEADER_COLLAPSE_THRESHOLD) {
      html.removeAttribute('data-dshm-header-collapsed')
    }
  }

  /** Keep the approval panel (a tool waiting for permission, rendered in the
   *  composer seat) inside the visible viewport on phones. The seat is
   *  sticky, but a stale keyboard inset or a mount racing the layout can
   *  leave the panel above or below the fold — invisible and unanswerable,
   *  which strands the pending command. Also releases any leftover input
   *  focus: switching to a waiting session while the composer keyboard is
   *  open would leave the panel covered by the keyboard. */
  /** Only the approval panel's own mount/unmount matters to
   *  #ensureApprovalVisible — filtering here keeps the constant message
   *  streaming mutations from paying for the panel query. */
  readonly #onApprovalMutation = (mutations: MutationRecord[]): void => {
    for (const mutation of mutations) {
      const nodes = mutation.addedNodes
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]
        if (node === undefined || node.nodeType !== 1) continue
        const el = node as Element
        if (el.matches?.('[data-approval-key]') === true || el.querySelector?.('[data-approval-key]') !== null) {
          this.#ensureApprovalVisible()
          return
        }
      }
      const removed = mutation.removedNodes
      for (let i = 0; i < removed.length; i++) {
        const node = removed[i]
        if (node === undefined || node.nodeType !== 1) continue
        const el = node as Element
        if (el.matches?.('[data-approval-key]') === true || el.querySelector?.('[data-approval-key]') !== null) {
          this.#ensureApprovalVisible()
          return
        }
      }
    }
  }

  readonly #ensureApprovalVisible = (): void => {
    if (!(this.#mql?.matches ?? false)) return
    const panel = document.querySelector<HTMLElement>('[data-approval-key]')
    if (panel === null || panel.clientHeight <= 0) return
    // An approval panel replaces the composer: no input may hold focus, and
    // the keyboard must read as closed (blur idempotent when already clear).
    const active = document.activeElement
    if (active instanceof HTMLElement && active.matches('input, textarea, [contenteditable]')) {
      active.blur()
    }
    this.#html?.style.setProperty('--dshm-keyboard-inset', '0px')
    const r = panel.getBoundingClientRect()
    const vh = window.innerHeight
    const fullyVisible = r.top >= 0 && r.bottom <= vh
    if (fullyVisible) return
    panel.scrollIntoView({ block: 'nearest', behavior: 'auto' })
  }
}
