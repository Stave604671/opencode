import { For, Show, createMemo, createResource, createSignal } from "solid-js"
import type { PermissionRequest, PermissionSavedInfo } from "@opencode/client/promise"
import { Button } from "@opencode/ui/button"
import { TextInput } from "@opencode/ui/text-input"
import type { LocalProject } from "@/shell/state/layout"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useServerSDK } from "@/runtime/server/client"
import { useWorkspaceLocation } from "@/workspaces/location"
import "./project-permissions.css"

export const SettingsProjectPermissions = (props: { project: LocalProject }) => {
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServerSDK()
  const location = useWorkspaceLocation()
  const [editing, setEditing] = createSignal<string>()
  const [editAction, setEditAction] = createSignal("")
  const [editResource, setEditResource] = createSignal("")
  const [status, setStatus] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  const projectID = createMemo(() => location().current?.project.id)

  const [saved, savedActions] = createResource(
    () => (server.connection.status() === "connected" ? projectID() : undefined),
    async (id) => {
      const items = await server.api.permission.saved.list({ projectID: id })
      return items as PermissionSavedInfo[]
    },
    { initialValue: [] as PermissionSavedInfo[] },
  )

  const [pending, pendingActions] = createResource(
    () => (server.connection.status() === "connected" ? location().directory : undefined),
    async (directory) => {
      const result = await server.api.permission.request.list({ location: { directory } })
      return result.data as PermissionRequest[]
    },
    { initialValue: [] as PermissionRequest[] },
  )

  const savedRows = () => (saved.state === "ready" || saved.state === "refreshing" ? saved.latest : [])
  const pendingRows = () => (pending.state === "ready" || pending.state === "refreshing" ? pending.latest : [])

  function startEdit(item: PermissionSavedInfo) {
    setEditing(item.id)
    setEditAction(item.action)
    setEditResource(item.resource)
    setStatus("")
  }

  async function saveEdit(item: PermissionSavedInfo) {
    setBusy(true)
    setStatus("")
    try {
      await server.api.permission.saved.update({
        id: item.id,
        action: editAction().trim() || undefined,
        resource: editResource().trim() || undefined,
      })
      void platform.logGiftAction?.({
        action: "permission.update",
        id: item.id,
        before: { action: item.action, resource: item.resource },
        after: { action: editAction().trim(), resource: editResource().trim() },
      })
      setEditing(undefined)
      setStatus(language.t("project.settings.permissions.saved.saved"))
      await savedActions.refetch()
    } catch (error) {
      setStatus(String(error))
    } finally {
      setBusy(false)
    }
  }

  async function revoke(item: PermissionSavedInfo) {
    setBusy(true)
    setStatus("")
    try {
      await server.api.permission.saved.remove({ id: item.id })
      void platform.logGiftAction?.({
        action: "permission.revoke",
        id: item.id,
        permission: item.action,
        resource: item.resource,
      })
      setStatus(language.t("project.settings.permissions.saved.revoked"))
      await savedActions.refetch()
    } catch (error) {
      setStatus(String(error))
    } finally {
      setBusy(false)
    }
  }

  async function revokeAll() {
    setBusy(true)
    setStatus("")
    try {
      const count = savedRows().length
      await Promise.all(savedRows().map((item) => server.api.permission.saved.remove({ id: item.id })))
      void platform.logGiftAction?.({ action: "permission.revokeAll", count })
      setStatus(language.t("project.settings.permissions.saved.revokedAll"))
      await savedActions.refetch()
    } catch (error) {
      setStatus(String(error))
    } finally {
      setBusy(false)
    }
  }

  async function reply(request: PermissionRequest, decision: "once" | "always" | "reject") {
    setBusy(true)
    setStatus("")
    try {
      await server.api.permission.reply({
        sessionID: request.sessionID,
        requestID: request.id,
        decision,
      })
      void platform.logGiftAction?.({
        action: "permission.reply",
        sessionID: request.sessionID,
        requestID: request.id,
        decision,
        permission: request.action,
        resources: request.resources,
      })
      await Promise.all([pendingActions.refetch(), savedActions.refetch()])
    } catch (error) {
      setStatus(String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.tab.permissions")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">
              {language.t("project.settings.permissions.description", { project: props.project.worktree })}
            </span>
          </div>
          <Button
            variant="ghost"
            size="normal"
            disabled={busy()}
            onClick={() => {
              void savedActions.refetch()
              void pendingActions.refetch()
            }}
          >
            {language.t("project.settings.permissions.refresh")}
          </Button>
        </div>
      </div>

      <div class="settings-tab-body settings-tab-body--sectioned">
        <section class="settings-section">
          <div class="permission-settings-section-header">
            <h3 class="settings-section-title">{language.t("project.settings.permissions.saved.title")}</h3>
            <Show when={savedRows().length > 0}>
              <Button variant="ghost" size="small" disabled={busy()} onClick={() => void revokeAll()}>
                {language.t("project.settings.permissions.saved.revokeAll")}
              </Button>
            </Show>
          </div>
          <Show when={saved.state === "errored"}>
            <p class="permission-settings-empty">{language.t("project.settings.permissions.loadFailed")}</p>
          </Show>
          <Show when={saved.state !== "errored"}>
            <Show
              when={savedRows().length > 0}
              fallback={<p class="permission-settings-empty">{language.t("project.settings.permissions.saved.empty")}</p>}
            >
              <For each={savedRows()}>
                {(item) => (
                  <div class="permission-settings-row">
                    <Show
                      when={editing() === item.id}
                      fallback={
                        <>
                          <div class="permission-settings-main">
                            <code class="permission-settings-code">{item.action}</code>
                            <span class="permission-settings-resource">{item.resource}</span>
                            <Show when={item.resource === "*" || item.action === "*"}>
                              <span class="permission-settings-risk">
                                {language.t("project.settings.permissions.saved.broad")}
                              </span>
                            </Show>
                            <span class="permission-settings-time">
                              {new Date(item.time.updated).toLocaleString(language.locale())}
                            </span>
                          </div>
                          <div class="permission-settings-actions">
                            <Button variant="ghost" size="small" disabled={busy()} onClick={() => startEdit(item)}>
                              {language.t("project.settings.permissions.saved.edit")}
                            </Button>
                            <Button variant="ghost" size="small" disabled={busy()} onClick={() => void revoke(item)}>
                              {language.t("project.settings.permissions.saved.revoke")}
                            </Button>
                          </div>
                        </>
                      }
                    >
                      <div class="permission-settings-edit">
                        <TextInput
                          value={editAction()}
                          aria-label={language.t("project.settings.permissions.saved.action")}
                          onInput={(event) => setEditAction(event.currentTarget.value)}
                        />
                        <TextInput
                          value={editResource()}
                          aria-label={language.t("project.settings.permissions.saved.resource")}
                          onInput={(event) => setEditResource(event.currentTarget.value)}
                        />
                      </div>
                      <div class="permission-settings-actions">
                        <Button variant="ghost" size="small" onClick={() => setEditing(undefined)}>
                          {language.t("project.settings.permissions.saved.cancel")}
                        </Button>
                        <Button variant="submit" size="small" disabled={busy()} onClick={() => void saveEdit(item)}>
                          {language.t("project.settings.permissions.saved.save")}
                        </Button>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </section>

        <section class="settings-section">
          <div class="permission-settings-section-header">
            <h3 class="settings-section-title">{language.t("project.settings.permissions.pending.title")}</h3>
          </div>
          <Show when={pending.state === "errored"}>
            <p class="permission-settings-empty">{language.t("project.settings.permissions.loadFailed")}</p>
          </Show>
          <Show when={pending.state !== "errored"}>
            <Show
              when={pendingRows().length > 0}
              fallback={<p class="permission-settings-empty">{language.t("project.settings.permissions.pending.empty")}</p>}
            >
              <For each={pendingRows()}>
                {(request) => (
                  <div class="permission-settings-row">
                    <div class="permission-settings-main">
                      <code class="permission-settings-code">{request.action}</code>
                      <span class="permission-settings-resource">{request.resources.join(", ")}</span>
                      <span class="permission-settings-time">{request.sessionID}</span>
                    </div>
                    <div class="permission-settings-actions">
                      <Button variant="ghost" size="small" disabled={busy()} onClick={() => void reply(request, "reject")}>
                        {language.t("project.settings.permissions.pending.deny")}
                      </Button>
                      <Button
                        variant="neutral"
                        size="small"
                        disabled={busy() || !request.save?.length}
                        title={
                          !request.save?.length
                            ? language.t("project.settings.permissions.pending.alwaysUnavailable")
                            : request.save?.includes("*")
                              ? language.t("project.settings.permissions.pending.alwaysBroad")
                              : undefined
                        }
                        onClick={() => void reply(request, "always")}
                      >
                        {language.t("project.settings.permissions.pending.allowAlways")}
                      </Button>
                      <Button variant="submit" size="small" disabled={busy()} onClick={() => void reply(request, "once")}>
                        {language.t("project.settings.permissions.pending.allowOnce")}
                      </Button>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </section>

        <p class="permission-settings-note">{language.t("project.settings.permissions.note")}</p>
        <Show when={status()}>
          <p class="permission-settings-status" role="status">
            {status()}
          </p>
        </Show>
      </div>
    </>
  )
}
