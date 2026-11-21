# 发布清单（GitHub / npm / DSH Market）

> 这份清单是发布前的操作步骤。仓库里已经有 `LICENSE`、`docs/screenshots/` 和 `MARKETING.md`；还差的是填真实 GitHub 地址、建仓库、推送和提交 Market catalog PR。

## 0. 先确认

```bash
node scripts/release-check.mjs
```

必须通过。当前版本：

```
dsh-screen-memory 0.5.5
```

发布前再检查：

```
· package.json version 与 lib/index.js / capabilities.json / api-snapshot.json 一致
· 没有把 ~/.dsh/.credentials.yaml、API Key、日志、截图测试数据提交进 Git
· LICENSE 是 MIT
· README / NEWBIE_QUICKSTART / MARKETING 里的包名与当前版本一致
```

## 1. 创建 GitHub 仓库

在 GitHub 新建仓库，例如：

```
https://github.com/<你的账号>/dsh-screen-memory
```

把地址填进 `package.json`（不要保留占位符）：

```json
"repository": {
  "type": "git",
  "url": "git+https://github.com/<你的账号>/dsh-screen-memory.git"
},
"homepage": "https://github.com/<你的账号>/dsh-screen-memory#readme",
"bugs": {
  "url": "https://github.com/<你的账号>/dsh-screen-memory/issues"
}
```

然后：

```bash
git remote add origin https://github.com/<你的账号>/dsh-screen-memory.git
git push -u origin main
```

## 2. 打 tag 和 GitHub Release

```bash
git tag v0.5.5
git push origin v0.5.5
```

在 GitHub Release 里：

```
标题：v0.5.5 — 首次使用引导与安全修复
附件：dsh-screen-memory-0.5.5.tgz
（就是你在本机 npm pack 后 dist 里生成的文件；不要写死本机绝对路径）
```

Release 正文可以直接用 `MARKETING.md` 的短版简介 + 配图。

## 3. npm（可选，但 Market 更偏好）

先确认包名是否可用：

```bash
npm view dsh-screen-memory
```

如果可用：

```bash
npm publish --access public
```

如果不可用，改用 scoped 包名，例如：

```
@<你的账号>/dsh-screen-memory
```

同时更新 `package.json` 的 `name`、`README` 和 Market 条目。Market 安装源优先使用 npm 包或作者提供的 GitHub Release tarball。

## 4. 提交 DSH Market catalog

**上传 GitHub 不会自动进 Market。**

Market 的插件列表来自 curated registry：

```
https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
```

步骤：

1. Fork `awesome-dsh-plugin/awesome-dsh-plugin`
2. 按它的 PR 模板添加一条插件记录
3. 条目里填：
   - 插件名：`dsh-screen-memory`
   - GitHub 仓库
   - npm 包名（如果发布了）
   - 一句话简介
   - 分类/标签：截图、图片仓库、本地优先、DSH 工具
4. 提 PR
5. 等 catalog 刷新（README 说通常一天内）
6. 打开 DSH 的 Plugin Market，重新加载列表

Market 的安装源是白名单机制：没有 catalog entry，用户不会在 Market 里看到或一键安装。

## 5. 发布配图

仓库里已经有 6 张 UI 演示图：

```
docs/screenshots/01-gallery.png     仓库总览
docs/screenshots/02-detail.png      单张详情
docs/screenshots/03-batch.png       批量操作
docs/screenshots/04-cleanup.png     存储清理
docs/screenshots/05-hud.png         窗口特写档案
docs/screenshots/06-help.png        内置引导
```

配图文案在：

```
MARKETING.md
```

Market / GitHub README 可以直接引用 `docs/screenshots/` 下的相对路径。

## 6. 发布前最后一次检查

```bash
node scripts/release-check.mjs
node scripts/doctor.mjs
node scripts/verify.mjs
```

预期：

```
release-check 通过
doctor 结论：可以安装
verify：0 FAIL（眼睛默认 SKIP）
```

如果改动过 `package.json`（例如 package name、repository），重新打包：

```bash
npm pack
```

并确认 Release 附件与本地包 hash 一致。

## 7. 不要做的事

```
· 不要把 ~/.dsh/.credentials.yaml 提交进 Git
· 不要把真实截图仓库 / 日志 / 测试临时目录提交进 Git
· 不要在 GitHub 上传后假设 Market 会自动收录
· 不要把“未配置眼睛”写成“插件不可用”；截图和仓库不依赖眼睛
```
