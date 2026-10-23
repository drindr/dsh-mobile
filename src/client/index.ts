/**
 * Browser half of the dsh-mobile plugin: mounts the DOM-side mobile
 * controller (viewport meta, safe-area/keyboard insets, pager page mirror)
 * and returns to the chat page when the current session changes (a session
 * picked in the sidebar). The global mobile sheet (mobile.css) is injected
 * with this bundle as a <style data-plugin> tag and removed on unload — the
 * stock GUI stays byte-identical without the plugin row.
 *
 * Mobile layout follows PiUI's chat pager: the stock three-column frame
 * becomes a horizontal scroll-snap pager (sidebar | chat), the chat column
 * renders completely untouched, and the pager starts on the chat page —
 * swiping reveals the always-open sidebar. A plugin occupying the details
 * slot (ThreadTrail) can opt into a third page right of the chat by setting
 * [data-dshm-details-page] on <html> (see controller.ts).
 */
// In 0.1.2 the client root context is plain cordis Context (the old client
// runtime package is gone); service surfaces arrive as declaration merges
// on '@deepseek-ai/cordis'.
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the layout plugin's Context merge (ctx.layout), the
// session object layer (ctx.sessions), and the uiSession service surface
// (ctx.uiSession.pendingInteractions) into this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { MobileController, type PendingInteractionInfo } from './controller.ts'
// Plugin-owned global mobile sheet (injected as a <style data-plugin> tag).
import './mobile.css'

/** Services required by the mobile plugin. */
export const inject = ['layout', 'sessions', 'uiSession']

/**
 * Install the mobile surfaces: the DOM controller (one effect). A
 * current-session change (a session picked from the sidebar page, or a new
 * session started) returns the pager to the chat page — list updates that
 * do not move `current` (running flags, titles) leave it alone.
 * @param ctx - Client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    // DSH 0.2 exposes pending interactions through the unified status source.
    // Retain the old source for installations still running DSH 0.1.
    type SessionKey = keyof ReturnType<typeof ctx.sessions.list.getSnapshot>["byId"]
    type Pending = { key: string; kind: string; sessionId: SessionKey }
    type Source<T> = { getSnapshot(): ReadonlyMap<SessionKey, T>; subscribe(fn: () => void): () => void }
    const ui = ctx.uiSession as unknown as {
      pendingInteractions?: Source<Pending>
      sessionStatus?: Source<{ pendingInteraction?: Pending }>
    }
    const pendingInteractions: Source<Pending> = ui.pendingInteractions ?? {
      getSnapshot: () => {
        if (!ui.sessionStatus) throw new Error('dsh-mobile: missing session status source')
        const pending = new Map<SessionKey, Pending>()
        for (const [id, status] of ui.sessionStatus.getSnapshot()) {
          if (status.pendingInteraction) pending.set(id, status.pendingInteraction)
        }
        return pending
      },
      subscribe: (fn) => {
        if (!ui.sessionStatus) throw new Error('dsh-mobile: missing session status source')
        return ui.sessionStatus.subscribe(fn)
      },
    }
    const controller = new MobileController({
      toggleSidebar: () => ctx.layout.toggleSidebar(),
      // One-tap session-switch guarantee: the row's own onClick switches on
      // its click, but a tap the browser swallows must still switch — the
      // controller opens the tapped session itself when the current session
      // did not move. The session id is resolved by matching the row's text
      // against the list snapshot's display titles (the rows carry no id
      // attribute).
      openSession: (sessionId) => {
        ctx.sessions.open(sessionId as Parameters<typeof ctx.sessions.open>[0])
      },
      resolveSessionId: (rowText) => {
        const state = ctx.sessions.list.getSnapshot()
        let best: string | undefined
        let bestLength = 0
        for (const id of state.ids) {
          const title = state.byId[id]?.displayTitle
          if (title !== undefined && title.length > bestLength && rowText.includes(title)) {
            best = id
            bestLength = title.length
          }
        }
        return best
      },
      currentSessionId: () => ctx.sessions.list.getSnapshot().current,
    })
    controller.mount()
    let lastCurrent = ctx.sessions.list.getSnapshot().current

    /** Surface sessions (other than the current one) that wait on the user —
     *  approval, question, or plan review — as a tappable banner. The app's
     *  own indicator (a tiny dot on a row inside a workspace group) is
     *  invisible on a phone. Pending interactions live on the uiSession
     *  service (a ReadonlyMap<SessionId, SessionPendingInteraction>), not on
     *  the list summary — same source the sidebar's dot reads in 0.1.2
     *  (ui-workspace's visiblePendingKind accepts exactly these kinds). */
    const syncPendingInteraction = (): void => {
      const state = ctx.sessions.list.getSnapshot()
      const current = state.current
      const pending = pendingInteractions.getSnapshot()
      let info: PendingInteractionInfo | null = null
      let extraCount = 0
      for (const [id, interaction] of pending) {
        if (id === current) continue // the current session shows the inline panel
        const kind = interaction.kind
        if (kind !== 'approval' && kind !== 'plan-review' && kind !== 'question') continue
        if (info === null) {
          info = {
            sessionId: id,
            title: state.byId[id]?.displayTitle ?? id,
            kind,
            extraCount: 0,
          }
        } else {
          extraCount += 1
        }
      }
      if (info !== null && extraCount > 0) info.extraCount = extraCount
      controller.setPendingInteraction(info)
    }

    const offPending = pendingInteractions.subscribe(() => {
      syncPendingInteraction()
    })
    const off = ctx.sessions.list.subscribe(() => {
      syncPendingInteraction()
      const next = ctx.sessions.list.getSnapshot().current
      if (next === lastCurrent) return
      lastCurrent = next
      controller.returnToChat()
    })
    syncPendingInteraction()

    /** Foreground recovery for lost pending waits. While the PWA is
     *  backgrounded, iOS can suspend the SSE stream WITHOUT closing it — no
     *  reconnect, so no mux-open replay. approval/question/plan-review frames
     *  that arrived in that window are never replayed. The uiSession pending
     *  map is re-published from the replayed requests, so "the CURRENT
     *  session has a pending interaction but no takeover panel is mounted"
     *  means the panel render was lost: reload to force a fresh connection
     *  whose mux-open replay re-mints the waits. A replay that never lands
     *  (the ask was withdrawn server-side) clears the map entry after
     *  reload, so this cannot loop. */
    const recoverLostPending = (): void => {
      if (document.visibilityState !== 'visible') return
      // Give the app a beat to re-render pending panels after foregrounding.
      window.setTimeout(() => {
        const current = ctx.sessions.list.getSnapshot().current
        if (current === undefined) return
        if (pendingInteractions.getSnapshot().get(current) === undefined) return
        const panel = document.querySelector(
          '[data-approval-key], [data-question-key], [data-plan-review-key]',
        )
        if (panel !== null) return
        location.reload()
      }, 700)
    }
    document.addEventListener('visibilitychange', recoverLostPending)
    return () => {
      offPending()
      off()
      document.removeEventListener('visibilitychange', recoverLostPending)
      controller.dispose()
    }
  }, 'dsh-mobile: DOM controller')
}
