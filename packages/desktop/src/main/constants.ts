type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

// This fork ships a custom pet window and is not published to the upstream
// release feed, so the official auto-updater must stay off: updating would
// replace the fork with the stock build. Re-enable only for upstream builds.
export const UPDATER_ENABLED = false
