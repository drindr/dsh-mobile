/**
 * DOM-side mobile controller: the non-React half of the plugin. Owns the
 * pieces the frame itself cannot express — the viewport meta upgrade, the
 * safe-area/keyboard CSS variables, and the pager's live state (page mirror,
 * 3D flip vars, click-to-return). Everything it installs is removed by
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
 */

/** The narrow breakpoint the pager keys off (PiUI's 768px). */
export const MOBILE_BREAKPOINT = '(max-width: 768px)'

/** The <html> attribute that mirrors the pager page the frame is resting on. */
export const PAGE_ATTR = 'data-dshm-page'

/** Pager page names (the mirror values of PAGE_ATTR). */
export type MobilePage = 'sidebar' | 'chat'

/** Wait after the last scroll event before the pager settles. */
const SCROLL_SETTLE_MS = 200

/** After a session-row tap, wait this long for the app's own onClick to
 *  switch the session before the plugin opens it itself (a tap the browser
 *  swallowed — scroll suppression, drag-gesture disambiguation — must still
 *  switch on the FIRST tap). */
const TAP_SUPPLEMENT_MS = 150

/** Pointer movement (px) above which a pointerup is a swipe, not a tap. */
const TAP_SLOP = 12

/** The sidebar shell's collapse toggle labels (zh / en) — clicking it while
 *  the sidebar is expanded must NOT collapse it to the rail (which would
 *  unload its content); it flips back to the chat page instead. */
const SIDEBAR_COLLAPSE_LABELS = new Set(['收起侧边栏', 'Collapse sidebar'])

/**
 * Viewport meta content: maximum-scale blocks the iOS focus zoom that would
 * otherwise fight the fixed-height mobile layout; viewport-fit=cover exposes
 * the safe-area insets to env().
 */
const VIEWPORT_CONTENT =
  'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover'

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

/** Test-facing surface of the controller (the class keeps everything else private). */
export interface MobileControllerHandle {
  /** True while the frame shows the sidebar expanded (not the rail). */
  isSidebarOpen(): boolean
  /** Return to the chat page (a session picked in the sidebar). */
  returnToChat(): void
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
  #keyboardFrame: number | null = null
  #mountFrame: number | null = null
  #resizeTimer: number | null = null
  #settleTimer: number | null = null
  /** Pointer-down position for tap-vs-swipe discrimination. */
  #pointerDownPos: { x: number; y: number } | null = null
  /** Pending session-open supplement timers (cleared on dispose). */
  #supplementTimers = new Set<number>()
  #expandPending = false
  /** Cached chat-page snap position (measure once per stable layout, never
   *  inside a scroll handler — reading offsetWidth there forces layout). */
  #chatLeftCache: ChatLeftCache | null = null
  /** Flip vars are suspended during a programmatic session-switch jump: the
   *  switch re-renders the conversation column on the main thread, so the
   *  jump must not pay per-frame 3D compositing on top of that render. */
  #flipSuppressed = false
  /** Last flip progress written (skip no-op style writes between frames). */
  #lastFlipProgress: number | null = null
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
   *  is INSTANT with flip vars suppressed: picking a session re-renders the
   *  conversation column on the main thread, so a smooth scroll with
   *  per-frame 3D updates would fight that render and jank on phones. */
  returnToChat(): void {
    this.#flipSuppressed = true
    this.#placeOnChat('auto')
    // Snap the flip vars straight to rest — no intermediate frames.
    const frame = findFrame()
    if (frame !== null) this.#setFlipVars(frame, 0)
    this.#html?.removeAttribute('data-dshm-flipping')
    this.#lastFlipProgress = 0
  }

  /** Measure the chat-page snap position and cache it (never cached from the
   *  unsettled fallback — a 0-width pre-layout read must not poison the
   *  cache). */
  readonly #measureChatLeft = (frame: HTMLElement): number => {
    const sidebar = frame.firstElementChild
    if (sidebar instanceof HTMLElement && sidebar.offsetWidth > 0) {
      this.#chatLeftCache = { frame, left: sidebar.offsetWidth }
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

  /** Drop the cached snap position (viewport reflow / breakpoint crossing);
   *  the next read re-measures from the live layout. */
  readonly #invalidateChatLeft = (): void => {
    this.#chatLeftCache = null
  }

  /** Write the four flip vars for a given pager progress (-1 … 0). */
  readonly #setFlipVars = (frame: HTMLElement, progress: number): void => {
    const abs = Math.abs(progress)
    const right = Math.max(0, progress)
    frame.style.setProperty('--dshm-rotate', `${progress * 10}deg`)
    frame.style.setProperty('--dshm-scale', `${1 - abs * 0.06}`)
    frame.style.setProperty('--dshm-offset-x', `${right * right * -48}px`)
    frame.style.setProperty('--dshm-origin-x', `${50 - progress * 50}%`)
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

    this.#mql = window.matchMedia(MOBILE_BREAKPOINT)
    this.#mql.addEventListener('change', this.#onBreakpointChange)

    // Keyboard inset: the visual viewport shrinks when the OS keyboard
    // opens; the composer seat pads itself by the difference (rAF-throttled
    // — the resize fires every frame of the keyboard animation).
    const vv = window.visualViewport
    vv?.addEventListener('resize', this.#requestKeyboard)
    vv?.addEventListener('scroll', this.#requestKeyboard)

    // Keep the active page in place when the viewport width changes within
    // a breakpoint side (rotation / split-screen reflows the page tracks).
    window.addEventListener('resize', this.#onWindowResize)

    // A tap on the exposed chat card (while the pager rests on the sidebar
    // page) returns to the chat page — PiUI's overlay behavior.
    document.addEventListener('click', this.#onDocClickCapture, true)

    const root = document.getElementById('root')
    if (root !== null) {
      this.#rootObserver = new MutationObserver(() => { this.#ensureFrameObserver() })
      this.#rootObserver.observe(root, { childList: true })
    }
    this.#ensureFrameObserver()

    // The always-open phone layout: expand the sidebar once (AppFrame
    // auto-collapses it to the rail on narrow viewports) so its content
    // stays fully rendered, then start on the CHAT page.
    this.#ensureSidebarOpen()
    this.#placeOnChat('auto')
    this.#mountFrame = requestAnimationFrame(() => {
      this.#mountFrame = null
      this.#ensureSidebarOpen()
      this.#placeOnChat('auto')
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
    this.#mql?.removeEventListener('change', this.#onBreakpointChange)
    this.#mql = null
    window.removeEventListener('resize', this.#onWindowResize)
    window.visualViewport?.removeEventListener('resize', this.#requestKeyboard)
    window.visualViewport?.removeEventListener('scroll', this.#requestKeyboard)
    document.removeEventListener('click', this.#onDocClickCapture, true)
    for (const timer of [this.#keyboardFrame, this.#mountFrame, this.#resizeTimer, this.#settleTimer]) {
      if (timer !== null) (timer === this.#keyboardFrame || timer === this.#mountFrame ? cancelAnimationFrame : window.clearTimeout)(timer)
    }
    for (const timer of this.#supplementTimers) window.clearTimeout(timer)
    this.#supplementTimers.clear()
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
    const html = this.#html
    if (html !== null) {
      html.removeAttribute('data-dsh-mobile')
      html.removeAttribute(PAGE_ATTR)
      html.removeAttribute('data-dshm-flipping')
      html.style.removeProperty('--dshm-keyboard-inset')
    }
    this.#chatLeftCache = null
    this.#flipSuppressed = false
    this.#lastFlipProgress = null
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
    this.#updateFlipVars(frame)
  }

  /** Mirror the page the pager is resting on (scroll position decides). */
  readonly #mirrorPage = (frame: HTMLElement, hint?: MobilePage): void => {
    const html = this.#html
    if (html === null) return
    const chatLeft = this.#chatPageLeft(frame)
    const page: MobilePage = chatLeft <= 0
      ? (hint ?? 'chat')
      : frame.scrollLeft < chatLeft / 2 ? 'sidebar' : 'chat'
    html.setAttribute(PAGE_ATTR, page)
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
      attributeFilter: ['data-sidebar-collapsed'],
    })
    // Live pager driving (3D flip + settle re-snap) rides the frame's own
    // scroll. Pointer tracking backs the one-tap session-switch guarantee
    // (see #onPagerPointerUp).
    frame.addEventListener('scroll', this.#onPagerScroll, { passive: true })
    frame.addEventListener('pointerdown', this.#onPagerPointerDown, { passive: true })
    frame.addEventListener('pointerup', this.#onPagerPointerUp, { passive: true })
    // A frame that appears after mount (the layout entry loads later) still
    // gets the always-open treatment and starts on the chat page.
    this.#ensureSidebarOpen()
    this.#placeOnChat('auto')
  }

  /** Crossing the breakpoint: entering mobile re-expands the sidebar and
   *  places the pager on the chat page; leaving clears the 3D flip vars so
   *  the desktop layout renders flat. */
  readonly #onBreakpointChange = (): void => {
    const mobile = this.#mql?.matches ?? false
    const frame = findFrame()
    if (!mobile) {
      for (const prop of ['--dshm-rotate', '--dshm-scale', '--dshm-offset-x', '--dshm-origin-x']) {
        frame?.style.removeProperty(prop)
      }
      this.#html?.removeAttribute(PAGE_ATTR)
      this.#html?.removeAttribute('data-dshm-flipping')
      this.#flipSuppressed = false
      this.#lastFlipProgress = null
      return
    }
    this.#invalidateChatLeft()
    this.#ensureSidebarOpen()
    this.#placeOnChat('auto')
  }

  /** Width reflow within one breakpoint side: keep the active page put. */
  readonly #onWindowResize = (): void => {
    if (this.#resizeTimer !== null) return
    this.#resizeTimer = window.setTimeout(() => {
      this.#resizeTimer = null
      const frame = findFrame()
      const mobile = this.#mql?.matches ?? false
      if (frame === null || !mobile) return
      this.#invalidateChatLeft()
      const chatLeft = this.#chatPageLeft(frame)
      if (chatLeft <= 0) return
      const onChat = frame.scrollLeft >= chatLeft / 2
      frame.scrollTo({ left: onChat ? chatLeft : 0, behavior: 'auto' })
      this.#mirrorPage(frame)
      this.#updateFlipVars(frame)
    }, 120)
  }

  /** Live pager driver: PiUI's 3D flip vars follow the scroll, and once the
   *  scroll settles the pager re-snaps to the nearest whole page (a
   *  short-of-page stop is nudged). The state is deliberately NOT synced —
   *  the sidebar stays expanded (always rendered), so a swipe merely parks
   *  the pager; the sidebar column never re-renders. */
  readonly #onPagerScroll = (): void => {
    const frame = findFrame()
    const mobile = this.#mql?.matches ?? false
    if (frame === null || !mobile) return
    this.#updateFlipVars(frame)
    this.#mirrorPage(frame)
    if (this.#settleTimer !== null) window.clearTimeout(this.#settleTimer)
    this.#settleTimer = window.setTimeout(() => {
      this.#settleTimer = null
      this.#settlePager()
    }, SCROLL_SETTLE_MS)
  }

  /** Record the pointer-down position so #onPagerPointerUp can tell a tap
   *  from a swipe. Deliberately does NOT touch the scroll position: a
   *  programmatic scroll between pointerdown and pointerup is exactly what
   *  makes browsers suppress the click, so the pager must stay untouched. */
  readonly #onPagerPointerDown = (event: PointerEvent): void => {
    this.#pointerDownPos = { x: event.clientX, y: event.clientY }
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

  /** PiUI's flip: progress -1 (sidebar page) … 0 (chat page); the chat card
   *  rotates about the edge toward the swipe side and shrinks, so on the
   *  sidebar page it sinks away leaving only a sliver visible. Suppressed
   *  during programmatic session-switch jumps (see #flipSuppressed); the
   *  no-op guard also skips style writes when the progress has not actually
   *  moved between frames. The [data-dshm-flipping] attribute grants the
   *  card's 3D layer hint only while a flip is live — at rest the
   *  conversation column is a plain 2D element. */
  readonly #updateFlipVars = (frame: HTMLElement): void => {
    if (this.#flipSuppressed) return
    const chatLeft = this.#chatPageLeft(frame)
    if (chatLeft <= 0) return
    const progress = Math.max(-1, Math.min(1, (frame.scrollLeft - chatLeft) / chatLeft))
    if (this.#lastFlipProgress !== null && Math.abs(progress - this.#lastFlipProgress) < 0.001) return
    this.#lastFlipProgress = progress
    this.#setFlipVars(frame, progress)
    const html = this.#html
    if (Math.abs(progress) > 0.001) html?.setAttribute('data-dshm-flipping', '')
    else html?.removeAttribute('data-dshm-flipping')
  }

  readonly #settlePager = (): void => {
    // A programmatic jump's suppression ends when the pager settles; a user
    // swipe re-arms this timer via the scroll handler, which also ends it.
    this.#flipSuppressed = false
    const frame = findFrame()
    const mobile = this.#mql?.matches ?? false
    if (frame === null || !mobile) return
    const chatLeft = this.#chatPageLeft(frame)
    if (chatLeft <= 0) return
    const left = frame.scrollLeft
    const nearest: MobilePage = left < chatLeft / 2 ? 'sidebar' : 'chat'
    const target = nearest === 'sidebar' ? 0 : chatLeft
    if (Math.abs(left - target) > 4) {
      // INSTANT nudge: a smooth re-snap would animate after the gesture and
      // eat the first tap that lands during it (browsers suppress clicks
      // while the page scrolls).
      frame.scrollTo({ left: target, behavior: 'auto' })
    }
    this.#mirrorPage(frame)
    this.#updateFlipVars(frame)
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

  readonly #updateKeyboardInset = (): void => {
    const html = this.#html
    if (html === null) return
    const vv = window.visualViewport
    const inset = vv !== null && vv.height < window.innerHeight
      ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      : 0
    html.style.setProperty('--dshm-keyboard-inset', `${inset}px`)
  }
}
