import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import * as schema from "./schema";
import type { Ctx } from "./ctx";
import { completeInference } from "./llm";

// ---------------------------------------------------------------------------
// Local replacement for the SDK's `defineAction` (previously provided by
// the Muse-hosted SDK). It returns the definition object as-is, keeping the
// description/request/response/handler structure and type inference, so the
// 16 action definitions below did not need to change.
// ---------------------------------------------------------------------------

function defineAction<Req extends z.ZodTypeAny, Res extends z.ZodTypeAny>(def: {
  description: string;
  request: Req;
  response: Res;
  handler: (ctx: Ctx, args: z.infer<Req>) => Promise<z.infer<Res>>;
}): {
  description: string;
  request: Req;
  response: Res;
  handler: (ctx: Ctx, args: z.infer<Req>) => Promise<z.infer<Res>>;
} {
  return def;
}

// ---------------------------------------------------------------------------
// Source definitions
// ---------------------------------------------------------------------------

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const GN = "hl=zh-CN&gl=CN&ceid=CN:zh-Hans";

export const CATEGORIES = [
  { id: "top", label: "头条", url: `https://news.google.com/rss?${GN}` },
  { id: "nation", label: "国内", url: `https://news.google.com/rss/headlines/section/topic/NATION?${GN}` },
  { id: "world", label: "国际", url: `https://news.google.com/rss/headlines/section/topic/WORLD?${GN}` },
  { id: "business", label: "财经", url: `https://news.google.com/rss/headlines/section/topic/BUSINESS?${GN}` },
  { id: "tech", label: "科技", url: `https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?${GN}` },
  {
    id: "ai",
    label: "AI",
    url: `https://news.google.com/rss/search?q=%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD%20OR%20%E5%A4%A7%E6%A8%A1%E5%9E%8B%20OR%20AI&${GN}`,
  },
  { id: "sports", label: "体育", url: `https://news.google.com/rss/headlines/section/topic/SPORTS?${GN}` },
  { id: "science", label: "科学", url: `https://news.google.com/rss/headlines/section/topic/SCIENCE?${GN}` },
  { id: "health", label: "健康", url: `https://news.google.com/rss/headlines/section/topic/HEALTH?${GN}` },
] as const;

export const FEED_CATALOG = [
  { key: "bbc-zh", name: "BBC 中文", field: "国际", lang: "中文", url: "https://feeds.bbci.co.uk/zhongwen/simp/rss.xml" },
  { key: "bbc-world", name: "BBC World", field: "国际", lang: "English", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { key: "nyt-world", name: "纽约时报 · 国际", field: "国际", lang: "English", url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml" },
  { key: "ithome", name: "IT之家", field: "科技", lang: "中文", url: "https://www.ithome.com/rss/" },
  { key: "sspai", name: "少数派", field: "科技", lang: "中文", url: "https://sspai.com/feed" },
  { key: "verge", name: "The Verge", field: "科技", lang: "English", url: "https://www.theverge.com/rss/index.xml" },
  { key: "ars", name: "Ars Technica", field: "科技", lang: "English", url: "https://feeds.arstechnica.com/arstechnica/index" },
  { key: "hn", name: "Hacker News", field: "科技", lang: "English", url: "https://hnrss.org/frontpage" },
  { key: "bbc-sport", name: "BBC Sport", field: "体育", lang: "English", url: "https://feeds.bbci.co.uk/sport/rss.xml" },
] as const;

// ---------------------------------------------------------------------------
// Fetch + parse helpers
// ---------------------------------------------------------------------------

async function fetchText(url: string, headers?: Record<string, string>): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "*/*", ...headers },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function tagContent(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return m?.[1] != null ? decodeEntities(m[1]) : null;
}

interface FeedItem {
  title: string;
  url: string;
  summary: string | null;
  publishedAt: string | null;
  source: string;
}

/**
 * Google News' placeholder line ("在 Google 新闻上查看更多头条新闻和观点" /
 * "See more headlines and perspectives on Google News") — boilerplate the
 * feed appends in place of a real description. It is never a summary.
 */
const GN_PLACEHOLDER_RE =
  /在\s*Google\s*新闻上查看更多头条新闻和观点|(?:See|View)\s+more\s+headlines\s+and\s+perspectives\s+on\s+Google\s+News/gi;

/** Parse RSS 2.0 <item> and Atom <entry> blocks from a feed document. */
function parseFeed(xml: string, fallbackSource: string, limit: number): FeedItem[] {
  const items: FeedItem[] = [];
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
  for (const block of blocks) {
    const title = tagContent(block, "title");
    if (!title) continue;
    let link = tagContent(block, "link");
    if (!link) {
      const href = block.match(/<link[^>]*href="([^"]+)"/i)?.[1];
      link = href ? decodeEntities(href) : null;
    }
    if (!link) continue;
    // Bing News RSS wraps the publisher URL in an apiclick redirect whose
    // `url` query param IS the direct publisher address — decode it at parse
    // time so no relay link is ever stored.
    link = decodeBingClick(link);
    const dateRaw =
      tagContent(block, "pubDate") ??
      tagContent(block, "published") ??
      tagContent(block, "updated") ??
      tagContent(block, "dc:date");
    let publishedAt: string | null = null;
    if (dateRaw) {
      const d = new Date(dateRaw);
      if (!Number.isNaN(d.getTime())) publishedAt = d.toISOString();
    }
    const descRaw =
      tagContent(block, "description") ?? tagContent(block, "summary") ?? tagContent(block, "content");
    // Google News descriptions are a list of related headlines, sometimes
    // ending in (or consisting only of) the placeholder line "在 Google
    // 新闻上查看更多头条新闻和观点" — that text is NOT an article summary.
    // Strip it before anything else so it can never be stored or shown as
    // one; what remains is then judged by the title/source rules below, and
    // an item left with nothing is honestly title-only.
    const descClean = descRaw
      ? descRaw
          .replace(/在\s*Google\s*新闻上查看更多头条新闻和观点/g, " ")
          .replace(/(?:See|View)\s+more\s+headlines\s+and\s+perspectives\s+on\s+Google\s+News/gi, " ")
      : null;
    const summary = descClean ? stripTags(descClean).slice(0, 350) || null : null;
    const sourceName = tagContent(block, "source") ?? tagContent(block, "News:Source") ?? fallbackSource;
    // Google News appends " - <publisher>" to titles; the source is shown separately.
    const cleanTitle = title.endsWith(` - ${sourceName}`) ? title.slice(0, -(sourceName.length + 3)).trim() : title;
    // Google News descriptions are just "title + publisher" — that is not a real
    // summary. Treat it as no summary so the UI can honestly say 仅有标题.
    let cleanSummary = summary;
    if (summary) {
      if (summary === title || summary === cleanTitle || summary === sourceName) {
        cleanSummary = null;
      } else if (summary.startsWith(title) || summary.startsWith(cleanTitle)) {
        const base = summary.startsWith(title) ? title : cleanTitle;
        const rest = summary.slice(base.length).trim();
        cleanSummary = rest && rest !== sourceName && rest.length > 8 ? rest : null;
      }
      // Final guard: a summary that still carries the Google News
      // placeholder phrase (spacing/entity variants) loses that phrase;
      // if nothing real remains, the item is title-only.
      GN_PLACEHOLDER_RE.lastIndex = 0; // shared /g regex: .test is stateful
      if (cleanSummary && GN_PLACEHOLDER_RE.test(cleanSummary)) {
        const stripped = cleanSummary.replace(GN_PLACEHOLDER_RE, " ").replace(/\s+/g, " ").trim();
        cleanSummary = stripped && stripped !== sourceName && stripped.length > 8 ? stripped : null;
      }
    }
    items.push({ title: cleanTitle || title, url: link, summary: cleanSummary, publishedAt, source: sourceName });
    if (items.length >= limit) break;
  }
  return items;
}

// ---------------------------------------------------------------------------
// Direct-link helpers + Google News relay resolution + login-wall detection
// ---------------------------------------------------------------------------

/** Bing News apiclick links embed the publisher URL in the `url` param. */
function decodeBingClick(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname.includes("bing.com") && u.pathname.includes("apiclick")) {
      const direct = u.searchParams.get("url");
      if (direct && /^https?:\/\//i.test(direct)) return direct;
    }
  } catch {
    // not a URL we recognise — pass through
  }
  return url;
}

function isBingClick(url: string): boolean {
  return url.includes("bing.com/news/apiclick");
}

/** Universities, schools and government hosts — their pages ARE official entries. */
function isInstitutionalHost(host: string): boolean {
  return (
    /\.edu(\.[a-z]{2})?$/.test(host) ||
    /\.ac\.[a-z]{2}$/.test(host) ||
    /\.gov(\.[a-z]{2})?$/.test(host) ||
    host.includes("university") ||
    host.endsWith(".edu.cn")
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function isGnRelay(url: string): boolean {
  return url.includes("news.google.com/rss/articles/") || url.includes("news.google.com/articles/");
}

/**
 * Google News RSS links are relay tokens; opening them can land on an invalid
 * redirect page. Try the documented decode flow (article page carries
 * data-n-a-id/ts/sg, exchanged via batchexecute for the publisher URL).
 * Short timeouts: on any failure return null and the UI falls back to
 * keeping the summary plus a 复制标题 button.
 */
async function resolveGnUrl(url: string): Promise<string | null> {
  if (!isGnRelay(url)) return decodeBingClick(url);
  try {
    const pageRes = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: AbortSignal.timeout(8000),
    });
    if (!pageRes.ok) return null;
    // Google expects the cookies set by the article page on the exchange call.
    const cookies = (pageRes.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    const page = await pageRes.text();
    const id = page.match(/data-n-a-id="([^"]+)"/)?.[1];
    const ts = page.match(/data-n-a-ts="([^"]+)"/)?.[1];
    const sg = page.match(/data-n-a-sg="([^"]+)"/)?.[1];
    if (!id || !ts || !sg) return null;
    const inner = JSON.stringify([
      "garturlreq",
      [
        ["en-US", "US", ["FINANCE_TOP_INDICES", "WEB_TEST_1_0_0"], null, null, 1, 1, "US:en", null, 180, null, null, null, null, null, 0, null, null, [1608992183, 723341000]],
        "en-US", "US", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0,
      ],
      id,
      Number(ts),
      sg,
    ]);
    const freq = JSON.stringify([[["Fbv4je", inner, null, "generic"]]]);
    const res = await fetch("https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je", {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        ...(cookies ? { Cookie: cookies } : {}),
      },
      body: new URLSearchParams({ "f.req": freq }).toString(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    // The publisher URL sits inside nested JSON strings, so its =, & and ?
    // arrive as \uXXXX escapes (sometimes double-escaped). Unescape BEFORE
    // extracting, or the URL regex stops at the first backslash and stores
    // a truncated address ("...?id" with the value cut off).
    const unescaped = text
      .replace(/\\\\u003d/g, "=")
      .replace(/\\u003d/g, "=")
      .replace(/\\\\u0026/g, "&")
      .replace(/\\u0026/g, "&")
      .replace(/\\\\u003f/g, "?")
      .replace(/\\u003f/g, "?")
      .replace(/\\\//g, "/");
    const urls = unescaped.match(/https?:\/\/[^\s"\\]+/g) ?? [];
    const cand = urls.find(
      (u) => !u.includes("google.com") && !u.includes("gstatic.com") && !u.includes("googleusercontent.com"),
    );
    return cand ? cand.replace(/\\u003d/g, "=").replace(/\\u0026/g, "&").replace(/\\u003f/g, "?") : null;
  } catch {
    return null;
  }
}

interface ArticleMeta {
  /** The article page's own meta description — a real summary when RSS had none. */
  summary: string | null;
  /** Best official detail/application link found among the article's own outbound links. */
  officialUrl: string | null;
}

/**
 * Fetches a publisher article page once and extracts (a) its meta description
 * as a genuine summary and (b) for opportunity items, the organizer's official
 * detail page from the article's outbound links (institutional hosts and
 * admissions/scholarship link text score highest). Best-effort: any failure
 * returns nulls and the caller falls back honestly.
 */
async function fetchArticleMeta(url: string): Promise<ArticleMeta> {
  const empty: ArticleMeta = { summary: null, officialUrl: null };
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: AbortSignal.timeout(7000),
      redirect: "follow",
    });
    if (!res.ok) return empty;
    const html = await res.text();
    const metaDesc =
      html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description|twitter:description)["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description|twitter:description)["']/i)?.[1];
    let summary: string | null = null;
    if (metaDesc) {
      const s = stripTags(metaDesc).slice(0, 300);
      // Reject mojibake: a page served in GBK/GB2312 but decoded as UTF-8
      // yields runs of U+FFFD — that is not a readable description.
      const replacements = (s.match(/�/g) ?? []).length;
      if (s.length >= 15 && replacements <= 2) summary = s;
    }
    let officialUrl: string | null = null;
    let best = 0;
    const base = res.url || url;
    const publisherHost = hostOf(base);
    const anchorRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = anchorRe.exec(html)) !== null) {
      const hrefRaw = m[1];
      if (!hrefRaw || hrefRaw.startsWith("#") || hrefRaw.startsWith("javascript:")) continue;
      let abs: string;
      try {
        abs = new URL(hrefRaw, base).toString();
      } catch {
        continue;
      }
      if (!/^https?:\/\//i.test(abs)) continue;
      if (/share|login|passport|signup|register\/login/i.test(abs)) continue;
      const host = hostOf(abs);
      if (!host || /(weibo\.com|weixin|twitter\.com|x\.com|facebook\.com|t\.me)/i.test(host)) continue;
      const text = stripTags(m[2] ?? "");
      const hay = `${abs} ${text}`;
      const inst = isInstitutionalHost(host);
      const topicalEntity = /大学|学院|学校|university|college|school/i.test(hay);
      const topicalAction = /招生|奖学金|报名|申请|简章|scholarship|admission|apply|summer|competition/i.test(hay);
      let score = 0;
      if (inst) score += 4;
      if (topicalEntity) score += 2;
      if (topicalAction) score += 2;
      if (/官方|详情|official/i.test(text)) score += 1;
      // A bare institutional host is NOT enough (a TV station article's FCC
      // public-file .gov link scored 4 and was wrongly taken as the official
      // page): institutional links must also be topical, and non-institutional
      // links must name both an education entity and an application action
      // and point away from the publisher's own host.
      const qualifies =
        (inst && (topicalEntity || topicalAction) && score >= 6) ||
        (!inst && topicalEntity && topicalAction && host !== publisherHost);
      if (qualifies && score > best) {
        best = score;
        officialUrl = abs;
      }
    }
    return { summary, officialUrl };
  } catch {
    return empty;
  }
}

/** Sources known to require login / subscription to read full articles. */
const LOGIN_MARKERS = [
  "nytimes.com", "纽约时报", "wsj.com", "华尔街日报", "ft.com", "金融时报", "economist.com", "经济学人",
  "bloomberg.com", "彭博", "washingtonpost.com", "华盛顿邮报", "caixin.com", "财新", "nikkei.com", "日经",
  "theathletic.com", "thetimes.com", "泰晤士报",
];

function loginRequired(source: string, url: string): boolean {
  const hay = `${source} ${url}`.toLowerCase();
  return LOGIN_MARKERS.some((m) => hay.includes(m.toLowerCase()));
}

// ---------------------------------------------------------------------------
// China-reachability registry + aggregator (MSN) resolution
//
// The build/refresh sandbox sits OUTSIDE China, so a page loading fine here
// says nothing about whether it opens from mainland China (e.g. a CDN geo-
// block only triggers for Chinese IPs). Domains enter this registry ONLY on
// user-confirmed evidence from inside China — never from a sandbox fetch
// result. Items on a registered domain keep their Chinese summary in-page,
// are labelled 「中国境内打不开」 beside the link, and are never presented
// as a readable 查看原文； an accessible official/alternative link, when one
// exists, is offered instead.
// ---------------------------------------------------------------------------

const CN_BLOCKED_DOMAINS: Array<{ host: string; reason: string }> = [
  // User-confirmed 2026-11-21 (screenshot): 403 "The Amazon CloudFront
  // distribution is configured to block access from your country."
  { host: "wfyi.org", reason: "Amazon CloudFront 配置为屏蔽中国访问" },
];

/** Why this URL cannot be opened from mainland China, or null when no confirmed block is recorded. */
function cnBlockedReason(url: string | null | undefined): string | null {
  if (!url) return null;
  const host = hostOf(url);
  if (!host) return null;
  const hit = CN_BLOCKED_DOMAINS.find((d) => host === d.host || host.endsWith(`.${d.host}`));
  return hit ? hit.reason : null;
}

function isMsnUrl(url: string): boolean {
  const host = hostOf(url);
  // MSN serves reposts from msn.com (global) and msn.cn (China edition).
  return /(^|\.)msn\.(com|cn)$/.test(host);
}

const CRAWLER_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

/**
 * MSN article pages are reposts of a publisher's article. Served to a
 * crawler UA, the page is server-rendered and carries a
 * <link rel="canonical"> pointing at the ORIGINAL publisher's article URL
 * (verified 2026-11-21 for CNBC / Politico / Legit.ng reposts). Resolve at
 * ingest so an MSN repost link is never stored as an item's original link.
 * Returns null when no non-MSN canonical can be extracted.
 */
async function resolveMsnUrl(url: string): Promise<string | null> {
  if (!isMsnUrl(url)) return null;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": CRAWLER_UA, Accept: "text/html" },
      signal: AbortSignal.timeout(9000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();
    const canonical =
      html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] ??
      html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i)?.[1];
    if (!canonical) return null;
    const direct = decodeEntities(canonical);
    if (!/^https?:\/\//i.test(direct) || isMsnUrl(direct) || isGnRelay(direct) || isBingClick(direct)) return null;
    return direct;
  } catch {
    return null;
  }
}

/** Bing News names repost sources "CNBC on MSN" — once resolved to the publisher, the suffix goes. */
function cleanAggregatorSource(source: string): string {
  const cleaned = source.replace(/\s+on MSN$/i, "").trim();
  return cleaned || source;
}

/**
 * Google News relay resolution with a persistent relay→publisher cache, so
 * ingest (category loads) and on-expand detail lookups share resolutions
 * instead of re-running the batchexecute decode for the same token.
 */
async function resolveGnShared(ctx: Ctx, url: string): Promise<string | null> {
  if (!isGnRelay(url)) return decodeBingClick(url);
  const store = (await readCacheStale<Record<string, string>>(ctx, "gn:resolved:v2"))?.data ?? {};
  const hit = store[url];
  if (hit) return hit;
  const resolved = await resolveGnUrl(url);
  if (resolved && !isGnRelay(resolved) && !isBingClick(resolved)) {
    store[url] = resolved;
    const bounded: Record<string, string> = {};
    for (const [k, v] of Object.entries(store).slice(-400)) bounded[k] = v;
    await writeCache(ctx, "gn:resolved:v2", bounded);
    return resolved;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cache helpers (one snapshot row per key, replaced on refresh)
// ---------------------------------------------------------------------------

const NEWS_TTL_MS = 45 * 60 * 1000;
const FEED_TTL_MS = 60 * 60 * 1000;

async function readCache<T>(ctx: Ctx, key: string, ttlMs: number): Promise<{ data: T; asOf: string } | null> {
  const db = ctx.db;
  const rows = await db.select().from(schema.cacheSnapshots).where(eq(schema.cacheSnapshots.key, key)).limit(1);
  const row = rows[0];
  if (!row) return null;
  if (Date.now() - row.fetchedAt.getTime() > ttlMs) return null;
  return { data: JSON.parse(row.payload) as T, asOf: row.fetchedAt.toISOString() };
}

async function readCacheStale<T>(ctx: Ctx, key: string): Promise<{ data: T; asOf: string } | null> {
  const db = ctx.db;
  const rows = await db.select().from(schema.cacheSnapshots).where(eq(schema.cacheSnapshots.key, key)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return { data: JSON.parse(row.payload) as T, asOf: row.fetchedAt.toISOString() };
}

async function writeCache(ctx: Ctx, key: string, data: unknown): Promise<string> {
  const db = ctx.db;
  const now = new Date();
  await db
    .insert(schema.cacheSnapshots)
    .values({ key, payload: JSON.stringify(data), fetchedAt: now })
    .onConflictDoUpdate({
      target: schema.cacheSnapshots.key,
      set: { payload: JSON.stringify(data), fetchedAt: now },
    });
  return now.toISOString();
}

/** Records the most recent refresh failure time (content itself stays on the previous version). */
async function noteRefreshFailure(ctx: Ctx): Promise<void> {
  try {
    const db = ctx.db;
    const rows = await db.select().from(schema.cacheSnapshots).where(eq(schema.cacheSnapshots.key, "meta:status")).limit(1);
    const prev = rows[0] ? (JSON.parse(rows[0].payload) as { lastFailureAt?: string }) : {};
    await writeCache(ctx, "meta:status", { ...prev, lastFailureAt: new Date().toISOString() });
  } catch {
    // bookkeeping only — never break a load over it
  }
}

// ---------------------------------------------------------------------------
// Source loaders
// ---------------------------------------------------------------------------

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Opens a resolved publisher URL to confirm it really is the publisher's
 * article page: fails only on definitive evidence — HTTP 404/410, a final
 * URL still on a Google/relay host, or a 2xx/3xx response that is not HTML.
 * A 403/5xx or a sandbox network error cannot prove the page is broken for
 * the reader (bot protection and geo-routing are common), so those keep the
 * decoded address, which came from Google's own decode rather than a guess.
 */
async function verifyPublisherPage(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: AbortSignal.timeout(7000),
      redirect: "follow",
    });
    if (res.status === 404 || res.status === 410) return false;
    const finalUrl = res.url || url;
    if (isGnRelay(finalUrl) || /news\.google\.com/.test(finalUrl)) return false;
    if (res.status >= 200 && res.status < 400) {
      const ct = res.headers.get("content-type") ?? "";
      if (ct && !/html/i.test(ct)) return false;
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * Ingest link + summary hygiene for category items, applied to EVERY
 * category (not just 国际）: no Google News relay link may be stored
 * anywhere on the page. Each relay token is decoded to the publisher's
 * direct address at ingest, every decoded address is opened once to
 * confirm it loads as the publisher's article page, and an item whose
 * link cannot be resolved AND verified is stored with an empty url —
 * the UI then keeps only its summary plus a 复制标题 button instead of
 * presenting a relay link as an original. Items left without a real
 * summary (the feed carried only the Google News placeholder or a
 * headline list) get one attempt at the article page's own meta
 * description — a genuine description — before they settle as
 * title-only. All passes run against a shared time budget so a category
 * load stays well inside the action time limit even when Google's
 * endpoints hang; successes accumulate in the shared gn:resolved cache
 * across refreshes, so later runs start from a warmer base.
 */
async function resolveCategoryIngest(ctx: Ctx, items: FeedItem[]): Promise<void> {
  const budgetUntil = Date.now() + 45_000;
  // Pass 1: parallel batches of 5 via the shared resolution cache.
  for (let s = 0; s < items.length; s += 5) {
    if (Date.now() > budgetUntil) break;
    await Promise.all(
      items.slice(s, s + 5).map(async (it) => {
        if (!isGnRelay(it.url)) return;
        const direct = await resolveGnShared(ctx, it.url);
        if (direct) it.url = direct;
      }),
    );
  }
  // Pass 2: sequential retries for the stubborn remainder — Google's
  // batchexecute throttles parallel bursts (intermittent 429/CAPTCHA),
  // so one-at-a-time attempts with a pause resolve some of what the
  // parallel pass missed. Failures are not cached, so each attempt is
  // a fresh decode.
  for (const it of items) {
    if (!isGnRelay(it.url)) continue;
    if (Date.now() > budgetUntil) break;
    await sleepMs(400);
    const direct = await resolveGnShared(ctx, it.url);
    if (direct) it.url = direct;
  }
  // Pass 3: open every resolved address once; a decode that lands on a
  // dead or non-article page goes back to unresolved.
  for (let s = 0; s < items.length; s += 5) {
    if (Date.now() > budgetUntil + 20_000) break;
    await Promise.all(
      items.slice(s, s + 5).map(async (it) => {
        if (!it.url || isGnRelay(it.url)) return;
        if (!(await verifyPublisherPage(it.url))) it.url = "";
      }),
    );
  }
  // Pass 4: real-description backfill. An item whose feed summary was
  // discarded (Google News placeholder / headline list) but which now
  // has a verified publisher address gets the article page's own meta
  // description as its summary; if the page yields none, the item stays
  // title-only — the placeholder is never resurrected as a summary.
  for (let s = 0; s < items.length; s += 5) {
    if (Date.now() > budgetUntil + 25_000) break;
    await Promise.all(
      items.slice(s, s + 5).map(async (it) => {
        if (it.summary || !it.url || isGnRelay(it.url)) return;
        const meta = await fetchArticleMeta(it.url);
        if (meta.summary && meta.summary !== it.title) it.summary = meta.summary;
      }),
    );
  }
  // Still a relay token after every pass → store no link at all.
  for (const it of items) {
    if (isGnRelay(it.url)) it.url = "";
  }
}

async function loadCategory(ctx: Ctx, categoryId: string, force: boolean): Promise<{ items: FeedItem[]; asOf: string }> {
  const cat = CATEGORIES.find((c) => c.id === categoryId) ?? CATEGORIES[0];
  // Every category carries a versioned v2 key: pre-v2 payloads could
  // still hold Google News relay URLs (all categories resolved only on
  // expand back then) and placeholder summaries, and must never be
  // served again — v2 stores publisher-direct addresses only (or no
  // link at all) and never a placeholder summary.
  const key = `news:${cat.id}:v2`;
  if (!force) {
    const cached = await readCache<FeedItem[]>(ctx, key, NEWS_TTL_MS);
    if (cached) return { items: cached.data, asOf: cached.asOf };
  }
  try {
    const xml = await fetchText(cat.url);
    let items = parseFeed(xml, "Google 新闻", 30);
    // 中新网's own RSS carries real summaries and direct article links (no
    // relay) — blend it into 头条/国内 so domestic items can be read in-page.
    if (cat.id === "top" || cat.id === "nation") {
      try {
        const cnXml = await fetchText("https://www.chinanews.com.cn/rss/scroll-news.xml");
        const cnItems = parseFeed(cnXml, "中新网", 30);
        const seenTitles = new Set(items.map((i) => i.title));
        items = [...items, ...cnItems.filter((i) => !seenTitles.has(i.title))].sort((a, b) => {
          const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
          const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
          return tb - ta;
        }).slice(0, 40);
      } catch {
        // keep Google News items only
      }
    }
    if (items.length === 0) throw new Error("empty feed");
    // Site-wide rule: every category resolves relay links at ingest and
    // backfills real descriptions for summary-less items (see
    // resolveCategoryIngest). No category stores a news.google.com link.
    await resolveCategoryIngest(ctx, items);
    const asOf = await writeCache(ctx, key, items);
    return { items, asOf };
  } catch {
    await noteRefreshFailure(ctx);
    const stale = await readCacheStale<FeedItem[]>(ctx, key);
    if (stale) return { items: stale.data, asOf: stale.asOf };
    return { items: [], asOf: new Date().toISOString() };
  }
}

async function loadFeedItems(
  ctx: Ctx,
  feedKey: string,
  name: string,
  url: string,
  force: boolean,
): Promise<{ items: FeedItem[]; error: string | null }> {
  const key = `feed:${feedKey}`;
  if (!force) {
    const cached = await readCache<FeedItem[]>(ctx, key, FEED_TTL_MS);
    if (cached) return { items: cached.data, error: null };
  }
  try {
    const xml = await fetchText(url);
    const items = parseFeed(xml, name, 20).map((it) => ({ ...it, source: name }));
    if (items.length === 0) throw new Error("empty feed");
    await writeCache(ctx, key, items);
    return { items, error: null };
  } catch {
    await noteRefreshFailure(ctx);
    const stale = await readCacheStale<FeedItem[]>(ctx, key);
    if (stale) return { items: stale.data, error: null };
    return { items: [], error: "这个订阅源暂时连不上" };
  }
}

// ---------------------------------------------------------------------------
// Learning column （学习）: courses, resources, student opportunities
// ---------------------------------------------------------------------------

type LearningCategory = "courses" | "resources" | "opportunities";

interface LearningItem {
  title: string;
  url: string;
  source: string;
  publishedAt: string | null;
  /** One Chinese sentence （适合谁＋能学到什么）; null when only the title is available. */
  summaryZh: string | null;
  /** Chinese key points drawn only from the source's own RSS summary; empty when title-only. */
  points: string[];
  /** True when no real summary/body text could be obtained — never guess content from the title. */
  titleOnly: boolean;
  /** Same institution's Chinese-edition link for foreign items, when one was verified by story-id match. */
  chineseUrl: string | null;
  /** Fee as stated by the source （免费 / 学费…); null = 未公布. */
  fee: string | null;
  /** Direct publisher URL for 查看原文； null when a Google News relay link could not be resolved. */
  readUrl: string | null;
  /** Official detail/application page, when the direct link is an institution/organizer page. */
  officialUrl: string | null;
  /** True when the source is known to require login/subscription. */
  needsLogin: boolean;
  /** Why the original cannot be opened from mainland China (user-confirmed registry); null when it opens normally. */
  blockedReason: string | null;
  category: LearningCategory;
  audienceStage: string | null;
  deadline: string | null;
  needsApplication: boolean;
}

const LEARNING_TTL_MS = 45 * 60 * 1000;

const BING_QFT = "qft=interval%3d%228%22"; // Bing News: past month only
function bingNewsUrl(query: string): string {
  return `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&${BING_QFT}`;
}

/**
 * Direct institutional / platform feeds first, then Bing News searches.
 * Google News search feeds were dropped for this column (2026-11-20): their
 * RSS links are relay tokens whose decode endpoint is CAPTCHA-blocked from
 * this environment, so items could only ever be stored as unresolvable relay
 * links with no summary. Bing News RSS instead embeds the publisher's direct
 * URL in each link (decoded in parseFeed) and carries a real description per
 * item, so every stored item has a direct link AND genuine text to enrich.
 */
const LEARNING_FEEDS: Array<{ hint: LearningCategory; name: string; url: string; direct: boolean }> = [
  { hint: "courses", name: "Coursera 博客", url: "https://blog.coursera.org/feed/", direct: true },
  { hint: "courses", name: "FutureLearn 博客", url: "https://www.futurelearn.com/info/blog/feed", direct: true },
  { hint: "courses", name: "MIT News · 教育", url: "https://news.mit.edu/rss/topic/education", direct: true },
  { hint: "resources", name: "芥末堆", url: "https://www.jiemodui.com/rss", direct: true },
  { hint: "resources", name: "中国教育在线", url: "https://www.eol.cn/rss.xml", direct: true },
  { hint: "resources", name: "联合国新闻", url: "https://news.un.org/feed/subscribe/zh/news/all/rss.xml", direct: true },
  { hint: "courses", name: "Bing 资讯 · 课程", url: bingNewsUrl("大学 公开课 免费课程"), direct: false },
  { hint: "courses", name: "Bing News · Courses", url: bingNewsUrl("free online course university students"), direct: false },
  { hint: "resources", name: "Bing 资讯 · 资源", url: bingNewsUrl("开放教材 学习资源 题库"), direct: false },
  { hint: "opportunities", name: "Bing 资讯 · 奖学金", url: bingNewsUrl("奖学金 申请 学生"), direct: false },
  { hint: "opportunities", name: "Bing 资讯 · 招生", url: bingNewsUrl("研究生 招生简章 报名"), direct: false },
  { hint: "opportunities", name: "Bing 资讯 · 竞赛", url: bingNewsUrl("学科竞赛 报名 学生"), direct: false },
  { hint: "opportunities", name: "Bing News · Scholarships", url: bingNewsUrl("scholarship application students university"), direct: false },
];

const learningEnrichSchema = z.object({
  items: z.array(
    z.object({
      id: z.number(),
      keep: z.boolean().catch(true),
      category: z.enum(["courses", "resources", "opportunities"]).catch("resources"),
      summaryZh: z.string().catch(""),
      pointsZh: z.array(z.string()).catch([]),
      audienceStage: z.string().nullable().catch(null),
      deadline: z.string().nullable().catch(null),
      fee: z.string().nullable().catch(null),
      needsApplication: z.boolean().catch(false),
    }),
  ),
});

/** Persisted per-item enrichment, keyed by the item's direct publisher URL. */
interface EnrichEntry {
  category: LearningCategory;
  summaryZh: string | null;
  points: string[];
  audienceStage: string | null;
  deadline: string | null;
  fee: string | null;
  needsApplication: boolean;
}

type LearningCandidate = FeedItem & {
  hint: LearningCategory;
  chineseUrl: string | null;
  feed: string;
  directFeed: boolean;
  isSearch: boolean;
  officialHint: string | null;
};

async function loadLearning(ctx: Ctx, force: boolean): Promise<{ items: LearningItem[]; asOf: string }> {
  if (!force) {
    const cached = await readCache<LearningItem[]>(ctx, "learning:all", LEARNING_TTL_MS);
    // Guard against payloads written by older builds: missing link fields, or
    // any item still carrying a relay link (Google News / Bing apiclick) as
    // its stored URL — those payloads must be rebuilt, never served.
    if (
      cached &&
      cached.data.every(
        (it) =>
          it.readUrl !== undefined &&
          it.blockedReason !== undefined &&
          !isGnRelay(it.url) &&
          !isBingClick(it.url) &&
          !isGnRelay(it.readUrl ?? "") &&
          !isMsnUrl(it.url),
      )
    ) {
      return { items: cached.data, asOf: cached.asOf };
    }
  }

  // 1) Fetch all sources in parallel; a failing source just contributes nothing.
  const raw: Array<FeedItem & { hint: LearningCategory; chineseUrl: string | null; feed: string; directFeed: boolean; isSearch: boolean }> = [];
  await Promise.all(
    LEARNING_FEEDS.map(async (f) => {
      try {
        // Bing News serves an HTML page (not RSS) to mobile user agents —
        // learning feeds are fetched with a desktop UA.
        const xml = await fetchText(f.url, {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        });
        for (const it of parseFeed(xml, f.name, 25)) {
          // Search feeds are recency-limited server-side; enforce it here too
          // so a stale search result never enters the column.
          if (!f.direct && it.publishedAt) {
            const ageMs = Date.now() - new Date(it.publishedAt).getTime();
            if (ageMs > 45 * 24 * 3600 * 1000) continue;
          }
          raw.push({ ...it, hint: f.hint, chineseUrl: null, feed: f.name, directFeed: f.direct, isSearch: !f.direct });
        }
      } catch {
        // source unavailable this round
      }
    }),
  );

  // 1b) UN News EN/ZH story-id pairing (same as before): attach the official
  //     Chinese-edition link to the foreign item and drop the ZH twin.
  const storyId = (u: string) => u.match(/\/story\/\d{4}\/\d{2}\/(\d+)/)?.[1] ?? null;
  const zhByStory = new Map<string, string>();
  for (const it of raw) {
    const id = storyId(it.url);
    if (id && it.url.includes("/zh/story/")) zhByStory.set(id, it.url);
  }
  const consumedZh = new Set<string>();
  for (const it of raw) {
    const id = storyId(it.url);
    if (id && it.url.includes("/en/story/")) {
      const zh = zhByStory.get(id);
      if (zh) {
        it.chineseUrl = zh;
        consumedZh.add(zh);
      }
    }
  }
  const paired = raw.filter((it) => !consumedZh.has(it.url));

  // 2) Resolve every relay link to the publisher's direct address BEFORE
  //    anything is stored. An item whose link cannot be resolved to a direct
  //    publisher address is dropped — a relay URL is never stored as an
  //    item link, readUrl or officialUrl.
  const resolvedPairs = await Promise.all(
    paired.map(async (it) => {
      if (isGnRelay(it.url)) {
        const direct = await resolveGnUrl(it.url);
        if (!direct || isGnRelay(direct) || isBingClick(direct)) return null;
        return { ...it, url: direct };
      }
      // MSN reposts resolve to the publisher's own article via the page's
      // canonical link; an unresolvable repost is dropped, never stored.
      if (isMsnUrl(it.url)) {
        const direct = await resolveMsnUrl(it.url);
        if (!direct) return null;
        return { ...it, url: direct, source: cleanAggregatorSource(it.source) };
      }
      const direct = decodeBingClick(it.url);
      if (isGnRelay(direct) || isBingClick(direct)) return null;
      return { ...it, url: direct };
    }),
  );
  const directItems = resolvedPairs.filter((it): it is NonNullable<typeof it> => it !== null);

  // 3) Dedupe by direct URL, then select fairly: newest few per feed first,
  //    then round-robin across feeds so high-volume search results cannot
  //    crowd out the direct institutional feeds.
  const seen = new Set<string>();
  const deduped = directItems.filter((it) => {
    if (seen.has(it.url)) return false;
    seen.add(it.url);
    return true;
  });
  const byFeed = new Map<string, typeof deduped>();
  for (const it of deduped) {
    const arr = byFeed.get(it.feed) ?? [];
    arr.push(it);
    byFeed.set(it.feed, arr);
  }
  const feedLists = [...byFeed.values()].map((arr) =>
    arr
      .sort((a, b) => {
        const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
        const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
        return tb - ta;
      })
      .slice(0, 4),
  );
  feedLists.sort((a, b) => {
    const ta = a[0]?.publishedAt ? new Date(a[0].publishedAt).getTime() : 0;
    const tb = b[0]?.publishedAt ? new Date(b[0].publishedAt).getTime() : 0;
    return tb - ta;
  });
  const candidates: LearningCandidate[] = [];
  for (let round = 0; candidates.length < 24; round++) {
    let progressed = false;
    for (const list of feedLists) {
      const it = list[round];
      if (it) {
        candidates.push({ ...it, officialHint: null });
        progressed = true;
        if (candidates.length >= 24) break;
      }
    }
    if (!progressed) break;
  }

  if (candidates.length === 0) {
    await noteRefreshFailure(ctx);
    const stale = await readCacheStale<LearningItem[]>(ctx, "learning:all");
    if (stale) return { items: stale.data, asOf: stale.asOf };
    return { items: [], asOf: new Date().toISOString() };
  }

  // 4) For items with no real summary, and for opportunity items, fetch the
  //    publisher page once: its meta description is a genuine summary (so the
  //    item is no longer title-only), and its outbound links can yield the
  //    organizer's official detail page.
  await Promise.all(
    candidates.map(async (it) => {
      const needsSummary = !(it.summary && it.summary.trim().length > 0);
      if (!needsSummary && it.hint !== "opportunities") return;
      const meta = await fetchArticleMeta(it.url);
      if (needsSummary && meta.summary && meta.summary !== it.title) {
        it.summary = meta.summary;
      } else if (it.hint === "opportunities" && meta.summary && it.summary && !it.summary.includes(meta.summary.slice(0, 30))) {
        // Opportunity RSS descriptions often open with background text while
        // the page's own description carries the dates/fees — give the model
        // both so deadline and fee extraction has the real text to work from.
        it.summary = `${it.summary} ${meta.summary}`.slice(0, 350);
      }
      if (meta.officialUrl && meta.officialUrl !== it.url) it.officialHint = meta.officialUrl;
    }),
  );

  // 5) Enrichment, persisted per item URL in `learning:enrich:v2`. Items
  //    already enriched in a previous run reuse their stored entry and are
  //    never re-sent to the model, so a refresh only pays for genuinely new
  //    items and a successful enrichment can never be lost by a later
  //    partially-failed run.
  const enrichStore = (await readCacheStale<Record<string, EnrichEntry>>(ctx, "learning:enrich:v2"))?.data ?? {};
  const fresh = candidates.filter((it) => !enrichStore[it.url]);
  const freshIndex = new Map<string, number>();
  fresh.forEach((it, i) => freshIndex.set(it.url, i));

  const enrichPrompt = (batch: LearningCandidate[], offset: number) => {
    const listing = batch
      .map((it, j) => {
        const has = !!(it.summary && it.summary.trim().length > 0);
        return `[${offset + j}] 类别提示:${it.hint} | 来源:${it.source} | 标题:${it.title} | 摘要:${
          has ? (it.summary as string).slice(0, 180) : "（无摘要，仅有标题）"
        }`;
      })
      .join("\n");
    return (
      `你在为学生整理一个「学习」资讯栏目。下面是抓到的候选条目（带编号）。请逐条判断并整理：\n` +
      `- keep：是否真的对学生学习有用（课程/讲座、学习资源、或可报名的竞赛/暑期学校/奖学金等机会）。教材出版、学习工具、教育资源类资讯，只要对学生或教师的学习有实际参考价值，也 keep=true。纯娱乐、明星八卦、招生广告软文、培训机构广告、与学习无关的新闻，keep=false。\n` +
      `- category：courses（课程与讲座）/ resources（学习资源）/ opportunities（学生机会），以内容为准，可修正类别提示。\n` +
      `- summaryZh：用一句中文说清「适合谁、能学到什么」。只能依据摘要里已有的信息写（摘要是英文的就翻译提炼），不要编造课程内容、机构承诺或数字。条目标注「无摘要，仅有标题」时，summaryZh 必须留空字符串——绝不根据标题猜测正文。\n` +
      `- pointsZh：2-3 条中文要点，逐条只能来自摘要原文的信息（英文摘要翻译成中文）；无摘要的条目留空数组。\n` +
      `- audienceStage：适用学段（如 小学/初中/高中/本科/硕士研究生/博士研究生/不限）。标题或摘要明确提到、或标题本身明确限定（如“博士研究生招生简章”“中学生暑期课程”）时就填——即使该条无摘要，也可以依据标题中明确写出的学段填；都没有才填 null。\n` +
      `- deadline：报名截止日期，只有标题或摘要明确写出具体日期时才填，格式 YYYY-MM-DD；只写“即将截止”“倒计时”而没有具体日期的，填 null。\n` +
      `- fee：费用，只有标题或摘要明确写出时才填（如“免费”“学费 2 万元”“报名费 180 元”），没写就填 null（页面会显示「未公布」，不要猜）。\n` +
      `- needsApplication：这条是否需要报名/申请才能参加。\n\n${listing}`
    );
  };

  type EnrichResult = z.infer<typeof learningEnrichSchema>["items"][number];
  const byId = new Map<number, EnrichResult>();
  let enrichErrorRecorded = false;
  const recordEnrichError = async (e: unknown, batchStart: number) => {
    if (enrichErrorRecorded) return;
    enrichErrorRecorded = true;
    try {
      const db = ctx.db;
      const rows = await db.select().from(schema.cacheSnapshots).where(eq(schema.cacheSnapshots.key, "meta:status")).limit(1);
      const prev = rows[0] ? (JSON.parse(rows[0].payload) as Record<string, unknown>) : {};
      await writeCache(ctx, "meta:status", {
        ...prev,
        enrichError: (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 500),
        enrichErrorAt: new Date().toISOString(),
        enrichBatch: batchStart,
      });
    } catch {
      // ignore bookkeeping failures
    }
  };
  // Small batches: a 10-item call measurably exceeded the inference timeout
  // (a 6-item call takes ~75s), which is why enrichment results kept being
  // lost. 5 items per batch, and a failed batch retries once as two halves.
  const enrichBatch = async (batch: LearningCandidate[], offset: number): Promise<void> => {
    try {
      const result = await completeInference(ctx, enrichPrompt(batch, offset), {
        schema: learningEnrichSchema,
        timeout_secs: 110,
      });
      result.items.forEach((r, j) => {
        const gid = r.id >= offset && r.id < offset + batch.length ? r.id : offset + j;
        if (gid < offset + batch.length && !byId.has(gid)) byId.set(gid, r);
      });
    } catch (e) {
      await recordEnrichError(e, offset);
      if (batch.length > 2) {
        const mid = Math.ceil(batch.length / 2);
        await Promise.all([
          enrichBatch(batch.slice(0, mid), offset),
          enrichBatch(batch.slice(mid), offset + mid),
        ]);
      }
    }
  };
  const batches: LearningCandidate[][] = [];
  for (let s = 0; s < fresh.length; s += 5) batches.push(fresh.slice(s, s + 5));
  await Promise.all(batches.map((batch, bi) => enrichBatch(batch, bi * 5)));

  // Fold this run's successful results into the persistent enrichment store.
  let newEnriched = 0;
  for (const [url, idx] of freshIndex) {
    const r = byId.get(idx);
    if (!r || !r.keep) continue;
    let deadline: string | null = null;
    if (r.deadline) {
      const d = new Date(`${r.deadline}T00:00:00`);
      if (!Number.isNaN(d.getTime())) deadline = r.deadline;
    }
    enrichStore[url] = {
      category: r.category,
      summaryZh: r.summaryZh.trim() || null,
      points: r.pointsZh.map((p) => p.trim()).filter(Boolean).slice(0, 3),
      audienceStage: r.audienceStage?.trim() ? r.audienceStage.trim() : null,
      deadline,
      fee: r.fee?.trim() ? r.fee.trim() : null,
      needsApplication: r.needsApplication,
    };
    newEnriched++;
  }
  const droppedUrls = new Set<string>();
  for (const [url, idx] of freshIndex) {
    const r = byId.get(idx);
    if (r && !r.keep) droppedUrls.add(url);
  }

  // 6) Build the final items. Every item's url AND readUrl are the direct
  //    publisher address resolved in step 2 — never a relay link.
  const items: LearningItem[] = [];
  for (const it of candidates) {
    if (droppedUrls.has(it.url)) continue;
    const entry = enrichStore[it.url];
    const hasSummary = !!(it.summary && it.summary.trim().length > 0);
    const fallbackSummaryZh = hasSummary ? (it.summary as string).slice(0, 90) : null;
    const host = hostOf(it.url);
    let officialUrl: string | null = it.officialHint;
    if (!officialUrl && isInstitutionalHost(host)) officialUrl = it.url;
    if (!officialUrl && it.directFeed) officialUrl = it.url;
    items.push({
      title: it.title,
      url: it.url,
      source: it.source,
      publishedAt: it.publishedAt,
      // Enrichment applies whenever the item has genuine summary text; the
      // stage/deadline/fee fields apply even for title-only items when the
      // title itself states them. Title-only items keep summaryZh/points
      // empty — never guessed from the title.
      summaryZh: hasSummary ? entry?.summaryZh ?? fallbackSummaryZh : null,
      points: hasSummary ? (entry && entry.points.length > 0 ? entry.points : [it.summary as string]) : [],
      titleOnly: !hasSummary,
      chineseUrl: it.chineseUrl,
      fee: entry?.fee ?? null,
      readUrl: it.url,
      officialUrl,
      needsLogin: loginRequired(it.source, it.url),
      blockedReason: cnBlockedReason(it.url),
      category: entry?.category ?? it.hint,
      audienceStage: entry?.audienceStage ?? null,
      deadline: entry?.deadline ?? null,
      needsApplication: entry?.needsApplication ?? it.hint === "opportunities",
    });
  }

  items.sort((a, b) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  });

  // 7) Persistence guard: if this run produced NO enriched item at all while
  //    a previous version has enriched items, keep serving the previous
  //    version instead of overwriting it with a degraded one.
  const anyEnriched = items.some((it) => it.summaryZh !== null);
  if (!anyEnriched && items.length > 0) {
    const stale = await readCacheStale<LearningItem[]>(ctx, "learning:all");
    if (stale && stale.data.some((it) => it.summaryZh !== null)) {
      return { items: stale.data, asOf: stale.asOf };
    }
  }

  // Persist the enrichment store (bounded: current candidates first, then
  // recent entries from previous runs) and the column itself.
  const boundedStore: Record<string, EnrichEntry> = {};
  for (const it of candidates) {
    const e = enrichStore[it.url];
    if (e) boundedStore[it.url] = e;
  }
  for (const [url, e] of Object.entries(enrichStore)) {
    if (Object.keys(boundedStore).length >= 200) break;
    if (!(url in boundedStore)) boundedStore[url] = e;
  }
  await writeCache(ctx, "learning:enrich:v2", boundedStore);
  void newEnriched;
  const asOf = await writeCache(ctx, "learning:all", items);
  return { items, asOf };
}

/**
 * User-verified correction (2026-11-21) for the WFYI story "New Indiana
 * college scholarship offers students up to $5,000 to finish degrees":
 * wfyi.org is CloudFront-blocked from China (the blockedReason comes from
 * the registry), and the enrichment pass had presented the INvestEd Success
 * Scholarship as if it were open to the user. Verified facts: official page
 * https://www.investedindiana.org/success-scholarship/ — up to $5,000,
 * applications 2026-11-19 → 2027-02-05, 600 awards / $3M per year, and
 * eligibility is limited to Indiana residents who are U.S. citizens in
 * their junior or senior year at an Indiana four-year university — NOT
 * applicable to a Jiangxi 专科 student. Applied on every getLearning
 * response (idempotent), so cached payloads are corrected too.
 */
const WFYI_SCHOLARSHIP_URL =
  "https://www.wfyi.org/education/2026-11-20/new-indiana-college-scholarship-offers-students-up-to-5-000-to-finish-degrees";

function correctLearningItem(it: LearningItem): LearningItem {
  const blockedReason = it.blockedReason ?? cnBlockedReason(it.readUrl ?? it.url);
  if (it.url !== WFYI_SCHOLARSHIP_URL && it.readUrl !== WFYI_SCHOLARSHIP_URL) {
    return blockedReason === it.blockedReason ? it : { ...it, blockedReason };
  }
  return {
    ...it,
    blockedReason: blockedReason ?? "Amazon CloudFront 配置为屏蔽中国访问",
    officialUrl: "https://www.investedindiana.org/success-scholarship/",
    summaryZh:
      "仅限印第安纳州居民且为美国公民、在印第安纳州四年制大学读大三或大四的学生申请的 INvestEd Success Scholarship，最高 5000 美元——不适用于中国江西的专科生。",
    points: [
      "最高 5000 美元，帮助符合条件的学生完成学位。",
      "申请期：2026 年 11 月 19 日至 2027 年 2 月 5 日；每年 600 个名额，项目每年投入 300 万美元。",
      "仅限印第安纳州居民且美国公民、在印第安纳州四年制大学读大三或大四，不适用于中国江西的专科生。",
    ],
    titleOnly: false,
    audienceStage: "本科大三、大四（仅限印第安纳州居民）",
    deadline: "2027-02-05",
    needsApplication: true,
  };
}

// ---------------------------------------------------------------------------
// Personal homepage （个人资讯页）: 江西专升本 / 海外机会 / 我关注的世界
// User profile (stated 2026-11-20): 江西大二专科生， 信息安全技术应用专业，
// 预计 2028 年毕业. All three columns are tuned to that profile.
// ---------------------------------------------------------------------------

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function bingNewsUrlAll(query: string): string {
  return `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`;
}

async function fetchBingItems(query: string, fallbackSource: string, limit: number): Promise<FeedItem[]> {
  const xml = await fetchText(bingNewsUrlAll(query), { "User-Agent": DESKTOP_UA });
  return parseFeed(xml, fallbackSource, limit);
}

/** Official-source priority: exam authority / education dept / .edu.cn & .gov.cn hosts rank first. */
function officialBoost(it: FeedItem): number {
  const hay = `${it.source} ${it.url}`.toLowerCase();
  if (hay.includes("jxeea") || hay.includes("教育考试院")) return 3;
  if (hay.includes("jyt.jiangxi") || hay.includes("教育厅")) return 3;
  if (/\.edu\.cn|\.gov\.cn|\.gov\b|\.edu\b/.test(hay)) return 2;
  if (hay.includes("eol.cn") || hay.includes("中国教育在线")) return 1;
  return 0;
}

/**
 * An item counts as 官方来源 only when its own URL is on an official host:
 * 江西省教育考试院官网的唯一域名是 www.jxeea.cn （专升本报名入口在该站
 * 「专升本考试」栏目）, plus 省教育厅 (.gov.cn) and 招生院校 (.edu.cn).
 * A media repost that merely quotes or retells an official notice is NOT an
 * official source — it is labelled 转载 in the UI instead.
 */
function isJiangxiOfficialUrl(url: string): boolean {
  const host = hostOf(url);
  return host.endsWith("jxeea.cn") || host.endsWith(".edu.cn") || host.endsWith(".gov.cn");
}

function yearOf(text: string): string | null {
  const m = text.match(/(20\d{2})\s*年/);
  return m?.[1] ? `${m[1]}年` : null;
}

function isTodayShanghai(iso: string | null): boolean {
  if (!iso) return false;
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" });
  return fmt.format(new Date(iso)) === fmt.format(new Date());
}

// --- 江西专升本 -------------------------------------------------------------

type JiangxiTag = "报名" | "考试科目" | "专业对照" | "招生简章" | "其他";

interface JiangxiItem {
  title: string;
  url: string;
  source: string;
  publishedAt: string | null;
  summaryZh: string | null;
  points: string[];
  titleOnly: boolean;
  readUrl: string | null;
  needsLogin: boolean;
  tag: JiangxiTag;
  /** e.g. "2026年"; null when the source does not state a year. */
  applicableYear: string | null;
  /** One Chinese sentence: how this relates to a 信息安全技术应用专科生. */
  relevance: string;
  /** One Chinese sentence: what the user should do with this item now. */
  actionNeeded: string;
  /** Past-year material (before the user's 2028 exam year) — 备考参考 only. */
  isReference: boolean;
  /** True only when the item's own URL is on jxeea.cn / .gov.cn / .edu.cn. */
  official: boolean;
  /** True when the item is a media repost rather than an official page — never presented as 官方来源. */
  repost: boolean;
}

const JIANGXI_TTL_MS = 60 * 60 * 1000;
const JIANGXI_QUERIES = [
  "江西专升本 招生 考试院",
  "江西省教育考试院 专升本",
  "江西 专升本 考试科目 专业对照",
  "江西 专升本 报名 招生简章",
];

const jiangxiEnrichSchema = z.object({
  items: z.array(
    z.object({
      id: z.number(),
      keep: z.boolean().catch(true),
      tag: z.enum(["报名", "考试科目", "专业对照", "招生简章", "其他"]).catch("其他"),
      summaryZh: z.string().catch(""),
      pointsZh: z.array(z.string()).catch([]),
      relevance: z.string().catch(""),
      actionNeeded: z.string().catch(""),
    }),
  ),
});

interface JiangxiEnrichEntry {
  tag: JiangxiTag;
  summaryZh: string | null;
  points: string[];
  relevance: string;
  actionNeeded: string;
}

function jiangxiFallback(it: FeedItem): JiangxiEnrichEntry {
  const hay = `${it.title} ${it.summary ?? ""}`;
  const tag: JiangxiTag = /专业对照|对应专业|报考专业/.test(hay)
    ? "专业对照"
    : /考试科目|考试大纲|考试时间/.test(hay)
      ? "考试科目"
      : /招生简章|招生章程|招生计划/.test(hay)
        ? "招生简章"
        : /报名|报考|志愿/.test(hay)
          ? "报名"
          : "其他";
  const yr = yearOf(it.title);
  return {
    tag,
    summaryZh: it.summary ? it.summary.slice(0, 90) : null,
    points: it.summary ? [it.summary] : [],
    relevance:
      "面向江西省普通高校专升本考生，与你 2028 年参加专升本的方向相关；信息安全技术应用专业具体能报哪个本科专业，要以当年公布的专业对照表为准。",
    actionNeeded: yr
      ? `这是 ${yr} 的材料，先当备考参考：看清考试科目和报考要求，2028 年的正式通知出来后再按新通知办。`
      : "先打开原文核对内容，2028 年的正式通知出来后再按新通知办。",
  };
}

async function loadJiangxi(ctx: Ctx, force: boolean): Promise<{ items: JiangxiItem[]; asOf: string }> {
  if (!force) {
    const cached = await readCache<JiangxiItem[]>(ctx, "jiangxi:all:v2", JIANGXI_TTL_MS);
    if (cached) return { items: cached.data, asOf: cached.asOf };
  }
  const raw: FeedItem[] = [];
  await Promise.all(
    JIANGXI_QUERIES.map(async (q) => {
      try {
        raw.push(...(await fetchBingItems(q, "Bing 资讯", 15)));
      } catch {
        // one query failing contributes nothing
      }
    }),
  );
  const seen = new Set<string>();
  const deduped = raw
    .filter((it) => {
      const direct = decodeBingClick(it.url);
      it.url = direct;
      if (isGnRelay(direct) || isBingClick(direct) || seen.has(direct)) return false;
      seen.add(direct);
      // Only 江西普通高校专升本 — drop 成人高考/自考/专套本 noise by title.
      if (!/专升本/.test(it.title)) return false;
      if (/成人高考|自学考试|自考/.test(it.title) && !/普通高校专升本|普通专升本/.test(it.title)) return false;
      return true;
    })
    .sort((a, b) => {
      const boost = officialBoost(b) - officialBoost(a);
      if (boost !== 0) return boost;
      const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return tb - ta;
    })
    .slice(0, 18);

  if (deduped.length === 0) {
    await noteRefreshFailure(ctx);
    const stale = await readCacheStale<JiangxiItem[]>(ctx, "jiangxi:all:v2");
    if (stale) return { items: stale.data, asOf: stale.asOf };
    return { items: [], asOf: new Date().toISOString() };
  }

  const store = (await readCacheStale<Record<string, JiangxiEnrichEntry>>(ctx, "jiangxi:enrich:v1"))?.data ?? {};
  const fresh = deduped.filter((it) => !store[it.url]);
  const enrichBatch = async (batch: FeedItem[], offset: number): Promise<void> => {
    const listing = batch
      .map((it, j) => {
        const has = !!(it.summary && it.summary.trim());
        return `[${offset + j}] 来源:${it.source} | 标题:${it.title} | 摘要:${has ? (it.summary as string).slice(0, 180) : "（无摘要，仅有标题）"}`;
      })
      .join("\n");
    try {
      const result = await completeInference(ctx, 
        `你在为一位江西大二专科生（专业：信息安全技术应用，预计 2028 年毕业、2028 年参加普通高校专升本）整理「江西专升本」栏目。逐条判断：\n` +
          `- keep：是否确为江西省普通高校专升本的通知/政策/招生信息。成人高考、自考、培训机构广告、机构测评软文 keep=false。\n` +
          `- tag：报名 / 考试科目 / 专业对照 / 招生简章 / 其他，按内容选最贴切的一个。\n` +
          `- summaryZh：一句中文概括这条讲了什么，只能依据摘要已有信息；无摘要时留空字符串，绝不根据标题猜正文。\n` +
          `- pointsZh：2-3 条中文要点，全部来自摘要原文；无摘要留空数组。\n` +
          `- relevance：一句中文说明与这位学生的关系。摘要或标题明确涉及信息安全/计算机类专业时说明直接关系；只是全省通用通知时，说明这是全体考生都要看的通用事项；不要编造专业对照结论。\n` +
          `- actionNeeded：一句中文说明他现在需要做什么。往年（2028 年之前）的材料，写明这是备考参考、现在只需了解科目与要求；不要编造报名日期或截止时间。\n\n${listing}`,
        { schema: jiangxiEnrichSchema, timeout_secs: 110 },
      );
      const dropped = new Set<string>();
      result.items.forEach((r, j) => {
        const idx = r.id >= offset && r.id < offset + batch.length ? r.id : offset + j;
        const it = deduped.find((d) => d.url === fresh[idx]?.url);
        if (!it) return;
        if (!r.keep) {
          dropped.add(it.url);
          return;
        }
        const has = !!(it.summary && it.summary.trim());
        store[it.url] = {
          tag: r.tag as JiangxiTag,
          summaryZh: has ? r.summaryZh.trim() || null : null,
          points: has ? r.pointsZh.map((p) => p.trim()).filter(Boolean).slice(0, 3) : [],
          relevance: r.relevance.trim(),
          actionNeeded: r.actionNeeded.trim(),
        };
      });
      for (const url of dropped) delete store[url];
      // Mark dropped items so they are excluded below: keep a tombstone list.
      const tomb = (await readCacheStale<string[]>(ctx, "jiangxi:dropped:v1"))?.data ?? [];
      await writeCache(ctx, "jiangxi:dropped:v1", [...new Set([...tomb, ...dropped])]);
    } catch {
      // fallback entries are built below for anything still missing
    }
  };
  const batches: FeedItem[][] = [];
  for (let s = 0; s < fresh.length; s += 5) batches.push(fresh.slice(s, s + 5));
  await Promise.all(batches.map((b, bi) => enrichBatch(b, bi * 5)));
  const droppedUrls = new Set((await readCacheStale<string[]>(ctx, "jiangxi:dropped:v1"))?.data ?? []);

  const items: JiangxiItem[] = [];
  for (const it of deduped) {
    if (droppedUrls.has(it.url)) continue;
    const entry = store[it.url] ?? jiangxiFallback(it);
    const has = !!(it.summary && it.summary.trim());
    const applicableYear = yearOf(it.title) ?? yearOf(it.summary ?? "");
    const yearNum = applicableYear ? Number(applicableYear.slice(0, 4)) : null;
    items.push({
      title: it.title,
      url: it.url,
      source: it.source,
      publishedAt: it.publishedAt,
      summaryZh: has ? entry.summaryZh ?? it.summary?.slice(0, 90) ?? null : null,
      points: has ? (entry.points.length > 0 ? entry.points : [it.summary as string]) : [],
      titleOnly: !has,
      readUrl: it.url,
      needsLogin: loginRequired(it.source, it.url),
      tag: entry.tag,
      applicableYear,
      relevance: entry.relevance || jiangxiFallback(it).relevance,
      actionNeeded: entry.actionNeeded || jiangxiFallback(it).actionNeeded,
      isReference: yearNum !== null ? yearNum < 2028 : true,
      official: isJiangxiOfficialUrl(it.url),
      repost: !isJiangxiOfficialUrl(it.url),
    });
  }
  items.sort((a, b) => {
    if (a.isReference !== b.isReference) return a.isReference ? 1 : -1;
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  });

  const bounded: Record<string, JiangxiEnrichEntry> = {};
  for (const [url, e] of Object.entries(store)) {
    if (Object.keys(bounded).length >= 200) break;
    bounded[url] = e;
  }
  await writeCache(ctx, "jiangxi:enrich:v1", bounded);
  const asOf = await writeCache(ctx, "jiangxi:all:v2", items);
  return { items, asOf };
}

// --- 海外机会与政策变化 -------------------------------------------------------

type OverseasEligibility = "diploma_eligible" | "unclear" | "bachelor_only";

interface OverseasItem {
  title: string;
  url: string;
  source: string;
  publishedAt: string | null;
  country: string;
  /** 变了什么 (Chinese, from the source's own summary only). */
  whatChanged: string | null;
  /** 适用于谁 (Chinese). */
  whoApplies: string | null;
  /** 何时生效； null = source does not state it （未公布）. */
  effectiveWhen: string | null;
  eligibility: OverseasEligibility;
  isImmigration: boolean;
  /** For immigration items: the status it applies to (e.g. 学生签证持有者）. */
  identityLabel: string | null;
  points: string[];
  titleOnly: boolean;
  readUrl: string | null;
  needsLogin: boolean;
  /** Why the original cannot be opened from mainland China (user-confirmed registry); null when it opens normally. */
  blockedReason: string | null;
  official: boolean;
  /** True for student-visa / post-study-work-visa changes (requirements, fees, stay length, opening or tightening). */
  visa: boolean;
  /** True when the item lives in the fixed visa zone: it does not rotate out on daily refreshes and is only removed when superseded by a newer item on the same topic or expired. */
  pinned: boolean;
}

const OVERSEAS_TTL_MS = 60 * 60 * 1000;

/**
 * Curated, verified item (2026-11-20): on 2026-11-16 the U.S. District Court
 * for the District of Massachusetts vacated DHS's final rule eliminating
 * Duration of Status (D/S) for F/J nonimmigrants (Presidents' Alliance v.
 * DHS, No. 1:26-cv-13799-FDS). Search results repeatedly surfaced this one
 * event as ~6 separate media items, so it is pinned here as a single entry
 * sourced from a university's own office (Yale OISS, updated 2026-11-17,
 * page links the court order PDF) instead of aggregator/media reposts.
 */
const DS_RULING_ITEM: OverseasItem = {
  title: "Elimination of Duration of Status: Summary & FAQs（耶鲁大学 OISS）",
  url: "https://oiss.yale.edu/immigration/elimination-of-duration-of-status-summary-faqs",
  source: "耶鲁大学 OISS",
  publishedAt: "2026-11-17T00:00:00.000Z",
  country: "美国",
  whatChanged:
    "法院整体推翻固定停留期规则，D/S（停留期限）保留：2026-11-16 美国马萨诸塞联邦地区法院在 Presidents' Alliance v. DHS（No. 1:26-cv-13799-FDS）一案中，整体推翻国土安全部取消留学生「停留期限」（D/S）的最终规则；该规则原定 2026-09-15 生效，但已于 9 月 14 日被法院禁令拦下，从未生效。",
  whoApplies: "未来持 F-1/J-1 赴美留学的中国学生（含专科背景申请人）",
  effectiveWhen: "2026-11-16 裁决即恢复 D/S；国土安全部可能上诉，但上诉本身不恢复该规则",
  eligibility: "diploma_eligible",
  isImmigration: false,
  identityLabel: null,
  points: [
    "D/S 继续有效，F-1/J-1 学生按录取与学业期限合法停留，无需采取任何行动。",
    "被推翻的固定停留期规则原定 2026-09-15 生效，9 月 14 日已被禁令拦下，从未生效。",
    "耶鲁 OISS 该页面（2026-11-17 更新）附有法院命令 PDF 链接；国土安全部可能上诉，但上诉本身不恢复该规则。",
  ],
  titleOnly: false,
  readUrl: "https://oiss.yale.edu/immigration/elimination-of-duration-of-status-summary-faqs",
  needsLogin: false,
  blockedReason: null,
  official: true,
  visa: true,
  pinned: true,
};

/**
 * Curated, verified item (2026-11-21, restored at the user's request after it
 * rotated out of the daily list): New Zealand extended Post-Study Work Visa
 * eligibility to graduates who completed a Level 7 Graduate Diploma
 * full-time in New Zealand AND hold a bachelor's degree (New Zealand or
 * overseas, no time limit). Eligibility is bachelor_only: the brief states
 * it is limited to bachelor's degree holders.
 * Effective-date correction (2026-11-21, user-verified): the start date is
 * 2026-11-23, NOT 2026-11-16 — Immigration New Zealand delayed it one week
 * because of a Microsoft outage, and Amendment Circular 2026-36 confirms
 * both the new Short-term Graduate Work Visa and the PSWV expansion start
 * 2026-11-23.
 * Official-source swap (2026-11-21): the item originally linked the Legit.ng
 * retelling the user supplied; it now links Immigration New Zealand's own
 * announcement page (read and verified at edit time: Level 7 graduate
 * diploma completed full-time in NZ + a bachelor's degree from NZ or
 * overseas with no time limit, visa up to 1 year). The INZ page's own title
 * still says "from 16 November 2026" — the page was not retitled after the
 * delay — while the item's effective date stays 2026-11-23 per Amendment
 * Circular 2026-36 as the brief directs.
 */
const NZ_PSWV_ITEM: OverseasItem = {
  title: "Post-Study Work Visa eligibility extended（新西兰移民局官方）",
  url: "https://www.immigration.govt.nz/about-us/news-centre/post-study-work-visa-eligibility-extended-from-16-november-2026/",
  source: "新西兰移民局（Immigration New Zealand）",
  publishedAt: null,
  country: "新西兰",
  whatChanged:
    "新西兰自 2026 年 11 月 23 日起扩大毕业后工作签证（Post-Study Work Visa）资格：在新西兰全日制读完整个课程的 7 级研究生文凭（Graduate Diploma）毕业生，如另持学士学位（新西兰或海外获得均可、不限获得时间），也可申请该签证，时长与文凭就读时长相同、最长 1 年；同日起新设 6 个月的短期毕业生工作签证（Short-term Graduate Work Visa，给不符合毕业后工签资格的 5–7 级毕业生），毕业后工签申请改为只能在线提交。生效日原定 11 月 16 日，因新西兰移民局微软故障推迟一周，修正指令 Amendment Circular 2026-36 确认改为 11 月 23 日起——11 月 23 日是推迟一周后的日期。",
  whoApplies: "只限有学士学位者：须同时持有学士学位并在新西兰全日制完成 7 级研究生文凭；没有学士学位的专科毕业生不在此次开放范围内",
  effectiveWhen: "2026 年 11 月 23 日起生效（原定 11 月 16 日，因移民局微软故障推迟一周后的日期，修正指令 Amendment Circular 2026-36 确认）",
  eligibility: "bachelor_only",
  isImmigration: false,
  identityLabel: null,
  points: [
    "生效日已推迟一周：原定 2026 年 11 月 16 日，新西兰移民局因微软故障延期，修正指令 Amendment Circular 2026-36 确认新短期毕业生工作签证与毕业后工签扩大均自 2026 年 11 月 23 日起。",
    "7 级研究生文凭须在新西兰全日制读完整个课程，学分转换或先前学习认定（RPL）读完的部分不算。",
    "学士学位可在新西兰或海外获得、不限获得时间；申请时要提交学士学位证书和正式成绩单。",
    "毕业后工作签证一生只能获批一次；本条链接即新西兰移民局（INZ）官网原文，移民局页面标题仍写 11 月 16 日，但生效日以修正指令 Amendment Circular 2026-36 的 11 月 23 日为准。",
  ],
  titleOnly: false,
  readUrl: "https://www.immigration.govt.nz/about-us/news-centre/post-study-work-visa-eligibility-extended-from-16-november-2026/",
  needsLogin: false,
  blockedReason: null,
  official: true,
  visa: true,
  pinned: true,
};

/**
 * Curated, verified item (2026-11-21): the UK Graduate visa shortens from
 * 2 years to 18 months for applications made on or after 2027-01-01
 * (bachelor's/master's graduates; PhD stays 3 years). Confirmed in the
 * Immigration Rules — Home Office Graduate route caseworker guidance v6.0
 * (published 2026-08-03) — and stated on university pages; the item links
 * the University of Salford's own explainer. The 2026-10-28 Budget proposal
 * to restore 2 years for "high-compliance" universities is a proposal only
 * (criteria unpublished, not in the Rules) and is flagged as such.
 */
const UK_GRADUATE_VISA_ITEM: OverseasItem = {
  title: "Changes to Graduate visas from 1 January 2027（萨福德大学）",
  url: "https://www.salford.ac.uk/askus/immigration-and-visas/changes-to-graduate-visas-from-1-january-2027",
  source: "萨福德大学（University of Salford）",
  publishedAt: null,
  country: "英国",
  whatChanged:
    "英国毕业生签证（Graduate visa）停留期缩短：2027 年 1 月 1 日或之后提交申请的本科与硕士毕业生，由 2 年减为 18 个月；2027 年 1 月 1 日前提交的仍按 2 年；博士毕业生不变，仍为 3 年。变化已写入移民规则。另：2026 年 10 月 28 日预算提出让「高合规」大学的毕业生保留 2 年，但符合条件的大学名单与细则尚未公布、尚未写入规则，目前只是提案。",
  whoApplies: "在英国完成学士或硕士学位、持学生签证的国际毕业生（只限学位毕业生）；博士毕业生不受此次缩短影响",
  effectiveWhen: "2027-01-01 起提交的申请按 18 个月；此前提交的仍为 2 年",
  eligibility: "bachelor_only",
  isImmigration: false,
  identityLabel: null,
  points: [
    "只看申请提交日期：在 2026 年 12 月 31 日或之前提交，仍拿 2 年；2027 年 1 月 1 日起提交，拿 18 个月。",
    "博士及其他博士学位毕业生仍为 3 年，不受影响。",
    "「高合规大学保留 2 年」是 2026-10-28 预算提案，名单未公布，不能据此做决定。",
  ],
  titleOnly: false,
  readUrl: "https://www.salford.ac.uk/askus/immigration-and-visas/changes-to-graduate-visas-from-1-january-2027",
  needsLogin: false,
  blockedReason: null,
  official: true,
  visa: true,
  pinned: true,
};

/**
 * Curated, verified item (2026-11-21): Singapore has no dedicated post-study
 * work visa; graduates stay only via an employer-sponsored Employment Pass
 * (EP) or S Pass, and MOM's qualifying salaries rise for new applications
 * from 2027-01-01 (EP S$5,600→S$6,000; S Pass S$3,300→S$3,600).
 * Official-source swap (2026-11-21): the item originally linked a Singapore
 * institution's (TMC Academy) alumni guide; it now links the Ministry of
 * Manpower's own factsheet PDF ("Factsheet: Foreign Workforce Policy
 * Announcements at COS 2026", URL supplied by the user and read at edit
 * time — it states verbatim EP $5,600→$6,000 and S Pass $3,300→$3,600,
 * applying to new applications from January 2027 and renewals for passes
 * expiring from January 2028). Eligibility stays 'unclear': the source
 * does not single out diploma holders' applicability.
 */
const SG_WORK_PASS_ITEM: OverseasItem = {
  title: "Factsheet on Foreign Workforce Policies（新加坡人力部官方文件）",
  url: "https://www.mom.gov.sg/-/media/mom/documents/press-releases/2026/factsheet-on-foreign-workforce-policies-03032026.pdf-3",
  source: "新加坡人力部（MOM）",
  publishedAt: null,
  country: "新加坡",
  whatChanged:
    "新加坡毕业后工作准证的薪资门槛上调：就业准证（EP）最低月薪自 2027 年 1 月 1 日起由 5,600 新元涨到 6,000 新元（金融服务业 6,200→6,600 新元），S 准证由 3,300 新元涨到 3,600 新元（金融服务业 3,800→4,000 新元），新门槛适用于新申请，续签自 2028 年 1 月 1 日起到期者适用。新加坡没有专门的毕业后工作签证，学生准证到期后必须由雇主申请 EP 或 S 准证才能留新工作；获批院校的毕业生可先申请长期探访准证（LTVP）在新求职。",
  whoApplies: "毕业后想留在新加坡工作的国际毕业生（须有雇主为其申请工作准证）；原文未单独写明专科毕业生是否适用，适用学历不明确",
  effectiveWhen: "2027-01-01 起的新申请按新门槛；续签自 2028-01-01 起到期者适用",
  eligibility: "unclear",
  isImmigration: false,
  identityLabel: null,
  points: [
    "EP 除月薪门槛外还要通过 COMPASS 积分（至少 40 分）；S 准证有行业配额，门槛随年龄上调。",
    "没有雇主担保就不能留新工作：学生准证取消后没有自动宽限期，逾期停留属违法。",
    "本条链接即新加坡人力部（MOM）官方说明文件（PDF）：EP 5,600→6,000 新元、S 准证 3,300→3,600 新元，金融服务业门槛更高（EP 6,200→6,600、S 准证 3,800→4,000 新元）。",
  ],
  titleOnly: false,
  readUrl: "https://www.mom.gov.sg/-/media/mom/documents/press-releases/2026/factsheet-on-foreign-workforce-policies-03032026.pdf-3",
  needsLogin: false,
  blockedReason: null,
  official: true,
  visa: true,
  pinned: true,
};

/**
 * Curated, verified item (2026-11-21): Japan's Immigration Services Agency
 * (出入国在留管理庁） tightened how Japanese-language-school students prove
 * A1-level Japanese. The ISA's own notice (read at edit time,
 * moj.go.jp/isa/10_00258.html) states that the previous proof — a study
 * record of 150+ hours — no longer suffices on its own: a certificate from
 * a recognised test (JLPT N5 or higher, JFT-Basic A1 or higher, among
 * others) or a formal interview confirmation by the school is now
 * mandatory. It applies to Certificate of Eligibility applications for
 * students enrolling from October 2026, and to change-of-status / extension
 * applications filed from 2026-07-01. Scope is Japanese language schools
 * （日本語教育機関， including university 日语别科） only — not universities
 * or vocational schools themselves. The visa issuance fee rise (single
 * entry ≈ ¥15,000 from 2026-07-01) is stated in the user's verified brief.
 * Eligibility stays 'unclear': the notice does not single out diploma
 * holders, and the item is carried for the language-school route only.
 */
const JP_LANGUAGE_SCHOOL_ITEM: OverseasItem = {
  title: "日本語教育機関に入学する者に係る運用の一部見直しについて（出入国在留管理厅）",
  url: "https://www.moj.go.jp/isa/10_00258.html",
  source: "日本出入国在留管理厅",
  publishedAt: null,
  country: "日本",
  whatChanged:
    "日本出入国在留管理厅收紧语言学校留学生的日语能力证明：以往凭 150 小时以上的日语学习记录即可证明 A1 相当日语能力，今后必须提交认可考试的证明书（如 JLPT N5 或以上、JFT-Basic A1 或以上等入管厅认可的考试），或由学校通过正式面试确认 A1 相当能力，150 小时学习记录不再单独够用。要求水平本身没变（日本语教育参照枠 A1 相当，约 JLPT N5），变的是证明方式。另：签证签发费自 2026 年 7 月 1 日起上调，单次入境签证约 15,000 日元。",
  whoApplies: "计划入读日本语言学校（日本语教育机关，含大学日语别科）的留学生；只针对语言学校，不针对大学、专门学校的留学生",
  effectiveWhen: "在留资格认定证明书：2026 年 10 月入学起的新申请适用；续签与在留资格变更：2026 年 7 月 1 日起的申请适用；签证签发费：2026 年 7 月 1 日起单次约 15,000 日元",
  eligibility: "unclear",
  isImmigration: false,
  identityLabel: null,
  points: [
    "证明方式变了：必须交考试证明书或由学校面试确认，150 小时学习记录不能再单独作为 A1 证明；学校还须在确认书上写明用的是「考试」还是「面试」。",
    "认可考试包括 JLPT（N5 或以上）与 JFT-Basic（A1 或以上）等；没有考试证书时，学校须在面试中确认 A1 相当能力并具体记录。",
    "适用范围只限日本语教育机关（含日语别科）；直接入读大学或专门学校不走这条证明要求。",
    "本条链接即出入国在留管理厅官网原文（日语）。",
  ],
  titleOnly: false,
  readUrl: "https://www.moj.go.jp/isa/10_00258.html",
  needsLogin: false,
  blockedReason: null,
  official: true,
  visa: true,
  pinned: true,
};

/**
 * Curated, verified item (2026-11-21): the Korean Ministry of Justice pilot
 * announced 2026-02-06 — 16 vocational colleges opened specialised
 * technical departments for international D-2 students. Source is
 * Korea.net, the Korean government's official portal (read at edit time):
 * TOPIK Level 3+ waives the D-2 financial proof (KRW 20M capital area /
 * KRW 16M elsewhere), part-time work rises from 30 to 35 hours/week, and
 * graduates hired in their major (starting salary ≥ KRW 26M/year, KIIP
 * Level 4 or TOPIK 5) can receive the new K-CORE (E-7-M) work visa. The 16
 * majors are automotive, textiles, electrical, machinery, smart
 * agriculture, renewable energy and similar technical fields — Information
 * Security Technology Application is NOT among them, so this pilot does
 * not apply to the user; the item says so explicitly. The separate October
 * 2026 student-visa reform plan is NOT yet in force and is deliberately
 * not pinned. Pilot runs to the end of 2027 (per the user's verified
 * brief). Eligibility stays 'unclear' so the row never shows a 专科可申请
 * badge that would contradict the not-applicable-to-the-user note.
 */
const KR_TECH_PILOT_ITEM: OverseasItem = {
  title: "New tech depts. at 16 vocational schools to train int'l workers（韩国法务部试点）",
  url: "https://www.korea.net/NewsFocus/Society/view?articleId=287072",
  source: "Korea.net（韩国政府官方门户）",
  publishedAt: "2026-02-06T00:00:00.000Z",
  country: "韩国",
  whatChanged:
    "韩国法务部 2026 年 2 月 6 日公布试点：16 所职业院校开设专门技术人才培养系，入读指定技术专业的 D-2 留学生，TOPIK 3 级以上可免资金证明（免去首都圈 2,000 万韩元、地方 1,600 万韩元的存款证明要求），学期内打工上限由每周 30 小时提高到 35 小时；毕业后与所学专业对口就业（起薪年薪 2,600 万韩元起，并达到 KIIP 4 级或 TOPIK 5 级），可换新设的 E-7-M（K-CORE）工作签证，在该签证下工作满 5 年（或在人口减少地区同一公司满 3 年）可申请 F-2 居留签证。试点到 2027 年底。2026 年 10 月公布的学生签证改革方案尚未生效，不在本条范围内。",
  whoApplies:
    "入读 16 所试点职业院校指定技术专业的 D-2 留学生——16 个专业是汽车、纺织、电气、机械、智能农业、可再生能源等，不含信息安全技术应用，所以这条不适用于我",
  effectiveWhen: "2026 年 2 月 6 日公布，试点到 2027 年底",
  eligibility: "unclear",
  isImmigration: false,
  identityLabel: null,
  points: [
    "免资金证明有条件：仅限入读试点专业且 TOPIK 3 级以上的学生；不在试点专业内，仍须按首都圈 2,000 万韩元 / 地方 1,600 万韩元提供存款证明。",
    "打工上限 30→35 小时/周只适用于试点专业的在读学生，不是所有 D-2 学生的统一新规。",
    "16 个指定专业为汽车、纺织、电气、机械、智能农业、可再生能源等技术专业，不含信息安全技术应用——本条对信息安全技术应用专业的专科生不适用。",
    "本条链接为韩国政府官方门户 Korea.net 对法务部试点的报道；法务部 2026 年 10 月的学生签证改革方案尚未生效，未收录。",
  ],
  titleOnly: false,
  readUrl: "https://www.korea.net/NewsFocus/Society/view?articleId=287072",
  needsLogin: false,
  blockedReason: null,
  official: true,
  visa: true,
  pinned: true,
};

/** The hand-verified visa items that always anchor the fixed visa zone. */
const CURATED_VISA_ITEMS: OverseasItem[] = [
  DS_RULING_ITEM,
  NZ_PSWV_ITEM,
  UK_GRADUATE_VISA_ITEM,
  SG_WORK_PASS_ITEM,
  JP_LANGUAGE_SCHOOL_ITEM,
  KR_TECH_PILOT_ITEM,
];

/**
 * Hosts barred from the fixed visa zone: third-party explainer/blog sites
 * standing in for a government or university original. The Korea student-
 * visa reform item was removed 2026-11-21 because its only link was the
 * Day One Korea commercial blog — no Ministry of Justice / HiKorea original
 * could be found, and the fixed zone's rule is: no official original, no pin.
 * gistreel.com was added 2026-11-21: its "New Zealand Opens Post-Study Work
 * Visa Pathway for Graduates With These 2 Qualifications" piece is a
 * retelling of the INZ change the curated NZ item already carries (and it
 * states the wrong effective date, 2026-11-16 instead of 2026-11-23), yet
 * it still reached the fixed zone — the host is barred outright so no
 * title/summary wording can let it pin again.
 */
const PINNED_VISA_BLOCKED_HOSTS = ["dayonekorea.com", "gistreel.com"];

const PINNED_VISA_KEY = "overseas:visa:pinned:v4";
/** Non-curated pinned visa items expire this long after their publish date. */
const PINNED_VISA_MAX_AGE_MS = 365 * 24 * 3600 * 1000;

/**
 * Merge the fixed visa zone: curated items always win; previously pinned
 * discoveries persist across refreshes; a newer item on the same
 * country+topic supersedes the older one; non-curated items older than a
 * year expire. Returns the zone sorted newest first (undated last).
 */
async function mergePinnedVisaItems(ctx: Ctx, discovered: OverseasItem[]): Promise<OverseasItem[]> {
  const stored = (await readCacheStale<Record<string, OverseasItem>>(ctx, PINNED_VISA_KEY))?.data ?? {};
  const byUrl = new Map<string, OverseasItem>();
  for (const it of Object.values(stored)) {
    if (it && typeof it.url === "string") byUrl.set(it.url, { ...it, visa: true, pinned: true });
  }
  for (const it of discovered) byUrl.set(it.url, { ...it, visa: true, pinned: true });
  for (const it of CURATED_VISA_ITEMS) byUrl.set(it.url, it);
  const curatedUrls = new Set(CURATED_VISA_ITEMS.map((it) => it.url));
  const now = Date.now();
  const fresh = [...byUrl.values()].filter((it) => {
    // Blocked hosts (third-party explainers, no official original) never pin.
    if (PINNED_VISA_BLOCKED_HOSTS.some((h) => it.url.includes(h) || (it.readUrl ?? "").includes(h))) return false;
    if (curatedUrls.has(it.url)) return true;
    // Retellings of events a curated item already covers never stay pinned.
    const text = `${it.title} ${it.whatChanged ?? ""}`;
    if (
      isDsRulingEventText(text) ||
      isNzPswvEventText(text) ||
      isUkGraduateCutEventText(text) ||
      isJpLanguageSchoolEventText(text) ||
      isKrTechPilotEventText(text)
    )
      return false;
    if (!it.publishedAt) return true;
    return now - new Date(it.publishedAt).getTime() < PINNED_VISA_MAX_AGE_MS;
  });
  // Supersede: same country + same normalized topic key → keep the newest.
  const byTopic = new Map<string, OverseasItem>();
  for (const it of fresh) {
    const key = `${it.country}|${titleKey(it.title)}`;
    const prev = byTopic.get(key);
    if (!prev) {
      byTopic.set(key, it);
      continue;
    }
    const tp = prev.publishedAt ? new Date(prev.publishedAt).getTime() : 0;
    const ti = it.publishedAt ? new Date(it.publishedAt).getTime() : 0;
    if (ti >= tp) byTopic.set(key, it);
  }
  const pinned = [...byTopic.values()]
    .sort((a, b) => {
      const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return tb - ta;
    })
    .slice(0, 20);
  const bounded: Record<string, OverseasItem> = {};
  for (const it of pinned) bounded[it.url] = it;
  await writeCache(ctx, PINNED_VISA_KEY, bounded);
  return pinned;
}

/** Text-level matcher for the D/S event (used for search results and for pinned-store items alike). */
function isDsRulingEventText(hay: string): boolean {
  if (/duration of status/i.test(hay)) return true;
  if (/Presidents' Alliance/i.test(hay) || /13799/.test(hay)) return true;
  if (/(停留期限|身份期限|逗留期限)/.test(hay) && /(法院|法官|推翻|禁令|叫停|暂停|国土安全部|DHS)/.test(hay)) return true;
  if (/\bD\/S\b/.test(hay) && /(法院|推翻|vacat|court)/i.test(hay)) return true;
  // English retellings naming neither "duration of status" nor the case:
  // the Tufts Daily piece ("Tufts prepares for student visa rule change as
  // injunction faces uncertainty", tuftsdaily.com, 2026-11) is the same
  // event — the Trump administration's fixed-period rule replacing D/S and
  // the injunction against it — so a student-visa rule change discussed
  // together with an injunction / fixed stay period is this event.
  if (
    /(student visa|international student|foreign student)/i.test(hay) &&
    /(injunction|fixed[- ](?:period|stay|term)|end(?:ing)?\s+(?:of\s+)?duration)/i.test(hay)
  )
    return true;
  // Announcement-side retellings of the same fixed-period rule (no court
  // mention): limiting how long student-visa holders may stay IS the D/S
  // rule the Yale item covers end-to-end.
  if (/(学生签证|留学生|F-1)/.test(hay) && /(居留|停留).{0,3}(时长|期限)/.test(hay) && /(限制|新规|特朗普|国土安全部|DHS)/.test(hay)) return true;
  return false;
}

/** True when a search result is the 2026-11-16 D/S vacatur event (any outlet's retelling of it). */
function isDsRulingEvent(it: FeedItem): boolean {
  const hay = `${it.title} ${it.summary ?? ""}`;
  if (isDsRulingEventText(hay)) return true;
  // The same ruling retold without the technical term ("judge blocks /
  // strikes down the student-visa limit") — outlets' short Bing summaries
  // often omit "duration of status" entirely, so also match the event's
  // shape inside its news window (ruling 2026-11-16, coverage Nov 14–22).
  const t = it.publishedAt ? new Date(it.publishedAt).getTime() : 0;
  const inWindow = t >= Date.UTC(2026, 10, 14) && t <= Date.UTC(2026, 10, 22, 23, 59, 59);
  const courtAction =
    /(judge|court|法官|法院)/i.test(hay) && /(block|strike|struck|vacat|推翻|阻止|拦下|废除)/i.test(hay);
  const studentVisa = /(student visa|international student|foreign student|学生签证|留学生|国际学生)/i.test(hay);
  if (inWindow && courtAction && studentVisa) return true;
  return false;
}

/**
 * True when text retells the New Zealand post-study work change effective
 * 2026-11-23 (delayed one week from 2026-11-16; Amendment Circular 2026-36)
 * (PSWV extended to Level 7 Graduate Diploma holders with a bachelor's
 * degree, plus the new Short-Term Graduate Work Visa). The event is carried
 * once by the curated NZ_PSWV_ITEM, so every outlet's retelling is dropped
 * — the same one-event-one-entry rule as the D/S ruling.
 */
function isNzPswvEventText(text: string): boolean {
  if (!/(new zealand|新西兰)/i.test(text)) return false;
  const pswv = /(post-study|post study|毕业后工作签证|毕业后工签)/i.test(text);
  const gd = /(graduate diploma|研究生文凭|level 7|7\s*级|2 qualifications|two qualifications|两种资格)/i.test(text);
  const shortTermGrad =
    /(short-term graduate|short term graduate|six-month|6-month|六个月|6个月)/i.test(text) && /(graduate|毕业)/i.test(text);
  // Thin-summary retellings that name neither the Graduate Diploma nor
  // Level 7 (e.g. the GistReel piece, whose enrichment only said
  // 「扩大毕业后工作签证的申请资格范围」) still retell this one expansion:
  // NZ + post-study work visa + an eligibility expansion verb.
  const expansion =
    pswv && /(扩大|扩展|extend|expand|opens?\b)/i.test(text) && /(资格|eligib|qualificat)/i.test(text);
  return (pswv && gd) || shortTermGrad || expansion;
}

/**
 * True when text retells the UK Graduate visa shortening to 18 months for
 * applications from 2027-01-01. Carried once by UK_GRADUATE_VISA_ITEM.
 */
function isUkGraduateCutEventText(text: string): boolean {
  const grad = /(graduate (visa|route)|毕业生签证)/i.test(text);
  const cut = /(18 ?months|18 个月|18个月|short|缩短|削减|reduc)/i.test(text);
  if (grad && cut) return true;
  // Roundups of the same UK 2027 package (two or more of Graduate route /
  // High Potential Individual / Skilled Worker mentioned together with
  // 2027) retell the curated item's event among others — also one entry.
  if (!/(UK|英国|United Kingdom)/i.test(text) || !/2027/.test(text)) return false;
  const hits = [/(graduate|毕业生)/i, /(high potential|\bHPI\b|高潜力)/i, /(skilled worker|技术工人)/i].filter((r) =>
    r.test(text),
  ).length;
  return hits >= 2;
}

/**
 * True when text retells the Japan ISA change carried once by
 * JP_LANGUAGE_SCHOOL_ITEM: language-school students must prove A1 Japanese
 * by a recognised test certificate or a school interview; a 150-hour study
 * record no longer suffices on its own.
 */
function isJpLanguageSchoolEventText(text: string): boolean {
  const jp = /(日本|japan|出入国在留管理|入管庁)/i.test(text);
  const langSchool = /(语言学校|日本語教育機関|日本语教育机关|日语学校|language school)/i.test(text);
  const proof = /(A1|150\s*(小时|時間|hours)|JLPT|JFT)/i.test(text);
  return jp && langSchool && proof;
}

/**
 * True when text retells the Korean Ministry of Justice February 2026
 * pilot carried once by KR_TECH_PILOT_ITEM: specialised technical
 * departments at 16 vocational colleges, with the new E-7-M (K-CORE) work
 * visa. The October 2026 reform plan is a different, not-yet-in-force
 * proposal and deliberately does NOT match here.
 */
function isKrTechPilotEventText(text: string): boolean {
  const kr = /(韩国|korea|法务部|ministry of justice)/i.test(text);
  const pilot = /(E-7-M|K-CORE|K-Core|专门技术人才|specialized technical|16\s*所|16 vocational)/i.test(text);
  return kr && pilot;
}

/** The UK student-visa funds item aimed at African applicants — irrelevant to a Chinese 专科 student. */
function isUkAfricaFundsItem(it: FeedItem): boolean {
  const hay = `${it.title} ${it.summary ?? ""}`;
  return /(英国|\bUK\b|United Kingdom)/i.test(hay) && /(非洲|Africa|尼日利亚|Nigeria|加纳|Ghana|肯尼亚|Kenya)/i.test(hay) && /(签证|visa)/i.test(hay);
}

/**
 * Stale opinion/commentary about student-visa policy is not decision-changing
 * news for this column. Covers the two Aug 2026 pieces named by the user —
 * Good Men Project "Opinion: The New Student Visa Policy Doesn't Add Up" and
 * independent.org "New Student-Visa Requirements Earn an 'F' in Economics" —
 * matched by host/source plus title, by title alone, and by the general
 * shape: an opinion-marked student-visa piece older than 45 days.
 */
function isStaleVisaOpinionItem(it: FeedItem): boolean {
  const title = it.title.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
  const host = hostOf(it.url);
  const src = it.source.toLowerCase();
  if (
    (host.includes("goodmenproject") || src.includes("good men project")) &&
    title.includes("student visa policy") &&
    title.includes("add up")
  )
    return true;
  if (title.includes("the new student visa policy doesn") && title.includes("add up")) return true;
  if (
    (host.includes("independent.org") || src.includes("independent")) &&
    title.includes("student-visa requirements") &&
    title.includes("economics")
  )
    return true;
  if (title.includes("student-visa requirements earn an")) return true;
  const opinionMarked = /\b(opinion|commentary|editorial)\b/.test(title) || /观点|评论/.test(it.title);
  const studentVisa = /(student visa|学生签证|留学生签证)/i.test(`${it.title} ${it.summary ?? ""}`);
  if (opinionMarked && studentVisa && it.publishedAt) {
    const ageMs = Date.now() - new Date(it.publishedAt).getTime();
    if (ageMs > 45 * 24 * 3600 * 1000) return true;
  }
  return false;
}
const OVERSEAS_QUERIES = [
  "中国大专 留学 申请 大学",
  "专科生 留学 奖学金 申请",
  "留学生 签证 政策 变化",
  "international students diploma admission university credit transfer",
  "student visa policy change international students",
  "New Zealand student visa international students policy",
  "Ireland UK student visa international students change",
  "Japan Korea Singapore student visa international students",
];

/**
 * Per-country visa sweep for the fixed visa zone: one query per tracked
 * country, aimed only at student-visa and post-study-work-visa changes
 * (requirements, fees, stay length, opening or tightening). Items the
 * enrichment pass classifies as visa changes are pinned into the fixed
 * zone by mergePinnedVisaItems instead of rotating out on the next refresh.
 */
const OVERSEAS_VISA_QUERIES = [
  "美国 F-1 学生签证 政策 变化 OPT",
  "New Zealand student visa post-study work visa changes",
  "Singapore Student's Pass Employment Pass salary threshold international graduates",
  "越南 留学生 签证 政策 变化",
  "日本 留学签证 费用 在留 政策 变化",
  "韩国 留学生 签证 D-2 D-10 政策 变化",
  "Ireland student visa Third Level Graduate Scheme changes",
  "UK Graduate visa student visa changes 2027",
];

const overseasEnrichSchema = z.object({
  items: z.array(
    z.object({
      id: z.number(),
      keep: z.boolean().catch(false),
      country: z.string().catch("其他"),
      whatChanged: z.string().catch(""),
      whoApplies: z.string().catch(""),
      effectiveWhen: z.string().nullable().catch(null),
      eligibility: z.enum(["diploma_eligible", "unclear", "bachelor_only"]).catch("unclear"),
      isImmigration: z.boolean().catch(false),
      identityLabel: z.string().nullable().catch(null),
      pointsZh: z.array(z.string()).catch([]),
      visa: z.boolean().catch(false),
    }),
  ),
});

interface OverseasEnrichEntry {
  country: string;
  whatChanged: string | null;
  whoApplies: string | null;
  effectiveWhen: string | null;
  eligibility: OverseasEligibility;
  isImmigration: boolean;
  identityLabel: string | null;
  points: string[];
  keep: boolean;
  /** Student-visa / post-study-work-visa change → goes to the fixed visa zone. */
  visa: boolean;
}

async function loadOverseas(ctx: Ctx, force: boolean): Promise<{ items: OverseasItem[]; asOf: string }> {
  if (!force) {
    const cached = await readCache<OverseasItem[]>(ctx, "overseas:all:v10", OVERSEAS_TTL_MS);
    if (cached) return { items: cached.data, asOf: cached.asOf };
  }
  const raw: FeedItem[] = [];
  await Promise.all(
    [...OVERSEAS_QUERIES, ...OVERSEAS_VISA_QUERIES].map(async (q) => {
      try {
        raw.push(...(await fetchBingItems(q, "Bing News", 12)));
      } catch {
        // ignore
      }
    }),
  );
  const seen = new Set<string>();
  const cutoff = Date.now() - 150 * 24 * 3600 * 1000;
  const deduped = raw
    .filter((it) => {
      const direct = decodeBingClick(it.url);
      it.url = direct;
      if (isGnRelay(direct) || isBingClick(direct) || seen.has(direct)) return false;
      seen.add(direct);
      if (it.publishedAt && new Date(it.publishedAt).getTime() < cutoff) return false;
      // The 2026-11-16 D/S vacatur is one event: every outlet's retelling is
      // dropped here and the column carries the single curated Yale OISS
      // entry (DS_RULING_ITEM) instead.
      if (isDsRulingEvent(it)) return false;
      // GistReel's NZ post-study piece retells the curated INZ item's event
      // with the wrong effective date (2026-11-16, not 2026-11-23) — the
      // host is barred from the whole column (and from the fixed visa zone
      // via PINNED_VISA_BLOCKED_HOSTS) so it can never come back.
      if (direct.includes("gistreel.com")) return false;
      // Same one-event-one-entry rule for the other curated visa events:
      // the NZ post-study work expansion (NZ_PSWV_ITEM), the UK Graduate
      // visa shortening (UK_GRADUATE_VISA_ITEM), the Japan language-school
      // A1 proof change (JP_LANGUAGE_SCHOOL_ITEM) and the Korean technical
      // pilot (KR_TECH_PILOT_ITEM).
      const hay = `${it.title} ${it.summary ?? ""}`;
      if (
        isNzPswvEventText(hay) ||
        isUkGraduateCutEventText(hay) ||
        isJpLanguageSchoolEventText(hay) ||
        isKrTechPilotEventText(hay)
      )
        return false;
      // UK visa-funds item written for African applicants — not relevant here.
      if (isUkAfricaFundsItem(it)) return false;
      // Stale student-visa opinion/commentary (incl. the two Aug 2026 pieces
      // named by the user) is not decision-changing news — dropped here so
      // no refresh can bring it back.
      if (isStaleVisaOpinionItem(it)) return false;
      return true;
    })
    .sort((a, b) => {
      const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return tb - ta;
    })
    .slice(0, 32);

  if (deduped.length === 0) {
    await noteRefreshFailure(ctx);
    const stale = await readCacheStale<OverseasItem[]>(ctx, "overseas:all:v10");
    if (stale) return { items: stale.data, asOf: stale.asOf };
    // Even with no fresh search results, the fixed visa zone stands.
    const pinnedOnly = await mergePinnedVisaItems(ctx, []);
    const asOf = await writeCache(ctx, "overseas:all:v10", pinnedOnly);
    return { items: pinnedOnly, asOf };
  }

  // MSN reposts (e.g. "CNBC on MSN") resolve to the publisher's own article
  // at ingest via the page's canonical link. An MSN link that cannot be
  // resolved to the publisher is dropped — a repost is never stored as the
  // item's original link.
  const resolved = (
    await Promise.all(
      deduped.map(async (it) => {
        if (!isMsnUrl(it.url)) return it;
        const direct = await resolveMsnUrl(it.url);
        if (!direct) return null;
        return { ...it, url: direct, source: cleanAggregatorSource(it.source) };
      }),
    )
  ).filter((it): it is FeedItem => it !== null);

  const store = (await readCacheStale<Record<string, OverseasEnrichEntry>>(ctx, "overseas:enrich:v1"))?.data ?? {};

  // Items whose RSS entry carried no summary get one more grounded chance:
  // the article page's own meta description (the accessible original). If
  // that also yields nothing, the item stays title-only — never guessed.
  await Promise.all(
    resolved.map(async (it) => {
      if (it.summary && it.summary.trim()) return;
      const meta = await fetchArticleMeta(it.url);
      if (meta.summary && meta.summary !== it.title) it.summary = meta.summary;
    }),
  );

  // "Fresh" = never enriched, OR enriched before but its Chinese summary is
  // still missing even though the item HAS genuine summary text to work
  // from (e.g. the 2026-11-21 08:02 run, where inference timed out once).
  // Those are retried below in small batches. Title-only items are not
  // retried for a summary that cannot exist — they keep the 仅有标题 label.
  const fresh = resolved.filter((it) => {
    const e = store[it.url];
    if (!e) return true;
    const has = !!(it.summary && it.summary.trim());
    return has && e.keep && (!e.whatChanged || e.points.length === 0);
  });

  let overseasEnrichErrorRecorded = false;
  const recordOverseasEnrichError = async (e: unknown) => {
    if (overseasEnrichErrorRecorded) return;
    overseasEnrichErrorRecorded = true;
    try {
      const db = ctx.db;
      const rows = await db.select().from(schema.cacheSnapshots).where(eq(schema.cacheSnapshots.key, "meta:status")).limit(1);
      const prev = rows[0] ? (JSON.parse(rows[0].payload) as Record<string, unknown>) : {};
      await writeCache(ctx, "meta:status", {
        ...prev,
        enrichError: `海外栏摘要：${(e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 400)}`,
        enrichErrorAt: new Date().toISOString(),
      });
    } catch {
      // bookkeeping only — never break a load over it
    }
  };
  const enrichBatch = async (batch: FeedItem[], offset: number): Promise<void> => {
    const listing = batch
      .map((it, j) => {
        const has = !!(it.summary && it.summary.trim());
        return `[${offset + j}] 来源:${it.source} | 标题:${it.title} | 摘要:${has ? (it.summary as string).slice(0, 200) : "（无摘要，仅有标题）"}`;
      })
      .join("\n");
    try {
      const result = await completeInference(ctx, 
        `你在为一位中国专科（大专）学生（信息安全技术应用专业，预计 2028 年毕业）筛选「海外机会与政策变化」。只保留会改变他决策的消息：某校开始接受中国大专学历申请、学分认定/转学分变化、面向专科生的奖学金开放、学生签证要求调整、影响留学生的安全提醒。逐条判断：\n` +
          `- keep：符合上面任一类才 true。留学中介广告、论坛帖子、泛泛的留学介绍、与专科生无关的普通新闻 keep=false。评论、观点、社论类文章（opinion/commentary/editorial）不是政策变化本身，哪怕评论的正是学生签证政策，keep=false。只面向其他国家或地区申请人（例如仅面向非洲申请人）、与中国学生无关的条目 keep=false。跟踪国家只有：美国、新西兰、新加坡、越南、日本、韩国、爱尔兰、英国；其他国家 keep=false。\n` +
          `- country：从这八个国家里选一个最贴切的中文名；实在判断不了填「其他」。\n` +
          `- whatChanged：一句中文说明变了什么，只能依据摘要已有信息；无摘要留空字符串，绝不根据标题猜。\n` +
          `- whoApplies：一句中文说明适用于谁，依据摘要写；摘要没写清就如实写「来源未写明适用人群」。\n` +
          `- effectiveWhen：何时生效，只有摘要明确写出时间时才填原文说法（如「2027年1月起」），没写填 null。\n` +
          `- eligibility：摘要明确说大专/专科可申请或接受大专学历，才填 diploma_eligible；明确只面向本科毕业生填 bachelor_only；没写清学历要求一律填 unclear——绝不能把不明确的标成能申请。\n` +
          `- isImmigration：是否属于移民/居留政策（不是学生签证本身的教学类消息）。是移民政策时 identityLabel 必填，写明适用身份（如「毕业生工签申请人」「学生签证持有者」）；不是则填 null。\n` +
          `- visa：这条是否属于学生签证或毕业后工作签证方面的变化——签证申请要求变了、费用变了、可停留期限变了、毕业后工作签证开放或收紧。属于填 true（这类条目会进入固定签证区长期展示）；奖学金、招生、学分认定等非签证消息填 false。\n` +
          `- pointsZh：2-3 条中文要点，全部来自摘要；无摘要留空数组。\n\n${listing}`,
        { schema: overseasEnrichSchema, timeout_secs: 110 },
      );
      result.items.forEach((r, j) => {
        const idx = r.id >= offset && r.id < offset + batch.length ? r.id : offset + j;
        const it = fresh[idx];
        if (!it) return;
        const has = !!(it.summary && it.summary.trim());
        const existing = store[it.url];
        const newWhat = has ? r.whatChanged.trim() || null : null;
        // A retry that still yields no Chinese summary must not erase a
        // previously stored good one.
        if (r.keep && existing?.keep && existing.whatChanged && !newWhat) return;
        store[it.url] = {
          country: r.country.trim() || "其他",
          whatChanged: newWhat,
          whoApplies: r.whoApplies.trim() || null,
          effectiveWhen: r.effectiveWhen?.trim() ? r.effectiveWhen.trim() : null,
          eligibility: r.eligibility,
          isImmigration: r.isImmigration,
          identityLabel: r.isImmigration ? r.identityLabel?.trim() || "适用身份见原文" : null,
          points: has ? r.pointsZh.map((p) => p.trim()).filter(Boolean).slice(0, 3) : [],
          keep: r.keep,
          visa: r.visa,
        };
      });
    } catch (e) {
      // Small-batch retry: a timed-out batch is split in half and retried,
      // down to single items. An item that still fails stays unstored (or
      // keeps its previous entry), so the next refresh retries it instead
      // of serving a guessed or half-finished Chinese summary.
      await recordOverseasEnrichError(e);
      if (batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        await enrichBatch(batch.slice(0, mid), offset);
        await enrichBatch(batch.slice(mid), offset + mid);
      }
    }
  };
  // Batches of 3, run sequentially: the 08:02 timeout came from larger
  // parallel batches; small sequential batches are slower but finish.
  const batches: FeedItem[][] = [];
  for (let s = 0; s < fresh.length; s += 3) batches.push(fresh.slice(s, s + 3));
  for (const [bi, b] of batches.entries()) {
    await enrichBatch(b, bi * 3);
  }

  const items: OverseasItem[] = [];
  for (const it of resolved) {
    const entry = store[it.url];
    if (entry && !entry.keep) continue;
    // Belt-and-braces: an item the model itself describes as applying only
    // to African applicants never belongs in this column.
    if (entry && entry.country === "英国" && /非洲/.test(entry.whoApplies ?? "")) continue;
    const has = !!(it.summary && it.summary.trim());
    const host = hostOf(it.url);
    items.push({
      title: it.title,
      url: it.url,
      source: it.source,
      publishedAt: it.publishedAt,
      country: entry?.country ?? "其他",
      // Unenriched fallback: only a summary that is already Chinese may
      // stand in for 变了什么； an English summary is shown as-is under
      // 要点 (labelled 来自公开摘要） and 变了什么 stays null rather than
      // presenting untranslated text as a Chinese summary.
      whatChanged:
        entry?.whatChanged ??
        (has && /[一-鿿]/.test(it.summary as string) ? (it.summary as string).slice(0, 90) : null),
      whoApplies: entry?.whoApplies ?? null,
      effectiveWhen: entry?.effectiveWhen ?? null,
      eligibility: entry?.eligibility ?? "unclear",
      isImmigration: entry?.isImmigration ?? false,
      identityLabel: entry?.identityLabel ?? null,
      points: entry && entry.points.length > 0 ? entry.points : has ? [it.summary as string] : [],
      titleOnly: !has,
      readUrl: it.url,
      needsLogin: loginRequired(it.source, it.url),
      blockedReason: cnBlockedReason(it.url),
      official: isInstitutionalHost(host) || /\.gov/.test(host),
      visa: entry?.visa === true,
      pinned: false,
    });
  }
  items.sort((a, b) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  });
  // Fixed visa zone: visa-classified discoveries join the pinned store and
  // stay across refreshes; the curated items (D/S ruling, NZ PSWV, UK
  // Graduate visa, Korea reform plan, Singapore work-pass thresholds)
  // always anchor it. Pinned items are removed from the rotating list so
  // each appears exactly once.
  const pinned = await mergePinnedVisaItems(ctx, items.filter((it) => it.visa));
  const pinnedUrls = new Set(pinned.map((it) => it.url));
  const rotating = items.filter((it) => !pinnedUrls.has(it.url));
  const all = [...pinned, ...rotating];

  const bounded: Record<string, OverseasEnrichEntry> = {};
  for (const [url, e] of Object.entries(store)) {
    if (Object.keys(bounded).length >= 200) break;
    bounded[url] = e;
  }
  await writeCache(ctx, "overseas:enrich:v1", bounded);
  const asOf = await writeCache(ctx, "overseas:all:v10", all);
  return { items: all, asOf };
}

// --- 我关注的世界 -------------------------------------------------------------

interface WorldItem extends FeedItem {
  topic: string;
  weekly: boolean;
}

const WORLD_TTL_MS = 60 * 60 * 1000;

const WORLD_DAILY_QUERIES: Array<{ topic: string; q: string }> = [
  { topic: "网络安全", q: "网络安全 漏洞 数据泄露" },
  { topic: "出行安全", q: "出行安全 提醒 旅行安全" },
  { topic: "地区冲突", q: "地区冲突 局势" },
  { topic: "国内经济", q: "中国 经济 数据 政策" },
];

const WORLD_WEEKLY_QUERIES: Array<{ topic: string; q: string }> = [
  { topic: "书籍", q: "新书 出版 推荐 阅读" },
  { topic: "历史", q: "历史 新书 研究 考古" },
  { topic: "语言学习", q: "英语学习 语言学习 方法" },
];

function titleKey(title: string): string {
  return title.replace(/[\s\p{P}]/gu, "").slice(0, 14);
}

async function loadMyWorld(ctx: Ctx, force: boolean): Promise<{ daily: WorldItem[]; weekly: WorldItem[]; all: WorldItem[]; asOf: string }> {
  if (!force) {
    const cached = await readCache<{ daily: WorldItem[]; weekly: WorldItem[]; all: WorldItem[] }>(ctx, "world:all:v2", WORLD_TTL_MS);
    if (cached) return { ...cached.data, asOf: cached.asOf };
  }
  const pool: WorldItem[] = [];
  const pushDedup = (items: FeedItem[], topic: string, weekly: boolean) => {
    for (const it of items) {
      const direct = decodeBingClick(it.url);
      if (isBingClick(direct)) continue;
      // No relay link is stored in this column either: category items now
      // arrive pre-resolved at ingest (publisher-direct or linkless), and
      // anything that still carries a Google News relay token is stored
      // linkless — summary plus 复制标题 only, never a news.google.com URL.
      pool.push({ ...it, url: isGnRelay(direct) ? "" : direct, topic, weekly });
    }
  };
  // Category feeds already maintained by the 资讯 surface.
  const catTopics: Array<{ cat: string; topic: string }> = [
    { cat: "business", topic: "经济" },
    { cat: "world", topic: "政治" },
    { cat: "tech", topic: "科技" },
  ];
  await Promise.all(
    catTopics.map(async ({ cat, topic }) => {
      try {
        const { items } = await loadCategory(ctx, cat, false);
        pushDedup(items.slice(0, 15), topic, false);
      } catch {
        // ignore
      }
    }),
  );
  await Promise.all(
    WORLD_DAILY_QUERIES.map(async ({ topic, q }) => {
      try {
        pushDedup(await fetchBingItems(q, "Bing 资讯", 10), topic, false);
      } catch {
        // ignore
      }
    }),
  );
  await Promise.all(
    WORLD_WEEKLY_QUERIES.map(async ({ topic, q }) => {
      try {
        pushDedup(await fetchBingItems(q, "Bing 资讯", 10), topic, true);
      } catch {
        // ignore
      }
    }),
  );

  // Merge duplicates: same event reported by several outlets collapses to
  // one entry — first by normalized title key, then by character-bigram
  // similarity of title+summary (the same event retold under different
  // headlines still shares most of its wording).
  const bigramSet = (text: string): Set<string> => {
    const clean = text.replace(/[\s\p{P}]/gu, "");
    const set = new Set<string>();
    for (let i = 0; i + 2 <= clean.length; i++) set.add(clean.slice(i, i + 2));
    return set;
  };
  const jaccard = (a: Set<string>, b: Set<string>): number => {
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
  };
  const seenKeys = new Set<string>();
  const keptGrams = new Map<string, Array<Set<string>>>();
  const merged = pool.filter((it) => {
    const k = titleKey(it.title);
    if (!k || seenKeys.has(k)) return false;
    // Similarity merging only within the same topic and only at a high
    // threshold: distinct stories in one field share vocabulary, while the
    // same event retold by several outlets shares most of its wording.
    const grams = bigramSet(`${it.title} ${(it.summary ?? "").slice(0, 160)}`);
    const sameTopic = keptGrams.get(it.topic) ?? [];
    if (grams.size >= 20 && sameTopic.some((g) => jaccard(g, grams) > 0.42)) return false;
    seenKeys.add(k);
    sameTopic.push(grams);
    keptGrams.set(it.topic, sameTopic);
    return true;
  });
  const byTime = (a: WorldItem, b: WorldItem) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  };
  const dailyPool = merged.filter((it) => !it.weekly).sort(byTime);
  // Daily picks: at most 5, round-robin across topics so one topic cannot
  // fill the whole homepage list.
  const daily: WorldItem[] = [];
  const topics = [...new Set(dailyPool.map((it) => it.topic))];
  for (let round = 0; daily.length < 5; round++) {
    let progressed = false;
    for (const t of topics) {
      const candidate = dailyPool.filter((it) => it.topic === t && !daily.includes(it))[0];
      if (candidate) {
        daily.push(candidate);
        progressed = true;
        if (daily.length >= 5) break;
      }
    }
    if (!progressed) break;
  }
  const weekly = merged.filter((it) => it.weekly).sort(byTime).slice(0, 9);
  const all = merged.sort(byTime).slice(0, 40);
  if (all.length === 0) {
    await noteRefreshFailure(ctx);
    const stale = await readCacheStale<{ daily: WorldItem[]; weekly: WorldItem[]; all: WorldItem[] }>(ctx, "world:all:v2");
    if (stale) return { ...stale.data, asOf: stale.asOf };
    return { daily: [], weekly: [], all: [], asOf: new Date().toISOString() };
  }
  const asOf = await writeCache(ctx, "world:all:v2", { daily, weekly, all });
  return { daily, weekly, all, asOf };
}

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const feedItemSchema = z.object({
  title: z.string(),
  url: z.string(),
  summary: z.string().nullable(),
  publishedAt: z.string().nullable(),
  source: z.string(),
});

const learningItemSchema = z.object({
  title: z.string(),
  url: z.string(),
  source: z.string(),
  publishedAt: z.string().nullable(),
  summaryZh: z.string().nullable(),
  points: z.array(z.string()),
  titleOnly: z.boolean(),
  chineseUrl: z.string().nullable(),
  fee: z.string().nullable(),
  readUrl: z.string().nullable(),
  officialUrl: z.string().nullable(),
  needsLogin: z.boolean(),
  blockedReason: z.string().nullable(),
  category: z.enum(["courses", "resources", "opportunities"]),
  audienceStage: z.string().nullable(),
  deadline: z.string().nullable(),
  needsApplication: z.boolean(),
});

const jiangxiItemSchema = z.object({
  title: z.string(),
  url: z.string(),
  source: z.string(),
  publishedAt: z.string().nullable(),
  summaryZh: z.string().nullable(),
  points: z.array(z.string()),
  titleOnly: z.boolean(),
  readUrl: z.string().nullable(),
  needsLogin: z.boolean(),
  tag: z.enum(["报名", "考试科目", "专业对照", "招生简章", "其他"]),
  applicableYear: z.string().nullable(),
  relevance: z.string(),
  actionNeeded: z.string(),
  isReference: z.boolean(),
  official: z.boolean(),
  repost: z.boolean(),
});

const overseasItemSchema = z.object({
  title: z.string(),
  url: z.string(),
  source: z.string(),
  publishedAt: z.string().nullable(),
  country: z.string(),
  whatChanged: z.string().nullable(),
  whoApplies: z.string().nullable(),
  effectiveWhen: z.string().nullable(),
  eligibility: z.enum(["diploma_eligible", "unclear", "bachelor_only"]),
  isImmigration: z.boolean(),
  identityLabel: z.string().nullable(),
  points: z.array(z.string()),
  titleOnly: z.boolean(),
  readUrl: z.string().nullable(),
  needsLogin: z.boolean(),
  blockedReason: z.string().nullable(),
  official: z.boolean(),
  visa: z.boolean(),
  pinned: z.boolean(),
});

const worldItemSchema = feedItemSchema.extend({
  topic: z.string(),
  weekly: z.boolean(),
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const Actions = {
  getCategoryNews: defineAction({
    description: "Returns the latest headlines for one news category (top, nation, world, business, tech, ai, sports, science, health). The entertainment category and the platform hot lists were removed 2026-11-21 at the user's request.",
    request: z.object({
      category: z.enum(["top", "nation", "world", "business", "tech", "ai", "sports", "science", "health"]),
      force: z.boolean().default(false),
    }),
    response: z.object({ asOf: z.string(), items: z.array(feedItemSchema) }),
    async handler(ctx, args) {
      return await loadCategory(ctx, args.category, args.force);
    },
  }),

  listCategories: defineAction({
    description: "Lists the news categories shown on the headlines surface.",
    request: z.object({}),
    response: z.object({
      categories: z.array(z.object({ id: z.string(), label: z.string() })),
    }),
    async handler() {
      return { categories: CATEGORIES.map((c) => ({ id: c.id, label: c.label })) };
    },
  }),

  getSubscriptions: defineAction({
    description: "Returns the preset RSS catalog with follow state, plus the user's own custom feeds.",
    request: z.object({}),
    response: z.object({
      catalog: z.array(
        z.object({
          key: z.string(),
          name: z.string(),
          field: z.string(),
          lang: z.string(),
          url: z.string(),
          followed: z.boolean(),
        }),
      ),
      custom: z.array(
        z.object({ id: z.number(), name: z.string(), url: z.string() }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db;
      const subs = await db.select().from(schema.subscriptions).orderBy(asc(schema.subscriptions.id));
      const followedKeys = new Set(subs.map((s) => s.feedKey));
      return {
        catalog: FEED_CATALOG.map((f) => ({ ...f, followed: followedKeys.has(f.key) })),
        custom: subs
          .filter((s) => s.isCustom === 1)
          .map((s) => ({ id: s.id, name: s.name, url: s.url })),
      };
    },
  }),

  toggleCatalogFeed: defineAction({
    description: "Follows or unfollows one preset catalog feed by its key.",
    request: z.object({ key: z.string().min(1).max(60) }),
    response: z.object({ followed: z.boolean() }),
    async handler(ctx, args) {
      const feed = FEED_CATALOG.find((f) => f.key === args.key);
      if (!feed) throw new Error("目录里没有这个订阅源");
      const db = ctx.db;
      const existing = await db
        .select()
        .from(schema.subscriptions)
        .where(eq(schema.subscriptions.feedKey, feed.key))
        .limit(1);
      if (existing[0]) {
        await db.delete(schema.subscriptions).where(eq(schema.subscriptions.feedKey, feed.key));
        ctx.invalidateQueries();
        return { followed: false };
      }
      await db.insert(schema.subscriptions).values({
        feedKey: feed.key,
        name: feed.name,
        url: feed.url,
        isCustom: 0,
      });
      ctx.invalidateQueries();
      return { followed: true };
    },
  }),

  addCustomFeed: defineAction({
    description: "Adds a user-supplied RSS feed URL to their subscriptions after verifying it parses as a feed.",
    request: z.object({
      name: z.string().trim().min(1).max(40),
      url: z.string().trim().url().max(500),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      if (!/^https?:\/\//i.test(args.url)) throw new Error("只支持 http/https 的订阅地址");
      let items: FeedItem[] = [];
      try {
        const xml = await fetchText(args.url);
        items = parseFeed(xml, args.name, 5);
      } catch {
        throw new Error("这个地址暂时连不上，检查一下再试");
      }
      if (items.length === 0) throw new Error("这个地址不像一个 RSS/Atom 订阅源");
      const db = ctx.db;
      const feedKey = `custom:${args.url}`;
      const existing = await db
        .select()
        .from(schema.subscriptions)
        .where(eq(schema.subscriptions.feedKey, feedKey))
        .limit(1);
      if (existing[0]) throw new Error("你已经订阅了这个源");
      const inserted = await db
        .insert(schema.subscriptions)
        .values({ feedKey, name: args.name, url: args.url, isCustom: 1 })
        .returning({ id: schema.subscriptions.id });
      const row = inserted[0];
      if (!row) throw new Error("保存失败，请重试");
      // Warm the cache with the items we already fetched.
      await writeCache(ctx, `feed:${feedKey}`, items.map((it) => ({ ...it, source: args.name })));
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  removeCustomFeed: defineAction({
    description: "Removes one of the user's custom RSS subscriptions by id.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db;
      await db.delete(schema.subscriptions).where(eq(schema.subscriptions.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  getStatus: defineAction({
    description: "Returns the last successful refresh time across all caches and the daily refresh schedule.",
    request: z.object({}),
    response: z.object({
      lastUpdatedAt: z.string().nullable(),
      lastFailureAt: z.string().nullable(),
      enrichError: z.string().nullable(),
      refreshTimeLabel: z.string(),
      refreshTimezone: z.string(),
      refreshScheduleLabel: z.string(),
    }),
    async handler(ctx) {
      const db = ctx.db;
      const rows = await db.select().from(schema.cacheSnapshots);
      let max: Date | null = null;
      let lastFailureAt: string | null = null;
      let enrichError: string | null = null;
      for (const r of rows) {
        if (r.key === "meta:status") {
          try {
            const meta = JSON.parse(r.payload) as { lastFailureAt?: string; enrichError?: string };
            lastFailureAt = meta.lastFailureAt ?? null;
            enrichError = meta.enrichError ?? null;
          } catch {
            lastFailureAt = null;
          }
          continue;
        }
        // Only content caches count as a successful update (not detail lookups).
        if (!/^(news:|feed:|learning:|jiangxi:|overseas:|world:)/.test(r.key)) continue;
        if (r.key.includes(":enrich:") || r.key.includes(":dropped:")) continue;
        if (!max || r.fetchedAt.getTime() > max.getTime()) max = r.fetchedAt;
      }
      return {
        lastUpdatedAt: max ? max.toISOString() : null,
        lastFailureAt,
        enrichError,
        refreshTimeLabel: "08:02",
        refreshTimezone: "Asia/Shanghai",
        refreshScheduleLabel: "每天 08:02 · Asia/Shanghai (UTC+8)",
      };
    },
  }),

  getMyFeed: defineAction({
    description: "Returns the merged latest items from every feed the user follows, newest first by original published time.",
    request: z.object({ force: z.boolean().default(false) }),
    response: z.object({
      items: z.array(feedItemSchema),
      feedErrors: z.array(z.object({ name: z.string(), error: z.string() })),
      followedCount: z.number(),
      asOf: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db;
      const subs = await db.select().from(schema.subscriptions).orderBy(asc(schema.subscriptions.id));
      if (subs.length === 0) return { items: [], feedErrors: [], followedCount: 0, asOf: null };
      const results = await Promise.all(
        subs.map((s) => loadFeedItems(ctx, s.feedKey, s.name, s.url, args.force)),
      );
      const items: FeedItem[] = [];
      const feedErrors: Array<{ name: string; error: string }> = [];
      results.forEach((r, i) => {
        items.push(...r.items);
        const sub = subs[i];
        if (r.error && sub) feedErrors.push({ name: sub.name, error: r.error });
      });
      items.sort((a, b) => {
        const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
        const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
        return tb - ta;
      });
      // Latest cache time among feed snapshots is this surface's asOf.
      const cacheRows = await db.select().from(schema.cacheSnapshots);
      let maxFeed: Date | null = null;
      for (const r of cacheRows) {
        if (r.key.startsWith("feed:") && (!maxFeed || r.fetchedAt.getTime() > maxFeed.getTime())) maxFeed = r.fetchedAt;
      }
      return {
        items: items.slice(0, 60),
        feedErrors,
        followedCount: subs.length,
        asOf: maxFeed ? maxFeed.toISOString() : new Date().toISOString(),
      };
    },
  }),

  getBookmarks: defineAction({
    description: "Lists the user's saved articles, newest saved first.",
    request: z.object({}),
    response: z.object({
      bookmarks: z.array(
        z.object({
          id: z.number(),
          title: z.string(),
          url: z.string(),
          source: z.string(),
          publishedAt: z.string().nullable(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db;
      const rows = await db.select().from(schema.bookmarks).orderBy(asc(schema.bookmarks.id));
      return {
        bookmarks: rows
          .slice()
          .reverse()
          .map((r) => ({
            id: r.id,
            title: r.title,
            url: r.url,
            source: r.source,
            publishedAt: r.publishedAt,
          })),
      };
    },
  }),

  toggleBookmark: defineAction({
    description: "Saves an article to bookmarks, or removes it if already saved (matched by URL).",
    request: z.object({
      title: z.string().min(1).max(300),
      url: z.string().min(1).max(1000),
      source: z.string().min(1).max(120),
      publishedAt: z.string().nullable().default(null),
    }),
    response: z.object({ saved: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db;
      const existing = await db
        .select()
        .from(schema.bookmarks)
        .where(eq(schema.bookmarks.url, args.url))
        .limit(1);
      if (existing[0]) {
        await db.delete(schema.bookmarks).where(eq(schema.bookmarks.url, args.url));
        ctx.invalidateQueries();
        return { saved: false };
      }
      await db.insert(schema.bookmarks).values({
        title: args.title,
        url: args.url,
        source: args.source,
        publishedAt: args.publishedAt,
      });
      ctx.invalidateQueries();
      return { saved: true };
    },
  }),

  getLearning: defineAction({
    description:
      "Returns the 学习 (learning) column: courses/lectures, learning resources and student opportunities for students, newest first, with a Chinese one-line summary per item, plus stage and application deadline when the source states them. Also returns upcoming deadlines (next 30 days, soonest first) for the reminder strip.",
    request: z.object({ force: z.boolean().default(false) }),
    response: z.object({
      asOf: z.string(),
      items: z.array(learningItemSchema),
      deadlines: z.array(learningItemSchema),
    }),
    async handler(ctx, args) {
      const loaded = await loadLearning(ctx, args.force);
      const items = loaded.items.map(correctLearningItem);
      const asOf = loaded.asOf;
      // "可报名" list: only deadlines from today (Asia/Shanghai) through the
      // next 30 days — expired opportunities are excluded here and badged
      // 已截止 in the full list. Application-type items (scholarships,
      // competitions, summer schools…) additionally need a CONFIRMED
      // official entry: an opportunity whose officialUrl was never
      // confirmed does not enter this list at all. Courses/lectures and
      // learning resources are unaffected — they are not application
      // items and keep showing in the full list as before.
      const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
      const limit = new Date(`${todayStr}T00:00:00`);
      limit.setDate(limit.getDate() + 30);
      const limitStr = `${limit.getFullYear()}-${String(limit.getMonth() + 1).padStart(2, "0")}-${String(limit.getDate()).padStart(2, "0")}`;
      const deadlines = items
        .filter(
          (it) =>
            it.deadline !== null &&
            it.deadline >= todayStr &&
            it.deadline <= limitStr &&
            it.officialUrl !== null &&
            it.officialUrl !== "",
        )
        .sort((a, b) => (a.deadline ?? "").localeCompare(b.deadline ?? ""));
      return { items, deadlines, asOf };
    },
  }),

  getItemDetail: defineAction({
    description:
      "Returns in-page reading material for one article row: Chinese key points derived only from the item's public RSS summary (translated/extracted, never invented from the title). When the item has no real summary, returns titleOnly=true so the UI can honestly label it 仅有标题. Results are cached by URL.",
    request: z.object({
      url: z.string().min(1).max(1000),
      title: z.string().min(1).max(300),
      source: z.string().max(120).default(""),
      summary: z.string().max(1500).nullable().default(null),
    }),
    response: z.object({
      titleOnly: z.boolean(),
      introZh: z.string().nullable(),
      points: z.array(z.string()),
      readUrl: z.string().nullable(),
      needsLogin: z.boolean(),
      blockedReason: z.string().nullable(),
    }),
    async handler(
      ctx,
      args,
    ): Promise<{
      titleOnly: boolean;
      introZh: string | null;
      points: string[];
      readUrl: string | null;
      needsLogin: boolean;
      blockedReason: string | null;
    }> {
      // A Google News placeholder line is not a summary, wherever it
      // arrives from — strip it and judge what (if anything) remains.
      GN_PLACEHOLDER_RE.lastIndex = 0;
      const summary = (args.summary ?? "").replace(GN_PLACEHOLDER_RE, " ").replace(/\s+/g, " ").trim();
      let hash = 0;
      for (let i = 0; i < args.url.length; i++) hash = ((hash * 31) + args.url.charCodeAt(i)) | 0;
      // v4: v3 entries could hold points "summarized" from a Google News
      // placeholder summary; those must never be served again.
      const key = `detail:v4:${(hash >>> 0).toString(36)}`;
      type Detail = {
        titleOnly: boolean;
        introZh: string | null;
        points: string[];
        readUrl: string | null;
        needsLogin: boolean;
        blockedReason: string | null;
      };
      const cached = await readCacheStale<Detail>(ctx, key);
      if (cached) return cached.data;

      // Resolve the direct publisher URL in parallel with summarizing:
      // Google News relay → batchexecute decode (shared cache), MSN repost
      // → the page's canonical publisher link. A link that cannot be
      // resolved yields readUrl=null and the UI offers 复制标题 instead of
      // a broken or repost link.
      const resolvePromise = isMsnUrl(args.url) ? resolveMsnUrl(args.url) : resolveGnShared(ctx, args.url);
      let base: { titleOnly: boolean; introZh: string | null; points: string[] };
      if (!summary || summary === args.title.trim()) {
        base = { titleOnly: true, introZh: null, points: [] };
      } else {
        try {
          const r = await completeInference(ctx, 
            `下面是一条新闻的公开摘要。请只依据这段摘要本身整理中文要点，不要补充摘要里没有的信息，不要根据标题猜测正文：\n` +
              `- introZh：一句中文概括这段摘要讲了什么；摘要是英文的就翻译提炼。\n` +
              `- points：2-3 条中文要点，每条一句话，全部来自摘要原文。\n\n标题：${args.title}\n摘要：${summary.slice(0, 800)}`,
            {
              schema: z.object({ introZh: z.string(), points: z.array(z.string()) }),
              timeout_secs: 60,
            },
          );
          base = {
            titleOnly: false,
            introZh: r.introZh.trim() || null,
            points: r.points.map((p) => p.trim()).filter(Boolean).slice(0, 3),
          };
          if (base.points.length === 0) base = { titleOnly: false, introZh: null, points: [summary] };
        } catch {
          // Model unavailable: show the source's own summary text as-is.
          base = { titleOnly: false, introZh: null, points: [summary] };
        }
      }
      const readUrl = await resolvePromise;
      const result: Detail = {
        ...base,
        readUrl,
        needsLogin: loginRequired(args.source, readUrl ?? args.url),
        // Confirmed China-blocked host (registry): the UI labels the item
        // 「中国境内打不开」 and keeps only the summary + 复制标题.
        blockedReason: cnBlockedReason(readUrl) ?? cnBlockedReason(args.url),
      };
      await writeCache(ctx, key, result);
      return result;
    },
  }),

  getJiangxi: defineAction({
    description:
      "Returns the 江西专升本 column for a Jiangxi 专科 student （信息安全技术应用， 2028 年毕业）: official-first notices about 报名/考试科目/专业对照/招生简章， each with applicable year, relevance to the major and what to do. Past-year items are flagged isReference （备考参考）; the pending list marks each 2028 matter as 待公布 until a 2028 notice covers it.",
    request: z.object({ force: z.boolean().default(false) }),
    response: z.object({
      asOf: z.string(),
      items: z.array(jiangxiItemSchema),
      pending: z.array(z.object({ label: z.string(), status: z.string() })),
      hasTodayUpdate: z.boolean(),
    }),
    async handler(ctx, args) {
      const { items, asOf } = await loadJiangxi(ctx, args.force);
      const current = items.filter((it) => !it.isReference);
      const covers = (tag: JiangxiTag) => current.some((it) => it.tag === tag);
      const pending = [
        { label: "2028 年报名通知", status: covers("报名") ? "已有 2028 年消息，见下方" : "待公布" },
        { label: "2028 年考试科目", status: covers("考试科目") ? "已有 2028 年消息，见下方" : "待公布" },
        { label: "2028 年专业对照表", status: covers("专业对照") ? "已有 2028 年消息，见下方" : "待公布" },
        { label: "2028 年招生简章", status: covers("招生简章") ? "已有 2028 年消息，见下方" : "待公布" },
      ];
      return { items, pending, asOf, hasTodayUpdate: items.some((it) => isTodayShanghai(it.publishedAt)) };
    },
  }),

  getOverseas: defineAction({
    description:
      "Returns decision-changing overseas opportunities and policy changes for a Chinese 专科 (diploma) student across the US, New Zealand, Singapore, Vietnam, Japan, South Korea, Ireland and the UK: what changed, who it applies to and when it takes effect, with the original university/government link. Student-visa and post-study-work-visa changes carry visa=true and live in a fixed zone (pinned=true): they persist across daily refreshes and are only removed when superseded by a newer item on the same topic or expired. Bachelor-only items are flagged bachelor_only (hidden by default in the rotating list; pinned visa items stay visible with their badge); unclear eligibility stays 'unclear' and is never presented as diploma-eligible. Immigration items carry an identityLabel.",
    request: z.object({ force: z.boolean().default(false) }),
    response: z.object({
      asOf: z.string(),
      items: z.array(overseasItemSchema),
      hasTodayUpdate: z.boolean(),
    }),
    async handler(ctx, args) {
      const { items, asOf } = await loadOverseas(ctx, args.force);
      return { items, asOf, hasTodayUpdate: items.some((it) => isTodayShanghai(it.publishedAt)) };
    },
  }),

  getMyWorld: defineAction({
    description:
      "Returns 我关注的世界： daily picks (at most 5, same event merged, across 国内经济/国外经济/政治/科技/网络安全/出行安全/地区冲突）, weekly picks （书籍/历史/语言学习）, and the full topic-browsable list.",
    request: z.object({ force: z.boolean().default(false) }),
    response: z.object({
      asOf: z.string(),
      daily: z.array(worldItemSchema),
      weekly: z.array(worldItemSchema),
      all: z.array(worldItemSchema),
    }),
    async handler(ctx, args) {
      return await loadMyWorld(ctx, args.force);
    },
  }),

  refreshAll: defineAction({
    description: "Refreshes every cache: the three homepage columns, the learning column, all news categories, and every followed feed. Used by the daily schedule and first-load warm-up. (Platform hot lists were removed 2026-11-21 and are no longer refreshed.)",
    request: z.object({}),
    response: z.object({ ok: z.literal(true), refreshedAt: z.string() }),
    async handler(ctx): Promise<{ ok: true; refreshedAt: string }> {
      // Learning first: its model enrichment is the slowest, most
      // deadline-sensitive step, so it must not queue behind nine sequential
      // category fetches (that ordering is what starved it of inference time).
      await loadLearning(ctx, true);
      await Promise.all([loadJiangxi(ctx, true), loadOverseas(ctx, true), loadMyWorld(ctx, true)]);
      await Promise.all(CATEGORIES.map((cat) => loadCategory(ctx, cat.id, true)));
      const db = ctx.db;
      const subs = await db.select().from(schema.subscriptions);
      for (const s of subs) {
        await loadFeedItems(ctx, s.feedKey, s.name, s.url, true);
      }
      ctx.invalidateQueries();
      return { ok: true, refreshedAt: new Date().toISOString() };
    },
  }),
};
