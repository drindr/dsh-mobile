/**
 * Browser half of dsh-mobile: mounts the DOM controller and keeps the pager
 * on the chat page after sidebar navigation.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { MobileController, type PendingInteractionInfo } from './controller.ts'
import './mobile.css'

export const inject = ['layout', 'uiWorkspace', 'sessions', 'uiSession']

export function apply(ctx: Context): void {
  ctx.effect(() => {
    const controller = new MobileController({
      toggleSidebar: () => ctx.layout.toggleSidebar(),
      openSession: (sessionId) => ctx.uiWorkspace.openSession(sessionId as Parameters<typeof ctx.uiWorkspace.openSession>[0]),
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
    })
    controller.mount()

    const syncPendingInteraction = (): void => {
      const state = ctx.sessions.list.getSnapshot()
      const statuses = ctx.uiSession.sessionStatus.getSnapshot()
      let info: PendingInteractionInfo | null = null
      let extraCount = 0
      for (const [id, status] of statuses) {
        const interaction = status.pendingInteraction
        if (interaction === undefined) continue
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
      if (info !== null) info.extraCount = extraCount
      controller.setPendingInteraction(info)
    }

    const offStatus = ctx.uiSession.sessionStatus.subscribe(syncPendingInteraction)
    const offSessions = ctx.sessions.list.subscribe(() => {
      syncPendingInteraction()
      controller.returnToChat()
    })
    syncPendingInteraction()

    return () => {
      offStatus()
      offSessions()
      controller.dispose()
    }
  }, 'dsh-mobile: DOM controller')
}
