# 鲸鱼女仆 皮肤（`skin: whale`）· 素材来源与许可

## 当前版本（2026-11-06 起，`.webp` 动画）

本目录中的 `.webp` 动画取自 `PC2005-cloud/dsh-pet` 的 `whaletail-maid`
帧序列（经 `dsh-dafeiyu` 的 `assets/pet` 转换，源 commit
`549fff2ea33c2acfb16612c76912c6137da4a758`，裁切 412×344，24fps）。

- 角色与美术：PC2005-cloud / dsh-pet
- 许可证：MIT（Copyright (c) 2026 PC2005-cloud）；上游 MIT 文本见同目录
  `dsh-pet-LICENSE.txt`。
- 使用范围：可以随 PhilaGift 免费或商业分发，但必须保留上面的版权和
  许可声明。当前使用 `assets/pet/` 的 MIT 素材，不是 dsh-bigfish 或
  `legacy/dafeiyu/` 的受限 BigFish 素材。
- 转换：每 8 帧采样，等比缩放并居中到 320×320 RGBA 透明画布，
  60ms/帧，无限循环，动画 WebP（保留 alpha）。
- 状态映射：idle→idle, thinking→thinking, working→working,
  sweeping→working_command, waiting→waiting, needsinput→head_pat,
  attention→poke, error→error, sad→tail, happy→success, greet→head_pat,
  loafing→idle_stretch, sleeping→idle_yawn, talking→idle, roam→dragging。
- 旧版 360×360 GIF 仍保留在本目录，作为回退/历史参考，`pet.ts` 不再引用。

## 旧版（LLMPET 360×360 GIF，保留作回退）

本皮肤使用**自有原创角色**「鲸鱼女仆」，与 `assets/cat/`（抖音 @月薪喵 的表情包）
无关，不受其版权限制。

## 制作方式

动作参考取自 `assets/cat/` 对应状态的原动画（仅参考动作语义，不复制画面）。

1. **关键帧**：以角色设定图 + 动作参考图为输入，用图像模型生成每个状态一张
   1254×1254 的纯洋红底关键帧。
2. **补边**：内容缩到 87% 贴在洋红画布上，给模型的主体膨胀留出余量，
   桌面类场景额外把桌面色带向两侧补满（悬空的桌子会诱使模型重画整张桌子）。
3. **图生视频**：`doubao-seedance-2-0-fast`，720p / 1:1 / 4s / 固定机位。
4. **逆裁 + 抠像**：按补边的严格逆运算裁回原构图；抠像判据 `min(R,B) - G`
   ——实测洋红背景 ≈204，人物最高分像素（腮红）只有 25，两个分布完全不重叠。
5. **选循环**：在 97 帧里穷举 (起点, 长度)，按绝对接缝评分并要求窗口保留全片
   60% 以上的动态范围；没有自然周期的动作（刷手机、呼吸）转乒乓循环。

完整管线与踩坑记录见 `~/LLMPET_emoji/README.md`。

## 规格

状态映射与 cat 皮肤同构，可直接互换。App 内交付的是 360×360 高清 GIF，按
180×180 逻辑像素显示，为 Retina 屏提供真实 2x 像素；40ms/帧、无限循环、
逐帧真透明（二值 alpha）、0 绿色主导像素、0 残留洋红像素。原制作管线仍保留
120×120 兼容输出，但 App 不再放大该低分辨率版本。

## 状态覆盖

23 个画面覆盖 21 个状态键，另有 3 组姿态轮换池（working 4 张 / loafing 3 张 / sleeping 2 张），
与 cat 皮肤同构。历史上曾有 5 个状态借图顶替，现已全部补齐专属画面：


`thinking` 与 `working-3` 的画面按需求做过对调：按太阳穴配压力符号的那张作 `thinking`
主图，桌前对着笔记本的那张改名为 `whale-working-3.gif` 放进 working 轮换池。

2026-08-19 返工：全部关键帧按安全区规范重出（float 主体高占比降到 60–69%、
四边留白 17–33%），并补齐轮换池素材。
