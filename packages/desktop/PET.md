# 桌面宠物（鲸鱼）开发说明

这个包在原版 OpenCode Desktop 上加了一只常驻桌面的鲸鱼宠物：它读取聊天窗口的实时状态，切换对应表情动图；任务完成、失败、需要授权、需要回答时，用头顶气泡说一句话（替代系统右下角通知）。

本文只讲宠物相关的代码位置、状态规则、踩过的坑和构建方式。其余部分与原版 opencode 一致。

## 文件地图

主进程（窗口、状态机、IPC）：

| 文件 | 作用 |
|---|---|
| `src/main/pet.ts` | 宠物窗口创建、状态派生（`getPetSnapshot`）、拖拽、说话投递。**状态机的唯一实现** |
| `src/main/ipc.ts` | 注册 `pet-*` 通道（report / get / toggle / drag / say / say-click 等） |
| `src/main/windows.ts` | `keepOwnBackground`：阻止聊天主题把背景色刷到透明窗口上 |
| `src/main/store-keys.ts` | `PET_WINDOW_ENABLED_KEY`、`PET_WINDOW_POSITION_KEY` |
| `src/preload/index.ts` | 暴露 `window.api.pet.*` 给两个渲染进程 |
| `src/preload/types.ts` | `PetState` / `PetActivity` / `PetSnapshot` / `PetSpeech` 类型 |

宠物渲染进程：

| 文件 | 作用 |
|---|---|
| `src/renderer/pet/index.html` | 精灵 + 气泡骨架 |
| `src/renderer/pet/pet.ts` | `SPRITES` / `POOLS` 映射、轮换定时器、气泡逐字输出、拖拽输入 |
| `src/renderer/pet/pet.css` | 气泡样式（含深色主题）与状态类 |
| `src/renderer/pet/assets/whale/*.gif` | 21 张动图，360×360，单张约 0.9 MB |

聊天窗口侧（决定宠物看到什么）：

| 文件 | 作用 |
|---|---|
| `src/renderer/index.tsx` | `usePetActivity`：把会话状态折成一条 `PetActivity` 上报；`platform.notify` 改为让宠物说话 |
| `packages/app/src/context/pet-speech.ts` | 把事件整理成一句人话（本轮回复摘要 / 权限 / 追问 / 错误） |
| `packages/app/src/context/notification.tsx` | 任务完成、会话出错时调用「让宠物说」而非系统 toast |
| `packages/app/src/pages/layout.tsx` | 权限请求、追问时同样走宠物 |
| `packages/app/src/i18n/{en,zh,zht}.ts` | 台词模板 `notification.speech.*`（其余语言回落英文） |

## 数据流

```
会话事件（server SSE）
  → renderer/index.tsx  usePetActivity()  折成 { state, detail, title, sessionID }
  → ipc "pet-report"
  → main/pet.ts          reportPetActivity() 校验后存起来
  → getPetSnapshot()    叠加时间规则（过期、漂移、休眠）+ 每秒 tick
  → webContents.send("pet-state")
  → renderer/pet/pet.ts  render() 换图 + 气泡
```

主进程不直接读会话数据。聊天窗口是唯一知道「模型在干什么」的地方，它已经在订会话事件流，所以状态从这里来，避免第二套数据源。

## 状态与触发

`PetState` 共 14 个，三处必须同步：`main/pet.ts` 的 `PET_STATES`、`renderer/pet/pet.ts` 的 `SPRITES`、以及 `preload/types.ts` 的联合类型。少一处，该状态会静默回落到 `idle`。

| 状态 | 触发 |
|---|---|
| `idle` | 没有任务 |
| `thinking` | assistant 在推理 / 还没有正文输出 |
| `talking` | 正在流式输出正文（模型在说话） |
| `working` | 有工具在跑 |
| `sweeping` | 出现 `compaction` 类型 part（压缩上下文） |
| `waiting` | 等待工具或子任务返回 |
| `needsinput` | 有 `question.asked`（需要用户回答） |
| `attention` | 有权限请求，或 `session_status.type === "retry"` |
| `error` | 会话报错 |
| `sad` | 用户中止（`MessageAbortedError`） |
| `happy` | 一轮结束 |
| `greet` | 切到还没发过消息的新会话 |
| `loafing` | 安静超过 90 s |
| `sleeping` | 安静超过 5 min |

`happy` / `greet` / `sad` / `error` 是有寿命的（`TRANSIENT_MS`），到点自动退场；`working` / `sleeping` / `loafing` 有轮换池（`POOLS`），60 s 换一姿势，避免一张 4 秒循环播十分钟像卡死。

## 三条硬约束（都踩过）

**1. 拖拽只能用 `setBounds` 且每次带尺寸。**
在 150% 缩放的屏幕上，Electron 42 的 `BrowserWindow.setPosition()` **每调用一次就把宽高各加 1 逻辑像素**。拖一次会发几百个 move 事件，窗口一路涨到屏幕那么大。`dragPet()` 因此每帧显式给出 `width/height`，并且位置按「按下时的窗口位置 + 累计偏移」算，不是逐帧增量（丢帧也不会掉队）。
`ready-to-show` 里也要再 `setBounds` 一次，因为构造函数会把 220×260 取整成 222×260。

**2. 反应类状态过期后必须重新走 idle 阶梯。**
过期直接返回 `{ state: "idle" }` 是错的：`activity.state` 仍然是 `happy`，下一帧又走「过期分支」，永远进不了「idle → loafing」的漂移判断，结果 `loafing` 永不触发。现在过期分支自己判断 `>90s → loafing`、`>5min → sleeping`。

**3. 内存：只给当前显示的那张图设 `img.src`。**
GIF 是 360×360、约 100 帧，单张解码后约 50 MB。21 张全量解码约 1 GB。所以 `paint()` 只换当前 sprite 的 `src`，池内其余素材不解码——不要在 import 时就全部塞进 DOM。

## 构建

前置：Node 22、`bun`（仓库根目录 `bun install`）、Electron 42.3.3。

```bash
cd packages/desktop
bun run build          # prebuild（图标/meta/sidecar）+ electron-vite build → out/
bun run package:win    # electron-builder → dist/opencode-desktop-win-x64.exe + dist/win-unpacked/
```

`bun run build` 的 `prebuild` 会跑 `packages/opencode/script/build-node.ts` 生成 `packages/opencode/dist/node/node.js`（36.7 MB 的后端运行时），这是打包必需的输入。**如果直接调用 `electron-vite build`，必须确保这个文件已经存在**，否则打出来的包缺后端。

只给本机调试时，跳过打包、直接用 `out/` 跑更快：

```bash
cd packages/desktop
bun run dev            # 带热更新，userData 走 dev 通道，与已安装版互不干扰
```

打包参数（本机验证过）：

```bash
electron-builder --win --publish never --config electron-builder.config.ts -c.npmRebuild=false \
  "-c.electronDist=<repo>/node_modules/.bun/electron@42.3.3+.../node_modules/electron/dist"
```

`-c.npmRebuild=false` 是因为 `bun` 环境下重编原生模块会失败（`node-pty` 等已带 prebuild）。`electronDist` 指向本地已有的 Electron，省掉下载。

Windows 上的两个坑：

- 构建命令不要接 `| tail` 之类的管道。进程退出码会被管道吃掉，CI/后台任务误判失败。
- 清产物目录不要用 `rm -rf`（某些受限 shell 的 PATH 里没有 `/usr/bin`，`rm` 会被安全包装脚本拦截并直接失败，连 `&&` 后面的构建都不执行）。用 `node -e "fs.rmSync(p,{recursive:true,force:true})"`。

## 数据与位置

宠物不写安装目录，全部在用户数据目录：

| 内容 | 位置 |
|---|---|
| 宠物开关、上次位置 | `%APPDATA%\ai.opencode.desktop`（`store`） |
| 会话历史 | `~/.local/share/opencode/opencode.db` |
| 登录凭据 | `~/.local/share/opencode/auth.json` |
| 宠物状态变更日志 | 同一 userData 下 `logs/<时间戳>/pet.log` |

调试状态映射时，`pet.log` 里的 `state changed` 和 `activity reporting started` 是最直接的证据：前者说明主进程派生了什么状态，后者说明聊天窗口开始上报的时间点。

## 已知未做

- 拔掉副屏后如果宠物上次停在那块屏上，恢复位置可能落在不存在的区域（`clampToWorkArea` 按屏幕中心找最近显示器，越界时会被拉回，但没在真拔屏的场景下验过）。
- 产物没有代码签名。发给别人会触发 SmartScreen「未知发布者」，需要手动「更多信息 → 仍要运行」。
- `appId` 沿用 `ai.opencode.desktop`，与官方版共用安装目录、`%APPDATA%\ai.opencode.desktop` 和单实例锁。想与官方版并存需另起 appId。
