#!/usr/bin/env node
/**
 * check-news-page.mjs — 新闻页只读巡检 / 部署验收（共用脚本）。
 *
 * 目标站：https://xin-wen-ye.vercel.app（仓库 xims8019-eng/xin-wen-ye）。
 * 两种用法：
 *   node scripts/check-news-page.mjs --mode daily  --base-url https://xin-wen-ye.vercel.app
 *   node scripts/check-news-page.mjs --mode deploy --base-url https://xin-wen-ye.vercel.app --sha <commit> [--focus actions,client]
 *
 * 关键设计（依据仓库 10f12e37 的真实代码，见 README 的“依据”一节）：
 * - 只调读动作：getStatus / getJiangxi / getOverseas / getLearning /
 *   getMyWorld / getHotLists / getDailyDigest / getFitness，全部 force=false
 *  （getFitness 无 force 参数）。绝不调 refreshAll、绝不传 force=true、
 *   绝不调 getItemDetail（未缓存时会调模型）、绝不调任何写动作。
 * - daily 模式是纯只读：先读 getStatus，再按各栏缓存的新鲜度决定是否调
 *   该栏的 get*。缓存过期时跳过该栏（宁可报“未读取”，也不触发重抓和
 *   模型调用）。deploy 模式则像用户打开页面一样调 get*（缓存过期时会像
 *   用户访问一样触发懒重抓，这是验收新代码的必要部分，见 README）。
 * - getStatus 里“08:02 定时任务完成”的判定只认 lastCronRun 记录（x 轮
 *   2026-11-24 新增的字段；2026-11-24 13:43 时该字段与 lastRefreshRun
 *   都是 null，所以当前只能标未确认）。lastRefreshRun 只能证明某次刷新
 *   完成过，不能证明是定时任务；栏目更新时间本身永远不算证据。
 * - 顶层 enrichError 是遗留字段（x 轮后已清掉，改为 currentErrors /
 *   lastError / errorHistory）。脚本以各栏 columns.*.error / recovered
 *   为准，currentErrors 非空时按当前错误告警；lastError / errorHistory
 *   里 recovered=true 的只当历史处理，已恢复的不再告警。字段缺失时容错
 *   （同时兼容 x 轮前后的两种 getStatus 形状）。
 * - 429 / 503：先有限重试（3 次，退避 2s / 5s）；仍失败时结合该栏的
 *   最近成功时间和 recovered 状态判断——已恢复的历史错误不重复告警。
 * - 三种状态分开报：栏目打不开（动作失败）/ 内容可读但整理延迟
 *   （能读，但最近一次成功更新距今超过 36 小时）/ 本来就没有可申请项目
 *   （近期可报名、升学栏为 0 是正常情况，不告警）。
 * - 条数正常增减不告警；只对规则违反告警（见下面的规则检查函数）。
 *
 * 退出码：0 = 通过（或只有警告）；1 = 有新确认的异常（见 check-result.json
 * 的 activeProblems）。脚本任何情况下都尽量写出 check-result.json。
 */

import { fileURLToPath } from "node:url";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// 常量（取值依据见文件末尾注释；改应用代码里的 TTL 或规则时要同步改这里）
// ---------------------------------------------------------------------------
const DEFAULT_BASE_URL = "https://xin-wen-ye.vercel.app";
// server/src/actions.ts 里的缓存 TTL：learning 45 分钟，jiangxi / overseas /
// world 60 分钟，hot 45 分钟（10f12e37 的行 1179 / 2224 / 2870 / 4446 / 5924）。
const TTL_MS = {
  learning: 45 * 60 * 1000,
  jiangxi: 60 * 60 * 1000,
  overseas: 60 * 60 * 1000,
  world: 60 * 60 * 1000,
  hot: 45 * 60 * 1000,
};
// 整理延迟阈值：最近一次成功更新距今超过 36 小时（错过一整天以上）。
const STALE_AFTER_MS = 36 * 3600 * 1000;
// 首页各栏的中文名（验收时核对生产站下发的 JS 里是否包含这些入口文案）。
const HOMEPAGE_LABELS = ["江西专升本", "近期可申请", "国内外要闻", "本周学习", "健身", "综合热榜"];
// 江西专升本只接受这两个官网原文（jxeea.cn 含 www 子域名；jyt.jiangxi.gov.cn）。
const JIANGXI_HOSTS = ["jxeea.cn", "jyt.jiangxi.gov.cn"];
// 学习栏已移除条目的去重名单（t 轮；URL 与标题双信号，任一命中即算回归）。
const REMOVED_LEARNING = [
  {
    key: "learning-coursera-back",
    name: "Coursera 宣传博客《Introducing AI Series on Coursera》重新进入学习栏",
    urlPart: "blog.coursera.org/introducing-ai-series-on-coursera",
    titlePart: "Introducing AI Series on Coursera",
  },
  {
    key: "learning-airtel-back",
    name: "Airtel 已颁奖报道重新进入学习栏",
    urlPart: "airtel-foundation-grants-55-engineering-scholarships",
    titlePart: "Airtel Foundation Grants 55 Engineering Scholarships",
  },
];
// 已颁奖报道的信号词（与应用内 isAlreadyAwardedReport 同义，简化版）。
const AWARDED_RE = /(已发放|已颁发|已授予|has awarded|have awarded|awarded\s+\d+|grants?\s+\d+\D{0,40}scholarships?)/i;
const OPEN_APPLICATION_RE = /(报名开放|正在报名|接受申请|open for applications|now accepting applications)/i;
// 宣传博客的信号（与应用内 isPromoBlogWithoutFreeEntry 同义，简化版）。
const PROMO_TITLE_RE = /(introducing|推出|发布|上线|官宣|全新).{0,20}(series|系列|学习计划|合集|专栏)/i;
// 日期（只认 decisionDateLabel / effectiveParts / effectiveWhen 三处专用字段，
// 与 w 轮规则 isPolicyWithoutDatedEffectiveChange 一致；publishedAt 不算）。
// 注意真实数据里的中文日期带空格（“2026 年 11 月 16 日”），分隔符前后允许空白。
const DATE_RE = /(\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}|\d{4}\s*年\s*\d{1,2}\s*月)/;

// ---------------------------------------------------------------------------
// 北京时间工具
// ---------------------------------------------------------------------------
const fmtDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });
const fmtTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function beijingString(d) {
  const date = d instanceof Date ? d : new Date(d);
  return `${fmtDate.format(date)} ${fmtTime.format(date)}`;
}

/** 今天北京时间 08:02 的 Date。 */
function today0802Beijing(now = new Date()) {
  return new Date(`${fmtDate.format(now)}T08:02:00+08:00`);
}

/** 是否在每天刷新后的巡检窗口内（北京时间 08:02–08:47）。 */
function inPostRefreshWindow(now = new Date()) {
  const t = now.getTime();
  const start = today0802Beijing(now).getTime();
  return t >= start && t <= start + 45 * 60 * 1000;
}

function ageMs(iso, nowMs) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : nowMs - t;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// 带有限重试的请求（429 / 503 / 5xx / 超时 / 断网都重试；其余 4xx 不重试）
// ---------------------------------------------------------------------------
async function fetchWithRetry(url, { method = "GET", body = undefined, timeoutMs = 30000, retries = 3 } = {}) {
  let lastError = null;
  let lastStatus = null;
  let attempts = 0;
  for (let i = 0; i < retries; i++) {
    attempts = i + 1;
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      lastStatus = res.status;
      if (res.status === 429 || res.status === 503 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status}`);
        lastError.status = res.status;
      } else if (!res.ok) {
        // 其余 4xx 不重试，直接返回。
        return { ok: false, status: res.status, attempts, error: `HTTP ${res.status}`, text: "" };
      } else {
        return { ok: true, status: res.status, attempts, text: await res.text(), error: null };
      }
    } catch (e) {
      lastError = e;
      lastStatus = null;
    }
    if (i < retries - 1) await sleep(i === 0 ? 2000 : 5000);
  }
  return { ok: false, status: lastStatus, attempts, error: String(lastError?.message ?? lastError), text: "" };
}

function parseJson(text) {
  try {
    return { data: JSON.parse(text), error: null };
  } catch (e) {
    return { data: null, error: `响应不是合法 JSON：${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// 栏目规则检查（纯函数，可单测；输入是动作返回的原始 JSON）
// ---------------------------------------------------------------------------
function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isJiangxiOfficialUrl(url) {
  const h = hostOf(url);
  return JIANGXI_HOSTS.some((allowed) => h === allowed || h.endsWith(`.${allowed}`));
}

/** 江西：items 与 archive 里的每条都必须是两个官网原文。 */
export function checkJiangxi(payload) {
  const problems = [];
  const notes = [];
  if (!payload || typeof payload !== "object") return { problems, notes: ["getJiangxi 无返回"] };
  const lists = [
    ["items", payload.items ?? []],
    ["archive", payload.archive ?? []],
  ];
  for (const [field, items] of lists) {
    for (const it of items) {
      if (!isJiangxiOfficialUrl(it?.url ?? "")) {
        problems.push({
          key: "jiangxi-non-official",
          title: `江西栏出现非官网来源：${(it?.title ?? "（无标题）").slice(0, 40)}`,
          detail: `${field} 里的条目链接不是 jxeea.cn / jyt.jiangxi.gov.cn 原文：${it?.url ?? "（无链接）"}`,
        });
      }
      const att = it?.attachmentUrl;
      if (att && !isJiangxiOfficialUrl(att)) {
        problems.push({
          key: "jiangxi-non-official",
          title: `江西档案附件不是官网链接：${(it?.title ?? "").slice(0, 40)}`,
          detail: `附件链接 ${att}`,
        });
      }
    }
  }
  // 2028 四项：待公布是正常状态；已有 2028 年消息是允许的替换，不告警。
  const pending = payload.pending ?? [];
  const announced = pending.filter((p) => p?.status && p.status !== "待公布").map((p) => p.label);
  notes.push(
    `2028 四项：${pending.length} 项，待公布 ${pending.filter((p) => p?.status === "待公布").length} 项` +
      (announced.length ? `；已有 2028 年消息：${announced.join("、")}` : ""),
  );
  notes.push(`hasTodayUpdate=${payload.hasTodayUpdate === true ? "是" : "否"}（当天无新公告是正常情况）`);
  return { problems, notes };
}

function textOfLearning(it) {
  return [it?.title, it?.summaryZh, ...(it?.points ?? []), it?.relevance].filter(Boolean).join(" ");
}

/** 学习：已移除条目回归、已颁奖进可报名、宣传博客进随时可学、费用未说明免费。 */
export function checkLearning(payload) {
  const problems = [];
  const warnings = [];
  const notes = [];
  if (!payload || typeof payload !== "object") return { problems, warnings, notes: ["getLearning 无返回"] };
  const items = payload.items ?? [];
  const anytime = items.filter((it) => it?.group === "anytime");
  const upcoming = items.filter((it) => it?.group === "upcoming");
  notes.push(`共 ${items.length} 条：随时可学 ${anytime.length} 条，近期可报名 ${upcoming.length} 条（可报名为 0 是正常情况）`);
  for (const it of items) {
    const url = it?.url ?? "";
    const title = it?.title ?? "";
    let denylisted = false;
    for (const removed of REMOVED_LEARNING) {
      if (url.includes(removed.urlPart) || title.includes(removed.titlePart)) {
        problems.push({
          key: removed.key,
          title: removed.name,
          detail: `标题：${title}；链接：${url}`,
        });
        denylisted = true;
      }
    }
    // 已颁奖报道绝不能出现在近期可报名。
    if (it?.group === "upcoming") {
      const text = textOfLearning(it);
      if (AWARDED_RE.test(text) && !OPEN_APPLICATION_RE.test(text)) {
        problems.push({
          key: "learning-awarded-upcoming",
          title: `已颁奖报道出现在近期可报名：${title.slice(0, 40)}`,
          detail: `该条目写的是已发放/已颁发，没有开放报名的表述；链接：${url}`,
        });
      }
    }
    // 宣传博客（无免费学习证据）绝不能进随时可学。已命中去重名单的条目
    // 不再重复触发通用规则，避免同一条目开两个 issue。
    if (it?.group === "anytime" && !denylisted) {
      const isBlog = /blog\./i.test(hostOf(url)) || url.includes("/blog/") || /博客/.test(it?.source ?? "");
      const text = textOfLearning(it);
      if (isBlog && PROMO_TITLE_RE.test(title) && !/免费/.test(text)) {
        problems.push({
          key: "learning-promo-blog",
          title: `宣传博客进入随时可学：${title.slice(0, 40)}`,
          detail: `链接：${url}`,
        });
      }
    }
    // 费用：写明免费（或免费注册、仅证书收费）才算合规；写了价格又没提免费的，只警告不告警。
    const fee = it?.fee;
    if (typeof fee === "string" && fee && !/免费/.test(fee) && /[$¥￥\d]\s*(元|美元|USD|USD\/|\/月|每年)/.test(fee)) {
      warnings.push(`费用未说明免费，请人工核对：${title.slice(0, 30)}（费用：${fee}）`);
    }
  }
  return { problems, warnings, notes };
}

/** 海外：置顶卡必须带注明日期的生效变更（与 w 轮规则同义）；条数变化不告警。 */
export function checkOverseas(payload) {
  const problems = [];
  const notes = [];
  if (!payload || typeof payload !== "object") return { problems, notes: ["getOverseas 无返回"] };
  const items = payload.items ?? [];
  const pinned = items.filter((it) => it?.pinned);
  const study = items.filter((it) => it?.category === "study");
  notes.push(`共 ${items.length} 条：置顶 ${pinned.length} 张，海外升学 ${study.length} 条（升学为 0 是正常情况）`);
  for (const it of pinned) {
    const hasDate =
      (it?.decisionDateLabel && DATE_RE.test(it.decisionDateLabel)) ||
      (Array.isArray(it?.effectiveParts) && it.effectiveParts.some((p) => DATE_RE.test(p))) ||
      (it?.effectiveWhen && DATE_RE.test(it.effectiveWhen));
    if (!hasDate) {
      problems.push({
        key: "overseas-pinned-no-date",
        title: `置顶卡没有注明带日期的生效变更：${(it?.title ?? "").slice(0, 40)}`,
        detail: `decisionDateLabel / effectiveParts / effectiveWhen 三处都没有日期；来源：${it?.source ?? ""}`,
      });
    }
  }
  return { problems, notes };
}

/** 健身：静态精选，12 个动作、每卡 6 个字段；数量变了只警告（配置改动），缺字段或为空才告警。 */
export function checkFitness(payload) {
  const problems = [];
  const warnings = [];
  const notes = [];
  if (!payload || typeof payload !== "object") return { problems, warnings, notes: ["getFitness 无返回"] };
  const items = payload.items ?? [];
  notes.push(`共 ${items.length} 个动作（应为 12 个，分胸 2 / 背 2 / 腿臀 3 / 肩 2 / 核心 3）`);
  if (items.length === 0) {
    problems.push({ key: "fitness-unreadable", title: "健身栏为空", detail: "getFitness 返回 0 个动作" });
    return { problems, warnings, notes };
  }
  if (items.length !== 12) warnings.push(`健身动作数 ${items.length}，不是 12（配置可能改过，请人工确认）`);
  for (const it of items) {
    const missing = ["name", "equipment", "startPosition", "points", "commonMistake", "videoUrl"].filter(
      (f) => !it?.[f] || (Array.isArray(it[f]) && it[f].length === 0),
    );
    if (missing.length) {
      problems.push({
        key: "fitness-unreadable",
        title: `健身卡缺字段：${it?.name ?? "（无名）"}`,
        detail: `缺：${missing.join("、")}`,
      });
    }
  }
  return { problems, warnings, notes };
}

/** 国内外观察：能读即可；条数变化不告警；出现 Google  relay 链接是回归信号。 */
export function checkWorld(payload) {
  const problems = [];
  const warnings = [];
  const notes = [];
  if (!payload || typeof payload !== "object") return { problems, warnings, notes: ["getMyWorld 无返回"] };
  const daily = payload.daily ?? [];
  const weekly = payload.weekly ?? [];
  const all = payload.all ?? [];
  notes.push(`每日精选 ${daily.length} 条（上限 5），每周精选 ${weekly.length} 条，全部 ${all.length} 条`);
  if (all.length === 0) warnings.push("国内外观察全部为空（可能是当天无更新，也可能是整理延迟）");
  for (const it of all) {
    if ((it?.url ?? "").includes("news.google.com")) {
      problems.push({
        key: "world-relay-link",
        title: "国内外观察出现 Google News 中转链接",
        detail: `标题：${(it?.title ?? "").slice(0, 40)}`,
      });
    }
  }
  return { problems, warnings, notes };
}

/** 热榜：各平台能读即可；单个平台为空只警告，全部为空才告警。 */
export function checkHot(payload) {
  const problems = [];
  const warnings = [];
  const notes = [];
  if (!payload || typeof payload !== "object") return { problems, warnings, notes: ["getHotLists 无返回"] };
  const sources = payload.sources ?? [];
  const counts = sources.map((s) => `${s?.label ?? s?.id ?? "?"} ${s?.items?.length ?? 0} 条`).join("、");
  notes.push(`平台：${counts || "无"}`);
  if (sources.length === 0) {
    problems.push({ key: "hot-unreadable", title: "热榜无平台数据", detail: "getHotLists 返回 0 个平台" });
    return { problems, warnings, notes };
  }
  const empty = sources.filter((s) => (s?.items?.length ?? 0) === 0);
  if (empty.length === sources.length) {
    problems.push({ key: "hot-unreadable", title: "热榜全部平台为空", detail: "每个平台都 0 条，可能是热榜抓取失败" });
  } else if (empty.length) {
    warnings.push(`以下平台热榜为空：${empty.map((s) => s?.label ?? s?.id).join("、")}（其余平台正常）`);
  }
  return { problems, warnings, notes };
}

/** 首页近期可申请：不超过 5 条；为空是正常情况。 */
export function checkDigest(payload) {
  const problems = [];
  const notes = [];
  if (!payload || typeof payload !== "object") return { problems, notes: ["getDailyDigest 无返回"] };
  const items = payload.items ?? [];
  notes.push(`近期可申请 ${items.length} 条（上限 5 条；为 0 时首页显示「暂无符合条件的新机会」，是正常情况）`);
  if (items.length > 5) {
    problems.push({ key: "digest-too-many", title: "近期可申请超过 5 条", detail: `共 ${items.length} 条` });
  }
  return { problems, notes };
}

/**
 * 从 getStatus 里找其他疑似运行记录字段（兜底扫描；lastCronRun /
 * lastRefreshRun 由 interpretScheduledRun 直接处理）。
 * 排除静态文案字段：refreshScheduleLabel 只是“每天 08:02”这句固定说明，
 * 不是某次任务的完成记录。
 */
export function findScheduledRunRecord(status) {
  const candidates = [];
  const SKIP_KEYS = new Set(["lastUpdatedAt", "lastFailureAt", "enrichError", "lastCronRun", "lastRefreshRun"]);
  const isLabelKey = (k) => /(Label|Timezone|TimeLabel)$/.test(k);
  if (status && typeof status === "object") {
    for (const [k, v] of Object.entries(status)) {
      if (SKIP_KEYS.has(k) || isLabelKey(k)) continue;
      if (/run|cron|schedul/i.test(k)) candidates.push({ key: k, value: v });
    }
    const cols = status.columns ?? {};
    for (const [col, c] of Object.entries(cols)) {
      if (c && typeof c === "object") {
        for (const [k, v] of Object.entries(c)) {
          if (SKIP_KEYS.has(k) || isLabelKey(k)) continue;
          if (/run|cron|schedul/i.test(k)) candidates.push({ key: `columns.${col}.${k}`, value: v });
        }
      }
    }
  }
  return candidates;
}

/**
 * 解读一条运行记录（x 轮新增的 lastCronRun / lastRefreshRun）。
 * 写入时的确切形状还没在生产站见过（2026-11-24 13:43 时两个字段都是
 * null），所以按最宽容的方式解读：字符串当时间戳；对象里找 finishedAt /
 * completedAt / endedAt / ranAt / at / startedAt 等时间字段（取最晚的），
 * 再找 ok / success / completed / status 里的成功标志。
 * 只有“有完成时间且不晚于今天 08:02、且没有失败标志”才算已确认。
 */
export function interpretRunRecordValue(value) {
  if (value === null || value === undefined) return { present: false, completedAt: null, ok: null };
  let completedAt = null;
  let ok = null;
  const considerTime = (v) => {
    if (typeof v === "string") {
      const t = Date.parse(v);
      if (!Number.isNaN(t) && (!completedAt || t > Date.parse(completedAt))) completedAt = new Date(t).toISOString();
    }
  };
  const considerOk = (v) => {
    if (typeof v === "boolean") ok = v;
    else if (typeof v === "string" && /^(ok|success|completed|complete|done)$/i.test(v)) ok = true;
    else if (typeof v === "string" && /^(fail|failed|error)$/i.test(v)) ok = false;
  };
  if (typeof value === "string") {
    considerTime(value);
  } else if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (/finish|complet|end|ran|_at$|^at$/i.test(k)) considerTime(v);
      if (/^(ok|success|completed|status)$/i.test(k)) considerOk(v);
    }
  }
  return { present: true, completedAt, ok };
}

/**
 * 判定今天 08:02 定时刷新是否完成。
 * 只有 lastCronRun（定时任务的记录）能确认；lastRefreshRun 只能证明某次
 * 刷新完成过（可能是手动刷新），不能证明是定时任务。栏目更新时间本身
 * 永远不算证据。旧形状（没有这两个字段）时一律未确认。
 */
export function interpretScheduledRun(status, today0802) {
  const columnTimes = () => {
    const parts = [];
    for (const [col, c] of Object.entries(status?.columns ?? {})) {
      parts.push(`${col}栏最近更新 ${c?.contentAt ? beijingString(c.contentAt) : "未知"}`);
    }
    return parts.join("；");
  };
  if (!status || typeof status !== "object") return { status: "unconfirmed", evidence: "getStatus 无返回，无法判断。" };
  const todayMs = today0802.getTime();
  const cron = interpretRunRecordValue(status.lastCronRun);
  if (cron.present) {
    if (cron.completedAt && Date.parse(cron.completedAt) >= todayMs && cron.ok !== false) {
      return { status: "confirmed", evidence: `lastCronRun 记录今天 08:02 之后完成（${beijingString(cron.completedAt)}）。` };
    }
    const why = !cron.completedAt
      ? "没有可读的完成时间"
      : Date.parse(cron.completedAt) < todayMs
        ? `最近一次完成是 ${beijingString(cron.completedAt)}，早于今天 08:02`
        : "记录标为失败";
    return {
      status: "unconfirmed",
      evidence: `lastCronRun 存在，但${why}。各栏更新时间：${columnTimes()}。今天 08:02 的定时任务是否完成：未确认。`,
    };
  }
  const refresh = interpretRunRecordValue(status.lastRefreshRun);
  if (refresh.present && refresh.completedAt && Date.parse(refresh.completedAt) >= todayMs && refresh.ok !== false) {
    return {
      status: "unconfirmed",
      evidence: `某次刷新在今天 08:02 之后完成（${beijingString(refresh.completedAt)}，lastRefreshRun），但 lastCronRun 为空，无法确认是定时任务还是手动刷新。各栏更新时间：${columnTimes()}。`,
    };
  }
  const other = findScheduledRunRecord(status);
  const evidence =
    (other.length
      ? `getStatus 里另有疑似运行记录字段：${other.map((r) => r.key).join("、")}，需人工判断。`
      : "getStatus 没有“定时任务完成”的记录字段（lastCronRun / lastRefreshRun 均为空）。") +
    ` 各栏更新时间：${columnTimes()}。今天 08:02 的定时任务是否完成：未确认。`;
  return { status: "unconfirmed", evidence };
}

// 各栏可能产生的问题键。某栏成功读到后，这些键都记为“已评估”，
// 这样恢复时 report-autocheck.sh 才能关闭之前为它们开的 issue；
// 没读到的栏不记（issue 保持原样）。
const COLUMN_PROBLEM_KEYS = {
  jiangxi: ["jiangxi-unreadable", "jiangxi-non-official", "stale-36h-jiangxi"],
  overseas: ["overseas-unreadable", "overseas-pinned-no-date", "stale-36h-overseas"],
  learning: [
    "learning-unreadable",
    "learning-coursera-back",
    "learning-airtel-back",
    "learning-awarded-upcoming",
    "learning-promo-blog",
    "stale-36h-learning",
  ],
  world: ["world-unreadable", "world-relay-link", "stale-36h-world"],
  hot: ["hot-unreadable", "stale-36h-hot"],
  digest: ["digest-unreadable", "digest-too-many", "stale-36h-digest"],
  fitness: ["fitness-unreadable", "stale-36h-fitness"],
};

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { mode: "daily", baseUrl: DEFAULT_BASE_URL, sha: null, focus: "", out: "check-result.json", summary: "check-summary.md" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") args.mode = argv[++i];
    else if (a === "--base-url") args.baseUrl = argv[++i];
    else if (a === "--sha") args.sha = argv[++i];
    else if (a === "--focus") args.focus = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--summary") args.summary = argv[++i];
  }
  return args;
}

async function callAction(baseUrl, action, args, { timeoutMs, retries }) {
  const r = await fetchWithRetry(`${baseUrl}/api/action`, {
    method: "POST",
    body: { action, args },
    timeoutMs,
    retries,
  });
  if (!r.ok) return { ok: false, status: r.status, attempts: r.attempts, error: r.error, data: null };
  const parsed = parseJson(r.text);
  if (parsed.error) return { ok: false, status: r.status, attempts: r.attempts, error: parsed.error, data: null };
  if (parsed.data && typeof parsed.data === "object" && "error" in parsed.data && typeof parsed.data.error === "string") {
    return { ok: false, status: r.status, attempts: r.attempts, error: parsed.data.error, data: null };
  }
  return { ok: true, status: r.status, attempts: r.attempts, error: null, data: parsed.data };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode === "deploy" ? "deploy" : "daily";
  const baseUrl = args.baseUrl.replace(/\/$/, "");
  const now = new Date();
  const nowMs = now.getTime();
  const timeoutMs = mode === "deploy" ? 75000 : 30000;
  const result = {
    mode,
    sha: args.sha ?? null,
    focus: args.focus ? args.focus.split(",").map((s) => s.trim()).filter(Boolean) : [],
    baseUrl,
    checkedAt: now.toISOString(),
    checkedAtBeijing: beijingString(now),
    status: "pass",
    websiteReadable: false,
    homepage: {},
    scheduledRun: { status: "unconfirmed", evidence: "" },
    columns: {},
    activeProblems: [],
    checkedProblems: [],
    warnings: [],
    notes: [],
  };
  const addProblem = (p) => {
    if (!result.activeProblems.some((x) => x.key === p.key)) result.activeProblems.push(p);
    if (!result.checkedProblems.includes(p.key)) result.checkedProblems.push(p.key);
  };
  const markChecked = (key) => {
    if (!result.checkedProblems.includes(key)) result.checkedProblems.push(key);
  };

  try {
    // -- 1. 首页是否能打开（静态壳 + 下发的 JS 里是否含各栏入口文案）--
    const home = await fetchWithRetry(`${baseUrl}/`, { timeoutMs: 30000, retries: 3 });
    let chunkLabels = [];
    let chunkName = null;
    if (home.ok) {
      const hasTitle = home.text.includes("<title>新闻页</title>");
      const chunkMatch = home.text.match(/chunk-[A-Za-z0-9_-]+\.js/);
      chunkName = chunkMatch ? chunkMatch[0] : null;
      result.homepage = { http: home.status, hasTitle, chunk: chunkName, attempts: home.attempts };
      if (!hasTitle) {
        addProblem({ key: "homepage-down", title: "首页 HTML 里没有“新闻页”标题", detail: `HTTP ${home.status}，但标题缺失` });
      } else if (chunkName) {
        // 下发的 JS 是用户实际看到的页面：核对各栏入口文案是否在里面。
        const chunk = await fetchWithRetry(`${baseUrl}/${chunkName}`, { timeoutMs: 30000, retries: 3 });
        if (chunk.ok) {
          chunkLabels = HOMEPAGE_LABELS.filter((label) => chunk.text.includes(label));
          result.homepage.chunkLabels = chunkLabels;
          if (chunkLabels.length < 4) {
            addProblem({
              key: "homepage-down",
              title: "首页下发的 JS 里缺栏目入口文案",
              detail: `只找到 ${chunkLabels.length}/6 个：${chunkLabels.join("、") || "无"}`,
            });
          } else {
            result.websiteReadable = true;
          }
        } else {
          result.homepage.chunkError = chunk.error;
          result.websiteReadable = true; // 壳能打开；chunk 取不到只记一条警告
          result.warnings.push(`首页 JS 文件取不到（${chunk.error}），只核对了 HTML 壳`);
        }
      } else {
        result.websiteReadable = true;
        result.warnings.push("首页 HTML 里没有找到 chunk JS 文件名，只核对了标题");
      }
      // 首页取到了：homepage-down 这个问题键已评估过（有问题时上面已记入 activeProblems）。
      markChecked("homepage-down");
    } else {
      result.homepage = { http: home.status, error: home.error, attempts: home.attempts };
      addProblem({ key: "homepage-down", title: "首页打不开", detail: `GET / 失败：${home.error}（已重试 ${home.attempts} 次）` });
    }

    // -- 2. getStatus（纯数据库读，绝不触发刷新或模型调用）--
    const st = await callAction(baseUrl, "getStatus", {}, { timeoutMs, retries: 3 });
    let statusData = null;
    if (!st.ok) {
      addProblem({
        key: "site-unreachable",
        title: "getStatus 读不到",
        detail: `getStatus 失败：${st.error}（已重试 ${st.attempts} 次）`,
      });
      result.notes.push("getStatus 失败，后续栏目检查按“未确认”处理，不再逐栏告警。");
    } else {
      statusData = st.data;
      markChecked("site-unreachable");
      const cols = statusData.columns ?? {};
      // 顶层 enrichError 是遗留字段：各栏 error 全空时只当历史处理。
      const colErrors = Object.entries(cols).filter(([, c]) => c?.error);
      const topError = statusData.enrichError;
      if (topError && colErrors.length === 0) {
        result.notes.push(
          `顶层 enrichError 仍有旧文本（${String(topError).slice(0, 60)}…），但三栏 error 全空——按历史错误处理，不告警。` +
            `最近失败时间 lastFailureAt=${statusData.lastFailureAt ?? "未知"}（北京时间 ${statusData.lastFailureAt ? beijingString(statusData.lastFailureAt) : "未知"}）。`,
        );
      }
      for (const [col, c] of Object.entries(cols)) {
        const rec = c?.recovered === true;
        const err = c?.error ?? null;
        result.columns[col] = {
          contentAt: c?.contentAt ?? null,
          contentAtBeijing: c?.contentAt ? beijingString(c.contentAt) : null,
          enrichAt: c?.enrichAt ?? null,
          enrichAtBeijing: c?.enrichAt ? beijingString(c.enrichAt) : null,
          error: err,
          errorAt: c?.errorAt ?? null,
          errorAtBeijing: c?.errorAt ? beijingString(c.errorAt) : null,
          recovered: rec,
        };
        if (err) {
          result.notes.push(`${col} 栏当前有错误未恢复：${String(err).slice(0, 120)}（${c?.errorAt ? beijingString(c.errorAt) : "时间未知"}）`);
          addProblem({
            key: `current-error-${col}`,
            title: `${col} 栏当前有未恢复的错误`,
            detail: `${String(err).slice(0, 200)}（${c?.errorAt ? beijingString(c.errorAt) : "时间未知"}）`,
          });
        } else if (c?.errorAt) {
          result.notes.push(`${col} 栏最近一次错误已恢复（错误时间 ${beijingString(c.errorAt)}，recovered=true）——不再重复告警。`);
        }
      }
      // x 轮新字段（2026-11-24）：currentErrors / lastError / errorHistory。
      // 旧形状没有这些字段时，下面的分支全部跳过，仍用 columns.*.error 判断。
      const currentErrors = Array.isArray(statusData.currentErrors) ? statusData.currentErrors : null;
      if (currentErrors && currentErrors.length > 0) {
        for (const e of currentErrors) {
          const col = e?.column ?? "unknown";
          addProblem({
            key: `current-error-${col}`,
            title: `${col} 栏当前有未恢复的错误`,
            detail: `${String(e?.message ?? e ?? "").slice(0, 200)}（${e?.errorAt ? beijingString(e.errorAt) : "时间未知"}）`,
          });
        }
      }
      const lastError = statusData.lastError;
      if (lastError && typeof lastError === "object") {
        if (lastError.recovered === true) {
          result.notes.push(
            `最近一次错误已恢复（${lastError.column ?? "未知栏目"}，错误时间 ${lastError.errorAt ? beijingString(lastError.errorAt) : "未知"}，恢复于 ${lastError.recoveredAt ? beijingString(lastError.recoveredAt) : "未知"}）——不再重复告警。`,
          );
        } else if (lastError.recovered === false) {
          addProblem({
            key: `current-error-${lastError.column ?? "unknown"}`,
            title: `最近一次错误未恢复（${lastError.column ?? "未知栏目"}）`,
            detail: String(lastError.message ?? "").slice(0, 200),
          });
        }
      }
      const errorHistory = Array.isArray(statusData.errorHistory) ? statusData.errorHistory : null;
      if (errorHistory && errorHistory.length > 0) {
        const recoveredCount = errorHistory.filter((h) => h?.recoveredAt).length;
        result.notes.push(
          `历史错误共 ${errorHistory.length} 条，其中已恢复 ${recoveredCount} 条（最近一条：${errorHistory[0]?.column ?? "?"}，${errorHistory[0]?.errorAt ? beijingString(errorHistory[0].errorAt) : "?"}，恢复于 ${errorHistory[0]?.recoveredAt ? beijingString(errorHistory[0].recoveredAt) : "未恢复"}）。`,
        );
      }
    }

    // -- 3. 定时刷新完成：只认 lastCronRun 记录；没有就是未确认 --
    const today0802 = today0802Beijing(now);
    result.scheduledRun = interpretScheduledRun(statusData, today0802);
    result.notes.push(`今天 08:02 北京时间 = ${today0802.toISOString()}；本次检查时间（北京时间）${result.checkedAtBeijing}。`);

    // -- 4. 各栏读取与规则检查 --
    // daily 模式的只读门禁：该栏缓存新鲜（contentAt 在 TTL 内）才调 get*；
    // 过期就跳过，报“未读取”，绝不触发重抓或模型调用。
    // deploy 模式像用户打开页面一样调 get*（缓存过期时会懒重抓，这是验收
    // 新代码的必要部分；不传 force=true，不调 refreshAll）。
    const canCallDaily = (col) => {
      const c = result.columns[col];
      if (!c?.contentAt) return { ok: false, reason: "getStatus 里没有该栏的 contentAt，无法证明缓存新鲜" };
      const age = ageMs(c.contentAt, nowMs);
      if (age === null || age >= TTL_MS[col]) {
        return { ok: false, reason: `缓存已过期（最近更新 ${c.contentAtBeijing}，距今超过 ${TTL_MS[col] / 60000} 分钟 TTL）` };
      }
      return { ok: true };
    };
    const inWindow = inPostRefreshWindow(now);
    const worldHotGate = () => {
      if (!inWindow) return { ok: false, reason: "不在每天刷新后的巡检窗口（北京时间 08:02–08:47）内，且 world / hot 没有单栏时间戳，无法证明缓存新鲜" };
      const last = statusData?.lastUpdatedAt;
      const age = ageMs(last, nowMs);
      if (age === null || age >= TTL_MS.hot) return { ok: false, reason: "lastUpdatedAt 不新鲜，无法证明 world / hot 缓存新鲜" };
      return { ok: true };
    };

    const checkColumn = async (key, label, action, args, gate, checker, unreadableKey) => {
      const entry = { state: "skipped", reason: "", counts: "", notes: [] };
      result.columns[key] = { ...(result.columns[key] ?? {}), ...entry };
      if (mode === "daily" && gate) {
        const g = gate();
        if (!g.ok) {
          result.columns[key].state = "skipped";
          result.columns[key].reason = `未调用 ${action}：${g.reason}。该栏按 getStatus 的时间判断，不触发刷新。`;
          result.notes.push(`${label}：跳过读取（${g.reason}）。`);
          return;
        }
      }
      const r = await callAction(baseUrl, action, args, { timeoutMs, retries: 3 });
      if (!r.ok) {
        // 429 / 503 且该栏最近成功过、已恢复 → 当作瞬时波动，不告警。
        const colStatus = result.columns[key];
        const recovered = colStatus?.recovered === true && !colStatus?.error;
        const lastOk = colStatus?.contentAt ? ageMs(colStatus.contentAt, nowMs) : null;
        if ((r.status === 429 || r.status === 503) && recovered && lastOk !== null && lastOk < STALE_AFTER_MS) {
          result.columns[key].state = "transient";
          result.columns[key].reason = `${action} 返回 ${r.status}，但该栏最近成功过且已恢复（最近更新 ${colStatus.contentAtBeijing}），按瞬时波动处理，不告警。`;
          result.warnings.push(`${label}：${action} 返回 ${r.status}，已按瞬时波动处理（最近成功 ${colStatus.contentAtBeijing}，已恢复）。`);
          return;
        }
        result.columns[key].state = "unreadable";
        result.columns[key].reason = `${action} 失败：${r.error}（已重试 ${r.attempts} 次）`;
        addProblem({ key: unreadableKey, title: `${label}打不开`, detail: `${action} 失败：${r.error}` });
        return;
      }
      const checked = checker(r.data);
      for (const p of checked.problems ?? []) addProblem(p);
      for (const w of checked.warnings ?? []) result.warnings.push(`${label}：${w}`);
      // 该栏成功读到：把它的全部问题键记为已评估（恢复时才能关 issue）。
      for (const k of COLUMN_PROBLEM_KEYS[key] ?? []) markChecked(k);
      result.columns[key].state = "ok";
      result.columns[key].asOf = r.data?.asOf ?? null;
      result.columns[key].asOfBeijing = r.data?.asOf ? beijingString(r.data.asOf) : null;
      result.columns[key].counts = (checked.notes ?? []).join("；");
      result.columns[key].notes = checked.notes ?? [];
      // 整理延迟：能读，但最近一次成功更新距今超过 36 小时。
      const contentAge = ageMs(r.data?.asOf, nowMs);
      if (contentAge !== null && contentAge > STALE_AFTER_MS) {
        result.columns[key].state = "stale";
        addProblem({
          key: `stale-36h-${key}`,
          title: `${label}内容可读但整理延迟`,
          detail: `最近一次成功更新是 ${beijingString(r.data.asOf)}，距今超过 36 小时。`,
        });
      }
      // 今早是否更新过（只报告，不单独告警；见 README 的误报说明）。
      const contentAt = result.columns[key].contentAt;
      if (contentAt) {
        const updatedThisMorning = Date.parse(contentAt) >= today0802.getTime();
        result.columns[key].updatedThisMorning = updatedThisMorning;
        if (!updatedThisMorning) {
          result.warnings.push(`${label}：今早 08:02 后没有更新记录（最近更新 ${result.columns[key].contentAtBeijing}）。可能是定时任务未完成，也可能是 Vercel 定时任务在 08:02 之后才触发——只警告，不告警。`);
        }
      }
    };

    // 健身是静态精选，不读缓存、不调模型，任何时候都能安全读。
    await checkColumn("fitness", "健身", "getFitness", {}, null, checkFitness, "fitness-unreadable");
    await checkColumn("jiangxi", "江西专升本", "getJiangxi", { force: false }, () => canCallDaily("jiangxi"), checkJiangxi, "jiangxi-unreadable");
    await checkColumn("overseas", "海外", "getOverseas", { force: false }, () => canCallDaily("overseas"), checkOverseas, "overseas-unreadable");
    await checkColumn("learning", "学习", "getLearning", { force: false }, () => canCallDaily("learning"), checkLearning, "learning-unreadable");
    await checkColumn("world", "国内外观察", "getMyWorld", { force: false }, worldHotGate, checkWorld, "world-unreadable");
    await checkColumn("hot", "热榜", "getHotLists", { force: false }, worldHotGate, checkHot, "hot-unreadable");
    await checkColumn(
      "digest",
      "近期可申请",
      "getDailyDigest",
      { force: false },
      () => {
        const a = canCallDaily("overseas");
        if (!a.ok) return { ok: false, reason: `依赖海外栏缓存新鲜：${a.reason}` };
        const b = canCallDaily("learning");
        if (!b.ok) return { ok: false, reason: `依赖学习栏缓存新鲜：${b.reason}` };
        return { ok: true };
      },
      checkDigest,
      "digest-unreadable",
    );

    // -- 5. 总状态 --
    if (result.activeProblems.length > 0) result.status = "anomaly";
    else if (result.warnings.length > 0) result.status = "warning";
    else result.status = "pass";
    if (mode === "deploy" && args.sha) result.notes.push(`本次验收的提交：${args.sha}`);
    if (result.focus.length) result.notes.push(`本次改动涉及：${result.focus.join("、")}（按提交改动文件映射，见工作流）。`);
  } catch (e) {
    result.status = "anomaly";
    result.notes.push(`检查脚本内部出错：${e?.message ?? e}`);
    addProblem({ key: "site-unreachable", title: "检查脚本内部出错", detail: String(e?.message ?? e) });
  }

  // -- 6. 写出结果与摘要 --
  const summary = buildSummary(result);
  try {
    fs.writeFileSync(args.out, JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`写 ${args.out} 失败：${e.message}`);
  }
  try {
    fs.writeFileSync(args.summary, summary);
  } catch (e) {
    console.error(`写 ${args.summary} 失败：${e.message}`);
  }
  console.log(summary);
  process.exit(result.status === "anomaly" ? 1 : 0);
}

function buildSummary(r) {
  const lines = [];
  const title = r.mode === "daily" ? "每日巡检" : "部署验收";
  lines.push(`# ${title}（${r.checkedAtBeijing} 北京时间）`);
  lines.push("");
  lines.push(`- 生产站：${r.baseUrl}`);
  if (r.sha) lines.push(`- 提交：${r.sha}`);
  if (r.focus.length) lines.push(`- 本次改动涉及：${r.focus.join("、")}`);
  lines.push(`- 网站可读：${r.websiteReadable ? "是" : "否"}`);
  lines.push(`- 定时刷新完成：${r.scheduledRun.status === "confirmed" ? "已确认" : "未确认"}（${r.scheduledRun.evidence}）`);
  lines.push(`- 总状态：${r.status === "pass" ? "通过" : r.status === "warning" ? "通过（有警告）" : "有异常"}`);
  lines.push("");
  lines.push("## 各栏目");
  lines.push("");
  lines.push("| 栏目 | 状态 | 内容 | 最近更新（北京时间） |");
  lines.push("| --- | --- | --- | --- |");
  const order = ["jiangxi", "overseas", "learning", "world", "hot", "digest", "fitness"];
  const labels = { jiangxi: "江西专升本", overseas: "海外", learning: "学习", world: "国内外观察", hot: "热榜", digest: "近期可申请", fitness: "健身" };
  for (const key of order) {
    const c = r.columns[key] ?? {};
    const stateText = { ok: "可读", skipped: "未读取", unreadable: "打不开", stale: "整理延迟", transient: "瞬时波动" }[c.state] ?? (c.state ?? "未知");
    lines.push(`| ${labels[key]} | ${stateText} | ${c.counts ?? c.reason ?? ""} | ${c.contentAtBeijing ?? c.asOfBeijing ?? ""} |`);
  }
  lines.push("");
  if (r.activeProblems.length) {
    lines.push("## 确认的异常");
    lines.push("");
    for (const p of r.activeProblems) lines.push(`- **${p.title}**（${p.key}）：${p.detail}`);
    lines.push("");
  }
  if (r.warnings.length) {
    lines.push("## 警告（不告警，只记录）");
    lines.push("");
    for (const w of r.warnings) lines.push(`- ${w}`);
    lines.push("");
  }
  if (r.notes.length) {
    lines.push("## 备注");
    lines.push("");
    for (const n of r.notes) lines.push(`- ${n}`);
    lines.push("");
  }
  return lines.join("\n");
}

// 只有直接运行时才执行 main；被测试文件 import 时只导出纯函数。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

/*
 * 常量依据（仓库 10f12e37，2026-11-24 克隆）：
 * - TTL：server/src/actions.ts 行 1179（LEARNING 45 分钟）、2224（JIANGXI
 *   60 分钟）、2870（OVERSEAS 60 分钟）、4446（WORLD 60 分钟）、5924（HOT
 *   45 分钟）。应用改了 TTL，这里要同步改，否则 daily 模式的只读门禁会误判。
 * - getStatus 字段：行 6150 起。columns 只有 learning / jiangxi / overseas
 *   三栏；world / hot 没有单栏时间戳——这是 daily 模式里 world / hot 只能
 *   用 lastUpdatedAt 粗判的原因（见 README“未确认”一节）。
 * - 读动作：getJiangxi（6529）、getOverseas（6588）、getMyWorld（6632）、
 *   getHotLists（6657）、getDailyDigest（6675）、getLearning（6342）、
 *   getFitness（6420）、getStatus（6150）。写动作 refreshAll（6780）与
 *   force=true 的刷新、getItemDetail（未缓存时调模型，行 6494）绝不能调。
 * - 定时刷新：vercel.json crons "2 0 * * *"（UTC 00:02 = 北京时间 08:02），
 *   走 GET /api/cron → refreshAll；刷新本身不写“本次定时任务完成”的记录。
 */
