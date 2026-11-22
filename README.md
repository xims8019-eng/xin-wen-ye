# 新闻页（xin-wen-ye）— Vercel + Turso 版

个人资讯页：首页三栏为「江西专升本 / 中国专科生海外机会与政策变化 / 我关注的世界」，另有学习栏、分类新闻、订阅与收藏。每天自动刷新一次，首页只放会改变决策的消息。

当前版本和 2026-11-20 备份的主要差别：首页改为个人资讯页（江西专升本 / 中国专科生海外机会与政策变化 / 我关注的世界 三栏 + 学习栏）；海外栏加了「签证新政 · 固定区」（6 条人工核实条目固定展示）；综合热榜和娱乐分类已整块删除；全站入库前解析中转链接（Google 新闻 / Bing / MSN）到发布方直达地址，解析不到的只留摘要；Google 新闻占位摘要入库时丢弃；学习栏「可报名」列表只收录已确认官方入口的条目。

## 目录

- `client/` — React 前端（`src/App.tsx` 是全部界面，`src/api.ts` 是类型化接口客户端，POST `/api/action`）
- `api/action.ts` — Vercel Serverless Function：`{action, args}` 路由到 `server/src/actions.ts`
- `api/cron.ts` — Vercel Serverless Function：定时刷新入口，调 `refreshAll`
- `server/src/actions.ts` — 全部服务端逻辑：抓取、解析、链接解析、去重、缓存、三栏、学习栏目、签证固定区、收藏与订阅（16 个接口）
- `server/src/ctx.ts` — 数据库连接（Turso / 本地 SQLite）与首次建表
- `server/src/llm.ts` — 可选的大模型客户端（OpenAI 兼容接口）
- `server/src/schema.ts` — 数据库三张表定义
- `drizzle/` — 建表 SQL（与 `ctx.ts` 里内联的建表语句一致）
- `config/feeds.json` — 分类新闻（9 个）、订阅目录（9 个）清单
- `config/learning.json` — 学习栏目数据源与规则
- `config/columns.json` — 首页三栏的搜索词、签证固定区 6 条、屏蔽域名与固定区禁用来源
- `docs/cron.md` — 定时更新配置
- `docs/summary-logic.md` — 摘要生成逻辑说明
- `docs/link-resolution.md` — 链接解析、去重与屏蔽规则说明
- `.env.example` — 需要的环境变量名（只列名称，无值）
- `DATA-PLAN.md` — 建站与历次改版的数据源实测记录（哪些源验过、哪些被弃用及原因）

## 本地运行

```bash
bun install
bun run build        # 打包前端到 client/dist
bun run typecheck    # client + server 两个 tsconfig
```

不配任何环境变量也能跑：数据库默认用本地文件 `./data/app.db`（首次使用时自动建表），大模型未配置时降级运行（见下）。

## 部署到 Vercel（免费版）+ Turso（免费版）

1. **Turso 建库**（免费版 1 个库、9 GB 存储够用）：
   ```bash
   turso db create xin-wen-ye
   turso db show xin-wen-ye --url        # 得到 libsql://...turso.io
   turso db tokens create xin-wen-ye     # 得到 auth token
   ```
   也可以在 [Turso 控制台](https://turso.tech) 建库并复制连接地址和 token。
2. **Vercel 导入**：在 [Vercel 控制台](https://vercel.com) 用「Add New → Project」导入这个 GitHub 仓库。Vercel 会按 `vercel.json` 构建（`bun run build`，产物目录 `client/dist`），不需要改构建设置。
3. **填环境变量**（Vercel 项目 → Settings → Environment Variables）：
   | 变量 | 必填 | 说明 |
   |---|---|---|
   | `TURSO_DATABASE_URL` | 是 | Turso 连接地址（`libsql://...`） |
   | `TURSO_AUTH_TOKEN` | 是 | Turso auth token |
   | `OPENAI_API_KEY` | 否 | 不填也能跑，见「不配大模型 key」 |
   | `LLM_BASE_URL` | 否 | 兼容接口地址，默认 `https://api.openai.com/v1` |
   | `LLM_MODEL` | 否 | 模型名，默认 `gpt-4o-mini` |
   | `CRON_SECRET` | 否 | 建议填，保护 `/api/cron` 不被随意触发 |
4. 部署完成后打开 Vercel 给的域名即可使用；首次打开会自动建表并拉取新闻。

## 定时刷新

`vercel.json` 里配了一条定时任务：每天 UTC 00:02（北京时间 08:02）调 `/api/cron`，触发全量刷新。注意 Vercel 免费版的限制：

- 每天最多一次定时触发，且触发时间会在整点内浮动（不保证 exactly 00:02）。
- Serverless Function 的 `maxDuration` 在免费版（Hobby）上限是 60 秒，本仓库已按 60 秒配置（`api/action.ts`、`api/cron.ts`、`vercel.json` 三处一致），免费版可以正常部署。注意：60 秒是硬上限。**不配大模型 key 时**全量刷新只是拉取公开 RSS，通常能在 60 秒内跑完；**配了 key 时**中文整理要调多次模型，全量刷新（9 个分类 + 三栏 + 学习栏 + 订阅源）通常超过 60 秒，定时任务可能在刷新完成前被掐断——已写完的栏目缓存会保留，页面仍可读旧缓存，下次打开或手动刷新会继续补全。如需完整跑完一次带模型整理的全量刷新，需要 Vercel Pro（上限 300 秒）或把刷新拆成多次调用。

## 不配大模型 key 也能跑

抓取部分全部是公开接口，不需要任何密钥。只有 4 处用到大模型（新闻详情要点、学习 / 江西 / 海外三栏的中文整理），每处都有降级处理：未配置 `OPENAI_API_KEY` 时直接走降级分支，展示来源自己的摘要原文，页面其余功能不受影响。只配了 `ANTHROPIC_API_KEY`、没有 OpenAI 兼容 key 时同样降级（本项目没有 Anthropic 客户端）。

## 没包含的东西

- `node_modules/`、构建产物（`client/dist/`、`server/dist/` 等）、`data/app.db` 数据库文件 — 都是可再生成的，且数据库里是缓存和个人订阅/收藏，不属于源码。
- 任何密钥 — 包里只有 `.env.example` 的变量名。
