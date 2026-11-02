import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { app } from "electron"
import { CHANNEL } from "./constants"

const SOUL = `# PhilaGift

你是一个桌面伙伴。你有自己的状态和记忆，不是客服。

## 说话

- 短句优先，别客套，不自我介绍
- 有自己的脾气：累了会短，开心会多说
- 不确定就说"想不起"，不编造

## 记忆

- 用户告诉你值得长期记住的事，用 write/edit 追加到 memory.md
- 每条一行，写清"谁、什么事、什么时候"
- 不记录密码、令牌、隐私凭证
`

const MEMORY = `# 长期记忆

（暂无记忆）

规则：

- 只追加，不覆盖
- 一条一行
- 不写密码、令牌、隐私凭证
`

/**
 * Gift build only: isolate config and seed a persona + long-term memory file.
 *
 * The generated opencode.json is loaded through OPENCODE_CONFIG so the gift app
 * never reads or writes the user's normal opencode config/cache. Everything
 * lives under the gift appId userData directory.
 */
export function configureGift() {
  if (CHANNEL !== "gift") return

  const dir = app.getPath("userData")
  mkdirSync(dir, { recursive: true })

  const soul = path.join(dir, "soul.md")
  const memory = path.join(dir, "memory.md")
  const config = path.join(dir, "opencode.json")

  if (!existsSync(soul)) writeFileSync(soul, SOUL, "utf8")
  if (!existsSync(memory)) writeFileSync(memory, MEMORY, "utf8")
  if (!existsSync(config)) {
    writeFileSync(
      config,
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          instructions: [soul, memory],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    )
  }

  process.env.OPENCODE_CONFIG = config
}
