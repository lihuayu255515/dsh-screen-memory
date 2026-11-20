# 屏幕记忆（dsh-screen-memory）

给 DeepSeek Harness（DSH）加一双"记得住"的眼睛：**截屏 → 存进本地图片仓库 → 按编号/关键词找回来**；还能按窗口截、把区域放大成特写、分层归档、回顾判断，以及让视觉模型"看图说文字"（不把图塞进你的上下文）。

```
版本     0.4.30（实验性，0.x 阶段；接口可能微调，但数据结构向后兼容）
平台     截图仅 Windows；仓库/眼睛在 macOS/Linux 也可用（对已有图片）
依赖     Node ≥18（推荐 ≥22）· ffmpeg（可选）· 视觉 API Key（可选）· 系统 tar（可选）
数据     ~/.dsh/storages/screen-memory/（卸载不删）
安全     不开端口 · 不建计划任务 · 不注册全局 hook · 初始化失败不影响 DSH 启动
```

---

# 给 AI agent 的必读（人类可跳过到「一、按你的情况选方案」）

你要帮用户安装/使用这个插件时，**按这个顺序做，并把第 3 步告诉用户**：

### 0. 先跑一条命令（最快了解这个插件）

```bash
node scripts/info.mjs          # 一页纸：这是什么 / 11 个工具 / 现在缺什么 / 怎么补 / 怎么装
node scripts/info.mjs --json   # 同样的内容，机器可读
```

### 1. 装之前检查（只读，不改任何东西）

```bash
node -v                                   # ≥22 有 SQLite 索引；<22 自动退化为 JSON（可用但慢）
ffmpeg -version                           # 可选：没有则只能整屏截图，不能按窗口/特写
node <包目录>/scripts/doctor.mjs          # 自检，结论必须是「可以安装」
```

### 2. 安装

```bash
dsh plugin --profile web add <tgz 或目录>
# 注意：profile 名字不一定是 web —— 桌面版常见是 desktop。
# 不确定就看你 ~/.dsh/profiles/ 下有哪些目录，用对的那个。
# 装完必须重启 DSH
```

### 3. 必须主动告诉用户这 3 件事（别说"没什么风险"就装）

1. **它会截屏**：截的是整个虚拟桌面（多显示器全算），录屏/共享屏幕的内容也会被拍进去。
2. **眼睛会把图片发给视觉 API**（默认 DeepSeek 官方；可改成任何 OpenAI 兼容服务或本地模型）。不配置 Key 就不会外发。
3. **归档会删原图但保留 tar.gz 备份**：`screen_maintain` 默认归档 30 天前的图、回收站 7 天后物理删除；`screen_get` 可从归档自动恢复。

### 4. 装完验证

```
调用 screen_status  → 看 capture.chosen / vision.configured / budget.profile / store
调用 screen_look    → 应返回编号 +（balanced/rich 档）本地路径
调用 screen_describe→ 有 Key 时返回三段文字；没 Key 会返回配置指引
```

### 5. 出问题

```
DSH 打不开        → 安全模式启动（插件不加载）→ 跑 rollback.ps1 或 dsh plugin remove
工具报错          → 工具内部全捕获，只会返回错误文本，不影响对话
```

机器可读能力清单：[capabilities.json](./capabilities.json)；安装提示词模板：[AGENT_INSTALL.md](./AGENT_INSTALL.md)。

---

# 一、按你的情况选方案

| 你的情况 | 会怎样 | 解决方案 |
|---|---|---|
| Windows + 有 ffmpeg | 全部截图功能 | 直接装 |
| Windows + 没有 ffmpeg | 能整屏 + 按窗口截图；**不能特写** | 想要特写再装 `ffmpeg`（`winget install ffmpeg`） |
| macOS / Linux | 截图不可用 | 等后续版本；仓库 + 眼睛对已有图片仍可用 |
| 模型能看图（有 `read_image`） | 可让主会话直接看 | 用 balanced/rich 档 |
| **模型不能看图 / 没 read_image** | 截图能存但看不了 | 用 `screen_describe`（自带眼睛），不需要模型有视觉能力 |
| 有 DeepSeek Key（`~/.dsh/.credentials.yaml`） | 眼睛开箱即用 | 直接装 |
| 有别的视觉 API Key | 眼睛需配置 | `vision: { apiKey, baseUrl, model }`（qwen-vl / gpt-4o / glm-4v / 本地 vLLM） |
| 什么 Key 都没有 | 眼睛不可用，其余正常 | 只用截图 + 仓库；或在 credentials.yaml 加 `DEEPSEEK_API_KEY` |
| Node < 22 | 索引退化 JSON | 可用但慢；建议升 Node |
| 没有 `tar` 命令 | 归档/回收站清理不可用 | Windows 10+ 自带 bsdtar；Linux/macOS 默认有 |
| 已装别的看图插件 | **不冲突** | 本插件只写文件，不碰图片管线 |
| 只想存图 | 仓库可用 | 只用 `screen_archive` / `screen_list` / `screen_get` |
| 只想省限额、不想让主会话看图 | 设 `budget.profile: "lean"` | 一律走 `screen_describe`，不返回本地路径 |

---

# 二、能力清单（工具 × 参数 × 依赖）

| 工具 | 参数 | 作用 | 依赖 |
|---|---|---|---|
| `screen_status` | — | 后端/眼睛/预算/仓库状态（JSON） | 无 |
| `screen_look` | `window?` `region?{x,y,w,h}` `place?` `format?` `quality?` `note?` | 截屏入库（`window` 按窗口标题；`region` 需要 ffmpeg 做特写） | 截图后端（特写需 ffmpeg） |
| `screen_archive` | `path?` `dataUrl?` `note?` `source?` | 任意图片入库（QQ 图/网页图） | 无 |
| `screen_describe` | `id?` `path?` `question?` | 眼睛：看图只回文字，不占上下文 | 视觉 API |
| `screen_list` | `query?` `limit?` | 列出仓库（时间倒序） | 无 |
| `screen_get` | `id` | 取回路径；归档图会自动从 tar.gz 解出 | 无 |
| `screen_hud` | `window?` `region?` `place?` `clear?` | 按窗口记住特写区域 | ffmpeg |
| `screen_review` | `limit?` | 列出待判断（留/删）的图 | 无 |
| `screen_judge` | `id` `keep` | 保留 / 进回收站（7 天内可反悔） | 无 |
| `screen_maintain` | `dryRun?` `archiveAfterDays?` `trashAfterDays?` | 归档旧图 + 清理回收站 | tar |
| `screen_search` | `query?` `days?` `since?` `until?` `state?` `limit?` | 按关键词/时间/状态检索 | 无 |

**特写摆放**：`corner`（默认右下）/ `br` `bl` `tr` `tl` / `rail`（右侧）/ `strip`（下方）。

---

# 三、上下文预算档位（不同用户必须选一个）

**主会话每看一张图约占 1000 token，且会长期留在上下文里。** 所以提供三档：

| 档位 | 每小时图 | 是否给本地路径 | 适合谁 |
|---|---|---|---|
| `rich` | 20 | ✅ | 预算大（200K+），希望主会话频繁亲自看 |
| `balanced`（默认） | 6 | ✅ | 大多数情况 |
| `lean` | 0 | ❌（不给路径） | 预算紧 / 模型不能看图：一律 `screen_describe` |

边界保护：

- 超过每小时配额 → `screen_look` 不再返回路径，只给编号并提示用 `screen_describe`
- `lean` 档从设计上不给路径，模型想 `read_image` 也没有路径
- `screen_describe` 不占主会话上下文（另有每日 100 次上限）
- `screen_status` 实时返回 `{profile, imagesPerHour, givePath, usedThisHour, note}`

---

# 四、分层仓库

```
hot       日常用的图
archived  超过 N 天 → 打包 archive/*.tar.gz，原图删除（省空间，可用 screen_get 恢复）
trashed   判断"不要"的图 → 保留 7 天，之后物理删除
```

推荐节奏：隔天 `screen_review` → `screen_judge` → 一周一次 `screen_maintain`（先 `dryRun:true` 看预演）。

## 4.1 仓库 UI（0.4.30）

右侧栏「屏幕记忆」或浏览器打开：

```
/dsh-screen-memory/ui
```

能做的：

```
· 浏览屏幕截图缩略图、查看原图
· 按备注 / 来源 / 编号搜索
· 按状态筛选：待判断 / 活跃 / 已归档 / 回收站
· 每页 60 张，加载更多
· 编辑单张备注（最多 500 字）
· 判断「保留 / 不要」；不要会二次确认并移入回收站
· 勾选 / 全选当前页，批量保留 / 不要 / 归档 / 恢复
· 让视觉模型描述某一张（配置视觉 API 后）
· 把单张活跃图归档；从归档恢复
· 把单张屏幕截图移入回收站
· 把回收站里的图恢复为活跃
```

删除的安全边界：

```
· UI 不提供永久删除；「不要」和「移到回收站」都只进入回收站
· 两者都经过浏览器 confirm 二次确认；取消不会改任何状态
· 批量「不要」也会先确认；批量接口只处理 screen 截图，逐条返回结果
· 「保留」不删除，只标记 judged=1 并留在活跃
· 只会操作 source 以 screen 开头的截图，非屏幕图片会被拒绝
· 回收站由 screen_maintain 在 7 天后物理删除；期间可在「回收站」筛选查看
· 恢复：UI 里有「恢复」按钮；也可用 screen_judge({id, keep:true})。恢复后 judged 清零，重新进入 review 范围
· 归档只对活跃图；归档后原图进 tar.gz，恢复后回活跃并清零 judged
```

---

# 五、配置写在哪

三种方式，任选其一（优先级：插件 config > 环境变量 > credentials.yaml）：

```jsonc
// 1) 插件配置（在 profile 的插件条目 config 下）
{
  "budget": { "profile": "balanced" },          // rich / balanced / lean
  "vision": {
    "apiKey": "sk-...",
    "baseUrl": "https://api.deepseek.com",      // 任何 OpenAI 兼容服务
    "model": "deepseek-flash",
    "maxEdge": 1400,
      "maxTokens": 2500,
    "dailyCap": 100
  },
  "dataDir": "D:/screen-memory"                 // 可选，默认 ~/.dsh/storages/screen-memory
}
```

```bash
# 2) 环境变量
DSH_VISION_API_KEY=sk-...
DSH_VISION_BASE_URL=https://api.deepseek.com
DSH_VISION_MODEL=deepseek-flash

# 3) 默认读 ~/.dsh/.credentials.yaml 里的 DEEPSEEK_API_KEY
```

---

# 六、隐私与安全（安装前请务必知道）

- 截图/图片**只存本机**；`screen_describe({path})` 和 `screen_archive({path})` **只接受图片**（pgn/jpg/webp），传 txt/密钥等会被拒绝 —— 但也不要对不受信任的路径调用
- 截图/图片**只存本机**
- **只有调用 `screen_describe` 时**，才会把图片发给配置的视觉 API；不配 Key 就不外发
- 截图范围是**整个虚拟桌面**（多显示器全拍），录屏/共享屏幕软件可能出现
- 归档会删原图（tar.gz 里有备份）；回收站 7 天后物理删除
- 插件不开端口、不建计划任务、不注册全局 hook；初始化失败只写日志，不影响 DSH 启动

---

# 七、数据存在哪

```
~/.dsh/storages/screen-memory/
├─ index.db                     SQLite 索引（Node <22 时 json-index.json）
├─ blobs/<sha 前2位>/<sha>.jpg  原图（内容寻址，重复只存一份）
├─ archive/*.tar.gz             归档包
├─ hud-profiles.json            按窗口记住的特写
├─ vision-usage.json            眼睛每日用量
├─ usage.json                   每小时图片配额
└─ logs/plugin.log              插件日志
```

卸载不删数据；清空就删该目录（或 `rollback.ps1 -PurgeData`）。

---

# 八、测试与验收（发布前 / 安装后都跑一遍）

## 8.1 三层验收标准

| 层级 | 谁跑 | 命令 | 通过标准 |
|---|---|---|---|
| **L1 环境自检** | 任何人 | `node scripts/doctor.mjs` | 最后一行「结论：可以安装」 |
| **L2 一键验收** | 安装后 / 发布前 | `node scripts/verify.mjs` | **0 个 FAIL**（SKIP 允许，附原因） |
| **L3 真实场景** | 使用者 | 按 TESTING.md 手动跑 | 各步骤符合期望 |

`verify.mjs` **默认不调用视觉 API**（不把图片外发）；想测眼睛加 `--vision`。

`verify.mjs` 会检查：Node 版本、平台、11 个工具是否注册、整屏截图、按窗口截图、特写合成、归档+去重、review/judge、search、maintain 预演与执行、**归档恢复**、**lean 档不给路径**、眼睛、错误处理。

输出：终端 PASS/FAIL 列表 + `verify-report.json`；**退出码 0 = 无 FAIL**。

终端最后会明确列出：

```
汇总：PASS 16 · FAIL 0 · SKIP 3

跳过项（这些没测到，不代表通过）：
 · 眼睛 — 未配置视觉 API
   解决：配 vision.apiKey 或 DSH_VISION_API_KEY（README 11.3）
 · 特写合成 — 需要 ffmpeg
   解决：安装 ffmpeg 后重跑（README 11.1）
 · 按窗口截图 — 找不到带标题的窗口
   解决：先打开一个普通窗口（不要最小化）再跑一次
```

`verify-report.json` 里的 `skips` / `fails` 数组也带同样的 `detail` 和 `hint`，agent 可以直接读取转述。

```bash
node scripts/verify.mjs            # 人看
node scripts/verify.mjs --json     # 机器读（CI/agent）
node scripts/verify.mjs --keep     # 保留临时目录方便排查
```

## 8.1.1 发布前跑什么（一条命令）

```bash
npm run release        # = node scripts/release-check.mjs
```

它会做 5 件事，**任何一项失败就不许打包**：

1. **API 快照比对**：11 个工具的名字 / 参数 schema 与 `api-snapshot.json` 一致（防止误改接口）
2. `verify.mjs`（宿主 defineTool 路径）必须 0 FAIL
3. `verify.mjs`（强制兜底实现 `DSM_NO_HOST_TOOLS=1`）必须 0 FAIL
4. `integration-test.mjs` 退出码 0
5. 静态检查：版本四处一致 / 两个 ps1 带 BOM / package files 都在 / 没有遗留调试文件

**有意改接口时**：`node scripts/release-check.mjs --update-baseline` 更新快照，并在版本说明里写清楚。

## 8.2 发布门槛（0.x 阶段）

一个版本可以发出去，必须同时满足：

1. `verify.mjs` **无 FAIL**（SKIP 要能解释）
2. `doctor.mjs` 在干净机器上「可以安装」
3. 装 → 重启 → 用 → **卸载 → 重启** 能回到安装前状态
4. `rollback.ps1` 演练过一次（至少在本机）
5. README/TESTING/capabilities 的版本号一致

## 8.2.1 一个环境坑（会让验收出现假阴性）

`doctor.mjs` / `verify.mjs` 会启动 PowerShell / ffmpeg 子进程。某些沙箱（agent 自己的 pwsh/bash 工具、受限 CI 容器）会禁止子进程开管道，导致「截图全 FAIL / 没装 ffmpeg」的假阴性。
0.4.16 起所有子进程调用都改为**无管道**（只看退出码 + sidecar 元数据），但**仍建议在普通终端里跑**。

## 8.3 给朋友（或他的 agent）的报告模板

让 agent 装完后按这个格式回你，问题就能一眼定位：

```json
{
  "system": "Windows 11 x64 / Node v22 / DSH 0.2.1",
  "doctor": "可以安装",
  "verify": {"pass": 18, "fail": 0, "skip": 0},
  "vision": "configured / not-configured",
  "ffmpeg": "yes / no",
  "failedItems": [],
  "notes": "free text"
}
```

---

# 九、出问题怎么办

| 症状 | 处理 |
|---|---|
| DSH 打不开/白屏 | 安全模式启动（插件不加载）→ `rollback.ps1` 或 `dsh plugin --profile web remove dsh-screen-memory` |
| 工具报错 | 内部全捕获，只返回错误文本，不影响对话 |
| 眼睛报"没有配置视觉 API" | 按第五节配置三种方式之一 |
| 眼睛报"只产出思考、没有正文" | 调大 `vision.maxTokens`（默认 2500，已带重试） |
| 归档失败 | 检查 `tar` 是否可用；Windows 10+ 自带 |
| 想彻底撤销 | `rollback.ps1`（先备份 profile 的 package.json） |
| **某个工具没出现**（如 screen_look / screen_hud） | 看 `~/.dsh/storages/screen-memory/logs/plugin.log`：<br>· 有「defineTool 失败（名字）」→ 该 DSH 版本 schema 更严，把这一行发我<br>· 有「注册失败 名字」→ 同上<br>· 什么都没有 → 插件没加载，检查 profile 的 dependencies / bundles |

`rollback.ps1 -PurgeData` 会连数据一起删。

---

# 十、限制与已知问题（装之前先看这一段）

这些不是 bug，是**系统/方案本身的边界**。知道它，才不会以为是插件坏了。

## 10.1 截图相关

| 限制 | 现象 | 原因 | 可选对策 |
|---|---|---|---|
| **全屏独占游戏** | 截到黑屏或纯色 | 全屏独占（Exclusive Fullscreen）的帧在 DWM 之外，任何 GDI/CopyFromScreen 方案都拿不到 | 把游戏改成**无边框窗口 / 窗口化**；或改用游戏自带截图 |
| **窗口被遮挡** | 按窗口截到的图里有别的窗口 | 本插件用"窗口矩形 + 屏幕拷贝"，不是抓窗口内容 | 先把目标窗口切到前面再截 |
| **窗口最小化** | 报错或截到桌面 | 最小化窗口没有可见区域 | 还原窗口再截 |
| **多显示器** | 整屏截的是"虚拟桌面"合并画面 | Windows 把多屏拼成一个矩形 | `region` 坐标以**截图像素左上角**为原点；需要单屏时用 `window` |
| **高 DPI 缩放** | 0.4.17 及以前：整屏只截到「左上角一块」 | PowerShell 未声明 DPI 感知，`VirtualScreen` 只有逻辑尺寸 | **0.4.18 已修**（先 `SetProcessDpiAwareness`）；`region` 仍按返回的实际像素坐标给 |
| **macOS / Linux** | 截图不可用 | 只实现了 Windows 后端 | 仓库、检索、眼睛对**已有图片**仍可用；截图等后续版本 |

## 10.2 环境相关

| 限制 | 影响 | 对策 |
|---|---|---|
| 没有 ffmpeg | 不能特写；整屏/窗口仍可用 | 见「十一」里 ffmpeg 的装法，或不用特写 |
| 没有 `tar` | `screen_maintain` 归档/清理不可用 | Windows 10 1803+ 自带；Linux/macOS 默认有 |
| Node < 22 | 索引用 JSON，图多了变慢 | 由 DSH 自带 Node 决定，`screen_status.node` 能看到；一般无需处理 |
| 没用视觉 API | `screen_describe` 不可用，其余正常 | 见「十一」里视觉 API 的三种配法 |
| PowerShell 被组策略禁用 | 无截图后端 | 装 ffmpeg 走 ffmpeg 后端（需要 ffmpeg 支持 gdigrab） |

## 10.3 上下文与费用

| 限制 | 说明 |
|---|---|
| 主会话每看一张图 ≈ 1000 token | 而且会**长期留在上下文**里；用 `budget.profile` 控制（见「三」） |
| 眼睛按次计费 | 每次约 600~1500 token；有每日上限 `vision.dailyCap`（默认 100） |
| 图片不加密 | 仓库是本地明文文件，磁盘被别人看到就能看到图 |

## 10.5 版本相关（已修）

- **0.4.4 及以前**：`region` 参数缺少 `properties` / `additionalProperties`，
  在 schema 校验严格的 DSH 版本上会让 `screen_look` / `screen_hud` **注册失败**
  （报 `unsupported JSON schema: parameters.region.additionalProperties must be explicitly true or false`）。
  **0.4.5 已修**，并加了「单个工具 defineTool 失败就退回内置实现」的兜底。
- **0.4.5 及以前**：`render` 在没有 `text` 字段时返回空字符串（例如 `screen_status` 的结果显示为空白）。
  **0.4.6 已修**：没有 `text` 时自动把整个结果 JSON 化输出。
- **0.4.10 及以前**：`rollback.ps1` 缺少 UTF-8 BOM，在 Windows PowerShell 下会因中文乱码报语法错（安全网失效）。
  **0.4.11 已修**，并把「两个 .ps1 都要有 BOM」加进了 verify。
- **0.4.6 及以前**：`screen_describe` 读归档图会失败、超大图不压缩、特写失败时静默返回原图；
  插件日志无限增长。**0.4.7 / 0.4.8 已修**（归档自动恢复、>2MB 也压缩、失败有提示、日志 1MB 轮转）。

## 10.4 其他

- 截图是**整屏**，录屏/直播/共享屏幕的画面也会被拍进去
- 归档会**删除原图**（tar.gz 有备份，可用 `screen_get` 恢复）
- 回收站 7 天后**物理删除**，不可恢复
- 同一张图（内容相同）只存一份，编号会复用

---

# 十一、缺环境时怎么补（可选，自己决定）

**原则**：本插件不打包任何环境，也不替用户安装。下面只给"如果你想补，可以怎么做"，补不补、用哪个方案，由你自己选。

## 11.1 缺 ffmpeg（想要"特写"才需要）

| 方案 | 命令 / 做法 | 说明 |
|---|---|---|
| winget（推荐） | `winget install Gyan.FFmpeg` 或 `winget install ffmpeg` | 装完重开终端；`ffmpeg -version` 能出版本即可 |
| Chocolatey | `choco install ffmpeg` | 需要已装 Chocolatey |
| Scoop | `scoop install ffmpeg` | 用户级安装 |
| 手动 | 从 ffmpeg.org 下 Windows build，解压后把 `bin` 目录加进 PATH | 最可控 |
| 指路径 | 设环境变量 `FFMPEG_PATH=D:\path\ffmpeg.exe`（重启 DSH） | 不想动 PATH 时用这个 |

**不装也可以**：整屏 + 按窗口截图、仓库、眼睛都不受影响，只是 `region`/`place` 特写会用不了（会返回明确错误）。

## 11.2 缺"看图能力"（模型是纯文本 / 没有 read_image）

这是最常见的情况。三种方案，按需选：

| 方案 | 怎么做 | 优点 | 代价 |
|---|---|---|---|
| **A. 用本插件的眼睛** | 配 `vision.apiKey`（见第五节），然后只用 `screen_describe` | 不用装任何别的插件；模型不需要视觉能力 | 每张图会发给视觉 API（有费用/隐私考虑） |
| **B. 装一个看图插件** | `dsh plugin --profile web add <插件名>`，例如：`dsh-plugin-image-input`（图转文字给盲模型）、`dsh-tool-describe-image`（视觉 API 描述）、`dsh-vision-router`（一堆视觉工具） | 生态成熟、可以同时给别的场景用 | 多一个依赖；配置项在各自插件里 |
| **C. 不补** | 只用 `screen_look` + `screen_list` 当"截图存档"，不看内容 | 零成本、零外发 | 只能存，不能"看" |

> 插件名以 npm/市场里实际存在的为准（安装前可先 `dsh plugin --profile web add <名字>` 看能否解析）。

## 11.3 缺视觉 API Key（想用眼睛）

| 服务 | 怎么配 | 备注 |
|---|---|---|
| DeepSeek 官方 | 在 `~/.dsh/.credentials.yaml` 加 `DEEPSEEK_API_KEY: sk-...`，或设 `DSH_VISION_API_KEY` | 默认；`baseUrl` 不用填 |
| 任意 OpenAI 兼容 | 插件配置里：`vision: { apiKey, baseUrl, model }` | 例：DashScope（qwen-vl）、OpenAI（gpt-4o）、智谱（glm-4v）、本地 vLLM |
| 本地 Ollama | `baseUrl: "http://127.0.0.1:11434/v1"`，`apiKey: "ollama"`，`model: "<你的视觉模型>"` | 图不出本机 |

## 11.4 缺 tar（归档功能）

- Windows 10 1803 之后自带 `tar.exe`（bsdtar），一般不用装
- 老系统：装 7-Zip 并把 `7z.exe` 加进 PATH（本插件暂不自动用它，可先不用归档）
- 不归档也能用：仓库会一直留在 hot，只是占空间

## 11.5 Node 版本

- 插件跑在 **DSH 自带的 Node** 里，不是你系统里的 node
- 是否 ≥22 看 `screen_status` 返回的 `node` 字段
- 低于 22 只影响"索引性能"（走 JSON），**不需要单独升级系统 Node**
- 想升级：升级 DSH 客户端即可

## 11.6 PowerShell 不可用（罕见）

- 组策略禁用 PowerShell 时，插件没有截图后端
- 对策：装 ffmpeg（见 11.1），插件会自动选 ffmpeg 后端做整屏截图
- 按窗口截图仍然依赖 PowerShell；这种情况下只能整屏

---

# 十二、路线图

| 版本 | 内容 |
|---|---|
| 0.1.0 | 整屏截图 + 仓库 + 4 工具 |
| 0.2.0 | 归档、ffmpeg 后端、按窗口、JPEG、特写 |
| 0.3.0 | 眼睛（视觉 API，三段式，模型不会看图也能用） |
| 0.4.1 | 分层归档、回顾判断、检索、**上下文预算三档** |
| 0.4.11 | 修 schema/render/BOM 等兼容问题；verify 21 项 |
| 0.4.12 | rollback 备份不覆盖/无改动不备份 |
| 0.4.13 | 眼睛默认分辨率 900→1400（实测更准更省） |
| 0.4.15 | 发布检查（API 快照 + 双路径 verify + 静态检查）；眼睛日限可调 |
| 0.4.16 | 沙箱无管道、path 只收图片、verify 默认不外发、窗口截图提示修正 |
| 0.4.18 | 高 DPI 修复（整屏不再只截左上角）；`window:"auto"` 截前台窗口；文档补「怎么看」 |
| 0.4.20 | `scripts/info.mjs` 一页纸自描述；文档补桌面版安装限制 |
| 0.4.21 | 只读仓库 UI（右侧栏面板 / `/dsh-screen-memory/ui`） |
| 0.4.22 | UI 内说明（这是什么/能干什么/眼睛未配置时禁用按钮） |
| 0.4.23 | 定时归档可配置（22:00 / 3 天 / 每批 10 张） |
| 0.4.24 | 修复 4.16 反馈：后端路径统一、注册可清理、跨卷恢复、stderr 排错、窗口标题含 `[]` |
| 0.4.25 | 仓库 UI：搜索（备注/来源/编号）、状态筛选、分页、备注展示 |
| 0.4.26 | 仓库 UI：单张移入回收站（二次确认，仅 screen 截图，无永久删除） |
| 0.4.27 | 仓库 UI：备注编辑（≤500 字）、回收站恢复为活跃 |
| 0.4.28 | 仓库 UI：待判断筛选、保留/不要（不要需确认并进回收站） |
| 0.4.29 | 仓库 UI：单张归档 / 从归档恢复 |
| **0.4.30（当前）** | 仓库 UI：批量选择 + 批量保留/不要/归档/恢复 |
| 0.5.0 | UI 管理操作：HUD、上传/导入、存储清理 |
| 0.6.0 | 完整仓库面板：HUD 管理、上传 / 导入、存储清理 |

---

# 十三、许可

MIT。请自行评估在含敏感信息的屏幕上使用本插件的风险。
