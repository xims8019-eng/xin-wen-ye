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
