# 零基础安装与使用（照做就行）

> 这份是给「完全不懂技术」的人看的。你只需要做两件事：**让 AI 帮你装**，然后**对它说一句话**。

---

## 一、先判断你用的是哪种 DSH

| 你打开 DSH 的方式 | 属于哪种 | 安装方式 |
|---|---|---|
| 双击桌面上的 **DeepSeek Harness** 图标 | 桌面版 | 用 App 里的**插件管理**（见第二节 A） |
| 在终端/命令行里敲 `dsh web` 或 `dsh` | 命令行/网页版 | 用 **`dsh plugin` 命令**（见第二节 B） |

> 实测提醒：**桌面版不能用命令行装**。命令行会直接拒绝：
> `error: profile "desktop" is managed exclusively by the Electron application`

---

## 二、安装（选你对应的那一种）

### A. 桌面版（双击图标打开的那种）

1. 打开 DeepSeek Harness
2. 进 **设置 → 插件**（或点侧边栏的「插件」）
3. 找到 **安装插件 / 从本地安装**
4. 选中你下载的最新版 `dsh-screen-memory-0.5.5.tgz`（以实际下载的文件名为准）
5. **完全退出 App 再打开**（不是关窗口，要退出进程）

> 如果 App 里找不到「从本地安装」，就把下面这句话发给 App 里的 AI：
> 「我下载了一个 DSH 插件 dsh-screen-memory-0.5.5.tgz，在下载文件夹。请告诉我这个桌面版应该怎么装它，一步一步来，我看不懂技术名词。」

### B. 命令行 / 网页版

把 tgz 放到一个好找的地方（例如 `C:\Users\你\Downloads`），然后：

```powershell
dsh plugin --profile web add "C:\Users\你\Downloads\dsh-screen-memory-0.5.5.tgz"
# 装完重启 DSH（关掉再开）
```

> 不知道 profile 叫什么？执行 `dir %USERPROFILE%\.dsh\profiles` 看有哪些目录，
> 常见是 `web`；桌面版是 `desktop`（但桌面版不能用命令装）。

---

## 三、让 AI 帮你检查（最简单的一步）

装完重启后，**对 AI 说这句话**：

```text
我刚装了 dsh-screen-memory 插件。请你：
1) 调用 screen_status，告诉我能不能用；
2) 调用 screen_look 截一张我的屏幕；
3) 然后把截图的路径传给 read_image，用两三句话告诉我屏幕上有什么；
   如果你不能看图，就调用 screen_describe 让它转成文字。
如果哪一步失败，直接把报错告诉我，不要自己乱改。
```

如果它能说出你屏幕上的内容，就说明「截图 + 看」这条链路通了。

---

## 四、最常用的 4 句话（直接对 AI 说）

```text
截个屏                      → 它调用 screen_look
看看我屏幕上是什么          → 它截图 + read_image / screen_describe
把刚才那张找出来            → screen_list / screen_get
看看有哪些图要清理          → screen_review → screen_judge
```

---

## 五、想用全部功能，还需要两样东西（可选）

| 功能 | 需要什么 | 怎么补 |
|---|---|---|
| 特写（放大某块区域） | ffmpeg | `winget install Gyan.FFmpeg`，然后重启 DSH |
| 眼睛（看图转文字） | 一个视觉 API Key | 在插件设置里填 `vision.apiKey`，或把 `DEEPSEEK_API_KEY` 放进 `~/.dsh/.credentials.yaml` |

**不装也能用**：截图、按窗口截、仓库、归档、回顾、检索都不需要它们。

---

## 五点半、一条命令看清这个插件

```powershell
node scripts\info.mjs
```

会打印：这是什么 / 11 个工具 / 你电脑上缺什么、怎么补 / 怎么装 / 怎么用。

## 六、验证装得对不对（可选，但很推荐）

打开 PowerShell，进到插件目录（tgz 解开后的那个文件夹），执行：

```powershell
node scripts\doctor.mjs     # 最后一行应该是「结论：可以安装」
node scripts\verify.mjs     # 应该是 0 个 FAIL，最后显示「✅ 验收通过」
```

看到 `✅ 验收通过` 就说明装对了。想看「眼睛」是否可用再加 `--vision`（会真的把一张图发给视觉 API）。

---

## 七、出问题怎么办

| 症状 | 处理 |
|---|---|
| 装完没有任何 `screen_*` 工具 | 没重启，或装到了另一个 profile；重启后让 AI 再调 `screen_status` |
| 命令报 `profile "desktop" is managed exclusively...` | 你用的是桌面版：按第二节 A 用 App 内插件管理装 |
| 截图是黑的 / 只有桌面 | 目标游戏是全屏独占，改成「无边框窗口」 |
| 截图只有左上角一块 | 插件版本过旧（< 0.4.18）；换最新版 |
| 「特写未生成：…」 | 没装 ffmpeg（见第五节），不是坏了 |
| 眼睛报「没有配置视觉 API」 | 没配 Key（见第五节） |
| 想彻底卸载 | 桌面版：App 里卸载插件；命令行：`dsh plugin --profile <名字> remove dsh-screen-memory` |

---

## 八、给 AI 的「一句话安装指令」（复制即用）

```text
我下载了一个 DSH 插件：dsh-screen-memory-0.5.5.tgz，在下载文件夹。
我不懂技术，请你按最稳的方式帮我装好，并且：
· 装之前先跑包里的 scripts/doctor.mjs，告诉我环境缺不缺东西；
· 告诉我应该用桌面版 App 装还是命令行装（别装错）；
· 装完提醒我重启；
· 重启后用 screen_status / screen_look / read_image（或 screen_describe）各验证一次；
· 最后用一句话告诉我怎么日常使用。
任何一步失败，先停下来把原始报错发我，不要自己改 DSH。
```
