# CHANGES.md — 动态壁纸（Wallpaper Engine 场景 / 视频壁纸）支持

> 基于 fork 上游 0.2.1（27d8699）。所有改动均为增量，静态壁纸原有链路保持不变。
> 0.3.0：场景壁纸 + 视频壁纸（.mp4/.webm 直接导入）+ 循环冻结看门狗 + ZCode 启动自动拉起 serve。

---

# v0.4.0 — 可靠性修复：受信渲染路径 + 用户属性合并

实测（Windows 10，Wallpaper Engine 32 位常驻实例）发现并修复四个问题：

## 1. WE 安全机制导致临时路径渲染黑屏

WE 只在受信位置（Steam 创意工坊、`Documents\Wallpaper Engine\`）执行场景脚本；
`%TEMP%` 等不受信路径的信任弹窗在无头播放窗口里无法确认，场景 JS 永远不执行，
渲染窗口表现为纯黑。修复：渲染前把壁纸整目录拷贝到
`Documents\Wallpaper Engine\projects\zcode-beautify\<hash>`，从受信副本打开播放窗口。

## 2. 用户在 WE 里调过的属性对渲染窗口不可见

WE 的播放窗口只读 project.json 里的默认值；用户在 WE 设置栏改过的开关
（提示框、音频条、时间组件……）保存在 `wallpaper_engine/config.json`
的 `profiles.<profile>.wproperties` 里，渲染时完全看不到。修复：渲染前读取
config.json（按壁纸路径匹配，支持正反斜杠两种键格式），把所有存在于
project.json 的属性覆盖**字节级拼接**进副本的 project.json——不做 JSON
重序列化，原文件的字节形状保持不变（组合框属性带 options 数组，拼接后
逐一 JSON.parse 验证，防止误改 options 里的 value）。

## 3. Steam 库扫描漏掉 `steamapps\common` 布局

部分 Steam 库把 wallpaper_engine 放在 `<库>/steamapps/common/wallpaper_engine/`
下，原探测只查 `<库>/wallpaper_engine/`，导致"未检测到 Wallpaper Engine"。
修复：两种布局都探测。

## 4. 渲染窗口被用户窗口遮挡

ddagrab 录制的是整个屏幕，播放窗口若被用户正 focused 的窗口盖住，录到的就是
别人的画面。修复：定位播放窗口时置顶（HWND_TOPMOST），并把场景稳定等待从
3 秒放宽到 10 秒（大场景包 + 着色器编译需要时间）。

## 5. 表面颜色 / 透明度可调（新功能）

任务卡与消息气泡的底色来自 CSS 变量 `--color-panel` / `--color-card`，此前
完全由莫奈取色决定。新增面板控件「表面颜色」：颜色选择器 + 不透明度滑块 +
↺ 恢复莫奈，通过 `:root` 变量覆盖注入，改完即实时生效（经 /api/config 重注入）。

---

# 分区模糊 / 分区压暗（sidebar / main / terminal / sidepanel）

## 需求

原来模糊与压暗是全局的：整个窗口共用一个值。现在这四个布局区域各自可调，允许
「主区域虚化、侧边栏保持清晰」这类组合。

## 渲染方案

壁纸层本身不再带 `filter: blur()` 与压暗遮罩，改为：

1. `#zcode-beautify-wallpaper`：只负责画图（保留 `scale(1.04)`，让全局层的
   backdrop-filter 在窗口边缘仍能采样到图像，不出现淡出）；
2. `#zcode-beautify-global`：全窗口 `backdrop-filter: blur(...)` + 黑色压暗底；
3. `#zcode-beautify-region-<id>`：按区域矩形定位，各自 `backdrop-filter` + 压暗底；
4. 运行时把全局层裁掉各区域矩形。

这样区域值是**绝对值**而非叠加：把某区设为 0px 就是清晰，而不是「在全局基础上再加」。
同一张壁纸只有一份（不复制图片、不复制视频解码），跨区域连续无缝。

### 踩坑 1：多洞 polygon() 会切出蝴蝶结（用户报的「侧边栏有个 X」）

最初用 `clip-path: polygon(evenodd, 外框, 洞1, 洞2, …)`。`polygon()` 是**单条闭合
路径**：一个洞的最后一个点会与下一个洞的第一个点用**真实线段**相连，收尾再连回外框
起点。两个及以上区域时，这两条斜线在 evenodd 规则下把图层切成蝴蝶结——窗口上一个大
X。只有一个区域时连接线恰好与左边缘重合，所以单区测试完全正常，四个分区一起才暴露。

改为 `clip-path: path("M…Z M…Z …")`：每个洞是独立子路径，外框顺时针、每个洞逆时针，
靠 nonzero 规则成洞，不再有任何连接线段。断言见 `test/t11-verify.ts`。

### 踩坑 2：旧注入脚本的定时器会覆盖新代码

bootstrap 有「内容未变就跳过」的守卫（只比 CSS），所以**纯代码改动不会重新执行**，
运行中的渲染器一直跑旧逻辑。加入 `BOOTSTRAP_VERSION` 参与守卫后仍发现：旧版脚本注册
的 `setInterval` 闭包是旧 `sync`，它没保存 timer id、无法被清除，于是每 500ms 把新的
`path()` 覆盖回 `polygon()`（新旧两个定时器抢写）。

两层修法：

- 定时器与 resize 监听改为**每次注入都替换**，并经由 `window.__zcodeBeautify.*` 属性
  查调用，任何存活的旧定时器也会落到当前实现；
- 裁剪值不再写 inline，而是写进一个 `<style>` 的 `!important` 声明——重要作者声明
  优先于普通 inline 声明，因此无法被清除的旧脚本即使仍在写 inline 也无法覆盖。

### 踩坑 3：分区跟不上侧边面板的开合动画

症状：右侧面板开合时，右栏那块要等一会才变模糊、关闭后也要等一会才变回去。

实测后确认了三件事：

1. 面板关闭时**不是从 DOM 卸载**，而是被平移到视口右侧之外，宽度不变——所以是
   **纯位置变化**，`ResizeObserver` 根本不会触发；
2. 面板的 `transitionDuration` 是 **0s**：它不是 CSS 动画，而是 JS 逐帧改宽度、
   位置由 flex 布局推导出来的；
3. 只有 500ms 兜底轮询能发现位置变化，所以延迟约 0.5s。

修法三层：

- **在 ResizeObserver 回调里直接写图层**（`onResizeObserved`），而不是丢给 rAF：
  RO 回调发生在布局之后、同一帧内，写入会在同一帧绘制；rAF 在布局之前，基于它
  跟随天然慢一帧，而动画期间一帧就是几百像素；
- **四个区域元素全部观察**（`regionSelectors` 随载荷下发），因为任一区域尺寸变化
  都会带动邻居移动——右栏自身尺寸不变，但主区域变窄，观察主区域即可同帧同步；
- 保留 80ms 兜底探针，但用 `dirty` 标记门控（观察器只置标记），窗口静止时零开销；
  另加挂在区域元素及其外层容器上的属性观察器（`style`/`class`），捕捉既不改尺寸
  也不改结构的纯位置动画。

验收方式：在 ResizeObserver 回调里（绘制前一刻）逐帧比对「每个分区图层 vs 其目标
元素」的矩形。修复前关闭方向有持续上百毫秒、最大 364px 的偏差；修复后两个方向都是
**0 个不一致帧、最大偏差 0px**。注意用 rAF 采样会误判：rAF 在布局之前，读到的是帧
中间的瞬态，而该瞬态在绘制前已被 RO 回调修正。

## 区域识别

用 ZCode 自身的语义布局标记，而不是生成的 class 名：

| 区域 | 选择器 |
|---|---|
| sidebar | `[data-workspace-sidebar-panel]` |
| main | `[data-workspace-conversation-frame]` |
| terminal | `[data-workspace-terminal-frame]` |
| sidepanel | `[data-workspace-side-frame]` |

运行时每个区域绑一个 `ResizeObserver` + 窗口 resize + 500ms 兜底轮询（覆盖 React
换节点导致 observer 静默失效的情况）；矩形小于 2px（终端折叠为 0px）时隐藏该层。
改版失效时面板里点「拾取元素」重新指定，选择器按 `#id` → 唯一 `data-*` 属性 →
`nth-child` 路径生成。

## 新增 / 修改

- 新增 `src/core/regions.ts`：区域 id、默认选择器、`effectiveRegions()` 解析
  （每字段独立继承全局）、`sanitizeRegionPatch()` / `mergeRegionSettings()`
  （`null` = 清除该字段，区域清空后自动删除）。
- `src/core/inject.ts`：`BeautifyConfig.regions`；`buildPayload` 输出分区层 CSS 与
  `--zcb-*-filter` / `--zcb-*-dim` 自定义属性（无运行时也能靠 CSS 自愈出正确的全局
  外观），并给出 `regionIds` / `activeRegions` / `live` 供运行时使用。
- `src/core/cdp.ts`：bootstrap 建层、`sync()` 定位 + 裁洞（`path()` 子路径）、`BOOTSTRAP_VERSION` 参与守卫、`applyLive()` 供面板即时
  预览、`setInterval(track, 500)` 兜底；guard 加入区域集合（只改选择器时 CSS 不变，
  仅比 CSS 会漏掉重跑）；reset 清理新增层。
- `src/core/server.ts`：`/api/config` 接受 `regions` 补丁并合并；`publicConfig` 返回
  每区的解析值、`own`（该区自己拥有的字段）与选择器。
- `src/panel/panelScript.ts`：新增「调节目标」chip 行（全局 / 侧栏 / 主区 / 终端 /
  右栏）、按字段独立覆盖、`⌖ 拾取元素`、`↺ 跟随全局`、状态提示（已单独设置哪些项 /
  元素是否找到）。滑杆只写被拖动的那一项，另一项继续跟随全局。
- `src/cli.ts`：新增 `region <id> [--blur] [--dim] [--selector] [--reset]`。
- `src/mcp/server.ts`：`apply_options` 新增 `regions` 参数。
- `test/t11-verify.ts`：载荷契约、配置合并、注入脚本语法可编译等断言。
- README / README.zh-CN / skills / commands 同步说明。

## 兼容性

- `regions` 为可选字段，旧配置无需迁移；未设置任何区域时行为与之前一致（唯一差异是
  模糊改由 backdrop 层承担，视觉等价，窗口边缘反而更干净）。
- 壁纸隐藏（取消勾选「显示壁纸」）时不注入任何分区层，压暗也不会误伤半透明 UI。

---

## 功能概述

- 支持导入 Wallpaper Engine **场景壁纸**（`.pkg` 或含 `project.json` 的工坊目录）：
  WE 专属窗口渲染 → ffmpeg ddagrab 录制 → 交叉淡化无缝循环 → 本地缓存 → 注入 `<video>` 动态背景。
- 静态图片壁纸流程、面板、CLI、MCP 行为不变；场景壁纸复用同一注入层（增量字段）。

## 新增模块（src/core/）

| 文件 | 职责 |
|---|---|
| `wallpaperType.ts` | 输入类型检测（image/scene/video/web/unknown），覆盖真实工坊目录的多种 project.json 布局（含无 type/file 字段、资产在 files/ 子目录的情况） |
| `dependencyCheck.ts` | WE 检测（运行进程 → 注册表 → libraryfolders.vdf → 多盘扫描 → PATH）；ffmpeg 检测（PATH 或 `ZCODE_BEAUTIFY_FFMPEG` 环境变量覆盖，版本 ≥5.0 校验，ddagrab 需要）；安装引导文案 |
| `weLauncher.ts` | WE 专属窗口开关：`-control openWallpaper -playInWindow`；窗口等待/定位（EnumWindows 精确匹配 + SetWindowPos，实测客户区）；关闭走 `-control closeWallpaper`（spawn 句柄不可靠，仅诊断用） |
| `recorder.ts` | ddagrab 捕获（置顶窗口 → `hwdownload,format=bgra → crop → scale` → libx264）；blackdetect/signalstats 黑屏自检 |
| `loopProcessor.ts` | 无缝循环：`crossfade(尾部淡出, 开头淡入) ++ 主体` 构造，首尾帧严格相等（SSIM 实测 0.999996）；`-movflags +faststart -an` |
| `cacheManager.ts` | 内容寻址缓存（MD5 of 内容/清单 + opts），`~/.zcode/cli/plugins/data/zcode-beautify/scenes/<hash>/loop.mp4`；LRU（mtime 记账，NTFS atime 默认禁用不可依赖）10GB 上限 |
| `media.ts` | serve 模式媒体端点实现（HTTP Range 206，全区间/后缀/开区间） |
| `scenePipeline.ts` | 端到端流水线 importScene()：detect → deps → cache → open → record → loop → poster → save → LRU；每步 onProgress |

## 修改文件

- `src/core/cdp.ts`：`InjectionPayload` 新增 `videoSrc`；bootstrap 脚本支持 `<video>` 层（autoplay/loop/muted/playsinline，`document.hidden` 暂停/恢复，视频跳过 localStorage 持久化）；reset 清理 video 状态。**图片路径行为不变。**
- `src/core/inject.ts`：`BeautifyConfig` 新增 `sceneVideoUrl / mediaType / sceneHash / apiPort`；`buildPayload` 支持 video 源；新增 `buildInjectScript` 便捷封装。
- `src/core/session.ts`：`applyWallpaper` 自动识别场景输入并路由到新 `applySceneWallpaper`；`buildPayloadFromConfig` 视频分支（Monet 取色来自 poster.jpg，视频走 http 流）。图片应用逻辑等价重构（baseConfig 提取）。
- `src/core/scenePipeline.ts`：`resolveSceneInput` 接受 `.pkg`、壁纸目录、或目录内任意文件（文件对话框场景下向上查找 project.json）。
- `src/core/server.ts`：新增 `POST /api/pick-scene`（原生文件对话框，供面板「选择并导入」使用）、`POST /api/import-scene`（后台任务）、`GET /api/import-status`、`GET /api/library`（image/scene 分组）、`POST /api/apply-wallpaper`（按 hash 或 path）、`GET /media/scene/<hash>.mp4`（Range）；注入会话透传 videoSrc。
- `src/panel/panelScript.ts`：新增场景导入（「选择并导入…」按钮调起原生文件选择器 + 路径输入 + 进度条 + 失败依赖引导「已安装，重试」）、壁纸库分组列表。原有滑杆/开关不变。
- `src/cli.ts`：新增 `apply-scene` 子命令。
- `src/mcp/server.ts`：新增 `import_scene_wallpaper` 工具；`set_background` 自动识别场景输入；导出 `TOOL_NAMES` 注册表。
- `commands/beautify.md`：支持「导入场景壁纸」意图与依赖引导说明。
- `package.json`：devDependencies 增加 `tsx`（验证脚本运行器；构建产物不含）。

## 关键技术事实（详见 docs/spike-notes.md）

- crop 必须在 `hwdownload` 之后（d3d11 帧上 crop 被静默忽略）。
- ddagrab 抓合成屏幕：录制期间必须把 WE 窗口置顶。
- WE `-playInWindow` 窗口标题=参数值，但窗口归属已运行实例，关闭必须走控制命令。
- 原任务包的淡化滤镜链会丢弃 overlay 帧（overlay 随主输入结束），已替换为数学上首尾相等的构造。
- 渲染器 video 走 http://127.0.0.1 流（file:/// 不可靠、data URI 超配额）。

## 回滚方式

- 单文件独立，`git revert` 或按上表删除新增文件、还原修改文件即可。
- 缓存数据在 `~/.zcode/cli/plugins/data/zcode-beautify/scenes/`，删除该目录即完全清除动态壁纸缓存。
- 新增配置字段（mediaType/sceneHash/apiPort/sceneVideoUrl）均为可选，旧配置文件无需迁移。

## 验证

各任务验证脚本位于 `test/t*-verify.ts`（`npx tsx test/tX-verify.ts` 运行）。
T3/T4/T8 需要本机装有 Wallpaper Engine 与 ffmpeg（或设置 `ZCODE_BEAUTIFY_FFMPEG`）。
