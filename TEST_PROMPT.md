# 测试提示词（贴给你的 AI agent）

> 用法：把下面「完整提示词」整段复制给朋友（或他）的 AI agent，把 `<安装包路径>` 换成实际 tgz 路径。
> 精简版在最后。
> 注：命令里的 `--profile web` 要换成你实际的 profile（桌面版常见是 `desktop`，看 `~/.dsh/profiles/` 目录名）。

---

## 完整提示词（推荐）

```text
你要帮我测试一个 DSH 插件：dsh-screen-memory（屏幕记忆）。
安装包路径：<安装包路径，例如 C:\Users\me\Downloads\dsh-screen-memory-0.4.17.tgz>
插件目录里有 README.md、TESTING.md、AGENT_INSTALL.md，请先读 README 的「给 AI agent 的必读」和「测试与验收」。

=== 你的任务边界 ===
· 只做测试；不要修改、卸载、重装其他任何插件，不要动 DSH 核心文件。
· 安装/卸载前必须先告诉我（我在场再执行）。
· 任何一步失败都不要自己"修" DSH，先停下来把报错原文发我。
· 测试结束后不管成败，都按下面「报告格式」回我。

=== 第 0 步：环境信息（只读）===
操作系统版本、node -v、DSH 版本、是否有 ffmpeg（ffmpeg -version）、
~/.dsh/.credentials.yaml 里有没有 DEEPSEEK_API_KEY（不要打印 Key 本身）。

=== 第 1 步：环境自检（不安装、不改任何东西）===
在包目录执行：node scripts/doctor.mjs
· 最后一行不是「结论：可以安装」→ 停止，把输出发我，不要安装。

=== 第 2 步：备份 + 安装 ===
1. 备份 ~/.dsh/profiles/<profile>/package.json
2. 安装：dsh plugin --profile <profile> add "<安装包路径>"
3. 告诉我它改了哪些文件；然后我会重启 DSH。

=== 第 3 步：自动验收（重启后）===
在包目录执行：node scripts/verify.mjs
要求：FAIL 必须为 0；SKIP 允许，但要能解释（脚本会逐条列出原因和解决办法）。
注意：verify 默认**不会**调用视觉 API（不外发图片）。想连眼睛一起测再加 --vision：
   node scripts/verify.mjs --vision
（这会真的把一张截图发到视觉 API，产生一次费用，先跟我说一声。）
把最后「汇总 + 跳过项」整段发我。

可选：node scripts/release-check.mjs（发布级检查：双路径 verify + 集成测试 + 静态检查）

=== 第 4 步：手动抽查（各一次）===
1. screen_status → JSON 完整（capture / budget / vision / store）
2. screen_look({note:"测试整屏"})
   2b. **真的"看"一次**：把 screen_look 返回的 path 传给你的 read_image，然后用两三句话说出屏幕上有什么；
       如果你的模型不能看图，改用 screen_describe({id}) 让它转成文字。
       （只调 screen_look 等于只截图，不会有分析。）
3. screen_look({window:"<当前某个窗口的完整标题>"})   ← 不需要 ffmpeg
   3b. screen_look({window:"auto"}) → 应只截当前前台窗口
4. screen_look({region:{x:100,y:100,w:500,h:300}, place:"corner"})
   ← 没 ffmpeg 时会返回「特写未生成：…」，这是预期，不是失败
5. screen_archive({path:"<任意 png/jpg>", note:"测试"}) → screen_list 能看到
   再试 screen_archive({path:"<一个 txt 文件>"}) → 应被拒绝（只接受图片）
6. screen_describe({question:"图里有什么"})  ← 可选，有 Key 时返回三段文字
7. screen_review → screen_judge({id:<某个>, keep:true})
8. screen_maintain({dryRun:true})   ← 只报告不执行

=== 第 5 步：卸载演练 ===
1. dsh plugin --profile <profile> remove dsh-screen-memory
2. 重启 DSH，确认能正常打开、正常对话
3. 再装回去，确认 11 个工具都回来了

=== 第 6 步：报告（按这个 JSON 回我）===
{
  "system": "...",
  "node": "...",
  "dsh": "...",
  "profile": "...",
  "ffmpeg": "yes/no",
  "visionKey": "found/not-found",
  "doctor": "可以安装 / 不可以",
  "verify": {"pass": 0, "fail": 0, "skip": 0, "skips": []},
  "manual": {
    "look_full": "...", "look_window": "...", "look_hud": "...",
    "archive_ok": "...", "archive_reject_txt": "...",
    "describe": "...", "review_judge": "...", "maintain_dry": "..."
  },
  "uninstallCycle": "ok/failed",
  "failedItems": [],
  "notes": "自由补充：截图、报错原文、日志路径"
}

如果中途出问题：
· DSH 打不开 → 用安全模式启动，然后执行包目录里的 rollback.ps1，把输出发我
· 插件报错 → 把 ~/.dsh/storages/screen-memory/logs/plugin.log 最后 30 行发我
```

---

## 精简版（一行）

```text
请按 dsh-screen-memory 的 README「测试与验收」帮我验收：先跑 scripts/doctor.mjs，通过后安装并重启，跑 scripts/verify.mjs（要求 0 FAIL；默认不会外发图片，要测眼睛再加 --vision），再按 TESTING.md 手动测截图/窗口/特写/归档/眼睛/review，最后做一次卸载→重装演练，按 README 里的 JSON 模板给我报告。安装/卸载前告诉我，失败不要自己修，把报错原文发我。
```

---

## 你（人）自己测试时的最短路径

```powershell
cd <包目录>
node scripts/doctor.mjs        # 1. 自检
# 2. 安装并重启 DSH
dsh plugin --profile <profile> add "<tgz>"
node scripts/verify.mjs        # 3. 验收：看到「✅ 验收通过」且退出码 0
dsh plugin --profile <profile> remove dsh-screen-memory   # 4. 卸载演练
```

判定：

| 输出 | 含义 |
|---|---|
| `PASS 21 · FAIL 0` | 完整通过（加 --vision 且有 Key） |
| `PASS 20 · FAIL 0 · SKIP 1（眼睛）` | 正常通过（默认不测眼睛） |
| `PASS 20 · FAIL 0 · SKIP 2`（眼睛 + 特写） | 通过，缺 Key 和/或 ffmpeg |
| 任何 `FAIL` | 不通过：把 `verify-report.json` + `plugin.log` 发回来 |
