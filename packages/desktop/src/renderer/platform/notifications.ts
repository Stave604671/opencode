import type { Platform } from "@opencode/app/desktop"
import type { PetSpeech } from "../../preload/types"
import type { ElectronAPI } from "../api-types"

type DesktopNotifyAPI = Pick<ElectronAPI, "getWindowFocused" | "showWindow" | "setWindowFocus">

const MAX_ACTIVE_NOTIFICATIONS = 40

const activeNotifications = new Set<Notification>()

export function createDesktopNotify(api: DesktopNotifyAPI): Platform["notify"] {
  // Notifications voiced by the pet while it is on screen. Click refers to a
  // bubble still visible, so keeping the last few is enough.
  const petSpeech = new Map<string, () => void>()
  let petSpeechSeq = 0
  ;(window as any).api?.pet?.onSayClick?.((id: string) => {
    const action = petSpeech.get(id)
    petSpeech.delete(id)
    if (!action) return
    void api.showWindow().catch(() => undefined)
    void api.setWindowFocus().catch(() => undefined)
    action()
  })
  return async (title, description, onClick, tone) => {
    const focused = await api.getWindowFocused().catch(() => document.hasFocus())

    if (focused) return

    // Route through the pet bubble instead of a second OS toast.
    const id = "pet-say-" + ++petSpeechSeq
    if (onClick) {
      petSpeech.set(id, onClick)
      while (petSpeech.size > 4) {
        const oldest = petSpeech.keys().next()
        if (oldest.done) break
        petSpeech.delete(oldest.value)
      }
    }
    const said = await (window as any).api?.pet?.say?.({ id, title, detail: description ?? null, tone: tone ?? "info" }).catch(() => false)
    if (said) return
    petSpeech.delete(id)

    const notification = new Notification(title, {
      body: description ?? "",
      icon: "https://opencode.ai/favicon-96x96-v3.png",
      silent: true,
    })

    if (activeNotifications.size >= MAX_ACTIVE_NOTIFICATIONS) {
      const oldest = activeNotifications.values().next().value

      if (oldest) activeNotifications.delete(oldest)
    }

    activeNotifications.add(notification)

    const release = () => {
      activeNotifications.delete(notification)
      notification.onclick = null
      notification.onclose = null
      notification.onerror = null
    }

    notification.onclose = release
    notification.onerror = release

    notification.onclick = () => {
      release()
      void Promise.all([api.showWindow(), api.setWindowFocus()])
      onClick?.()
      notification.close()
    }
  }
}
