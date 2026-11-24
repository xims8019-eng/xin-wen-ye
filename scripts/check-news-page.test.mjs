#!/usr/bin/env node
/**
 * check-news-page.test.mjs — 规则检查函数的单测（不碰网络）。
 * 用法：node scripts/check-news-page.test.mjs
 * 夹具取真实返回形状：getOverseas 的置顶卡字段与 2026-11-24 线上读回一致；
 * 江西 / 学习夹具按 server/src/actions.ts 的 schema 构造。
 */
import {
  checkJiangxi,
  checkLearning,
  checkOverseas,
  checkFitness,
  checkWorld,
  checkHot,
  checkDigest,
  findScheduledRunRecord,
  interpretScheduledRun,
} from "./check-news-page.mjs";

let passed = 0;
let failed = 0;
function ok(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

// ---- 江西 ----
{
  const good = {
    asOf: "2026-11-24T00:06:00.000Z",
    items: [],
    archive: [
      { title: "报名通知", url: "http://www.jxeea.cn/a.html", attachmentUrl: null },
      { title: "考试说明", url: "http://jyt.jiangxi.gov.cn/b.html", attachmentUrl: "http://jyt.jiangxi.gov.cn/b.pdf" },
    ],
    pending: [
      { label: "2028 年报名通知", status: "待公布" },
      { label: "2028 年考试科目", status: "待公布" },
      { label: "2028 年专业对照表", status: "待公布" },
      { label: "2028 年招生简章", status: "已有 2028 年消息，见下方" },
    ],
    hasTodayUpdate: false,
  };
  const r = checkJiangxi(good);
  ok("江西：两个官网原文 + 2028 一项已有消息，不告警", r.problems.length === 0, JSON.stringify(r.problems));
  const bad = {
    ...good,
    items: [{ title: "转载的报名通知", url: "https://www.eol.cn/news.html" }],
  };
  const r2 = checkJiangxi(bad);
  ok("江西：eol.cn 转载被检出", r2.problems.some((p) => p.key === "jiangxi-non-official"));
}

// ---- 学习 ----
{
  const base = (overrides) => ({
    title: "人工智能应用基础",
    url: "https://www.icourse163.org/course/DKY-1460382164",
    source: "中国大学 MOOC",
    fee: "免费（需免费注册；认证证书付费）",
    group: "anytime",
    category: "courses",
    needsApplication: false,
    deadline: null,
    summaryZh: "免费学习",
    points: [],
    ...overrides,
  });
  const good = { asOf: "2026-11-24T00:06:00.000Z", items: [base()], deadlines: [] };
  const r = checkLearning(good);
  ok("学习：免费注册、仅证书收费的课程保留", r.problems.length === 0, JSON.stringify(r.problems));

  const coursera = {
    asOf: "2026-11-24T00:06:00.000Z",
    items: [
      base({
        title: "Introducing AI Series on Coursera: 12 Expert-curated learning plans",
        url: "https://blog.coursera.org/introducing-ai-series-on-coursera/",
        source: "Coursera 博客",
      }),
    ],
    deadlines: [],
  };
  ok("学习：Coursera 宣传博客回归被检出", checkLearning(coursera).problems.some((p) => p.key === "learning-coursera-back"));

  const airtel = {
    asOf: "2026-11-24T00:06:00.000Z",
    items: [
      base({
        title: "Airtel Foundation Grants 55 Engineering Scholarships to Chandigarh University Students",
        url: "https://www.lokmattimes.com/business/airtel-foundation-grants-55-engineering-scholarships-to-chandigarh-university-students-totaling-rs-77-crore-a001-w01/",
        source: "Lokmat Times",
        group: "upcoming",
        needsApplication: true,
      }),
    ],
    deadlines: [],
  };
  const ra = checkLearning(airtel);
  ok("学习：Airtel 已颁奖报道回归被检出", ra.problems.some((p) => p.key === "learning-airtel-back"));
  ok("学习：Airtel 同时命中已颁奖进可报名", ra.problems.some((p) => p.key === "learning-awarded-upcoming"));

  const upcomingOk = {
    asOf: "2026-11-24T00:06:00.000Z",
    items: [
      base({
        title: "2027 年春季奖学金开放报名",
        url: "https://example.edu/scholarship",
        source: "Example",
        group: "upcoming",
        needsApplication: true,
        deadline: "2026-12-20",
        summaryZh: "报名开放，免费申请",
      }),
    ],
    deadlines: [],
  };
  ok("学习：开放报名的 upcoming 不误报", checkLearning(upcomingOk).problems.length === 0);

  const emptyUpcoming = { asOf: "2026-11-24T00:06:00.000Z", items: [base()], deadlines: [] };
  ok("学习：近期可报名为 0 不告警", checkLearning(emptyUpcoming).problems.length === 0);
}

// ---- 海外置顶 ----
{
  const pinnedGood = {
    asOf: "2026-11-24T00:06:00.000Z",
    items: [
      { title: "Yale D/S", pinned: true, kind: "policy", decisionDateLabel: "法院裁决日期：2026 年 11 月 16 日", effectiveParts: null, effectiveWhen: null },
      { title: "NZ SGWV", pinned: true, kind: "policy", decisionDateLabel: null, effectiveParts: null, effectiveWhen: "2026 年 11 月 23 日起" },
      { title: "Singapore MOM", pinned: true, kind: "policy", decisionDateLabel: null, effectiveParts: ["新申请：2027-01-01 起", "续签：2028-01-01 起到期者"], effectiveWhen: null },
      { title: "Japan ISA", pinned: true, kind: "policy", decisionDateLabel: null, effectiveParts: ["签证签发费：2026 年 7 月 1 日起单次约 15,000 日元"], effectiveWhen: null },
      { title: "EdSource old commentary", pinned: false, kind: "policy", decisionDateLabel: null, effectiveParts: null, effectiveWhen: null, publishedAt: "2026-08-18T17:00:00.000Z" },
    ],
    hasTodayUpdate: false,
  };
  const r = checkOverseas(pinnedGood);
  ok("海外：四张好卡都带日期，旧评论未置顶，不告警", r.problems.length === 0, JSON.stringify(r.problems));

  const pinnedBad = {
    ...pinnedGood,
    items: [
      ...pinnedGood.items,
      { title: "Trump's visa policies are not deterring…", pinned: true, kind: "policy", decisionDateLabel: null, effectiveParts: null, effectiveWhen: null, publishedAt: "2026-08-18T17:00:00.000Z" },
    ],
  };
  ok("海外：无日期的 policy 被置顶会被检出", checkOverseas(pinnedBad).problems.some((p) => p.key === "overseas-pinned-no-date"));
}

// ---- 健身 / 世界 / 热榜 / Digest ----
{
  const mkFitness = (n) =>
    Array.from({ length: n }, (_, i) => ({
      name: `动作${i + 1}`,
      group: ["胸", "背", "腿臀", "肩", "核心"][i % 5],
      equipment: "徒手",
      startPosition: "站立",
      points: ["要点一", "要点二"],
      commonMistake: "错误",
      videoUrl: "https://www.bilibili.com/video/BV1test/",
    }));
  ok("健身：12 个完整动作不告警", checkFitness({ items: mkFitness(12) }).problems.length === 0);
  ok("健身：缺字段被检出", checkFitness({ items: [{ ...mkFitness(1)[0], videoUrl: "" }] }).problems.length > 0);
  ok("健身：0 个动作告警", checkFitness({ items: [] }).problems.some((p) => p.key === "fitness-unreadable"));

  ok("世界：空列表只警告不告警", checkWorld({ asOf: "x", daily: [], weekly: [], all: [] }).problems.length === 0);
  ok(
    "世界：Google 中转链接被检出",
    checkWorld({ asOf: "x", daily: [], weekly: [], all: [{ title: "t", url: "https://news.google.com/rss/articles/x" }] }).problems.some(
      (p) => p.key === "world-relay-link",
    ),
  );

  ok(
    "热榜：全部平台为空告警",
    checkHot({ asOf: "x", sources: [{ id: "weibo", label: "微博热搜", items: [] }] }).problems.some((p) => p.key === "hot-unreadable"),
  );
  ok(
    "热榜：单个平台为空只警告",
    checkHot({
      asOf: "x",
      sources: [
        { id: "weibo", label: "微博热搜", items: [{ rank: 1, title: "t", url: "https://x", heat: null }] },
        { id: "baidu", label: "百度热搜", items: [] },
      ],
    }).problems.length === 0,
  );

  ok("Digest：5 条以内不告警", checkDigest({ asOf: "x", items: [] }).problems.length === 0);
  ok(
    "Digest：超过 5 条告警",
    checkDigest({ asOf: "x", items: Array.from({ length: 6 }, (_, i) => ({ title: `t${i}`, url: "https://x", source: "s" })) }).problems.some(
      (p) => p.key === "digest-too-many",
    ),
  );
}

// ---- 定时任务记录查找 ----
{
  const noRecord = {
    lastUpdatedAt: "2026-11-24T04:06:26.931Z",
    lastFailureAt: "2026-11-24T00:21:30.407Z",
    enrichError: "Error: LLM request failed: HTTP 503",
    columns: { learning: { contentAt: "2026-11-24T04:06:07.829Z", error: null, recovered: true } },
  };
  ok("getStatus 当前形状没有运行记录字段", findScheduledRunRecord(noRecord).length === 0);
  const withLabels = {
    ...noRecord,
    refreshTimeLabel: "08:02",
    refreshTimezone: "Asia/Shanghai",
    refreshScheduleLabel: "每天 08:02 · Asia/Shanghai (UTC+8)",
  };
  ok("refreshScheduleLabel 等静态文案不算运行记录", findScheduledRunRecord(withLabels).length === 0);
  const withRunFields = { ...noRecord, lastCronRun: null, lastRefreshRun: null };
  ok("lastCronRun / lastRefreshRun 本身不算疑似字段（由判定函数直接处理）", findScheduledRunRecord(withRunFields).length === 0);
  const withRecord = { ...noRecord, lastCronRunAt: "2026-11-24T00:03:00.000Z" };
  ok("以后加了 lastCronRunAt 能被找到", findScheduledRunRecord(withRecord).length === 1);
}

// ---- 定时任务判定（interpretScheduledRun）----
{
  const base = {
    lastUpdatedAt: "2026-11-24T04:06:26.931Z",
    columns: {
      learning: { contentAt: "2026-11-24T00:06:07.829Z", error: null, recovered: true },
      jiangxi: { contentAt: "2026-11-24T00:06:00.000Z", error: null, recovered: true },
      overseas: { contentAt: "2026-11-24T00:06:26.931Z", error: null, recovered: true },
    },
  };
  const today0802 = new Date("2026-11-24T00:02:00.000Z");
  ok("定时：旧形状（无 lastCronRun）→ 未确认", interpretScheduledRun(base, today0802).status === "unconfirmed");
  ok(
    "定时：lastCronRun / lastRefreshRun 均为 null → 未确认",
    interpretScheduledRun({ ...base, lastCronRun: null, lastRefreshRun: null }, today0802).status === "unconfirmed",
  );
  ok(
    "定时：lastCronRun 今天 08:05 完成 → 已确认",
    interpretScheduledRun({ ...base, lastCronRun: { finishedAt: "2026-11-24T00:05:00.000Z", ok: true } }, today0802).status === "confirmed",
  );
  ok(
    "定时：lastCronRun 字符串时间戳 → 已确认",
    interpretScheduledRun({ ...base, lastCronRun: "2026-11-24T00:05:00.000Z" }, today0802).status === "confirmed",
  );
  ok(
    "定时：lastCronRun 是昨天 → 未确认",
    interpretScheduledRun({ ...base, lastCronRun: { finishedAt: "2026-11-23T00:05:00.000Z", ok: true } }, today0802).status === "unconfirmed",
  );
  ok(
    "定时：只有 lastRefreshRun 完成 → 仍未确认（无法证明是定时任务）",
    interpretScheduledRun({ ...base, lastCronRun: null, lastRefreshRun: { finishedAt: "2026-11-24T00:05:00.000Z", ok: true } }, today0802).status === "unconfirmed",
  );
  ok(
    "定时：lastCronRun 标失败 → 未确认",
    interpretScheduledRun({ ...base, lastCronRun: { finishedAt: "2026-11-24T00:05:00.000Z", ok: false } }, today0802).status === "unconfirmed",
  );
}

console.log(`\n${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
