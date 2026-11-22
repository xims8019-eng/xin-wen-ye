# 新闻页（xin-wen-ye）源码备份 — 2026-11-21 版

这是 Muse 里「新闻页」当前线上版本的完整源码导出（导出时间 2026-11-21），包含前端、服务端、数据源清单、链接解析与去重逻辑说明和定时配置。完整导出说明（含 Muse 依赖对照表）在同目录交付的《xin-wen-ye-backup-20261121.md》里，本文件只讲怎么把这份代码跑起来。

当前版本和 2026-11-20 备份的主要差别：首页改为个人资讯页（江西专升本 / 中国专科生海外机会与政策变化 / 我关注的世界 三栏 + 学习栏）；海外栏加了「签证新政 · 固定区」（6 条人工核实条目固定展示）；综合热榜和娱乐分类已整块删除；全站入库前解析中转链接（Google 新闻 / Bing / MSN）到发布方直达地址，解析不到的只留摘要；Google 新闻占位摘要入库时丢弃；学习栏「可报名」列表只收录已确认官方入口的条目。

## 目录

- `client/` — React 前端（`src/App.tsx` 是全部界面，`src/api.ts` 是类型化接口客户端）
- `server/src/actions.ts` — 全部服务端逻辑：抓取、解析、链接解析、去重、缓存、三栏、学习栏目、签证固定区、收藏与订阅（16 个接口）
- `server/src/schema.ts` — 数据库三张表定义
- `drizzle/` — 建表 SQL
- `config/feeds.json` — 分类新闻（9 个）、订阅目录（9 个）清单
- `config/learning.json` — 学习栏目数据源与规则
- `config/columns.json` — 首页三栏的搜索词、签证固定区 6 条、屏蔽域名与固定区禁用来源
- `docs/cron.md` — 定时更新配置（含自有环境等价写法）
- `docs/summary-logic.md` — 摘要生成逻辑说明
- `docs/link-resolution.md` — 链接解析、去重与屏蔽规则说明
- `docs/muse-cron-original.yaml` — Muse 托管的原始定时任务定义
- `.env.example` — 自有环境需要的变量名（只列名称，无值）
- `DATA-PLAN.md` — 建站与历次改版的数据源实测记录（哪些源验过、哪些被弃用及原因）

## 在 Muse 里继续运行

这份代码就是 Muse 网页应用（Space）的源码格式。放回 Muse 的 Space 目录后用 Muse 的构建工具发布即可，不要直接跑 `bun run build` 对外发布，那只生成本地产物。

## 迁到自有环境运行

原样跑不起来，因为有三处用了 Muse 托管能力，需要替换，工作量集中在 `server/src/actions.ts`：

1. `@hatch/space-sdk` 的 `defineAction` 和 `./actions` 接口 — 换成普通 HTTP 接口（Express / Hono / Next.js API 路由均可），前端 `api.ts` 相应改成 `fetch` 调用。
2. `ctx.db`（Drizzle + SQLite）— 换成你自己的 Drizzle + SQLite / Turso 连接，表结构和 SQL 不用改。
3. `ctx.inference.complete`（新闻详情要点、学习/江西/海外三栏整理，共 4 处调用）— 换成你自己的大模型 API，变量名见 `.env.example`，提示词和 Schema 在 `actions.ts` 里可原样复用。

替换后：

```bash
bun install
# 建表：执行 drizzle/ 下两个 SQL，或用 drizzle-kit 按 server/src/schema.ts 生成
bun run build
# 定时刷新：按 docs/cron.md 配每天 08:02 (Asia/Shanghai) 调用 refreshAll
```

抓取部分全部是公开接口，不需要任何密钥；只有第 3 项的大模型需要你自己的密钥，不配也能跑，只是详情要点和三栏/学习栏的中文整理会降级为展示原始摘要。

## 没包含的东西

- `node_modules/`、构建产物（`client/dist/`、`server/dist/` 等）、`app.db` 数据库文件 — 都是可再生成的，且数据库里是缓存和个人订阅/收藏，不属于源码。订阅和收藏的迁移方法见导出说明文档的「数据库与用户数据迁移」一节。
- 任何密钥 — 本项目当前版本没有用任何第三方密钥，包里只有 `.env.example` 的变量名。
