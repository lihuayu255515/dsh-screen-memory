# 测试说明（0.4.23）

> 这个版本：11 个工具（截图 / 窗口 / 特写 / 仓库 / 归档 / 回顾 / 检索 / 眼睛）+ 21 项自动验收。
> 先跑「0. 自动验收」，再按「2. 手动清单」抽查即可。

## 0. 自动验收（推荐第一步）

```bash
node scripts/doctor.mjs          # 环境自检：最后一行必须是「结论：可以安装」
node scripts/verify.mjs          # 21 项检查：要求 0 个 FAIL
node scripts/release-check.mjs   # 发布级检查（API 快照 + 双路径 verify + 静态检查）
```

说明：

- `verify.mjs` **默认不调用视觉 API**（不会把图片外发）。想连眼睛一起测：
  ```bash
  node scripts/verify.mjs --vision
  ```
  这会真的把一张截图发到 `vision.baseUrl`（默认 api.deepseek.com），产生一次费用。
- 报告写在 `verify-report.json`，里面有 `skips` / `fails` 数组，每条带原因和解决办法。
- **要在普通终端里跑**：放在 agent 沙箱 shell 里时，某些环境禁止子进程开管道 → 出现假阴性（0.4.16 已改成无管道，但普通终端最稳）。

## 1. 环境缺失时会发生什么（不是 bug）

| 缺什么 | 现象 | 解决办法 |
|---|---|---|
| 没有 ffmpeg | 「特写合成」SKIP；整屏/按窗口仍可用 | `winget install Gyan.FFmpeg` 或设 `FFMPEG_PATH` |
| 没有视觉 Key | 「眼睛」SKIP（默认本来就跳过） | 配 `vision.apiKey` / `DSH_VISION_API_KEY` / credentials.yaml |
| 没有 tar | `screen_maintain` 归档失败 | Win10 1803+ 自带；Linux/macOS 默认有 |
| 非 Windows | 截图不可用 | 仓库/眼睛对已有图片仍可用 |
| Node < 22 | 索引退化为 JSON | 可用但慢；建议升级 DSH |

## 2. 手动清单（每项做一次）

| # | 操作 | 期望 |
|---|---|---|
| 1 | `screen_status` | 返回 JSON：capture / budget / vision / store 都在 |
| 2 | `screen_look({note:"整屏"})` | 返回编号 + 尺寸 +（balanced/rich 档）本地路径 |
| 3 | `screen_look({window:"<某个窗口完整标题>"})` | 只截该窗口（不需要 ffmpeg） |
| 4 | `screen_look({region:{x:100,y:100,w:500,h:300}, place:"corner"})` | 有 ffmpeg：图里出现放大块；没有：返回里有一行「特写未生成：…」 |
| 5 | `screen_list` | 能看到刚才的图 |
| 6 | `screen_get({id})` | 返回本地路径 |
| 7 | 用 `screen_archive` 存一张 png/jpg | 成功；存一个 txt 会**被拒绝**（只接受图片） |
| 8 | `screen_review` | 列出待判断的图 |
| 9 | `screen_judge({id, keep:true})` / `keep:false` | 保留 / 进回收站（7 天后删） |
| 10 | `screen_maintain({dryRun:true})` | 只报告不执行 |
| 11 | `screen_maintain({archiveAfterDays:0})` | 归档成功，`screen_get` 能恢复 |
| 12 | `screen_search({query:"..."})` | 命中对应图 |
| 13 | `screen_hud({window:"...", region:{...}, place:"strip"})` | 记住；之后 `screen_look({window})` 自动套用 |
| 14 | `screen_describe({question:"..."})`（可选） | 有 Key：返回三段文字；无 Key：返回配置指引（不崩） |
| 14b | 重启后打开右侧栏「屏幕记忆」（或浏览器 /dsh-screen-memory/ui） | 屏幕截图网格；点开看原图；「让 AI 看这张」有 Key 返回文字、无 Key 提示配置 |

## 3. 预算档位（可选）

```jsonc
{ "budget": { "profile": "lean" } }   // rich / balanced / lean
```

lean 档：`screen_look` 的**文本和返回值都不带本地路径**，只能用 `screen_describe` 看内容。

## 4. 工具开销（可选）

11 个工具的 schema 常驻上下文（约 4.2k 字符 ≈ 1~2.6k token/请求）。想省：

```jsonc
{
  "tools": {
    "only": ["screen_look", "screen_describe", "screen_list"],  // 只注册这几个
    "deferLoading": true                                        // 或者延迟加载 5 个低频工具
  }
}
```

## 5. 卸载演练（装完先做一次）

```bash
dsh plugin --profile <你的profile> remove dsh-screen-memory
# 重启 DSH，确认能正常对话
dsh plugin --profile <你的profile> add "<tgz>"
```

数据不会删；要删数据用 `rollback.ps1 -PurgeData`。

## 6. 出问题怎么办

| 症状 | 处理 |
|---|---|
| DSH 打不开 | 安全模式启动 → `rollback.ps1` 或卸载 |
| 某个工具没出现 | 看 `~/.dsh/storages/screen-memory/logs/plugin.log` 里的「defineTool 失败 / 注册失败」 |
| 工具报错 | 内部全捕获，只返回错误文本，不影响对话 |
| 想彻底撤销 | `rollback.ps1`（会先备份 profile 的 package.json） |

## 7. 反馈请附上

1. `doctor.mjs` 完整输出
2. `verify.mjs` 最后「汇总 + 跳过项」
3. `verify-report.json`
4. 出错时 `logs/plugin.log` 最后 30 行

## 8. 已知限制（不是 bug）

- 全屏独占游戏截不到画面 → 改无边框窗口
- 按窗口截图截的是「窗口所在屏幕矩形」：窗口被遮挡会拍到遮挡物；最小化会失败
- 多显示器整屏是虚拟桌面合并；高 DPI 下截图尺寸可能与逻辑分辨率不同
- 眼睛默认把图缩到 1400 长边；再大不一定更准，但更多 token
- 眼睛模型必须是多模态：`deepseek-v4-pro` **不支持图片**，请保持 `deepseek-flash` 或换 qwen-vl / gpt-4o 等
- `screen_describe` 的 `path` 参数只接受图片文件；不要对不受信任的路径调用
