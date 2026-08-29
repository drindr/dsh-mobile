// @vitest-environment jsdom
/** MobileController: always-open sidebar + pager flip/settle, chrome, keyboard inset, teardown. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileController, PAGE_ATTR, type MobileControllerOptions } from '../src/client/controller.ts'

/** A MediaQueryList stub (jsdom has none) that records its change listener. */
function stubMatchMedia(matches: boolean): { fire: (next: boolean) => void } {
  const listeners = new Set<(e: MediaQueryListEvent) => void>()
  const mql = {
    matches,
    media: '(max-width: 768px)',
    onchange: null,
    addEventListener: (_type: string, fn: () => void) => { listeners.add(fn) },
    removeEventListener: (_type: string, fn: () => void) => { listeners.delete(fn) },
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList
  vi.stubGlobal('matchMedia', vi.fn(() => mql))
  return {
    fire: (next: boolean): void => {
      ;(mql as unknown as { matches: boolean }).matches = next
      for (const fn of listeners) fn({ matches: next } as MediaQueryListEvent)
    },
  }
}

/**
 * Build the AppFrame-shaped frame: a scrollable grid whose first child is the
 * half-open sidebar page (offsetWidth 300 = the chat page's snap position).
 * scrollTo is stubbed onto the instance so tests can read the requested
 * position. The frame starts collapsed (rail).
 */
function makeFrame(): HTMLElement {
  const root = document.createElement('div')
  root.id = 'root'
  const frame = document.createElement('div')
  frame.setAttribute('data-sidebar-collapsed', '')
  frame.setAttribute('data-details-collapsed', '')
  const sidebar = document.createElement('div')
  Object.defineProperty(sidebar, 'offsetWidth', { configurable: true, value: 300 })
  frame.append(sidebar)
  const center = document.createElement('div')
  frame.append(center)
  frame.scrollTo = ((opts: ScrollToOptions): void => { frame.scrollLeft = opts.left ?? 0 }) as never
  root.append(frame)
  document.body.append(root)
  return frame
}

function toggleSidebarSpy() { return vi.fn() }

/** Track every mounted controller so afterEach can dispose it. */
const liveControllers: MobileController[] = []
function makeController(options: MobileControllerOptions): MobileController {
  const controller = new MobileController(options)
  liveControllers.push(controller)
  return controller
}

async function flushTimers(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

afterEach(() => {
  for (const controller of liveControllers.splice(0)) controller.dispose()
  document.body.innerHTML = ''
  document.head.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('MobileController mount/dispose', () => {
  it('tags <html> and upgrades the viewport meta', () => {
    stubMatchMedia(false)
    makeFrame()
    const controller = makeController({ toggleSidebar: toggleSidebarSpy() })
    controller.mount()
    expect(document.documentElement.dataset.dshMobile).toBe('')
    const meta = document.querySelector('meta[name="viewport"]')
    expect(meta?.getAttribute('content')).not.toContain('viewport-fit')
    expect(meta?.getAttribute('content')).toContain('maximum-scale=1')
    controller.dispose()
    expect(document.documentElement.hasAttribute('data-dsh-mobile')).toBe(false)
  })

  it('restores the pre-existing viewport meta content on dispose', () => {
    stubMatchMedia(false)
    const meta = document.createElement('meta')
    meta.name = 'viewport'
    meta.content = 'width=device-width, initial-scale=1'
    document.head.append(meta)
    const controller = makeController({ toggleSidebar: toggleSidebarSpy() })
    controller.mount()
    expect(meta.content).toContain('maximum-scale=1')
    controller.dispose()
    expect(meta.content).toBe('width=device-width, initial-scale=1')
  })
})

describe('MobileController always-open sidebar + pager', () => {
  it('expands the collapsed sidebar on mount and starts on the CHAT page', () => {
    stubMatchMedia(true)
    const frame = makeFrame()
    // The real toggle flips the frame's collapsed attribute (AppFrame
    // re-renders from the layout store); the spy simulates that reaction.
    const toggle = vi.fn(() => { frame.removeAttribute('data-sidebar-collapsed') })
    const controller = makeController({ toggleSidebar: toggle })
    controller.mount()
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(controller.isSidebarOpen()).toBe(true)
    expect(frame.scrollLeft).toBe(300) // starts on the chat page
    expect(document.documentElement.getAttribute(PAGE_ATTR)).toBe('chat')
  })

  it('does not expand on wide viewports', () => {
    stubMatchMedia(false)
    makeFrame()
    const toggle = toggleSidebarSpy()
    const controller = makeController({ toggleSidebar: toggle })
    controller.mount()
    expect(toggle).not.toHaveBeenCalled()
    expect(controller.isSidebarOpen()).toBe(false)
  })

  it('state changes do NOT flip the pager (the page is user-driven)', async () => {
    stubMatchMedia(true)
    const frame = makeFrame()
    const toggle = vi.fn(() => { frame.removeAttribute('data-sidebar-collapsed') })
    const controller = makeController({ toggleSidebar: toggle })
    controller.mount()
    expect(frame.scrollLeft).toBe(300)
    // The sidebar collapses (rail): the pager stays put — the page follows
    // the user, not the state.
    frame.setAttribute('data-sidebar-collapsed', '')
    await new Promise(resolve => setTimeout(resolve, 0)) // mutation observer delivers
    expect(frame.scrollLeft).toBe(300)
    expect(document.documentElement.getAttribute(PAGE_ATTR)).toBe('chat')
  })

  it('picks up the frame when it mounts after the controller', async () => {
    stubMatchMedia(true)
    const root = document.createElement('div')
    root.id = 'root'
    document.body.append(root)
    let frame: HTMLElement | null = null
    const toggle = vi.fn(() => { frame?.removeAttribute('data-sidebar-collapsed') })
    const controller = makeController({ toggleSidebar: toggle })
    controller.mount()
    const frameEl = document.createElement('div')
    frame = frameEl
    frameEl.setAttribute('data-sidebar-collapsed', '')
    frameEl.setAttribute('data-details-collapsed', '')
    const sidebar = document.createElement('div')
    Object.defineProperty(sidebar, 'offsetWidth', { configurable: true, value: 300 })
    frameEl.append(sidebar)
    frameEl.scrollTo = ((opts: ScrollToOptions): void => { frameEl.scrollLeft = opts.left ?? 0 }) as never
    root.append(frameEl)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(toggle).toHaveBeenCalledTimes(1) // always-open expand
    expect(frameEl.scrollLeft).toBe(300) // starts on the chat page
  })

  it('clicking the exposed chat card returns to the chat page', () => {
    stubMatchMedia(true)
    const frame = makeFrame()
    const toggle = toggleSidebarSpy()
    const controller = makeController({ toggleSidebar: toggle })
    controller.mount()
    expect(toggle).toHaveBeenCalledTimes(1) // the mount-time always-open expand
    expect(frame.scrollLeft).toBe(300)
    // The user swiped to the sidebar page; the exposed chat card is the
    // frame's second child. Clicking it flips back to the chat page.
    frame.scrollLeft = 0
    const chatCard = frame.children[1] as HTMLElement
    chatCard.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(frame.scrollLeft).toBe(300)
    expect(toggle).toHaveBeenCalledTimes(1) // pure scroll, state untouched
  })

  it('the sidebar collapse toggle flips to chat instead of collapsing to the rail', () => {
    stubMatchMedia(true)
    const frame = makeFrame()
    const toggle = vi.fn(() => { frame.removeAttribute('data-sidebar-collapsed') })
    const controller = makeController({ toggleSidebar: toggle })
    controller.mount()
    expect(toggle).toHaveBeenCalledTimes(1) // the mount-time always-open expand
    // The user swiped to the sidebar page and taps the shell's collapse
    // button (aria-label 收起侧边栏): the rail collapse is stopped and the
    // pager returns to chat — the state stays expanded, content stays
    // rendered.
    frame.scrollLeft = 0
    const sidebarCol = frame.firstElementChild as HTMLElement
    const collapseBtn = document.createElement('button')
    collapseBtn.setAttribute('aria-label', '收起侧边栏')
    sidebarCol.append(collapseBtn)
    collapseBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(frame.scrollLeft).toBe(300)
    expect(toggle).toHaveBeenCalledTimes(1) // no extra toggle
    expect(controller.isSidebarOpen()).toBe(true)
  })

  it('returnToChat scrolls back to the chat page (session picked in the sidebar)', () => {
    stubMatchMedia(true)
    const frame = makeFrame()
    const controller = makeController({ toggleSidebar: toggleSidebarSpy() })
    controller.mount()
    frame.scrollLeft = 0
    controller.returnToChat()
    expect(frame.scrollLeft).toBe(300)
  })
})

describe('MobileController pager settle (re-snap without state sync)', () => {
  /** Mount with a synchronous rAF so the mount-time re-sync cannot race the
   *  manual scrollLeft the tests set afterwards. */
  function mountSync(frame: HTMLElement, toggle: ReturnType<typeof toggleSidebarSpy>) {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })
    const controller = makeController({ toggleSidebar: toggle })
    controller.mount()
    return controller
  }

  it('parks on the chat page after a past-midpoint swipe WITHOUT syncing state', async () => {
    stubMatchMedia(true)
    const frame = makeFrame()
    const toggle = vi.fn(() => { frame.removeAttribute('data-sidebar-collapsed') })
    mountSync(frame, toggle)
    expect(toggle).toHaveBeenCalledTimes(1) // the mount-time always-open expand
    // Let the mutation observer deliver the mount-time expand before the
    // test drives the scroll.
    await new Promise(resolve => setTimeout(resolve, 0))
    // Swipe from the chat page (300) toward the sidebar, stopping past the
    // midpoint: the settle re-snaps to the chat page, and the state stays
    // expanded — the sidebar column keeps its full rendering (PiUI).
    frame.scrollLeft = 200 // chatLeft 300, midpoint 150
    frame.dispatchEvent(new Event('scroll'))
    await flushTimers(250)
    expect(frame.scrollLeft).toBe(300)
    expect(toggle).toHaveBeenCalledTimes(1) // no state flip from the swipe
    expect(document.documentElement.getAttribute(PAGE_ATTR)).toBe('chat')
    expect(controllerIsOpen()).toBe(true)
    function controllerIsOpen(): boolean {
      return !frame.hasAttribute('data-sidebar-collapsed')
    }
  })

  it('nudges a stop just short of a page back to the whole page', async () => {
    stubMatchMedia(true)
    const frame = makeFrame()
    const toggle = toggleSidebarSpy()
    mountSync(frame, toggle)
    expect(toggle).toHaveBeenCalledTimes(1) // the mount-time always-open expand
    // Stops just short of the chat page: the settle nudges the scroll.
    frame.scrollLeft = 290 // chatLeft 300, nearest chat
    frame.dispatchEvent(new Event('scroll'))
    await flushTimers(250)
    expect(toggle).toHaveBeenCalledTimes(1) // no new flip
    expect(frame.scrollLeft).toBe(300)
  })
})

describe('MobileController keyboard inset', () => {
  it('writes the visual-viewport deficit as --dshm-keyboard-inset while an editable element is focused, and clears it otherwise', async () => {
    stubMatchMedia(false)
    makeFrame()
    const resizeHandlers: Array<() => void> = []
    // A realistic rAF stub: schedules the callback async and returns a
    // nonzero frame id (a synchronous stub returning 0 would leave the
    // controller's in-flight guard stuck).
    let rafId = 0
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queueMicrotask(() => cb(0))
      return ++rafId
    })
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        height: 320,
        offsetTop: 0,
        width: 375,
        addEventListener: (_t: string, fn: () => void) => { resizeHandlers.push(fn) },
        removeEventListener: vi.fn(),
      },
    })
    const controller = makeController({ toggleSidebar: toggleSidebarSpy() })
    controller.mount()
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 })
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 300 })
    const fire = async () => { resizeHandlers[0]?.(); await Promise.resolve(); await Promise.resolve() }
    // The keyboard inset only applies while typing: nothing focused → 0.
    await fire()
    expect(document.documentElement.style.getPropertyValue('--dshm-keyboard-inset')).toBe('0px')
    // An editable element holds focus (the composer input) → the deficit applies.
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    await fire()
    expect(document.documentElement.style.getPropertyValue('--dshm-keyboard-inset')).toBe('300px')
    // Focus leaves the input (keyboard closed) → back to 0, even though the
    // visualViewport still reports the shrunken height.
    input.blur()
    await fire()
    expect(document.documentElement.style.getPropertyValue('--dshm-keyboard-inset')).toBe('0px')
    controller.dispose()
  })
})

describe('MobileController third page (details opt-in)', () => {
  const OPT_IN = 'data-dshm-details-page'

  afterEach(() => {
    document.documentElement.removeAttribute(OPT_IN)
  })

  /** A frame with the details column present; clientWidth stubbed to 800 so
   *  the full-width page math has a real page width. The frame keeps its
   *  data-details-collapsed attribute throughout — AppFrame's computeColumns
   *  never opens the details track on narrow viewports, so the opt-in alone
   *  decides the page count. */
  function makeThreeColFrame(): HTMLElement {
    const frame = makeFrame()
    Object.defineProperty(frame, 'clientWidth', { configurable: true, value: 800 })
    frame.append(document.createElement('div')) // the details column
    return frame
  }

  function mountSync(options: MobileControllerOptions) {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })
    const controller = makeController(options)
    controller.mount()
    return controller
  }

  it('parks on the details page after a left swipe past the midpoint', async () => {
    stubMatchMedia(true)
    const frame = makeThreeColFrame()
    document.documentElement.setAttribute(OPT_IN, '')
    mountSync({ toggleSidebar: toggleSidebarSpy() })
    expect(frame.scrollLeft).toBe(300) // still starts on the chat page
    await new Promise(resolve => setTimeout(resolve, 0))
    // Swipe left from the chat page (300) toward the details page (1100),
    // stopping past the midpoint (700): the settle re-snaps to details.
    frame.scrollLeft = 800
    frame.dispatchEvent(new Event('scroll'))
    await flushTimers(250)
    expect(frame.scrollLeft).toBe(1100)
    expect(document.documentElement.getAttribute(PAGE_ATTR)).toBe('details')
  })

  it('stays two pages without the opt-in', async () => {
    stubMatchMedia(true)
    const frame = makeThreeColFrame()
    mountSync({ toggleSidebar: toggleSidebarSpy() })
    await new Promise(resolve => setTimeout(resolve, 0))
    frame.scrollLeft = 800
    frame.dispatchEvent(new Event('scroll'))
    await flushTimers(250)
    expect(frame.scrollLeft).toBe(300) // re-snapped to chat, no details target
    expect(document.documentElement.getAttribute(PAGE_ATTR)).toBe('chat')
  })

  it('a swipe back right from the details page re-snaps to the chat page', async () => {
    stubMatchMedia(true)
    const frame = makeThreeColFrame()
    document.documentElement.setAttribute(OPT_IN, '')
    mountSync({ toggleSidebar: toggleSidebarSpy() })
    await new Promise(resolve => setTimeout(resolve, 0))
    frame.scrollLeft = 1100 // resting on the details page
    frame.dispatchEvent(new Event('scroll'))
    await flushTimers(250)
    expect(document.documentElement.getAttribute(PAGE_ATTR)).toBe('details')
    // Swipe right, stopping short of the details midpoint: back to chat.
    frame.scrollLeft = 600
    frame.dispatchEvent(new Event('scroll'))
    await flushTimers(250)
    expect(frame.scrollLeft).toBe(300)
    expect(document.documentElement.getAttribute(PAGE_ATTR)).toBe('chat')
  })

  it('a late opt-in (plugin loads after dsh-mobile) grows the pager live', async () => {
    stubMatchMedia(true)
    const frame = makeThreeColFrame()
    mountSync({ toggleSidebar: toggleSidebarSpy() })
    await new Promise(resolve => setTimeout(resolve, 0))
    // Two pages: a far-left offset has no details target yet.
    frame.scrollLeft = 800
    frame.dispatchEvent(new Event('scroll'))
    await flushTimers(250)
    expect(frame.scrollLeft).toBe(300)
    // The plugin lands and opts in: the observer re-snaps live.
    document.documentElement.setAttribute(OPT_IN, '')
    await new Promise(resolve => setTimeout(resolve, 0))
    frame.scrollLeft = 800
    frame.dispatchEvent(new Event('scroll'))
    await flushTimers(250)
    expect(frame.scrollLeft).toBe(1100)
    expect(document.documentElement.getAttribute(PAGE_ATTR)).toBe('details')
  })
  it('keeps the details page rendering-skipped until a swipe approaches it', async () => {
    stubMatchMedia(true)
    const frame = makeThreeColFrame()
    document.documentElement.setAttribute(OPT_IN, '')
    mountSync({ toggleSidebar: toggleSidebarSpy() })
    await new Promise(resolve => setTimeout(resolve, 0))
    const NEAR = 'data-dshm-near-details'
    // At rest on the chat page (scrollLeft 300; reveal threshold is
    // 300 + 800*0.08 = 364): the huge details panel stays hidden.
    expect(document.documentElement.hasAttribute(NEAR)).toBe(false)
    // Swipe left toward the details page, past the reveal threshold: the
    // attribute lands early enough for the panel to paint before arrival.
    frame.scrollLeft = 500
    frame.dispatchEvent(new Event('scroll'))
    expect(document.documentElement.hasAttribute(NEAR)).toBe(true)
    // Back on the chat page: hidden again (offscreen tax removed).
    frame.scrollLeft = 300
    frame.dispatchEvent(new Event('scroll'))
    expect(document.documentElement.hasAttribute(NEAR)).toBe(false)
  })
})
