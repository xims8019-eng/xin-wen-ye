# 定时更新配置

当前线上版本（Muse 托管）：

- 任务 id：`xin-wen-ye-daily-refresh`
- 动作：调用新闻页的 `refreshAll`（顺序：先刷新学习栏目，再并行刷新江西专升本 / 海外机会 / 我关注的世界 / 综合热榜，然后 9 个分类新闻，最后逐个刷新全部已关注订阅源）
- 频率：每天一次
- 时间：08:02（文件里存的是 08:02:46，界面显示 08:02）
- 时区：`Asia/Shanghai`（UTC+8），在 Muse 里存为 `@user.current`，即跟随用户当前时区

原始定义见同包的 `muse-cron-original.yaml`。

注：综合热榜 2026-11-21 曾删除，2026-11-22 已恢复（只在首页底部默认折叠展示），`refreshAll` 会再次刷新四个热榜平台；娱乐分类没有恢复。

## 迁到自有环境后的等价写法

Linux crontab（服务器时区已是 Asia/Shanghai 时）：

```cron
2 8 * * * curl -fsS -X POST https://你的域名/api/refreshAll -H "Authorization: Bearer $CRON_SECRET"
```

GitHub Actions（`.github/workflows/daily-refresh.yml`，UTC 00:02 = 北京时间 08:02）：

```yaml
name: daily-refresh
on:
  schedule:
    - cron: "2 0 * * *"
  workflow_dispatch:
jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - run: curl -fsS -X POST https://你的域名/api/refreshAll -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}"
```

Vercel Cron（`vercel.json`）：

```json
{ "crons": [{ "path": "/api/refreshAll", "schedule": "2 0 * * *" }] }
```

注意：GitHub Actions 和 Vercel 的 cron 都是 UTC，北京时间 08:02 对应 UTC 00:02，所以写 `2 0 * * *`。夏令时不影响中国时区。

## 刷新状态记录（2026-11-24 修正）

`getStatus` 回答三个问题，答不出就写「未确认」，不猜：

- **当前还有没有错误**：只看各栏目自己的 `columns.*.error`（`currentErrors`）。顶层 `enrichError` 是「最近一次富化错误」的旧槽位，成功后不会被清掉，不能当作当前错误；同栏目后来成功后它归入 `errorHistory`（保留发生时间与恢复时间），只有同一栏目的成功才能让它退休，别栏的成功不算。
- **最近一次错误是否恢复**：`lastError.recovered`——`true` 只有同一栏目后来成功整理过；`false` 是仍 open；`null` 是记录太旧、没有栏目标签也对不上任何栏目的 `errorAt`，写「恢复情况未确认」。2026-11-24 之前写下的顶层旧错（如生产站 Gemini 503、Muse 版 "Web artifact inference timed out."）都没有栏目标签，`enrichErrorAt` 若与某栏 `errorAt` 秒级一致才能对应上，否则就是未确认。
- **最近一次 08:02 定时任务能否确认完成**：只看 `lastCronRun`——由定时任务自己在 `refreshAll` 开始（`running`）与结束（`completed`/`failed`，逐栏 `ok`/`failed`）时写入。某栏 `contentAt` 更新过只能证明该栏更新过（手动「刷新全部」或缓存过期后打开页面都会更新），不能写成定时任务已完成。`refreshAll` 带 `source` 参数：`cron` / `manual` / `unknown`，首页按钮传 `manual`，Vercel 定时入口（`api/cron.ts`）传 `cron`。
- **抓取失败**：`noteRefreshFailure` 现在带来源（`分类:<id>` / `订阅:<key>` / 学习 / 江西专升本 / 海外 / 我关注的世界），`lastFailureAt` + `lastFailureSource` 一起返回；没有来源的旧记录只写「未确认来源」。

已办（2026-11-24）：Muse 托管的定时任务 `xin-wen-ye-daily-refresh`（`docs/muse-cron-original.yaml`）调 `refreshAll` 时的参数已由协调员改成 `{"source": "cron"}`，下一个 08:02 之后 `lastCronRun` 才会出现；在此之前 Muse 版首页的「最近一次定时任务」诚实显示未确认。

## 页面内的缓存时长（与定时任务是两回事）

| 内容 | 缓存 | 说明 |
| --- | ---: | --- |
| 分类新闻（9 个分类） | 45 分钟 | 过期后下一次打开自动重抓 |
| 学习栏目 | 45 分钟 | 同上 |
| 综合热榜 | 45 分钟 | 同上 |
| 江西专升本 | 60 分钟 | 同上 |
| 海外机会（含签证固定区） | 60 分钟 | 固定区另有持久化存储，不随缓存过期消失 |
| 我关注的世界 | 60 分钟 | 同上 |
| 单个订阅源 | 60 分钟 | 同上 |

定时任务的作用是每天早上先把缓存焐热，用户打开时不用等；手动点「刷新全部」会强制重抓，不看缓存。首页「近期可申请」（getDailyDigest）没有自己的缓存，它实时合并海外和学习两栏的已缓存结果。
