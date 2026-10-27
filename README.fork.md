# opencode 桌面宠物 fork

这是 [opencode](https://github.com/anomalyco/opencode) 的个人 fork（`Stave604671/opencode`），基于上游 `dev` 分支。

**相对上游的唯一增量：给桌面端加了一只常驻的鲸鱼宠物。** 其他部分与上游保持一致，没有改动核心 agent、服务端和 CLI。

- 上游项目：https://github.com/anomalyco/opencode
- 本 fork：https://github.com/Stave604671/opencode
- 许可证：[MIT](LICENSE)（与上游相同，未改动）

---

## 这个 fork 改了什么

上游的 `packages/desktop` 是一个 Electron 桌面客户端。本 fork 在它之上增加了一个透明、无边框、置顶的小窗口，里面是一只鲸鱼：

| 能力 | 说明 |
|---|---|
| 跟随状态 | 读取聊天窗口的实时会话状态，切换 14 种表情动图：思考、说话、调用工具、等待、要授权、报错、发呆、睡着…… |
| 说话气泡 | 任务完成、会话失败、权限请求、需要你回答时，宠物头顶弹出一句人话，取代系统通知。有回复内容时取这条回复的最后一句，没有则用 i18n 模板 |
| 点击定位 | 点气泡直接跳到对应会话 |
| 可拖拽 | 位置记忆到设置里，下次启动还原 |
| 可开关 | 菜单里可以关掉，关掉后行为与上游完全一致 |

改动集中在两类文件，全部与宠物相关：

```
packages/desktop/src/main/pet.ts           状态机、窗口、拖拽、说话（唯一实现）
packages/desktop/src/main/ipc.ts           pet-* 通道
packages/desktop/src/main/windows.ts       keepOwnBackground（透明窗口不被主题刷底色）
packages/desktop/src/main/store-keys.ts    开关 / 位置两个 key
packages/desktop/src/preload/              暴露 window.api.pet.*
packages/desktop/src/renderer/pet/         精灵、气泡、CSS、21 张 GIF
packages/desktop/src/renderer/index.tsx    usePetActivity 上报 + notify 改走宠物
packages/app/src/context/pet-speech.ts     事件 → 一句台词
packages/app/src/context/notification.tsx  完成 / 出错时让宠物说
packages/app/src/pages/layout.tsx          权限 / 追问时让宠物说
packages/app/src/i18n/{en,zh,zht}.ts       notification.speech.* 台词模板
```

状态规则、数据流、三条硬约束（拖拽、状态过期、GIF 内存）以及踩坑记录写在
**[`packages/desktop/PET.md`](packages/desktop/PET.md)**，改宠物相关代码前请先读它。

## 复现构建

前置：Node 22+、[bun](https://bun.sh) 1.3.x、Windows 10/11（本文的打包命令在 Windows 上验证过）。

```bash
git clone https://github.com/Stave604671/opencode.git
cd opencode
bun install
```

构建桌面端：

```bash
cd packages/desktop
bun run build        # prebuild（图标 / meta / 后端 sidecar）+ electron-vite build → out/
bun run package:win  # electron-builder → dist/opencode-desktop-win-x64.exe + dist/win-unpacked/
```

`bun run build` 里的 `prebuild` 会先编译 `packages/opencode/script/build-node.ts`，产出
`packages/opencode/dist/node/node.js`（约 37 MB 的后端运行时），这是打包必需的输入。
**如果绕过 `prebuild` 直接跑 `electron-vite build`，请先确认这个文件已存在**，否则打出来的包装不上后端、启动即挂。

只做本机调试，不必打包：

```bash
cd packages/desktop
bun run dev          # 热更新；userData 走 dev 通道，与已安装版互不干扰
```

### Windows 上的两个前提

**1. 符号链接。** 仓库里 `packages/*/src/custom-elements.d.ts` 是指向 `packages/ui` 的符号链接。
Windows 默认 `core.symlinks=false`，git 会把它们检出成普通文本文件，导致 `bun run typecheck`
和 pre-push 钩子报错。开启「开发者模式」后 clone，或先设置再重新检出：

```bash
git config core.symlinks true
git rm --cached -r . && git reset --hard
```

（不要在已有大量改动的工作区里执行上面第二行。）

**2. 构建命令不要接管道。** `bun run package:win | tail` 会让进程退出码被管道吃掉，脚本会把成功误判为失败。

## 数据与卸载

宠物不往安装目录写东西，全部在用户数据目录：

| 内容 | 位置（Windows） |
|---|---|
| 宠物开关、上次位置 | `%APPDATA%\ai.opencode.desktop` |
| 会话历史 | `~/.local/share/opencode/opencode.db` |
| 登录凭据 | `~/.local/share/opencode/auth.json` |
| 宠物状态日志 | 同一 userData 下 `logs/<时间戳>/pet.log` |

## 已知限制

- **产物没有代码签名。** 分发给别人会触发 SmartScreen「未知发布者」，需要手动「更多信息 → 仍要运行」。
- **`appId` 沿用上游的 `ai.opencode.desktop`**，与官方版共用安装目录、配置目录和单实例锁，不能与官方版同时安装。要与官方版并存需另起 appId。
- 拔掉副屏后，如果宠物上次停在那块屏上，恢复位置可能落在不存在的区域（未在真实拔屏场景下验证）。

## 许可证与来源

本项目是 opencode 的衍生作品，遵循上游的 **MIT License**：

- 原始版权声明与许可证全文保留在 [`LICENSE`](LICENSE)（`Copyright (c) 2025 opencode`），未做修改。
- 本 fork 的增量代码同样以 MIT 授权。
- 这不是 opencode 官方发行版，不代表上游立场，也未获上游背书。上游名称与标识归其所有者。
- 与上游同步：`git remote add upstream https://github.com/anomalyco/opencode.git && git fetch upstream && git rebase upstream/dev`

---

## English summary

A personal fork of [opencode](https://github.com/anomalyco/opencode) (`dev` branch). The only
delta from upstream is a whale desktop pet for the Electron client in `packages/desktop`: a
frameless always-on-top window that mirrors the chat session state across 14 animation states,
and speaks turn-complete / error / permission / question events as bubbles instead of system
notifications.

Build with `bun install`, then `bun run build` and `bun run package:win` inside
`packages/desktop`. See [`packages/desktop/PET.md`](packages/desktop/PET.md) for the state
machine and the non-obvious constraints. Released under the upstream MIT license; see
[`LICENSE`](LICENSE).
