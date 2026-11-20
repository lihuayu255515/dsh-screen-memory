# 给 AI Agent 的安装说明（dsh-screen-memory P1）

> 把下面「提示词」整段复制给朋友的 AI，让它自己装。

---

## 提示词（直接复制）

```text
你先跑 `node scripts/info.mjs` 了解这个插件（这是什么、11 个工具、现在缺什么、怎么装），再执行下面的步骤。

请你帮我安装一个 DSH 插件：dsh-screen-memory（屏幕记忆：截图 + 图片仓库 + 眼睛）。
安装包在我电脑上的路径是：<把 tgz 的绝对路径填这里，例如 C:\Users\me\Downloads\dsh-screen-memory-0.1.0.tgz>

请按这个顺序做，每一步都告诉我结果：

1. 先检查环境（不要改任何东西）：
   - 运行 `node -v`，告诉我版本
   - 在包目录里运行 `node scripts/doctor.mjs`，把完整输出贴给我
   - 如果结论不是「可以安装」，停下来，不要装，把输出给我

2. 备份（装之前）：
   - 把 `~/.dsh/profiles/web/package.json` 复制一份为 `package.json.bak-before-screen-memory`

3. 安装：
   - `dsh plugin --profile web add "<tgz 绝对路径>"`
   - 装完告诉我它修改了哪些文件

4. 重启 DSH（必须），然后验证：
   - 调 `screen_status`，贴 JSON 给我（重点看 capture.chosen 是不是 powershell）
   - 调 `screen_look`，贴返回文字给我
   - 调 `screen_list`，确认能看到刚才那张
   - 用 `read_image` 打开 screen_look 返回的路径，确认能看到屏幕内容

5. 卸载演练（重要，确认能救回来）：
   - `dsh plugin --profile web remove dsh-screen-memory`
   - 重启 DSH，确认能正常打开、对话正常
   - 然后再装回去（重复第 3、4 步）

6. 如果任何一步失败：
   - 运行 `rollback.ps1`（在包目录里）：`powershell -NoProfile -ExecutionPolicy Bypass -File .\rollback.ps1`
   - 或手动：删掉 `package.json` 里 `dsh-screen-memory` 那一行 + `dsh.profile.bundles` 里同名项
   - 如果 DSH 打不开：用安全模式启动（插件不会加载）

最后请给我一份报告：
- 系统版本 / Node 版本 / DSH 版本
- doctor.mjs 输出
- screen_status 的 JSON
- 四项工具哪个成功、哪个失败
- 有没有出现任何报错，报错原文是什么
- 插件日志（`~/.dsh/storages/screen-memory/logs/plugin.log`）最后 20 行
```

---

## 给 Agent 的额外背景（不用告诉用户，你自己知道就行）

- 这个插件是**宿主插件**（不是 MCP），安装后工具名是 `screen_status` / `screen_look` / `screen_list` / `screen_get`
- 它只写自己的目录：`~/.dsh/storages/screen-memory/`
- 截图依赖 Windows 自带的 PowerShell + .NET，**不需要 Python、不需要 ffmpeg**
- 如果 `node scripts/doctor.mjs` 说"环境不满足"，说明不是 Windows，装了也截不了图（仓库仍可用）
- 卸载**不会**删数据；要删数据在 `rollback.ps1` 加 `-PurgeData`
- 不要试图修改 DSH 核心包；这个插件只通过 `dsh.bundle.patch` 增量挂载

---

## 注意：桌面版 App 不能用命令行装

实测报错：`error: profile "desktop" is managed exclusively by the Electron application`。
桌面版请用 App 内「设置 → 插件 → 安装本地插件」。

## 快速命令版（人自己操作时用）

```powershell
# 1. 自检
node <包目录>\scripts\doctor.mjs

# 2. 安装
dsh plugin --profile web add "<tgz 路径>"

# 3. 重启 DSH，然后让 AI 调 screen_status / screen_look

# 4. 卸载
dsh plugin --profile web remove dsh-screen-memory

# 5. 出问题回滚
powershell -NoProfile -ExecutionPolicy Bypass -File <包目录>\rollback.ps1
```
