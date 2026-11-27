import { z } from "zod";
import { asc, desc, eq, sql } from "drizzle-orm";
import * as schema from "./schema.js";
import type { Ctx } from "./ctx.js";
import { completeInference } from "./llm.js";
import { EnrichDeterministicError, isDeterministicEnrichError } from "./llm.js";

// ---------------------------------------------------------------------------
// Local replacement for the SDK's `defineAction` (previously provided by
// the Muse-hosted SDK). It returns the definition object as-is, keeping the
// description/request/response/handler structure and type inference, so the
// 19 action definitions below did not need to change.
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
  // Iterate to a fixed point (max 3 passes): feeds double-encode entities
  // (`&amp;#160;` in the raw XML), and a single pass decodes the `&amp;`
  // LAST, leaving a literal `&#160;` behind in the text (user rule,
  // 2026-11-23 — the m-round decode fixed titles but a Coursera item's
  // points still carried `&#160;`). Repeated passes collapse
  // `&amp;#160;` → `&#160;` → the real character; ordinary text is
  // unchanged after the first pass and the loop stops.
  let out = s;
  for (let pass = 0; pass < 3; pass++) {
    const next = decodeEntitiesOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

function decodeEntitiesOnce(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&middot;/g, "·")
    .replace(/&pound;/g, "£")
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&lsquo;/g, "‘")
    .replace(/&rsquo;/g, "’")
    .replace(/&ldquo;/g, "“")
    .replace(/&rdquo;/g, "”")
    // Numeric character references — decimal (&#163; → £, &#183; → ·) and
    // hex (&#xA3;). Titles arriving from feeds and search results carry
    // these raw; they must be decoded before display, never shown as-is.
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (m, hex: string) => {
      const cp = parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&#(\d{1,7});/g, (m, dec: string) => {
      const cp = parseInt(dec, 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&amp;/g, "&")
    .trim();
}

/**
 * Truncate at a word/sentence boundary (user rule, 2026-11-22): a summary
 * or relevance line must never be cut mid-word ("international studen",
 * "struggle t"). When the text exceeds `max`, walk back from the cut to
 * the last sentence end (。！？.!?；;) or, failing that, the last space —
 * shorter is fine, a half word is not. Deterministic; used everywhere a
 * slice() used to bite, with or without a model in the loop.
 */
function truncateAtBoundary(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sentenceEnd = Math.max(
    cut.lastIndexOf("。"),
    cut.lastIndexOf("！"),
    cut.lastIndexOf("？"),
    cut.lastIndexOf("；"),
    cut.lastIndexOf("; "),
  );
  if (sentenceEnd >= Math.floor(max * 0.45)) return cut.slice(0, sentenceEnd + 1).trim();
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace >= Math.floor(max * 0.45)) return cut.slice(0, lastSpace).trim();
  // Chinese text has no spaces: a character boundary IS a word-safe cut.
  if (!/[A-Za-z]/.test(cut.slice(-12))) return cut.trim();
  return cut.slice(0, Math.floor(max * 0.7)).trim();
}

/**
 * Build a display line out of COMPLETE sentences only (user rule,
 * 2026-11-23): the m-round boundary truncation still cut a Coursera
 * relevance line mid-SENTENCE ("…but many professionals struggle" —
 * a whole word, but half a thought). This takes whole sentences from
 * the item's own text until `max` is reached; the first sentence is
 * always kept whole, even when it alone exceeds `max` (a long complete
 * sentence beats a short broken one), and only a pathological
 * paragraph-length "sentence" falls back to boundary truncation.
 * Deterministic — no model, no translation: an English source yields a
 * complete English sentence, never a fabricated Chinese one.
 */
function completeSentences(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  const sentences = t.match(/[^。！？.!?；;]+[。！？.!?；;]+["'"“”‘’」』）)]*|[^。！？.!?；;]+$/g) ?? [t];
  let out = "";
  for (const s of sentences) {
    const trimmed = s.trim();
    if (!trimmed) continue;
    if (out && out.length + trimmed.length > max) break;
    out += trimmed;
    if (out.length >= max) break;
  }
  if (out) return out;
  const first = (sentences[0] ?? t).trim();
  return first.length <= 260 ? first : truncateAtBoundary(first, 260);
}

/**
 * Repair a stored string that an older slice() already cut mid-word:
 * when the text is at/near a known cap length and ends inside a Latin
 * word, drop the trailing partial word. Full sentences end with
 * punctuation and are untouched.
 */
function trimPartialTailWord(text: string, capHint: number): string {
  if (text.length < capHint - 6) return text;
  if (!/[A-Za-z0-9]$/.test(text)) return text;
  const lastSpace = text.lastIndexOf(" ");
  if (lastSpace < Math.floor(text.length * 0.5)) return text;
  return text.slice(0, lastSpace).trim();
}

/**
 * One entry, one saying (user rule, 2026-11-22): the same sentence must
 * never appear twice inside one item's points (the UNSW scholarship item
 * carried its own lede sentence twice). Comparison ignores surrounding
 * whitespace and trailing sentence punctuation.
 */
function dedupeSentences(points: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of points) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    const key = trimmed.replace(/[\s。．.!！?？；;，,、：:]+$/u, "").replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
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
    // A summary must come from THIS item's own source only (user rule,
    // 2026-11-22): a Google News description is an <ol> of RELATED
    // headlines from several outlets — stripping the tags splices those
    // outlets' reports into one fake "summary" whose facts contradict
    // each other (the Indonesia candy-factory fire carried death tolls
    // of 6, 3 and 7 from three different reports). A description made of
    // two or more <li> headlines is a headline list, not a summary: the
    // item is honestly title-only instead.
    const liCount = descRaw ? (descRaw.match(/<li[\s>]/gi) ?? []).length : 0;
    const summary =
      liCount >= 2 ? null : descClean ? truncateAtBoundary(stripTags(descClean), 350) || null : null;
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
      const s = truncateAtBoundary(stripTags(metaDesc), 300);
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

/**
 * Records the most recent content-fetch failure time AND its source
 * (分类:<id> / 订阅:<key> / 学习 / 江西专升本 / 海外 / 我关注的世界), so the
 * page can say WHERE fetching last failed. This is a fetch failure, not
 * an enrichment error — the two are tracked separately (see
 * deriveStatusErrors). Content itself stays on the previous version.
 */
async function noteRefreshFailure(ctx: Ctx, source: string): Promise<void> {
  try {
    const db = ctx.db;
    const rows = await db.select().from(schema.cacheSnapshots).where(eq(schema.cacheSnapshots.key, "meta:status")).limit(1);
    const prev = rows[0] ? (JSON.parse(rows[0].payload) as { lastFailureAt?: string }) : {};
    await writeCache(ctx, "meta:status", {
      ...prev,
      lastFailureAt: new Date().toISOString(),
      lastFailureSource: source,
    });
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

// --- Model-enrichment pacing (user rule, 2026-11-23) -----------------------
// The free Gemini tier behind the self-hosted copy allows ~15 model calls
// per minute; a refresh that fired every column's batches in parallel peaked
// at 23 calls/minute and got HTTP 429s (the daily quota was barely touched —
// it is the per-minute cap that binds). So enrichment batches now run ONE AT
// A TIME with a pause between batches: a batch call plus a 5s pause keeps a
// refresh at roughly 12 calls/minute at most, under the cap. A batch that
// still hits a 429 is retried once after an 8s backoff, only when the run
// budget still allows it. Batch size (5 per batch, 3 for overseas), the
// per-item enrichment caches and every column's own cache write on
// completion are unchanged — serialization never delays a finished column's
// cache write behind another column.
const ENRICH_BATCH_GAP_MS = 5000;
const ENRICH_429_BACKOFF_MS = 8000;

function isRateLimitError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return /\b429\b/.test(msg) || /too many requests/i.test(msg) || /rate.?limit/i.test(msg);
}

// --- Enrichment hardening (p-round, 2026-11-23) ---------------------------
// Three defects found in the o-round (2026-11-23): (1) the batch prompts
// never stated the {"items": [...]} shape, and the managed runtime (like
// Gemini's OpenAI-compat layer on the self-hosted copy) returns a bare JSON
// array when the model ignores the json_object constraint — the strict
// object schema then throws and the whole column falls back; (2) ANY batch
// error triggered a split-half retry, so a deterministic parse/schema error
// was retried until the 60s function budget died before any column wrote
// its cache; (3) a single 110s model timeout could starve every column
// after it, because refreshAll had no time budget and no per-batch save.
//
// The fixes below are shared by all three enriched columns:
//  - each batch prompt states the {"items": [...]} shape explicitly;
//  - each batch call uses a "loose" union schema — the strict object OR a
//    bare array of the same item shape — so a bare array survives the
//    managed runtime's validation and is wrapped into {"items": [...]} by
//    looseItems() below (the item fields themselves are still strictly
//    checked: a bad `id` still fails the whole batch);
//  - errors are classified, not blanket-caught: deterministic errors
//    (schema/parse failure, model not configured) end the batch at once
//    with the previous summary / original text kept; only 429s retry, once,
//    and only when the budget allows;
//  - results are backfilled by the batch's own issued ids only — missing,
//    duplicate or out-of-range ids never borrow another item's text;
//  - a run budget (55s, targeting the 60s self-hosted function cap) gates
//    every batch start and derives every per-call timeout, with time
//    reserved for cache writes; each successful batch is saved at once, so
//    a run killed mid-way keeps its progress and the next run resumes from
//    the items still missing from the per-URL store.
export const REFRESH_BUDGET_MS = 55_000;
const REFRESH_RESERVE_MS = 8_000;
const MIN_BATCH_START_MS = 12_000;
const ENRICH_CALL_TIMEOUT_MAX_SECS = 45;
const ENRICH_CALL_TIMEOUT_MIN_SECS = 10;

export interface RunBudget {
  readonly startedAt: number;
  readonly deadline: number;
}

export function newRunBudget(totalMs: number = REFRESH_BUDGET_MS): RunBudget {
  const startedAt = Date.now();
  return { startedAt, deadline: startedAt + totalMs };
}

export function budgetRemainingMs(budget: RunBudget): number {
  return budget.deadline - Date.now();
}

/** True when enough time remains to start one more batch and save its result. */
export function budgetCanStartBatch(budget: RunBudget): boolean {
  return budgetRemainingMs(budget) >= MIN_BATCH_START_MS;
}

/**
 * Per-call model timeout, derived from the remaining budget with time kept
 * back for cache writes. Never a fixed 110s again: a call that starts late
 * in a run gets a short timeout instead of eating the whole budget, and no
 * single call may exceed the 60s function cap.
 */
export function timeoutSecsForCall(budget: RunBudget): number {
  const secs = Math.ceil((budgetRemainingMs(budget) - REFRESH_RESERVE_MS) / 1000);
  return Math.min(ENRICH_CALL_TIMEOUT_MAX_SECS, Math.max(ENRICH_CALL_TIMEOUT_MIN_SECS, secs));
}

export type EnrichErrorKind = "deterministic" | "rate-limit" | "transient";

/**
 * Classifies a model-call failure by type, not by blanket catch.
 * Deterministic = the call can never succeed by retrying: a schema /
 * validation failure (including the self-hosted EnrichDeterministicError
 * and the ZodError "expected object, received array"),
 * a JSON parse failure, or no model configured. Rate-limit = 429 / quota.
 * Everything else (timeouts, network blips) is transient — the batch still
 * ends at once (the budget is the retry policy now), it just isn't a
 * deterministic failure.
 */
export function classifyEnrichError(e: unknown): EnrichErrorKind {
  if (isDeterministicEnrichError(e)) return "deterministic";
  if (isRateLimitError(e)) return "rate-limit";
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  if (
    /zoderror|schema|validation|failed to parse|json|not configured|未配置|not_configured|model.*config|invalid.*response|empty response/i.test(
      msg,
    )
  )
    return "deterministic";
  return "transient";
}

/**
 * True when the error is the runtime rejecting the union schema contract
 * itself (not the model's output): the managed worker converts the Zod
 * schema to JSON Schema before the call, so a daemon that cannot express
 * the object-or-array union fails here, before any model text exists.
 * Callers fall back to the strict object schema for the rest of the run.
 * An EnrichDeterministicError is an OUTPUT failure, never a contract failure.
 */
export function isSchemaContractError(e: unknown): boolean {
  if (e instanceof EnrichDeterministicError) return false;
  if (isRateLimitError(e)) return false;
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return /json.?schema|anyof|union|schema.*(unsupported|invalid|not supported|not representable)/i.test(msg);
}

/**
 * Normalizes a batch result accepted by a loose union schema: a correct
 * {"items": [...]} object passes through, a bare top-level array is wrapped
 * as {"items": <array>} — the tolerance the o-round's bare-array ZodError
 * needed. The wrapper does no field repair: item fields are still checked
 * by the schema itself (see the .catch() defaults on non-id fields, and the
 * strict numeric `id`).
 */
export function looseItems<T>(result: { items: T[] } | T[]): T[] {
  return Array.isArray(result) ? result : result.items;
}

/**
 * Backfills batch results by the batch's own issued ids ONLY. Missing id →
 * absent from the map (the caller keeps that item's original text /
 * fallback); duplicate id → first occurrence wins; out-of-range id →
 * ignored. Never a positional fallback: an id outside [offset,
 * offset + batchLength) must not borrow a neighbouring item's summary,
 * relevance or application conditions.
 */
export function backfillEnrichResults<T extends { id: number }>(
  results: T[],
  offset: number,
  batchLength: number,
): Map<number, T> {
  const byId = new Map<number, T>();
  for (const r of results) {
    const gid = r.id;
    if (!Number.isInteger(gid) || gid < offset || gid >= offset + batchLength) continue;
    if (byId.has(gid)) continue;
    byId.set(gid, r);
  }
  return byId;
}

/**
 * Runs one model call. The call receives its budget-derived timeout. Only a
 * 429 retries, once, after the 8s backoff — and only when the budget still
 * leaves room for the retry plus a cache write. Deterministic and transient
 * errors are rethrown at once: the caller ends the batch, keeps the previous
 * summary / original text, and moves on (no split-half retry — splitting a
 * deterministically-failing batch only re-spends the budget).
 */
export async function completeEnrichment<T>(
  call: (timeoutSecs: number) => Promise<T>,
  budget?: RunBudget,
): Promise<T> {
  const timeoutSecs = budget ? timeoutSecsForCall(budget) : ENRICH_CALL_TIMEOUT_MAX_SECS;
  try {
    return await call(timeoutSecs);
  } catch (e) {
    if (classifyEnrichError(e) !== "rate-limit") throw e;
    if (!budget || budgetRemainingMs(budget) <= ENRICH_429_BACKOFF_MS + MIN_BATCH_START_MS) throw e;
    await sleepMs(ENRICH_429_BACKOFF_MS);
    return await call(timeoutSecsForCall(budget));
  }
}

/**
 * Bounds a per-URL enrichment store before writing it: current candidates
 * first, then recent entries from previous runs, at most 200 entries.
 * Shared by all three columns so a per-batch save writes exactly what the
 * end-of-load save used to write.
 */
export function boundedEnrichStore<T>(store: Record<string, T>, urls: string[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const url of urls) {
    const e = store[url];
    if (e) out[url] = e;
  }
  for (const [url, e] of Object.entries(store)) {
    if (Object.keys(out).length >= 200) break;
    if (!(url in out)) out[url] = e;
  }
  return out;
}

// --- Per-column refresh status (p-round, 2026-11-23) -----------------------
// Requirement 4: getStatus must answer "which column updated". Content time
// is read off each column's own cache row in getStatus; enrichment success
// time, latest error (+ time) and the recovered flag live in meta:status
// under `columns`, written by the helpers below. A later success clears the
// error and sets recovered=true; an error clears recovered.
export type ColumnKey = "learning" | "jiangxi" | "overseas";

export const columnStatusSchema = z.object({
  contentAt: z.string().nullable(),
  enrichAt: z.string().nullable(),
  error: z.string().nullable(),
  errorAt: z.string().nullable(),
  recovered: z.boolean(),
});

export type ColumnStatus = z.infer<typeof columnStatusSchema>;

const EMPTY_COLUMN_STATUS: ColumnStatus = {
  contentAt: null,
  enrichAt: null,
  error: null,
  errorAt: null,
  recovered: false,
};

async function readMetaStatus(ctx: Ctx): Promise<Record<string, unknown>> {
  const db = ctx.db;
  const rows = await db.select().from(schema.cacheSnapshots).where(eq(schema.cacheSnapshots.key, "meta:status")).limit(1);
  return rows[0] ? (JSON.parse(rows[0].payload) as Record<string, unknown>) : {};
}

function columnStatusesOf(prev: Record<string, unknown>): Record<string, ColumnStatus> {
  return (prev.columns as Record<string, ColumnStatus> | undefined) ?? {};
}

// --- Refresh status, corrected 2026-11-24 ---------------------------------
// Rules (user request 2026-11-24 12:51): a top-level enrich error is NEVER
// cleared by another column's success — only a success in the SAME column
// retires it, and then it moves to `errorHistory` with its occurred and
// recovered times kept. A top-level error whose column was never recorded
// (legacy records predate the column tag) stays visible as history with
// recovered = 未确认; getStatus matches it to a column only when its
// enrichErrorAt equals that column's errorAt to the second (both were
// written by the same call). "最近有内容更新" (a column's contentAt) is
// never presented as "the 08:02 scheduled refresh completed": only a run
// record written by the scheduled run itself proves that (see
// recordRefreshRun / refreshAll `source`).
export const STATUS_COLUMN_KEYS: readonly ColumnKey[] = ["learning", "jiangxi", "overseas"];

export interface StatusHistoryError {
  message: string;
  column: ColumnKey | null;
  errorAt: string | null;
  recoveredAt: string | null;
}

export interface StatusCurrentError {
  column: ColumnKey;
  error: string;
  errorAt: string | null;
}

export interface StatusLastError {
  message: string;
  column: ColumnKey | null;
  errorAt: string | null;
  /** true = the owning column later enriched successfully; false = still failing; null = cannot be determined from the records. */
  recovered: boolean | null;
  recoveredAt: string | null;
}

export type RefreshRunSource = "cron" | "manual" | "unknown";
export type RefreshRunStatus = "running" | "completed" | "failed";
export type RefreshColumnOutcome = "pending" | "ok" | "failed";
/** Alias kept for the earlier self-hosted x-round draft. */
export type RefreshRunColumnResult = RefreshColumnOutcome;

export interface RefreshRunRecord {
  startedAt: string;
  finishedAt: string | null;
  source: RefreshRunSource;
  status: RefreshRunStatus;
  columns: Record<ColumnKey, RefreshColumnOutcome>;
}

/** Alias kept for the earlier self-hosted x-round draft. */
export type HistoryErrorEntry = StatusHistoryError;

export const refreshRunSchema = z.object({
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  source: z.enum(["cron", "manual", "unknown"]),
  status: z.enum(["running", "completed", "failed"]),
  columns: z.object({
    learning: z.enum(["pending", "ok", "failed"]),
    jiangxi: z.enum(["pending", "ok", "failed"]),
    overseas: z.enum(["pending", "ok", "failed"]),
  }),
});

function asColumnKey(v: unknown): ColumnKey | null {
  return v === "learning" || v === "jiangxi" || v === "overseas" ? v : null;
}

function asColumn(v: unknown): ColumnKey | null {
  return asColumnKey(v);
}

function asIsoOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Two timestamps from one writer call can differ by the time taken between the two reads; 1s absorbs that. */
export function withinOneSecond(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return Math.abs(ta - tb) <= 1000;
}

export function parseRefreshRun(raw: unknown): RefreshRunRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.startedAt !== "string" || r.startedAt.length === 0) return null;
  const source = r.source;
  if (source !== "cron" && source !== "manual" && source !== "unknown") return null;
  const status = r.status;
  if (status !== "running" && status !== "completed" && status !== "failed") return null;
  if (r.finishedAt !== null && typeof r.finishedAt !== "string") return null;
  const cols = r.columns as Record<string, unknown> | undefined;
  if (!cols || typeof cols !== "object") return null;
  const ok = (v: unknown): v is RefreshColumnOutcome => v === "ok" || v === "failed" || v === "pending";
  if (!ok(cols.learning) || !ok(cols.jiangxi) || !ok(cols.overseas)) return null;
  return {
    startedAt: r.startedAt,
    finishedAt: (r.finishedAt as string | null) ?? null,
    source,
    status,
    columns: { learning: cols.learning, jiangxi: cols.jiangxi, overseas: cols.overseas },
  };
}

/**
 * Validates stored error-history entries: malformed entries are dropped,
 * messages are capped at 500 chars, at most 5 entries are kept.
 */
export function parseHistoryErrors(raw: unknown): StatusHistoryError[] {
  if (!Array.isArray(raw)) return [];
  const out: StatusHistoryError[] = [];
  for (const entry of raw) {
    if (out.length >= 5) break;
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.message !== "string" || e.message.length === 0) continue;
    out.push({
      message: e.message.slice(0, 500),
      column: asColumnKey(e.column),
      errorAt: asIsoOrNull(e.errorAt),
      recoveredAt: asIsoOrNull(e.recoveredAt),
    });
  }
  return out;
}

export interface StatusErrorInput {
  enrichError: string | null;
  enrichErrorAt: string | null;
  enrichErrorColumn: ColumnKey | null;
  columns: Record<ColumnKey, ColumnStatus>;
  errorHistory: HistoryErrorEntry[];
}

export interface DerivedStatusErrors {
  currentErrors: Array<{ column: ColumnKey; error: string; errorAt: string | null }>;
  lastError: {
    message: string;
    column: ColumnKey | null;
    errorAt: string | null;
    recovered: boolean | null;
    recoveredAt: string | null;
  } | null;
}

/**
 * Pure derivation of the page's error picture from the stored status
 * fields. currentErrors lists only columns whose own error is still set.
 * lastError describes the top-level slot when one is present: its owning
 * column comes from enrichErrorColumn, or — for older unlabelled
 * records — from whichever column's errorAt matches enrichErrorAt
 * within one second. recovered is true only when that same column's
 * error has cleared AND its enrichAt is later than the error; false when
 * the owning column still carries an error; null when no owner can be
 * determined (an old record must never be reported as recovered on the
 * strength of another column's success). With no top-level error, the
 * newest history entry is the last error (recovered); failing that, the
 * first current error (not recovered).
 */
export function deriveStatusErrors(input: StatusErrorInput): DerivedStatusErrors {
  const { enrichError, enrichErrorAt, enrichErrorColumn, columns, errorHistory } = input;
  const currentErrors: DerivedStatusErrors["currentErrors"] = (
    ["learning", "jiangxi", "overseas"] as const
  )
    .filter((k) => !!columns[k].error)
    .map((k) => ({ column: k, error: columns[k].error as string, errorAt: columns[k].errorAt }));
  let lastError: DerivedStatusErrors["lastError"] = null;
  if (enrichError) {
    let matched: ColumnKey | null = enrichErrorColumn;
    if (!matched) {
      for (const k of ["learning", "jiangxi", "overseas"] as const) {
        if (withinOneSecond(enrichErrorAt, columns[k].errorAt)) {
          matched = k;
          break;
        }
      }
    }
    let recovered: boolean | null = null;
    let recoveredAt: string | null = null;
    if (matched) {
      const c = columns[matched];
      if (c.error) {
        recovered = false;
      } else {
        const errAt = enrichErrorAt ?? c.errorAt;
        if (
          c.enrichAt &&
          errAt &&
          !Number.isNaN(Date.parse(c.enrichAt)) &&
          !Number.isNaN(Date.parse(errAt)) &&
          Date.parse(c.enrichAt) > Date.parse(errAt)
        ) {
          recovered = true;
          recoveredAt = c.enrichAt;
        }
      }
    }
    lastError = { message: enrichError, column: matched, errorAt: enrichErrorAt, recovered, recoveredAt };
  } else if (errorHistory.length > 0) {
    const h = errorHistory[0] as HistoryErrorEntry;
    lastError = { message: h.message, column: h.column, errorAt: h.errorAt, recovered: true, recoveredAt: h.recoveredAt };
  } else if (currentErrors.length > 0) {
    const c = currentErrors[0] as { column: ColumnKey; error: string; errorAt: string | null };
    lastError = { message: c.error, column: c.column, errorAt: c.errorAt, recovered: false, recoveredAt: null };
  }
  return { currentErrors, lastError };
}

/** Writes a refresh-run record into meta:status. A cron-sourced run also
 * becomes lastCronRun — the only record the homepage may cite as proof that
 * a scheduled 08:02 run completed. A run record is written at start
 * (status "running") and again at finish, so an interrupted run stays
 * visible as "running" instead of silently looking complete. */
async function recordRefreshRun(ctx: Ctx, run: RefreshRunRecord): Promise<void> {
  try {
    const prev = await readMetaStatus(ctx);
    const next: Record<string, unknown> = { ...prev, lastRefreshRun: run };
    if (run.source === "cron") next.lastCronRun = run;
    await writeCache(ctx, "meta:status", next);
  } catch {
    // bookkeeping only — never break a refresh over it
  }
}

/**
 * A batch enriched successfully: record the success time (enrichAt). If
 * this column had an uncleared error, the error is retired into
 * errorHistory with its recovery time and the column is marked
 * recovered. The top-level enrichError slot is retired (and cleared)
 * ONLY when it belongs to this column — its enrichErrorColumn matches,
 * or its enrichErrorAt is within one second of this column's errorAt
 * (the two timestamps of one writer call). When the top-level error
 * belongs to another column, only this column's own error enters the
 * history and the top-level slot is left exactly as it was: one column's
 * success never "recovers" another column's error.
 */
async function markColumnEnrichSuccess(ctx: Ctx, column: ColumnKey): Promise<void> {
  try {
    const prev = await readMetaStatus(ctx);
    const columns = columnStatusesOf(prev);
    const cur = columns[column] ?? { ...EMPTY_COLUMN_STATUS };
    const now = new Date().toISOString();
    columns[column] = {
      ...cur,
      enrichAt: now,
      ...(cur.error ? { error: null, recovered: true } : {}),
    };
    const next: Record<string, unknown> = { ...prev, columns };
    if (cur.error) {
      const history = parseHistoryErrors(prev.errorHistory);
      const topMessage =
        typeof prev.enrichError === "string" && prev.enrichError ? prev.enrichError : null;
      const topAt = asIsoOrNull(prev.enrichErrorAt);
      const topColumn = asColumnKey(prev.enrichErrorColumn);
      if (topMessage !== null && (topColumn === column || withinOneSecond(topAt, cur.errorAt))) {
        history.unshift({
          message: topMessage.slice(0, 500),
          column,
          errorAt: topAt ?? cur.errorAt,
          recoveredAt: now,
        });
        next.enrichError = null;
        next.enrichErrorAt = null;
        next.enrichErrorColumn = null;
      } else {
        history.unshift({
          message: cur.error.slice(0, 500),
          column,
          errorAt: cur.errorAt,
          recoveredAt: now,
        });
      }
      next.errorHistory = history.slice(0, 5);
    }
    await writeCache(ctx, "meta:status", next);
  } catch {
    // bookkeeping only
  }
}

/**
 * A batch's enrichment failed: record the error on the column itself AND
 * in the top-level slot in the same write, with ONE shared timestamp and
 * the column label (enrichErrorColumn), so getStatus can later tell
 * which column the top-level error belongs to.
 */
async function markColumnEnrichError(ctx: Ctx, column: ColumnKey, e: unknown): Promise<void> {
  try {
    const prev = await readMetaStatus(ctx);
    const columns = columnStatusesOf(prev);
    const cur = columns[column] ?? { ...EMPTY_COLUMN_STATUS };
    const message = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 500);
    const now = new Date().toISOString();
    columns[column] = { ...cur, error: message, errorAt: now, recovered: false };
    await writeCache(ctx, "meta:status", {
      ...prev,
      enrichError: message,
      enrichErrorAt: now,
      enrichErrorColumn: column,
      columns,
    });
  } catch {
    // bookkeeping only — never break a load over it
  }
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
  const key = `news:${cat.id}:v3`;
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
    await noteRefreshFailure(ctx, `分类:${cat.id}`);
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
    await noteRefreshFailure(ctx, `订阅:${feedKey}`);
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
  relevance?: string;
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
  /**
   * Which text the summary shows (p-round, 2026-11-23): enriched by the
   * latest build ("new"), enriched by an earlier build ("stored"), or the
   * source's own text because no enrichment exists ("original"). The UI
   * badges this so the reader can tell a fresh model summary from an old
   * one or from the original text.
   */
  enrichState: "new" | "stored" | "original";
  /** Curated anytime resources only: the first lesson/practice to start with. */
  startHint?: string | null;
  /** Display group assigned at read time in getLearning; absent on stored pool items. */
  group?: "anytime" | "upcoming" | null;
  /** Hand-verified AI-learning curated courses only: member of the 「AI 学习」 topic filter. */
  aiTopic?: boolean;
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

const learningEnrichItemSchema = z.object({
  id: z.number(),
  keep: z.boolean().catch(true),
  category: z.enum(["courses", "resources", "opportunities"]).catch("resources"),
  summaryZh: z.string().catch(""),
  pointsZh: z.array(z.string()).catch([]),
  audienceStage: z.string().nullable().catch(null),
  deadline: z.string().nullable().catch(null),
  fee: z.string().nullable().catch(null),
  needsApplication: z.boolean().catch(false),
});

export const learningEnrichSchema = z.object({
  items: z.array(learningEnrichItemSchema),
});

// Loose contract for the batch call (p-round, 2026-11-23): the strict object
// OR a bare array of the same items. The managed runtime converts the union
// to JSON Schema and validates either shape, so a model that returns a bare
// array no longer throws — looseItems() wraps it into {"items": [...]}.
// Item fields are still strictly checked (a non-numeric `id` fails the
// whole batch, deterministically).
export const learningEnrichLooseSchema = z.union([learningEnrichSchema, z.array(learningEnrichItemSchema)]);

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

/**
 * Pure policy news carrying no learnable content (user, 2026-11-23):
 * a regulation / measure notice （征求意见稿， 管理条例/办法/规定/细则 in
 * the TITLE — the regulation markers are title-only) whose title +
 * summary + points carry NO learnable signal （课程/公开课/讲座/回放/
 * 练习/实验/题库/CTF/慕课/训练营/学习计划/系列课/教学视频/课堂/免费
 * 开放， or a 教材 that is itself free / downloadable / openly
 * accessible). A bare 教材 does NOT count as learnable: a 条例 about
 * textbooks is a rule ABOUT teaching materials, not a resource the user
 * can learn from (the named case is 《教材管理条例（征求意见稿）》，
 * which slipped into 随时可学 only because the actionable-title regex
 * matched its bare 教材）. A regulation explainer that does carry a
 * lecture / open-class / replay signal is not misclassified.
 */
function isPolicyNewsWithoutLearnableContent(item: {
  title: string;
  summaryZh?: string | null;
  points?: string[];
}): boolean {
  const text = `${item.title} ${item.summaryZh ?? ""} ${(item.points ?? []).join(" ")}`;
  return (
    /征求意见稿|管理条例|管理办法|实施办法|管理规定|暂行办法|实施细则|试行办法/.test(item.title) &&
    !/课程|公开课|讲座|回放|回看|练习|实验|实训|题库|CTF|慕课|训练营|学习计划|系列课|教学视频|课堂|免费开放|教材[^。]{0,6}(免费|下载|开放获取)/.test(text)
  );
}

/**
 * Promo-blog / trial-only items have no concrete free learning entry
 * (user, 2026-11-23 t-round): a blog article that merely ANNOUNCES a
 * series / collection / learning plan is not a resource the user can
 * start learning from. The named case is the Coursera blog
 * "Introducing AI Series on Coursera: 12 Expert-curated learning plans
 * to help you apply AI in your field" (blog.coursera.org — behind it
 * sits Coursera Plus, $49/month with a 7-day trial that needs payment
 * details; it names no single directly-enterable free course with
 * Chinese subtitles and targets working professionals). The rule needs
 * ALL THREE signals, so a real course is untouched: (a) a blog/article
 * host (blog. subdomain, /blog/ path, or a 博客 source); (b) a title
 * announcing a series / collection / plan rather than naming a
 * specific course; (c) NO free-learning evidence anywhere in the
 * item's own text. A blog post that does state free learning stays.
 */
function isPromoBlogWithoutFreeEntry(item: {
  title: string;
  summaryZh?: string | null;
  points?: string[];
  url?: string | null;
  source?: string | null;
}): boolean {
  const url = item.url ?? "";
  const isBlogHost =
    /:\/\/blog\./i.test(url) || /\/blog\//i.test(url) || /博客/.test(item.source ?? "");
  if (!isBlogHost) return false;
  const announcesSeries =
    /introducing|推出|发布|上线|官宣|全新/i.test(item.title) &&
    /series|系列|学习计划|合集|专栏/i.test(`${item.title} ${item.summaryZh ?? ""}`);
  if (!announcesSeries) return false;
  const text = `${item.title} ${item.summaryZh ?? ""} ${(item.points ?? []).join(" ")}`;
  // Full free learning stated → it has a verifiable free entry; keep it.
  if (/免费(学习|选课|旁听|开放|注册)|可免费(学习|选课)|免费.*全部/i.test(text)) return false;
  return !/免费/.test(text);
}

/**
 * Already-awarded reports are not application opportunities (user,
 * 2026-11-23 t-round): the named case is the Lokmat Times report
 * "Airtel Foundation Grants 55 Engineering Scholarships to Chandigarh
 * University Students, Totaling Rs 7.7 Crore" — "has awarded 55
 * scholarships to engineering students at Chandigarh University" — the
 * scholarships are already GIVEN to one named university's students;
 * there is no open application window and a Jiangxi 专科 student is
 * not in scope. The standing rule already drops awards-announced items
 * （获奖名单/颁奖 in Chinese titles); this adds the English awarded /
 * grants shape and the Chinese 已发放/已颁发 shape. An item that also
 * states applications are open is never caught.
 */
function isAlreadyAwardedReport(item: {
  title: string;
  summaryZh?: string | null;
  points?: string[];
}): boolean {
  const text = `${item.title} ${item.summaryZh ?? ""} ${(item.points ?? []).join(" ")}`;
  if (
    /报名开放|正在报名|现正接受申请|接受申请|开始申请|申请开放|open for applications|now accepting applications|applications (are |now )?open/i.test(
      text,
    )
  )
    return false;
  // Count-anchored already-awarded shape (user, 2026-11-24 z-round):
  // "65351名学生荣获2025—2026学年本专科生国家励志奖学金" — a named
  // count of recipients who HAVE received the award, with the award
  // noun after it. The 可获得/将获得 guard keeps an open scholarship
  // ("100名学生可获得奖学金") out of this pattern.
  if (
    /\d+\s*名(学生|人)(荣获|获得)[^。]{0,30}(奖学金|资助|奖励)/.test(text) &&
    !/可(获得|荣获)|将(获得|荣获)|有机会(获得|荣获)/.test(text)
  )
    return true;
  return (
    /(has|have)\s+(awarded|granted|presented|distributed)\b[^。]{0,50}\b(scholarships?|awards?|grants?|prizes?)\b/i.test(
      text,
    ) ||
    /\b(grants?|awards?|presents?|distributes?)\b[^。]{0,30}?\d+\b[^。]{0,30}\b(scholarships?|awards?|grants?)\b/i.test(
      text,
    ) ||
    /已(向|给|为|经)[^。]{0,20}(发放|颁发|授予)/.test(text) ||
    /已(发放|颁发|授予)/.test(text)
  );
}

/**
 * Course / learning platform hosts: a 夜校 item whose link IS one of
 * these is a course page, not a news report, and is never caught by
 * the night-school rule below.
 */
const COURSE_PLATFORM_HOSTS = [
  "icourse163.org",
  "smartedu.cn",
  "xuetangx.com",
  "coursera.org",
  "futurelearn.com",
  "edx.org",
  "cylabacademy.org",
  "overthewire.org",
  "cl.cam.ac.uk",
];

/**
 * Night-school NEWS reports with no course entry are not learning
 * resources (user, 2026-11-24 v-round): the named case is the 广州日报
 * 大洋网 report 《@广州青年：下班后去哪儿？来青年夜校打开新生活方式》
 * (news.dayoo.com) — a lifestyle news piece about youth night schools
 * that names no specific course, no sign-up entry and no free learning
 * entry; it entered the column only because enrichment marked it
 * needsApplication （可报名）, which reads as an actionable signal. The
 * rule needs ALL THREE signals, so a real night-school course is
 * untouched: (a) the title mentions 夜校； (b) NO course evidence at
 * all — fee empty (null / 未说明）, no startHint, no deadline; (c) the
 * link is NOT a course / learning platform page. The 7 curated anytime
 * resources and the 7 AI courses all carry a fee and a startHint, so
 * they never match.
 */
function isNightSchoolNewsWithoutCourseEntry(item: {
  title: string;
  fee?: string | null;
  startHint?: string | null;
  deadline?: string | null;
  url?: string | null;
}): boolean {
  if (!/夜校/.test(item.title)) return false;
  const fee = (item.fee ?? "").trim();
  if (fee && !/未说明|未公布/.test(fee)) return false;
  if (item.startHint && item.startHint.trim()) return false;
  if (item.deadline) return false;
  const host = item.url ? hostOf(item.url) : "";
  if (host && COURSE_PLATFORM_HOSTS.some((d) => host === d || host.endsWith(`.${d}`))) return false;
  return true;
}

/**
 * Weather reports are not learning content (user, 2026-11-24
 * aa-round): the named case is a Sichuan weather news item that
 * entered the learning column marked needsApplication=true — a
 * forecast / warning report names no course, no practice and no
 * application the user can act on, whatever free-entry fragments its
 * text carries （避暑点免费开放， 学校停课）. The rule needs the
 * weather-report shape in the TITLE (weather noun + a report signal:
 * 预报/预警/实况/播报/降温/降雨/降雪/寒潮/高温/暴雨/大风） and no
 * entry evidence of the item's own: no startHint and a link that is
 * NOT a course / learning platform page. A real meteorology course
 * on a course platform is untouched.
 */
function isWeatherNewsWithoutLearningEntry(item: {
  title: string;
  startHint?: string | null;
  url?: string | null;
}): boolean {
  if (!/天气|气象/.test(item.title)) return false;
  if (!/预报|预警|实况|播报|降温|降雨|降雪|寒潮|高温|暴雨|大风/.test(item.title)) return false;
  if (item.startHint && item.startHint.trim()) return false;
  const host = item.url ? hostOf(item.url) : "";
  if (host && COURSE_PLATFORM_HOSTS.some((d) => host === d || host.endsWith(`.${d}`))) return false;
  return true;
}

/**
 * z-round two-class gate (user, 2026-11-24): a pool item stays in the
 * learning column ONLY when it fits one of the user's two classes —
 * 随时可学 or 近期可报名 — judged on its own stored evidence, never on
 * the bare needsApplication flag. needsApplication=true alone proves
 * nothing: the Education Times weekly admissions/scholarships roundup,
 * the BERNAMA ARTIVO primary-school scholarship, the ifeng Sichuan
 * 励志奖学金获奖名单， the GET2026 closed-door forum invite and the
 * FutureLearn humanitarian-programmes blog all carried
 * needsApplication=true with fee null and no verified entry, and all
 * five entered the column (four of them as group=null, i.e. under the
 * client's 「其他学习机会」). Either helper returning true keeps the
 * item; otherwise it is dropped entirely and never reaches that group,
 * because the gate runs before grouping in getLearning, at ingest in
 * loadLearning, and in the getDailyDigest learning loop.
 */
type LearningGateItem = {
  title: string;
  summaryZh?: string | null;
  points?: string[];
  audienceStage: string | null;
  deadline: string | null;
  needsApplication?: boolean;
  url?: string | null;
  source?: string | null;
  fee?: string | null;
  startHint?: string | null;
  category?: LearningCategory;
  officialUrl?: string | null;
};

/** Free-entry evidence for a learnable entry: the fee field says 免费
 * (a bare 免费试听 never counts — the trial rule upstream already drops
 * those), a startHint names the first lesson, or the item's own text
 * binds 免费 DIRECTLY to a learnable entry （免费课程/免费公开课/免费
 * 学习/免费选课/免费旁听/免费注册/免费练习/免费实验/免费回放/免费
 * 慕课/免费题库/免费训练营/免费系列课/免费教学视频/免费开放课程，
 * 可免费学习/选课/旁听， or 课程/公开课/讲座/学习/选课/练习/实验
 * 免费）. Free registration and certificate-only charges keep the
 * item. Tightened 2026-11-24 (aa-round): the z-round pattern allowed
 * 免费 up to 8 chars before the noun and counted a bare 免费开放 on
 * its own — a Sichuan weather report (shelters / scenic spots 免费
 * 开放， classes suspended 停课） and roundup / solicitation texts
 * with an incidental 免费…课程 fragment passed on fragments that say
 * nothing about a free course entry of the item itself. A bare 免费
 * elsewhere （答案几乎免费， 免费参与一场论坛， 免费开放征集） is NOT
 * free-entry evidence. */
function hasVerifiedFreeEntry(item: LearningGateItem, text: string): boolean {
  const fee = item.fee ?? "";
  if (/免费/.test(fee) && !/试听/.test(fee)) return true;
  if (item.startHint && item.startHint.trim()) return true;
  return /免费(学习|选课|旁听|注册|课程|公开课|讲座|练习|实验|实训|回放|回看|慕课|题库|训练营|系列课|教学视频|开放课程)|可免费(学习|选课|旁听)|(课程|公开课|讲座|学习|选课|练习|实验)免费/i.test(
    text,
  );
}

/**
 * 随时可学 (user, 2026-11-24 z-round): the item names a concrete
 * learnable entry — 课程/公开课/讲座/回放/回看/练习/实验/实训/题库/
 * CTF/慕课/训练营/学习计划/系列课/教学视频/课堂/开放教材/录像/靶场/
 * 英语/日语/韩语/语言学习， a free textbook （教材＋免费/下载/开放
 * 获取）, or the English course/lecture/tutorial/bootcamp/lab/MOOC —
 * or it links straight to a known course platform
 * (COURSE_PLATFORM_HOSTS) — AND free entry is verified by
 * hasVerifiedFreeEntry. The platform-host alternative is what keeps a
 * bare-titled MOOC page (e.g. the curated 北理工网安课's MOOC twin,
 * whose title/summary name no 课）: platform + verified-free is itself
 * a free course entry. A FutureLearn/Coursera BLOG page on the same
 * host fails here: its fee is null and its text states no free entry.
 */
function isAnytimeLearnable(item: LearningGateItem): boolean {
  const text = `${item.title} ${item.summaryZh ?? ""} ${(item.points ?? []).join(" ")}`;
  if (!hasVerifiedFreeEntry(item, text)) return false;
  // The bare character 课 no longer counts as a learnable signal
  // (aa-round, 2026-11-24): it matched 停课 in weather reports and
  // 课 in unrelated compounds, none of which name a course, practice
  // or replay entry the user can start.
  const learnableText =
    /课程|公开课|讲座|回放|回看|练习|实验|实训|题库|CTF|慕课|训练营|学习计划|系列课|教学视频|课堂|开放教材|录像|靶场|英语|日语|韩语|语言学习|教材[^。]{0,6}(免费|下载|开放获取)|\b(courses?|lectures?|tutorials?|bootcamps?|labs?|mooc)\b/i.test(
      text,
    );
  if (learnableText) return true;
  const host = item.url ? hostOf(item.url) : "";
  return (
    !!host &&
    COURSE_PLATFORM_HOSTS.some((d) => host === d || host.endsWith(`.${d}`))
  );
}

/**
 * 近期可报名 (user, 2026-11-24 z-round): ALL of these must hold —
 * (a) needsApplication is true; (b) a confirmed official entry exists
 * (officialUrl, the stored proxy for a 主办方官方报名入口 — note a
 * direct-feed item carries officialUrl=url, so (b) alone proves nothing
 * and (c)–(e) do the real work); (c) free application is confirmed —
 * the fee field says 免费 or the text states 报名免费/申请免费/
 * 免报名费/免费报名/免申请费； (d) currently open — a future deadline,
 * or open/rolling wording （报名开放/正在报名/现正接受申请/接受申请/
 * 开始申请/申请开放/申请进行中/长期开放/滚动报名/常年开放/随时报名/
 * 全年开放/全年接受…); (e) the stated scope includes a Jiangxi 专科
 * 在读生 （专科/高职/大专/大学生/高校学生/在校大学生/不限/所有学生）
 * and is NOT restricted to another country's students — the NASA Moon
 * Base Student Challenge reports are the named case: open and dated
 * (registration open through Jan. 25, 2027) but fee unverified and
 * US-only (U.S. high school / post-secondary teams at eligible US
 * institutions), so they fail (b)/(c)/(e) together. A rolling /
 * long-term-open project may have no deadline. aa-round (2026-11-24):
 * (b) additionally rejects roundup titles and redirect-wrapper links
 * (see below), and (e)'s 不限 must be an education-scope 不限 — a
 * public solicitation's 不限年龄/不限地域 does not put a Jiangxi
 * 专科在读生 in scope.
 */
function isUpcomingClass(item: LearningGateItem, todayStr: string): boolean {
  if (item.needsApplication !== true) return false;
  if (!item.officialUrl) return false;
  // aa-round (2026-11-24): an aggregation is not an application entry.
  // A roundup title （汇总/盘点/一览/合集/WEEKLY ALERTS) aggregates
  // many programmes' deadlines — the item itself has no single
  // organizer application page, however official-looking its extracted
  // link is (the Education Times weekly roundup's "official" link was
  // an Outlook safelinks redirect). A redirect-wrapper URL is likewise
  // never a 主办方官方报名入口.
  if (/汇总|盘点|一览|合集|weekly alerts|roundup/i.test(item.title)) return false;
  const officialHost = hostOf(item.officialUrl);
  if (officialHost === "safelinks.protection.outlook.com" || officialHost.endsWith(".safelinks.protection.outlook.com"))
    return false;
  const text = `${item.title} ${item.summaryZh ?? ""} ${(item.points ?? []).join(" ")}`;
  const feeFree = (item.fee ?? "").includes("免费") && !/试听/.test(item.fee ?? "");
  const textFeeFree =
    /报名免费|申请免费|免报名费|免费报名|免申请费|no application fee|free (to )?apply|application is free/i.test(
      text,
    );
  if (!feeFree && !textFeeFree) return false;
  const open =
    (item.deadline != null && item.deadline >= todayStr) ||
    /报名开放|正在报名|现正接受申请|接受申请|开始申请|申请开放|申请进行中|长期开放|滚动报名|常年开放|随时报名|全年开放|全年接受|open for applications|now accepting applications|applications (are |now )?open|registration (is )?open|rolling admission/i.test(
      text,
    );
  if (!open) return false;
  const scopeText = `${item.audienceStage ?? ""} ${text}`;
  if (
    /仅限[^。]{0,12}美国|美国(高中生|大学生|在校学生|学生)|U\.?S\. (high school|post-secondary|college) students?|eligible US institutions|only (for )?U\.?S\. (students|residents|citizens)/i.test(
      scopeText,
    )
  )
    return false;
  // Scope evidence (aa-round tightening): a bare 不限 no longer
  // counts — public solicitations say 不限年龄/不限地域 without
  // including a Jiangxi 专科在读生 in any verified sense; only an
  // education-scope 不限 （学历/专业/学校/年级不限 or the reverse
  // order) or an explicit student scope counts.
  return /(专科|高职|大专|大学生|高校学生|在校大学生|所有学生|(学历|专业|学校|年级)不限|不限(学历|专业|学校|年级))/.test(scopeText);
}

/**
 * Learning-column rule (user, 2026-11-22): category 4 （学习与实践） keeps
 * ONLY what the user can still act on — skills competitions, free courses
 * or labs, language learning and language-exam registration that he can
 * still sign up for, watch a replay of, or start learning directly. This
 * strict filter applies to the FULL learning list (the getLearning
 * handler re-applies it to every response), not only to the homepage
 * digest strips. Hidden: opportunities whose deadline has already
 * passed; reports of events that are already over （研讨会/研讨活动
 * without an open call, 收官/落幕/闭幕， 赛报/获奖/一等奖， 获奖名单，
 * 圆满结束… — unless a replay is offered); items aimed at a
 * school stage that is not his — 中小学/初中/高中 students, or 博士/硕士
 * 研究生 admissions (he is a 专科 student); pure news reports and
 * industry forums; and items that clearly do not apply to him — open
 * only to one foreign country's students/residents （只限巴基斯坦、只限
 * 马来西亚…), to one specific employer's / organisation's employees or
 * their children (only for employees / employees' children / 只限…员工
 * （子女）— the WCMA dairy-company scholarships are the named case), or
 * an intake month that is already past. When nothing
 * qualifies, the column is honestly empty rather than padded with news.
 *
 * 2026-11-22 follow-up (three more named cases, all deterministic):
 * activity write-ups whose summary dates the event in the past
 * ("X月X日……举行/举办/召开", no replay and no sign-up — the 东湖
 * "江城群星" 大咖公开课 report); 专硕/学硕 wording, which is master's
 * stage even though it never spells out 硕士 (the Sohu 专硕 dorm-policy
 * news — also a pure policy report with nothing to join or learn);
 * and scholarships/opportunities limited to one local school
 * district's students or to high-school students only (the Yahoo /
 * News-Press NOW St. Joseph item: "St. Joseph School District juniors
 * and seniors can apply for a new scholarship…", high-school juniors
 * and seniors earning college credit while still in high school).
 *
 * 2026-11-23 follow-up (three more named cases): the wrong-stage
 * signals are now matched against title + summary + points +
 * audienceStage together — the Santa Cruz County middle-schools e-bike
 * safety class (middle school stage), the 「多所高校不给研究生宿舍」
 * discussion (master's stage, bare 研究生 in the title), and the HKU
 * robotics undergraduate item whose JUPAS / 中六 signals sit in its
 * summary and points rather than its title.
 */
function isLearningNotActionable(
  item: {
    title: string;
    summaryZh?: string | null;
    points?: string[];
    audienceStage: string | null;
    deadline: string | null;
    needsApplication?: boolean;
    url?: string | null;
    source?: string | null;
    fee?: string | null;
    startHint?: string | null;
    category?: LearningCategory;
    officialUrl?: string | null;
  },
  todayStr: string,
): boolean {
  const { title, audienceStage, deadline } = item;
  if (deadline && deadline < todayStr) return true;
  const t = title;
  const text = `${t} ${item.summaryZh ?? ""} ${(item.points ?? []).join(" ")}`;
  // Already-finished events and write-ups of them.
  if (/研讨会|研讨活动/.test(t) && !/报名|征集|将于|预告/.test(t)) return true;
  if (/圆满(结束|落幕|举行)|落下帷幕|成功(举办|召开|举行)|完美收官|圆满收官|获奖名单|颁奖(典礼|仪式)/.test(t)) return true;
  // Bare closing / results wording (user, 2026-11-22 follow-up): the fixed
  // phrases above miss a plain 收官/落幕/闭幕 in a title （零碳大赛宁德收官）
  // and results write-ups （赛报/获奖/一等奖 — the 广西信息素养挑战赛赛报）.
  // Both groups mark a finished event — unless a replay is offered, in
  // which case the user can still watch it and the item stays.
  // （赛报 is matched only as a leading/section word — a bare substring
  // test would also hit 竞赛报名， i.e. "registration open", the opposite.)
  if (
    (/(收官|落幕|闭幕|获奖|一等奖)/.test(t) || /(^|[\s|｜【〔])赛报/.test(t)) &&
    !/(回放|回看)/.test(text)
  )
    return true;
  // Activity write-ups whose own summary dates the event in the past
  // (user, 2026-11-22 follow-up): an activity-type title （公开课/大咖课/
  // 讲座/论坛…) whose summary/points say "X月X日……举行/举办/召开" for a
  // date that is not in the future, with no replay and no sign-up entry
  // anywhere in the text, is a report of an event that already happened.
  // The named case is the Sohu 东湖 "江城群星" 大咖公开课 (held
  // 2026-11-21, aimed at Wuhan entrepreneurs/executives): its title
  // carries no finished-word and 公开课 even reads as an actionable
  // signal, but the summary states it was held on 11月21日. A future
  // marker （将于/即将/拟于/定于） before the date, a later date, or any
  // 报名/回放/回看 in the text keeps the item — a lecture still
  // enrolling or offering a replay is still actionable and stays.
  // The gap between the date and the verb is allowed up to 60 chars
  // (2026-11-22 follow-up): the 东湖 item's real stored summary reads
  // "11月21日，由武汉市经济和信息化局主办、华中科技大学承办的"江城
  // 群星"年度大咖课举行" — 35 chars of organiser + course name sit
  // between 日 and 举行， so the original 30-char window returned null
  // and the item survived. 60 covers that with headroom while still
  // staying inside the same sentence (。 is excluded from the gap).
  if (
    /(公开课|大咖课|讲座|论坛|峰会|沙龙|分享会|研讨班|培训班)/.test(t) &&
    !/(回放|回看|报名)/.test(text)
  ) {
    const held = /(\d{1,2})\s*月\s*(\d{1,2})\s*日[^。]{0,60}?(举行|举办|召开|开讲)/.exec(text);
    if (held) {
      const before = text.slice(Math.max(0, held.index - 12), held.index);
      if (!/(将|拟|定于|即将)/.test(before)) {
        const em = Number(held[1]);
        const ed = Number(held[2]);
        const tm = Number(todayStr.slice(5, 7));
        const td = Number(todayStr.slice(8, 10));
        if (em < tm || (em === tm && ed <= td)) return true;
      }
    }
  }
  // Wrong school stage: primary / secondary school audiences.
  if (/中小学|中小学生|小学生|初中生|高中生|九年一贯制/.test(t)) return true;
  // Graduate admissions are not his stage either.
  if (/(博士|硕士)研究生招生|招收(博士|硕士)研究生/.test(t)) return true;
  // 专硕 / 学硕 are the professional / academic MASTER's degrees — the
  // same wrong stage as 硕士 even though the two characters never spell
  // it out (user, 2026-11-22 follow-up; the named case is the Sohu
  // report that many universities house no 专硕 students on campus —
  // a pure policy story with nothing to sign up for or learn, which
  // survived only because its title's 招生章程 read as an actionable
  // signal and 专硕 never matched the 硕士 patterns above).
  if (/(专硕|学硕)/.test(text)) return true;
  // Wrong-stage signals across ALL of the item's own text (user rule,
  // 2026-11-23): the stage is not always in the title — the HKU
  // robotics undergraduate item states JUPAS / 中六 only in its summary
  // and points, the Santa Cruz e-bike safety class is for "middle
  // schools", and the dorm discussion 「多所高校不给研究生宿舍」 is
  // master's-stage by its title's bare 研究生 without any 招生 wording
  // (the title-only patterns above all missed one of the three). Any
  // hit in title + summary + points + audienceStage excludes the item:
  // middle school(s), 中小学， 初中， 高中生， 中六， JUPAS, DSE,
  // 研究生 / 硕士研究生.
  const stageText = `${text} ${audienceStage ?? ""}`;
  if (/\bmiddle schools?\b/i.test(stageText)) return true;
  if (/中小学|初中|高中生|中六|研究生/.test(stageText)) return true;
  if (/\bJUPAS\b/i.test(stageText) || /\bDSE\b/i.test(stageText)) return true;
  if (audienceStage && /小学|初中|中小学|高中/.test(audienceStage)) return true;
  if (audienceStage && /(博士|硕士|专硕|学硕)/.test(audienceStage) && !/不限|专科|高职|大学生|本科/.test(audienceStage)) return true;
  // Internship postings live in category 3 （海外实习、工作与签证） — the
  // learning column links across to them instead of listing them here.
  if (/实习(生)?(招聘|岗位|招募|招收)|招聘实习生/.test(t)) return true;
  // Clearly not applicable to him: the offer is for one foreign country's
  // own students/residents only (the Pakistan HEC Coursera licences, the
  // Malaysia-only scholarship) — a Chinese student in Jiangxi cannot take
  // part, however free or well-meant it is.
  if (
    /(适合|面向|仅限|只限|专供|供)\s*(巴基斯坦|马来西亚|Pakistan|Malaysia)|(巴基斯坦|马来西亚)(高校|大学生|学生|居民)/i.test(
      text,
    )
  )
    return true;
  if (/不适用于(我|中国)|仅限[^。]{0,10}(公民|居民|学生)(申请|参加)?/.test(text)) return true;
  // Clearly not applicable to him: the offer is restricted to one specific
  // employer's / organisation's employees or their children (the WCMA
  // dairy-company scholarships, WSAU 2026-11-19 — its stored text reads
  // "Any employee or child of an employee at a WCMA dairy manufacturing,
  // processing, or …", a SINGULAR "child of an employee" wording the
  // plural-only patterns missed; he is neither an employee of a WCMA
  // member company nor an employee's child there, so he cannot apply).
  // Same treatment as the single-foreign-country offers above (user
  // rule, 2026-11-22; singular-form patterns added 2026-11-22 follow-up).
  if (
    /only for (the )?employees|children of employees|employ\w+('s|s')? children/i.test(text) ||
    /child(ren)? of (an?|the)? (employee|staff)/i.test(text) ||
    /employee(s)? or (a )?child of/i.test(text) ||
    /(只限|仅限|仅面向|只面向)[^。]{0,16}(员工|职工)/.test(text) ||
    /(员工|职工)(或其|及其)?的?(子女|孩子)/.test(text)
  )
    return true;
  // Clearly not applicable to him: a scholarship / opportunity limited
  // to one local school district's students, or to high-school (and
  // below) students only (user, 2026-11-22 follow-up). The named case
  // is the Yahoo / News-Press NOW item "New scholarship helps St.
  // Joseph students earn college credit": its real summary reads "St.
  // Joseph School District juniors and seniors can apply for a new
  // scholarship that covers tuition for one Missouri Western State
  // University course per semester" — high-school juniors/seniors of
  // one Missouri school district, earning college credit while still
  // in high school. Matched on the item's own title/summary/points in
  // both languages: at ingest the raw English summary carries "school
  // district" / "juniors and seniors" / "high school students"; the
  // stored Chinese rendering carries 学区 / 高中生 / 高二·高三 signals.
  // High-school athlete / football signals (2026-11-22 follow-up): the
  // People item "Deaf Student-Athlete Earns 10 College Scholarship
  // Offers Following Successful High School Career" carries none of the
  // signals above — its stored text only says "High School Football
  // Career" — yet it is a US high-school athlete's scholarship story,
  // not something a Jiangxi 专科 student can use. "High School
  // Football" / "high school athlete" wording is treated the same way:
  // high-school stage, out of the learning column.
  if (
    /juniors and seniors/i.test(text) ||
    /high school students/i.test(text) ||
    /\bstill in high school\b/i.test(text) ||
    /\bhigh school football\b/i.test(text) ||
    /\bhigh school athletes?\b/i.test(text) ||
    /\bschool district\b/i.test(text) ||
    /学区[^。]{0,20}(奖学金|申请|学生|高中生)/.test(text) ||
    /(面向|适合|仅限|只限|针对)[^。]{0,14}(高中生|中学生|初中生|小学生)/.test(text) ||
    /(高二|高三)(学生|年级|的同学)/.test(text)
  )
    return true;
  // Expired intake: the stated 入学/开学/开课 month is already past, even
  // when no formal deadline field was extracted (the Malaysia scholarship
  // was for a 2026 年 4 月 intake).
  const intake = text.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月[^。]{0,12}(入学|开学|开课|入读)/);
  if (intake) {
    const iy = Number(intake[1]);
    const im = Number(intake[2]);
    const ty = Number(todayStr.slice(0, 4));
    const tm = Number(todayStr.slice(5, 7));
    if (iy < ty || (iy === ty && im < tm)) return true;
  }
  // Industry forums / summits are not something a student joins to learn:
  // no student-facing sign-up, contest or course in the title → out (the
  // GET2026 ClassIn AI 教培生态论坛 is the shape this removes).
  if (/(论坛|峰会)/.test(t) && !/(学生|竞赛|大赛|报名|课程|讲座|公开课)/.test(t)) return true;
  // Pure policy news with no learnable content (user, 2026-11-23): a
  // 征求意见稿 / 管理条例·办法 notice is a rule, not a resource — out,
  // even when its title's bare 教材 would otherwise read as an
  // actionable signal below. Shared by ingest, every getLearning read
  // and the getDailyDigest learning loop via this one function.
  if (isPolicyNewsWithoutLearnableContent(item)) return true;
  // Promo blog / trial-only items with no concrete free learning entry
  // (user, 2026-11-23 t-round): a series announcement on a blog host
  // with no free-learning evidence in its own text is not a resource
  // the user can start — the Coursera blog case. A real course on a
  // course platform, or a blog post that does state free learning, is
  // untouched by the helper's three-signal conjunction.
  if (isPromoBlogWithoutFreeEntry(item)) return true;
  // Limited-time trial only, with no full free-learning statement
  // (user, 2026-11-23 t-round): 免费试听 / 试听 / 试用 / 限时体验
  // means the free scope cannot be verified — out, unless the item
  // also states the course itself can be learned for free.
  if (
    /限时(免费|试听|体验)|免费试听|试听|试用/i.test(text) &&
    !/免费(学习|选课|旁听|开放|注册)|可免费(学习|选课)|免费.*全部/i.test(text)
  )
    return true;
  // Already-awarded reports (user, 2026-11-23 t-round): scholarships
  // or awards already granted to named recipients, with no open
  // application window — the Airtel case. The standing rule already
  // drops awards-announced items; this covers the English/已发放
  // phrasings it missed.
  if (isAlreadyAwardedReport(item)) return true;
  // Night-school news reports with no course entry (user, 2026-11-24
  // v-round): a 夜校 lifestyle news piece with no fee, no startHint,
  // no deadline and a non-course-platform link is pure news — out,
  // even when enrichment marked it needsApplication. The 广州日报
  // 大洋网 youth-night-school report is the named case.
  if (isNightSchoolNewsWithoutCourseEntry(item)) return true;
  // Weather reports with no learning entry (user, 2026-11-24
  // aa-round): a Sichuan weather news item marked needsApplication
  // is pure news — out, whatever free-entry fragments its text
  // carries. A course-platform meteorology course is untouched.
  if (isWeatherNewsWithoutLearningEntry(item)) return true;
  // Two-class gate (user, 2026-11-24 z-round): a pool item stays ONLY
  // when it fits 随时可学 (a concrete free course / practice / replay
  // entry) or 近期可报名 (confirmed official entry + currently open +
  // free application + 专科在读 in scope). The old check below it let
  // anything with needsApplication=true through, which is how the
  // Education Times roundup, the BERNAMA primary-school scholarship,
  // the ifeng awarded-list report, the GET2026 forum invite and the
  // FutureLearn blog all entered with fee null and no verified entry.
  // Neither class → dropped entirely, never re-shown under 「其他」:
  // this filter runs before grouping in getLearning, at ingest in
  // loadLearning, and in the getDailyDigest learning loop.
  //
  // Class coherence (aa-round, 2026-11-24): an opportunities-category
  // item is an APPLICATION item — it can only qualify through the
  // 近期可报名 class, never through 随时可学 text fragments. The four
  // items the user named this round (a Sichuan weather report, an
  // overseas scholarship roundup, two similar moon-idea solicitation
  // reports — all needsApplication=true, fee unverified, group empty)
  // survived the z-round gate exactly that way: stray free-entry
  // fragments in their text passed isAnytimeLearnable, yet as
  // opportunities items they belonged to neither display group and
  // surfaced under the client's 「其他学习机会」 with group=null.
  // Courses / resources items keep both paths: a free course that
  // itself runs an open, free, in-scope application still qualifies.
  if (item.category === "opportunities") {
    if (!isUpcomingClass(item, todayStr)) return true;
  } else if (!isAnytimeLearnable(item) && !isUpcomingClass(item, todayStr)) {
    return true;
  }
  return false;
}

type LearningCandidate = FeedItem & {
  hint: LearningCategory;
  chineseUrl: string | null;
  feed: string;
  directFeed: boolean;
  isSearch: boolean;
  officialHint: string | null;
};

/**
 * Same-course dedupe (z-round, 2026-11-24): one course listed under two
 * platform entries is ONE course. Key = the title with punctuation,
 * spacing and dash variants stripped, plus the school: the school named
 * in the title first, else the school from the source (tail after · or /),
 * each only when it contains 大学/学院/学校 — so 「网络安全-应用技术与工程实践（北京理工大学）」 (the
 * 学堂在线 entry in CURATED_LEARNING_ANYTIME) and 「网络安全——应用
 * 技术与工程实践（北京理工大学）」 (the MOOC entry in
 * CURATED_LEARNING_AI) match, while every other course keeps its own
 * key. Within a group the entry carrying aiTopic=true wins, so the
 * survivor stays in both 随时可学 and the 「AI 学习」 filter; the
 * survivor keeps its own url / source / startHint. Applied at ingest
 * in loadLearning (so the persisted cache and getDailyDigest, which
 * reads through loadLearning, agree) and on every getLearning read
 * over the merged curated + pool list (so cached payloads written
 * before this rule are corrected too).
 */
export function collapseSameCourseEntries<T extends { title: string; source?: string | null; aiTopic?: boolean }>(items: T[]): T[] {
  const titleSchoolOf = (title: string): string =>
    title.match(/（([^）]+)）\s*$/)?.[1] ?? "";
  const schoolOfSource = (source?: string | null): string => {
    if (!source) return "";
    const tail = source.split(/[·/]/).pop()?.trim() ?? "";
    return tail.replace(/（[^）]*）\s*$/, "").replace(/\([^)]*\)\s*$/, "").trim();
  };
  const schoolOf = (it: T): string => {
    const fromTitle = titleSchoolOf(it.title);
    if (/大学|学院|学校/.test(fromTitle)) return fromTitle;
    const fromSource = schoolOfSource(it.source);
    if (/大学|学院|学校/.test(fromSource)) return fromSource;
    return fromTitle;
  };
  const keyOf = (it: T): string => {
    const core = it.title
      .replace(/[（）()]/g, "")
      .replace(/[\s\-—–·、。，；：？！《》〈〉「」『』""''‐‑]/g, "")
      .toLowerCase();
    return `${core}|${schoolOf(it)}`;
  };
  const best = new Map<string, T>();
  for (const it of items) {
    const k = keyOf(it);
    const prev = best.get(k);
    if (!prev || (it.aiTopic === true && prev.aiTopic !== true)) best.set(k, it);
  }
  const kept = new Set(best.values());
  return items.filter((it) => kept.has(it));
}

async function loadLearning(
  ctx: Ctx,
  force: boolean,
  budget: RunBudget = newRunBudget(),
): Promise<{ items: LearningItem[]; asOf: string }> {
  if (!force) {
    const cached = await readCache<LearningItem[]>(ctx, "learning:all:v3", LEARNING_TTL_MS);
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
    await noteRefreshFailure(ctx, "学习");
    const stale = await readCacheStale<LearningItem[]>(ctx, "learning:all:v3");
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
        it.summary = truncateAtBoundary(`${it.summary} ${meta.summary}`, 350);
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
      `- keep：是否真的对学生学习有用（课程/讲座、学习资源、或可报名的竞赛/暑期学校/奖学金等机会）。教材出版、学习工具、教育资源类资讯，只要对学生或教师的学习有实际参考价值，也 keep=true。纯娱乐、明星八卦、招生广告软文、培训机构广告、与学习无关的新闻，keep=false。已经结束的活动报道（如已召开的研讨会、论坛回顾、获奖名单、大赛收官/落幕/闭幕的报道、赛报和获奖喜报——除非明确提供回放/回看），以及只面向中小学生或博士/硕士研究生的内容，对一位专科在读生没有可行动价值，keep=false。纯新闻报道（时事评论、行业动态、企业产品或合作消息、大学项目介绍）即使与教育有关也不是能参加的学习内容，keep=false；面向行业从业者的论坛、峰会，keep=false；只面向某个外国国家本国学生/居民的机会（如仅限巴基斯坦、马来西亚学生），只限某一特定企业/机构员工或其子女的机会（如仅限乳制品企业员工子女的 WCMA 奖学金），以及入学时间已经过去的招生，keep=false。本栏只留他现在还能报名、能看回放或能直接开始学的内容，宁缺毋滥。\n` +
      `- category：courses（课程与讲座）/ resources（学习资源）/ opportunities（学生机会），以内容为准，可修正类别提示。\n` +
      `- summaryZh：用一句中文说清「适合谁、能学到什么」。只能依据摘要里已有的信息写（摘要是英文的就翻译提炼），不要编造课程内容、机构承诺或数字。条目标注「无摘要，仅有标题」时，summaryZh 必须留空字符串——绝不根据标题猜测正文。\n` +
      `- pointsZh：2-3 条中文要点，逐条只能来自摘要原文的信息（英文摘要翻译成中文）；无摘要的条目留空数组。\n` +
      `- audienceStage：适用学段（如 小学/初中/高中/本科/硕士研究生/博士研究生/不限）。标题或摘要明确提到、或标题本身明确限定（如“博士研究生招生简章”“中学生暑期课程”）时就填——即使该条无摘要，也可以依据标题中明确写出的学段填；都没有才填 null。\n` +
      `- deadline：报名截止日期，只有标题或摘要明确写出具体日期时才填，格式 YYYY-MM-DD；只写“即将截止”“倒计时”而没有具体日期的，填 null。\n` +
      `- fee：费用，只有标题或摘要明确写出时才填（如“免费”“学费 2 万元”“报名费 180 元”），没写就填 null（页面会显示「未公布」，不要猜）。\n` +
      `- needsApplication：这条是否需要报名/申请才能参加。\n\n只返回一个 JSON 对象，形状固定为 {"items":[...]}，不要输出其他任何文字；每条结果保留输入编号对应的 id（即 [n] 中的 n），结果顺序可以与输入不同。\n\n${listing}`
    );
  };

  type EnrichResult = z.infer<typeof learningEnrichSchema>["items"][number];
  // URLs enriched by THIS run's batches (for the per-item enrichState badge);
  // URLs the model dropped (keep=false) in this run.
  const newlyEnrichedUrls = new Set<string>();
  const droppedUrls = new Set<string>();
  let enrichErrorRecorded = false;
  const recordEnrichError = async (e: unknown, batchStart: number) => {
    if (enrichErrorRecorded) return;
    enrichErrorRecorded = true;
    try {
      const db = ctx.db;
      const rows = await db.select().from(schema.cacheSnapshots).where(eq(schema.cacheSnapshots.key, "meta:status")).limit(1);
      const prev = rows[0] ? (JSON.parse(rows[0].payload) as Record<string, unknown>) : {};
      const columns = (prev.columns as Record<string, ColumnStatus> | undefined) ?? {};
      const cur = columns.learning ?? { ...EMPTY_COLUMN_STATUS };
      // One timestamp for both stamps, plus the column tag: a later reader
      // must be able to tell that this top-level error IS the learning
      // column's error of this batch (2026-11-24 status fix).
      const message = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 500);
      const now = new Date().toISOString();
      columns.learning = {
        ...cur,
        error: message,
        errorAt: now,
        recovered: false,
      };
      await writeCache(ctx, "meta:status", {
        ...prev,
        enrichError: message,
        enrichErrorAt: now,
        enrichErrorColumn: "learning",
        enrichBatch: batchStart,
        columns,
      });
    } catch {
      // ignore bookkeeping failures
    }
  };
  // Fold one batch result into the persistent enrichment store. Runs per
  // batch (not once at the end), so a run killed after batch N keeps
  // batch N's results.
  const foldResult = (url: string, r: EnrichResult): boolean => {
    if (!r.keep) {
      droppedUrls.add(url);
      return false;
    }
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
    newlyEnrichedUrls.add(url);
    return true;
  };
  // Whether the loose (object-or-array) contract is still in use for this
  // run: if the runtime rejects the union schema itself, fall back to the
  // strict object schema for this and later batches.
  let looseSchemaOk = true;
  // Small batches: a 10-item call measurably exceeded the inference timeout
  // (a 6-item call takes ~75s), which is why enrichment results kept being
  // lost. 5 items per batch, run SERIALLY with a pause between calls — see
  // the pacing note at completeEnrichment. A failed batch ends at once
  // (p-round, 2026-11-23): deterministic errors never retry, 429s retry
  // once inside completeEnrichment when the budget allows, and there is no
  // split-half retry any more — the items stay fresh, so the next run
  // resumes from them instead of re-spending this run's budget.
  const enrichBatch = async (batch: LearningCandidate[], offset: number): Promise<boolean> => {
    if (!budgetCanStartBatch(budget)) return false;
    const attempt = async (schema: typeof learningEnrichSchema | typeof learningEnrichLooseSchema) =>
      completeEnrichment(
        (timeoutSecs) =>
          completeInference(ctx, enrichPrompt(batch, offset), {
            schema,
            timeout_secs: timeoutSecs,
          }),
        budget,
      );
    let raw: z.infer<typeof learningEnrichLooseSchema>;
    try {
      raw = looseSchemaOk ? await attempt(learningEnrichLooseSchema) : await attempt(learningEnrichSchema);
    } catch (e) {
      if (looseSchemaOk && isSchemaContractError(e)) {
        looseSchemaOk = false;
        try {
          raw = await attempt(learningEnrichSchema);
        } catch (e2) {
          await recordEnrichError(e2, offset);
          return false;
        }
      } else {
        await recordEnrichError(e, offset);
        return false;
      }
    }
    const results = backfillEnrichResults(looseItems(raw), offset, batch.length);
    let batchEnriched = 0;
    for (const [gid, r] of results) {
      const url = fresh[gid]?.url;
      if (!url) continue;
      if (foldResult(url, r)) batchEnriched++;
    }
    // Save this batch's results NOW (p-round, 2026-11-23): the old code
    // folded everything only after all batches, so a kill mid-run lost
    // every finished batch. A missing id simply stays fresh for next run.
    if (batchEnriched > 0 || droppedUrls.size > 0) {
      await writeCache(ctx, "learning:enrich:v2", boundedEnrichStore(enrichStore, candidates.map((c) => c.url)));
      await markColumnEnrichSuccess(ctx, "learning");
    }
    return batchEnriched > 0;
  };
  const batches: LearningCandidate[][] = [];
  for (let s = 0; s < fresh.length; s += 5) batches.push(fresh.slice(s, s + 5));
  for (const [bi, batch] of batches.entries()) {
    // Out of budget: stop starting batches — the rest stay fresh, so the
    // next refresh resumes from the unfinished batches.
    if (!budgetCanStartBatch(budget)) break;
    if (bi > 0) await sleepMs(ENRICH_BATCH_GAP_MS);
    await enrichBatch(batch, bi * 5);
  }

  // Results were already folded into the persistent enrichment store per
  // batch above (with a save after each successful batch); nothing is left
  // to fold here.

  // 6) Build the final items. Every item's url AND readUrl are the direct
  //    publisher address resolved in step 2 — never a relay link. Items the
  //    user can no longer act on (deadline passed, event already over,
  //    wrong school stage) are dropped here per the 2026-11-22 rule.
  const todayStrL = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const items: LearningItem[] = [];
  for (const it of candidates) {
    if (droppedUrls.has(it.url)) continue;
    const entry = enrichStore[it.url];
    // Official entry is derived BEFORE the filter (z-round, 2026-11-24):
    // the 近期可报名 class needs it as evidence, and the same value is
    // stored on the item below — ingest and every read judge the item
    // on identical evidence.
    const host = hostOf(it.url);
    let officialUrl: string | null = it.officialHint;
    if (!officialUrl && isInstitutionalHost(host)) officialUrl = it.url;
    if (!officialUrl && it.directFeed) officialUrl = it.url;
    if (
      isLearningNotActionable(
        {
          title: it.title,
          summaryZh: entry?.summaryZh ?? (it.summary && it.summary.trim() ? it.summary : null),
          points: entry?.points ?? [],
          audienceStage: entry?.audienceStage ?? null,
          deadline: entry?.deadline ?? null,
          needsApplication: entry?.needsApplication ?? it.hint === "opportunities",
          url: it.url,
          source: it.source,
          fee: entry?.fee ?? null,
          category: entry?.category ?? it.hint,
          officialUrl,
        },
        todayStrL,
      )
    )
      continue;
    const hasSummary = !!(it.summary && it.summary.trim().length > 0);
    // Unenriched fallback (user rule, 2026-11-23): whole sentences from
    // the item's own source summary — never a mid-sentence cut, and
    // never a fabricated translation when no model pass ran.
    const fallbackSummaryZh = hasSummary ? completeSentences(it.summary as string, 110) : null;
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
      enrichState: !entry ? "original" : newlyEnrichedUrls.has(it.url) ? "new" : "stored",
    });
  }

  items.sort((a, b) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  });

  // Same-course dedupe (z-round, 2026-11-24): one course under two
  // platform entries counts once — see collapseSameCourseEntries. The
  // persisted cache below therefore never stores the duplicate, and
  // getDailyDigest (which reads through loadLearning) agrees.
  items.splice(0, items.length, ...collapseSameCourseEntries(items));

  // 7) Persistence guard: if this run produced NO enriched item at all while
  //    a previous version has enriched items, keep serving the previous
  //    version instead of overwriting it with a degraded one.
  const anyEnriched = items.some((it) => it.summaryZh !== null);
  if (!anyEnriched && items.length > 0) {
    const stale = await readCacheStale<LearningItem[]>(ctx, "learning:all:v3");
    if (stale && stale.data.some((it) => it.summaryZh !== null)) {
      return { items: stale.data, asOf: stale.asOf };
    }
  }

  // Persist the enrichment store (bounded: current candidates first, then
  // recent entries from previous runs) and the column itself. Per-batch
  // saves already wrote the store during the run; this final write just
  // settles it.
  await writeCache(ctx, "learning:enrich:v2", boundedEnrichStore(enrichStore, candidates.map((c) => c.url)));
  const asOf = await writeCache(ctx, "learning:all:v3", items);
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
  // Already-awarded reports never need an application (user, 2026-11-23
  // t-round): the Airtel item was stored with needsApplication=true
  // although its 55 scholarships were already granted to one named
  // university's students — correct the flag on every read so it can
  // never re-enter the 可报名 list by any path.
  const base =
    isAlreadyAwardedReport(it) && it.needsApplication ? { ...it, needsApplication: false } : it;
  if (it.url !== WFYI_SCHOLARSHIP_URL && it.readUrl !== WFYI_SCHOLARSHIP_URL) {
    return blockedReason === it.blockedReason ? base : { ...base, blockedReason };
  }
  return {
    ...base,
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
 * An item counts as 官方来源 only when its own URL is on one of the TWO
 * official sites (user rule, 2026-11-23): 江西省教育考试院 www.jxeea.cn
 * （专升本报名入口在该站「专升本考试」栏目） and 江西省教育厅
 * jyt.jiangxi.gov.cn (the old jxedu.gov.cn no longer resolves and is
 * never used). The 江西 column shows ONLY originals from these two
 * sites: a media repost (eol.cn、搜狐、新浪、腾讯、人民网…) that merely
 * quotes or retells an official notice is NOT shown at all — the
 * official original is shown instead, and when no official original
 * exists the item is skipped. This predicate is the single gate: it is
 * applied at ingest in loadJiangxi and again on every getJiangxi read,
 * so a cached payload is corrected on read-back too.
 */
function isJiangxiOfficialUrl(url: string): boolean {
  const host = hostOf(url);
  return host === "jxeea.cn" || host.endsWith(".jxeea.cn") || host === "jyt.jiangxi.gov.cn";
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

type JiangxiTag = "报名" | "考试科目" | "专业对照" | "招生简章" | "录取" | "其他";

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
  /** True only when the item's own URL is on jxeea.cn / jyt.jiangxi.gov.cn (the only two official sites shown). */
  official: boolean;
  /** Kept for schema compatibility; always false now — non-official reposts are filtered out, never shown. */
  repost: boolean;
  /** 2028 届正式通知 (2028 + official source) / 往年备考参考 / 尚待确认的动态. */
  noticeKind: JiangxiNoticeKind;
  /** Whether 信息安全技术应用 can apply — set ONLY when a formal 专业对照 basis in the source names the major; otherwise null (never guessed). */
  canApplyMajor: boolean | null;
  /** Official attachment URL (curated archive items only). */
  attachmentUrl?: string | null;
  /** Document kind badge (curated archive items only). */
  docKind?: "真题" | "大纲样题" | "大纲" | "目录" | "通知" | null;
}

type JiangxiNoticeKind = "formal2028" | "reference" | "unconfirmed";
const JIANGXI_TTL_MS = 60 * 60 * 1000;
const JIANGXI_QUERIES = [
  "江西专升本 招生 考试院",
  "江西省教育考试院 专升本",
  "江西 专升本 考试科目 专业对照",
  "江西 专升本 报名 招生简章",
];

const jiangxiEnrichItemSchema = z.object({
  id: z.number(),
  keep: z.boolean().catch(true),
  tag: z.enum(["报名", "考试科目", "专业对照", "招生简章", "录取", "其他"]).catch("其他"),
  summaryZh: z.string().catch(""),
  pointsZh: z.array(z.string()).catch([]),
  relevance: z.string().catch(""),
  actionNeeded: z.string().catch(""),
});

export const jiangxiEnrichSchema = z.object({
  items: z.array(jiangxiEnrichItemSchema),
});

// Loose contract (p-round, 2026-11-23): strict object OR a bare array of
// the same items — see the note on learningEnrichLooseSchema.
export const jiangxiEnrichLooseSchema = z.union([jiangxiEnrichSchema, z.array(jiangxiEnrichItemSchema)]);

interface JiangxiEnrichEntry {
  tag: JiangxiTag;
  summaryZh: string | null;
  points: string[];
  relevance: string;
  actionNeeded: string;
}

/**
 * Deterministic 江西 tag classifier (user rule, 2026-11-22): the tag is
 * decided by CONTENT, not by whichever label a model or an older
 * fallback happened to store — 分数线/录取控制线/投档线/录取结果 →
 * 「录取」; 报名流程/报名通知/报考 → 「报名」; 考试时间/科目安排/
 * 准考证 → 「考试科目」(the column's exam bucket). Applied at ingest
 * and again on every read (fixJiangxiList), so a cached item tagged
 * 「报名」for a score-line announcement is corrected in place. Returns
 * null when no content signal matches, leaving the stored tag alone.
 */
function jiangxiTagFor(title: string, body: string): JiangxiTag | null {
  const admitRe = /分数线|录取控制线|投档线|录取结果|录取名单|录取查询|最低录取分数|录取分数/;
  const majorRe = /专业对照|对应专业|报考专业对照/;
  const examRe = /考试科目|考试时间|考试安排|科目安排|准考证|考试大纲|考试日程/;
  const prospectusRe = /招生简章|招生章程|招生计划/;
  const signupRe = /报名流程|报名通知|报名时间|报名入口|网上报名|报考|报名/;
  // The title is the item's own strongest statement of what it is: a
  // headline announcing 考试时间及科目安排 is an exam item even when
  // its body also mentions 招生章程. Title signals first (admissions
  // results, major mapping and exam arrangements outrank the rest),
  // then the same signals in the body.
  if (admitRe.test(title)) return "录取";
  if (majorRe.test(title)) return "专业对照";
  if (examRe.test(title)) return "考试科目";
  if (prospectusRe.test(title)) return "招生简章";
  if (signupRe.test(title)) return "报名";
  if (admitRe.test(body)) return "录取";
  if (majorRe.test(body)) return "专业对照";
  if (prospectusRe.test(body)) return "招生简章";
  if (examRe.test(body)) return "考试科目";
  if (signupRe.test(body)) return "报名";
  return null;
}

/**
 * Applicable year for past-year material (user rule, 2026-11-22): the
 * year must be SHOWN — taken from the title, then the summary/points,
 * then the publish date. Only an item with none of the three stays
 * unlabelled; an item WITH a publish date never reads 「未注明」.
 */
function jiangxiYearFor(it: {
  title: string;
  summaryZh: string | null;
  points: string[];
  publishedAt: string | null;
}): string | null {
  const fromTitle = yearOf(it.title);
  if (fromTitle) return fromTitle;
  const pubYear = it.publishedAt ? new Date(it.publishedAt).getFullYear() : null;
  const fromBody = yearOf(it.summaryZh ?? "") ?? yearOf(it.points.join(" "));
  if (fromBody) {
    const n = Number(fromBody.slice(0, 4));
    // A year buried in the body is the item's year only when it sits
    // near the publish year — a policy detail like 「2009年以后退役」
    // inside a 2021 prospectus is not the prospectus's year.
    if (pubYear === null || Number.isNaN(pubYear) || Math.abs(n - pubYear) <= 2) return fromBody;
  }
  if (pubYear !== null && !Number.isNaN(pubYear) && pubYear >= 2020 && pubYear <= 2035)
    return `${pubYear}年`;
  return null;
}

const JIANGXI_FALLBACK_RELEVANCE =
  "面向江西省普通高校专升本考生，与你 2028 年参加专升本的方向相关；信息安全技术应用专业具体能报哪个本科专业，要以当年公布的专业对照表为准。";

/**
 * Per-item relevance written from the item's OWN content (user rule,
 * 2026-11-22): the five visible 江西 items all carried the same
 * template sentence. Each tag gets a line that names what THIS item
 * actually is (score line / sign-up steps / subjects / major mapping /
 * prospectus), with its applicable year when known.
 */
function jiangxiRelevanceFor(it: { title: string; tag: JiangxiTag; applicableYear: string | null }): string {
  const yr = it.applicableYear ? `${it.applicableYear}的` : "";
  switch (it.tag) {
    case "录取":
      // Score lines and admission results are different materials and
      // get different lines (user rule, 2026-11-23): the m-round wrote
      // ONE template for the whole 录取 tag, so a 2026 score-line item
      // and a 2024 headcount item differed only by the year digits.
      if (/录取人数|录取结果|录取名单|录取查询|录取情况|录取名单公布/.test(it.title))
        return `这是${yr}江西专升本录取结果类材料，关系到往年实际录取了多少人、录到哪些学校，可先了解你目标院校的录取情况。`;
      if (/分数线|录取控制线|投档线|最低录取|录取分数/.test(it.title))
        return `这是${yr}江西专升本录取分数线材料，关系到你给 2028 年定目标分数时参考的往年录取门槛。`;
      return `这是${yr}江西专升本录取类材料，关系到往年录取的门槛和实际去向，先了解你目标院校的情况。`;
    case "报名":
      // Conditions and process are different materials too (user rule,
      // 2026-11-23): two 2026 报名 items — 「报名条件及报考指南」 and
      // 「报名流程及详细报考步骤」 — carried the identical sentence
      // because the m-round keyed the line on tag + year alone.
      if (/报名条件|报考条件|报名资格|报考资格|报名要求|报考指南/.test(it.title))
        return `这是${yr}江西专升本报名条件类材料，关系到你 2028 年报名前先核对自己是否符合报考条件、要准备哪些材料。`;
      if (/报名流程|报考步骤|报名步骤|报名程序|操作流程|详细报考|报名方式/.test(it.title))
        return `这是${yr}江西专升本报名流程类材料，关系到你 2028 年报名时一步步怎么操作，先熟悉步骤、时间和入口。`;
      return `这是${yr}江西专升本报名类通知，关系到你 2028 年报名的时间安排和入口，先了解往年的节奏。`;
    case "考试科目":
      return /准考证|考试时间|考试安排|考试日程/.test(it.title)
        ? `这是${yr}江西专升本考试安排类通知，关系到考试时间和准考证等考务事项，先了解往年节奏。`
        : `这是${yr}江西专升本考试科目类材料，关系到你备考要复习哪些科目，按它规划复习最直接。`;
    case "专业对照":
      return `专业对照决定信息安全技术应用能报考哪个本科专业——这是${yr}的材料，与你能不能报、报哪个专业直接相关。`;
    case "招生简章":
      return `这是${yr}江西专升本招生简章类材料，列了招生院校、专业与计划，关系到你 2028 年能报哪些学校。`;
    default:
      return `这是${yr}江西省普通高校专升本的通用通知，全体考生都要看，与你的报考准备相关。`;
  }
}

/**
 * Read-time + ingest-time correction for the whole 江西 list (user
 * rules, 2026-11-22): re-derive each item's tag from its content,
 * fill a missing applicable year from title/summary/publish date,
 * decode title entities, dedupe points, repair mid-word cuts, and
 * replace any relevance that is the shared template (or that repeats
 * another item's relevance verbatim) with a per-item line grounded in
 * that item's own tag/title/year. Official sources sort first inside
 * each group （官方原文优先）.
 */
/**
 * A short distinguishing phrase taken from an item's own title (user
 * rule, 2026-11-23): strip the words every 江西专升本 title shares
 * （江西 / 专升本 / 年份 / 通知…) and keep what is left — that residue
 * is what makes THIS item different from its same-tag neighbours
 * （报名条件及报考指南 vs 报名流程及详细报考步骤）.
 */
function jiangxiTitlePhrase(title: string): string {
  return title
    .replace(/20\d{2}\s*年?/g, " ")
    .replace(/江西省?|普通高校|专升本|教育考试院|考试院|公告|通知|发布/g, " ")
    .replace(/[「」『』【】〔〕（）()·・、，,：:；;！!？?—\-…\s]+/g, "")
    .slice(0, 14);
}

function fixJiangxiList(items: JiangxiItem[]): JiangxiItem[] {
  const relevanceCounts = new Map<string, number>();
  for (const it of items) {
    const r = (it.relevance ?? "").trim();
    if (r) relevanceCounts.set(r, (relevanceCounts.get(r) ?? 0) + 1);
  }
  const fixed = items.map((raw) => {
    const it: JiangxiItem = { ...raw, title: decodeEntities(raw.title) };
    const tag = jiangxiTagFor(it.title, `${it.summaryZh ?? ""} ${it.points.join(" ")}`) ?? it.tag;
    let applicableYear = it.applicableYear ?? jiangxiYearFor(it);
    // A stored year far from the publish year, with no year in the
    // title, was almost certainly scraped from a policy detail inside
    // the body (「2009年以后退役」 in a 2021 prospectus) — re-derive it
    // under the guarded rule instead of displaying the wrong year.
    if (applicableYear && !yearOf(it.title) && it.publishedAt) {
      const n = Number(applicableYear.slice(0, 4));
      const py = new Date(it.publishedAt).getFullYear();
      if (!Number.isNaN(n) && !Number.isNaN(py) && Math.abs(n - py) > 2) {
        applicableYear = jiangxiYearFor(it) ?? applicableYear;
      }
    }
    const yearNum = applicableYear ? Number(applicableYear.slice(0, 4)) : null;
    const relTrim = (it.relevance ?? "").trim();
    const relevance =
      !relTrim || relTrim === JIANGXI_FALLBACK_RELEVANCE || (relevanceCounts.get(relTrim) ?? 0) > 1
        ? jiangxiRelevanceFor({ title: it.title, tag, applicableYear })
        : it.relevance;
    return {
      ...it,
      tag,
      applicableYear,
      relevance,
      isReference: yearNum !== null ? yearNum < 2028 : it.isReference,
      noticeKind: (yearNum === 2028 && it.official
        ? "formal2028"
        : yearNum === 2028
          ? "unconfirmed"
          : yearNum !== null
            ? "reference"
            : it.noticeKind) as JiangxiNoticeKind,
      summaryZh: it.summaryZh ? trimPartialTailWord(decodeEntities(it.summaryZh), 90) : it.summaryZh,
      points: dedupeSentences(it.points.map((p) => decodeEntities(p))),
    };
  });
  // Column-level uniqueness guarantee (user rule, 2026-11-23): whatever
  // the per-tag lines produced, no two items in this column may carry
  // the IDENTICAL relevance sentence. A repeat gets one more clause
  // built from its own title's distinguishing phrase (falling back to
  // the source name when two titles reduce to the same phrase).
  const seenRelevance = new Map<string, Set<string>>();
  for (const it of fixed) {
    const r = it.relevance.trim();
    if (!r) continue;
    const isFirst = !seenRelevance.has(r);
    const used = seenRelevance.get(r) ?? new Set<string>();
    seenRelevance.set(r, used);
    if (isFirst) {
      used.add(jiangxiTitlePhrase(it.title));
      continue;
    }
    let phrase = jiangxiTitlePhrase(it.title);
    if (!phrase || used.has(phrase)) phrase = `${phrase ? `${phrase}·` : ""}${it.source}`;
    used.add(phrase);
    it.relevance = r.endsWith("。")
      ? `${r}本条具体内容是「${phrase}」。`
      : `${r}（本条具体内容是「${phrase}」）`;
  }
  fixed.sort((a, b) => {
    if (a.isReference !== b.isReference) return a.isReference ? 1 : -1;
    if (a.official !== b.official) return a.official ? -1 : 1;
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  });
  return fixed;
}

function jiangxiFallback(it: FeedItem): JiangxiEnrichEntry {
  const hay = `${it.title} ${it.summary ?? ""}`;
  const tag: JiangxiTag =
    jiangxiTagFor(it.title, it.summary ?? "") ??
    (/专业对照|对应专业|报考专业/.test(hay)
      ? "专业对照"
      : /招生简章|招生章程|招生计划/.test(hay)
        ? "招生简章"
        : /报名|报考|志愿/.test(hay)
          ? "报名"
          : "其他");
  const yr =
    yearOf(it.title) ??
    (it.publishedAt ? `${new Date(it.publishedAt).getFullYear()}年` : null);
  return {
    tag,
    summaryZh: it.summary ? truncateAtBoundary(it.summary, 90) : null,
    points: it.summary ? [it.summary] : [],
    relevance: jiangxiRelevanceFor({
      title: it.title,
      tag,
      applicableYear: yr && /^\d{4}年$/.test(yr) ? yr : null,
    }),
    actionNeeded: yr
      ? `这是 ${yr} 的材料，先当备考参考：看清考试科目和报考要求，2028 年的正式通知出来后再按新通知办。`
      : "先打开原文核对内容，2028 年的正式通知出来后再按新通知办。",
  };
}

/**
 * Homepage noise the user asked to hide (2026-11-22): he is a second-year
 * 专科 student, so two classes of search results never belong in this
 * column — (1) training-institution marketing （机构评测/测评、十大机构、
 * 哪家好、选机构类） and (2) 高考择校 content written for gaokao students
 * choosing a 专科/大专 school (including anything from the gaokao.eol.cn
 * channel). Deterministic, host/title based, applied at ingest so no
 * refresh or enrichment-fallback path can bring them back.
 */
function isJiangxiHiddenNoise(it: FeedItem): boolean {
  const host = hostOf(it.url);
  if (host === "gaokao.eol.cn" || host.startsWith("gaokao.")) return true;
  const t = it.title;
  // Training-institution marketing / roundups.
  if (
    /培训机构|机构评测|机构测评|机构.{0,6}(怎么选|如何选|哪家好)|哪家(机构|培训|学校).{0,4}(好|靠谱|强)|十大(培训|机构|品牌)|(培训|机构).{0,4}(排行榜|排名榜|推荐榜)/.test(t)
  )
    return true;
  // 高考择校： written for gaokao candidates picking a college, not for a
  // student already in his second year of 专科.
  if (/高考|高三|高中生/.test(t) && /大专|专科|高职/.test(t) && /怎么选|如何选|怎样选|择校|选校|值得(读|上|报)|推荐|志愿/.test(t))
    return true;
  if (/择校/.test(t) && /大专|专科|高职|高考/.test(t)) return true;
  return false;
}

/**
 * Ended exam-administration reminders (user rule, 2026-11-22): a 考区/
 * 考点/考场 reminder, a 准考证 notice or a 温馨提醒 is written for ONE
 * sitting of the exam and is published days before it. Once the piece
 * itself is more than ~45 days old, that sitting is over and the item is
 * history, not a live notice — it leaves the homepage's visible list
 * (e.g. 腾讯网 2026-03-23 《江西省2026年普通高校专升本考试九江考区温馨提醒》,
 * for the exam held 2026-03-29). Material with lasting 备考 value is
 * never caught by this rule, however old: 考试科目、专业对照、招生方案/
 * 实施方案、招生简章、报名流程、分数线 stay visible as 备考参考. A
 * reminder naming a FUTURE exam year is for an upcoming sitting and
 * stays. Deterministic: title shape + the title's exam year + the
 * publish date decide.
 */
const JIANGXI_VALUABLE_RE = /考试科目|专业对照|招生方案|实施方案|招生简章|招生计划|报名流程|报名办法|报名指南|分数线|录取控制线/;
const JIANGXI_EXAM_REMINDER_RE = /考区提醒|考点提醒|考点安排|考场安排|考场提醒|考前提醒|赴考提醒|温馨提醒|准考证/;

function isJiangxiEndedExamReminder(title: string, publishedAt: string | null): boolean {
  if (JIANGXI_VALUABLE_RE.test(title)) return false;
  if (!JIANGXI_EXAM_REMINDER_RE.test(title)) return false;
  if (!publishedAt) return false;
  const pub = new Date(publishedAt).getTime();
  if (Number.isNaN(pub)) return false;
  const y = yearOf(title);
  const curYear = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date()).slice(0, 4));
  if (y && Number(y.slice(0, 4)) > curYear) return false;
  return Date.now() - pub > 45 * 24 * 3600 * 1000;
}

async function loadJiangxi(
  ctx: Ctx,
  force: boolean,
  budget: RunBudget = newRunBudget(),
): Promise<{ items: JiangxiItem[]; asOf: string }> {
  if (!force) {
    const cached = await readCache<JiangxiItem[]>(ctx, "jiangxi:all:v5", JIANGXI_TTL_MS);
    if (cached) return { items: cached.data, asOf: cached.asOf };
  }
  const raw: FeedItem[] = [];
  let fetchOk = false;
  await Promise.all(
    JIANGXI_QUERIES.map(async (q) => {
      try {
        raw.push(...(await fetchBingItems(q, "Bing 资讯", 15)));
        fetchOk = true;
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
      // Official-only rule (2026-11-23): the 江西 column shows ONLY
      // originals published on the two official sites — 江西省教育考试院
      // jxeea.cn and 江西省教育厅 jyt.jiangxi.gov.cn. Reposts (eol.cn、
      // 搜狐、新浪、腾讯、人民网…) are dropped even when they quote an
      // official notice; when no official original exists the item is
      // skipped, never filled in with a repost. An empty pool after this
      // filter is the expected outcome on days with no new notice.
      if (!isJiangxiOfficialUrl(direct)) return false;
      // Only 江西普通高校专升本 — drop 成人高考/自考/专套本 noise by title.
      if (!/专升本/.test(it.title)) return false;
      if (/成人高考|自学考试|自考/.test(it.title) && !/普通高校专升本|普通专升本/.test(it.title)) return false;
      // User rule (2026-11-22): training-institution marketing and 高考择校
      // content are hidden from the homepage — he is already a second-year
      // 专科 student, neither class can change a decision of his.
      if (isJiangxiHiddenNoise(it)) return false;
      // Ended exam-administration reminders (a 准考证打印/考场提醒 whose exam
      // window has passed) are hidden by default — they cannot change a decision now.
      if (/(已结束|已经结束|报名已截止|考试已结束)/.test(it.title)) return false;
      // Dated exam-day reminders whose sitting has passed （考区温馨提醒、
      // 考点安排…) move to history; 考试科目/专业对照/招生方案 and the
      // other lasting-value material are exempt inside the matcher.
      if (isJiangxiEndedExamReminder(it.title, it.publishedAt)) return false;
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
    if (fetchOk) {
      // The searches worked; there is simply no notice on the two
      // official sites right now. An empty pool is the EXPECTED result
      // of the official-only rule — not a refresh failure — so cache
      // the empty list and let the UI show 「暂无新的官方公告」.
      const asOf = await writeCache(ctx, "jiangxi:all:v5", [] as JiangxiItem[]);
      return { items: [], asOf };
    }
    await noteRefreshFailure(ctx, "江西专升本");
    const stale = await readCacheStale<JiangxiItem[]>(ctx, "jiangxi:all:v5");
    if (stale) return { items: stale.data, asOf: stale.asOf };
    return { items: [], asOf: new Date().toISOString() };
  }

  const store = (await readCacheStale<Record<string, JiangxiEnrichEntry>>(ctx, "jiangxi:enrich:v1"))?.data ?? {};
  const fresh = deduped.filter((it) => !store[it.url]);
  // Whether the loose (object-or-array) contract is still in use for this
  // run — see the learning column's note on the union-schema fallback.
  let looseSchemaOk = true;
  const enrichBatch = async (batch: FeedItem[], offset: number): Promise<void> => {
    if (!budgetCanStartBatch(budget)) return;
    const listing = batch
      .map((it, j) => {
        const has = !!(it.summary && it.summary.trim());
        return `[${offset + j}] 来源:${it.source} | 标题:${it.title} | 摘要:${has ? (it.summary as string).slice(0, 180) : "（无摘要，仅有标题）"}`;
      })
      .join("\n");
    const prompt =
      `你在为一位江西大二专科生（专业：信息安全技术应用，预计 2028 年毕业、2028 年参加普通高校专升本）整理「江西专升本」栏目。逐条判断：\n` +
      `- keep：是否确为江西省普通高校专升本的通知/政策/招生信息。成人高考、自考、培训机构广告、机构测评软文、面向高考生选大专的择校指南 keep=false。\n` +
      `- tag：报名 / 考试科目 / 专业对照 / 招生简章 / 录取 / 其他，按内容选最贴切的一个——分数线、录取控制线、投档线、录取结果归「录取」；报名流程、报名通知、报考归「报名」；考试时间、科目安排、准考证归「考试科目」。\n` +
      `- summaryZh：一句中文概括这条讲了什么，只能依据摘要已有信息；无摘要时留空字符串，绝不根据标题猜正文。\n` +
      `- pointsZh：2-3 条中文要点，全部来自摘要原文；无摘要留空数组。\n` +
      `- relevance：一句中文说明与这位学生的关系，必须依据本条自己的标题/摘要写，每条各不相同，不要多条共用同一句模板。摘要或标题明确涉及信息安全/计算机类专业时说明直接关系；只是全省通用通知时，说明这是全体考生都要看的通用事项；不要编造专业对照结论。\n` +
      `- actionNeeded：一句中文说明他现在需要做什么。往年（2028 年之前）的材料，写明这是备考参考、现在只需了解科目与要求；不要编造报名日期或截止时间。\n\n只返回一个 JSON 对象，形状固定为 {"items":[...]}，不要输出其他任何文字；每条结果保留输入编号对应的 id（即 [n] 中的 n），结果顺序可以与输入不同。\n\n${listing}`;
    const attempt = async (schema: typeof jiangxiEnrichSchema | typeof jiangxiEnrichLooseSchema) =>
      completeEnrichment(
        (timeoutSecs) => completeInference(ctx, prompt, { schema, timeout_secs: timeoutSecs }),
        budget,
      );
    let raw: z.infer<typeof jiangxiEnrichLooseSchema>;
    try {
      raw = looseSchemaOk ? await attempt(jiangxiEnrichLooseSchema) : await attempt(jiangxiEnrichSchema);
    } catch (e) {
      if (looseSchemaOk && isSchemaContractError(e)) {
        looseSchemaOk = false;
        try {
          raw = await attempt(jiangxiEnrichSchema);
        } catch (e2) {
          // p-round, 2026-11-23: Jiangxi errors used to be swallowed
          // silently — they are now recorded per column, and the batch ends
          // at once (no split-half retry); fallback entries below cover
          // anything still missing.
          await markColumnEnrichError(ctx, "jiangxi", e2);
          return;
        }
      } else {
        await markColumnEnrichError(ctx, "jiangxi", e);
        return;
      }
    }
    const dropped = new Set<string>();
    let batchEnriched = 0;
    for (const [idx, r] of backfillEnrichResults(looseItems(raw), offset, batch.length)) {
      const it = fresh[idx];
      if (!it) continue;
      if (!r.keep) {
        dropped.add(it.url);
        continue;
      }
      const has = !!(it.summary && it.summary.trim());
      store[it.url] = {
        tag: r.tag as JiangxiTag,
        summaryZh: has ? r.summaryZh.trim() || null : null,
        points: has ? r.pointsZh.map((p) => p.trim()).filter(Boolean).slice(0, 3) : [],
        relevance: r.relevance.trim(),
        actionNeeded: r.actionNeeded.trim(),
      };
      batchEnriched++;
    }
    for (const url of dropped) delete store[url];
    // Mark dropped items so they are excluded below: keep a tombstone list.
    if (dropped.size > 0) {
      const tomb = (await readCacheStale<string[]>(ctx, "jiangxi:dropped:v1"))?.data ?? [];
      await writeCache(ctx, "jiangxi:dropped:v1", [...new Set([...tomb, ...dropped])]);
    }
    // Save this batch's results NOW: the old code only wrote the store at
    // the end of the load, so a kill mid-run lost every finished batch.
    if (batchEnriched > 0 || dropped.size > 0) {
      await writeCache(ctx, "jiangxi:enrich:v1", boundedEnrichStore(store, deduped.map((d) => d.url)));
      await markColumnEnrichSuccess(ctx, "jiangxi");
    }
  };
  const batches: FeedItem[][] = [];
  for (let s = 0; s < fresh.length; s += 5) batches.push(fresh.slice(s, s + 5));
  // Serial, paced (2026-11-23): one batch at a time with a pause between
  // batches — see the pacing note at completeEnrichment. Out of budget:
  // stop starting batches; the rest stay fresh for the next run.
  for (const [bi, b] of batches.entries()) {
    if (!budgetCanStartBatch(budget)) break;
    if (bi > 0) await sleepMs(ENRICH_BATCH_GAP_MS);
    await enrichBatch(b, bi * 5);
  }
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
      summaryZh: has ? entry.summaryZh ?? (it.summary ? truncateAtBoundary(it.summary, 90) : null) : null,
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
      noticeKind: (yearNum === 2028 && isJiangxiOfficialUrl(it.url)
        ? "formal2028"
        : yearNum === 2028
          ? "unconfirmed"
          : "reference") as JiangxiNoticeKind,
      canApplyMajor: ((): boolean | null => {
        // Only a 专业对照 item whose own text names the user's major counts
        // as a formal basis; anything else stays null (未确认), never guessed.
        if (entry.tag !== "专业对照") return null;
        const hay = `${it.title} ${it.summary ?? ""} ${entry.points.join(" ")}`;
        if (!/信息安全技术应用/.test(hay)) return null;
        if (/信息安全技术应用[^。；]{0,40}(不能报考|不可报考|不在对照|未列入|不对应)/.test(hay)) return false;
        if (/信息安全技术应用[^。；]{0,60}(可报考|可以报考|对应|可报)/.test(hay)) return true;
        return null;
      })(),
    });
  }
  // Whole-list correction at ingest (content-derived tags, applicable
  // years, per-item relevance, official sources first) — the same
  // fixJiangxiList runs again on every getJiangxi read.
  const fixedItems = fixJiangxiList(items);

  await writeCache(ctx, "jiangxi:enrich:v1", boundedEnrichStore(store, deduped.map((d) => d.url)));
  const asOf = await writeCache(ctx, "jiangxi:all:v5", fixedItems);
  return { items: fixedItems, asOf };
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
  /**
   * Effective-date nodes split per matter (user rule, 2026-11-22): when
   * one policy takes effect on different dates for different groups
   * (Singapore MOM: new applications vs renewals), each node is its own
   * line — 「新申请：2027-01-01 起」/「续签：2028-01-01 起到期者」 —
   * never crammed into one string. Derived from effectiveWhen in
   * normalizeOverseas when not set explicitly.
   */
  effectiveParts?: string[] | null;
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
  /** Main category — exactly one: 海外升学 (study) or 海外实习、工作与签证 (work_visa). */
  category?: OverseasCategory;
  /** Stage within the category (see OverseasStage). */
  stage?: OverseasStage;
  kind?: "news" | "job" | "policy";
  majorMatch?: string | null;
  languageReq?: string | null;
  /** Application deadline as stated by the source (free text, e.g. "2027年3月1日"); null = 未说明. */
  deadline?: string | null;
  tuition?: string | null;
  livingCost?: string | null;
  scholarship?: string | null;
  location?: string | null;
  remoteFromChina?: boolean | null;
  eduReq?: string | null;
  expReq?: string | null;
  acceptsOverseas?: boolean | null;
  visaSupport?: "yes" | "no" | "unstated";
  policyStatus?: "enacted" | "proposal" | "unstated" | "upcoming" | null;
  /**
   * Optional verbatim status label that overrides the generic
   * policyStatus wording in the card chip and the expanded 状态 row.
   * Set only where the generic 已生效/即将生效/提案 wording would
   * misstate the verified facts — the Yale OISS D/S card (2026-11-22):
   * the challenged rule never took effect, so D/S was never interrupted
   * and the label must read 「D/S 继续适用」, never 「恢复」.
   */
  policyStatusLabel?: string | null;
  /**
   * Structured effective date (YYYY-MM-DD) plus the policy location's IANA
   * time zone, when the status label must be COMPUTED from the location's
   * own local date (user rule, 2026-11-22) instead of trusting a stored
   * verdict: before the effective date the label is 「即将生效」, on/after
   * it 「已生效」. Set on the NZ Short-term Graduate Work Visa pin
   * (2026-11-23, Pacific/Auckland).
   */
  effectiveDate?: string | null;
  effectiveTimeZone?: string | null;
  /**
   * Optional verbatim tag that replaces BOTH the stage chip and the
   * status suffix of the 「政策 · 非岗位」 chip on this card. Set only
   * on the Yale OISS D/S card (2026-11-22, user-dictated): the old
   * 「签证/移民政策」 stage chip and the separate 「D/S 继续适用」
   * status label duplicated each other, so the card carries the single
   * combined tag 「美国签证政策｜D/S 继续适用」 and the policy chip
   * reads just 「政策 · 非岗位」.
   */
  cardTagLabel?: string | null;
  /**
   * Optional verbatim dated-event line rendered as its own row on the
   * card. Set only on the Yale OISS D/S card: 「法院裁决日期：2026 年
   * 11 月 16 日」 — the court judgment date, kept distinct from the
   * source page's update date (2026-11-17) and from the challenged
   * rule's never-reached effective date.
   */
  decisionDateLabel?: string | null;
}

type OverseasCategory = "study" | "work_visa";
type OverseasStage = "prepare" | "diploma" | "bachelor" | "intern" | "direct" | "overseas_job" | "general";
const OVERSEAS_TTL_MS = 60 * 60 * 1000;

/**
 * Curated, verified item (2026-11-20): on 2026-11-16 the U.S. District Court
 * for the District of Massachusetts vacated DHS's final rule eliminating
 * Duration of Status (D/S) for F/J nonimmigrants (Presidents' Alliance v.
 * DHS, No. 1:26-cv-13799-FDS). Search results repeatedly surfaced this one
 * event as ~6 separate media items, so it is pinned here as a single entry
 * sourced from a university's own office (Yale OISS, updated 2026-11-17,
 * page links the court order PDF) instead of aggregator/media reposts.
 * Wording correction (2026-11-22, user-verified against the Yale OISS
 * original, page updated 2026-11-17, checked 2026-11-22): the three dates /
 * states must stay distinct — (1) the 2026-11-16 judgment set aside the
 * challenged rule; (2) the rule NEVER took effect ("The rule never took
 * effect.") — it was enjoined on 2026-09-14, the day before its scheduled
 * 2026-09-15 effective date; (3) D/S therefore CONTINUES to apply
 * ("Duration of status remains in effect. F-1 students, J-1 students and
 * scholars, and their F-2 and J-2 dependents generally continue to be
 * admitted for D/S."). D/S was never interrupted, so the card must never
 * say 「恢复 D/S」; the top status label is the verbatim override
 * 「D/S 继续适用」 (policyStatusLabel), not the generic 生效状态未说明 /
 * 已生效 wording. DHS may appeal, but per Yale OISS "Filing an appeal by
 * itself would not put the rule into effect." — rendered as 「仅上诉本身
 * 不会让该规则生效」.
 * Tag + body rewrite (2026-11-22, user-dictated after re-reading the
 * Yale page's 2026-11-17 update; the page's Archived July FAQ is
 * historical material and is NOT used): the card tag is the single
 * combined 「美国签证政策｜D/S 继续适用」 (cardTagLabel — it replaces
 * the 「签证/移民政策」 stage chip and the separate status suffix,
 * while the 「政策 · 非岗位」 chip stays), the body (whatChanged and
 * effectiveWhen alike) is the user's verbatim sentence, and the
 * 2026-11-16 judgment gets its own line 「法院裁决日期：2026 年 11 月
 * 16 日」 (decisionDateLabel). publishedAt stays 2026-11-17 (the Yale
 * page's update date); the 2026-11-22 check date stays in the points.
 * correctOverseasItem reapplies this entry on every read, so a cached
 * payload can never serve the older wording.
 */
const DS_RULING_ITEM: OverseasItem = {
  title: "Elimination of Duration of Status: Summary & FAQs（耶鲁大学 OISS）",
  url: "https://oiss.yale.edu/immigration/elimination-of-duration-of-status-summary-faqs",
  source: "耶鲁大学 OISS",
  publishedAt: "2026-11-17T00:00:00.000Z",
  country: "美国",
  whatChanged:
    "原定以固定停留期取代 D/S 的规则，在生效前已被法院叫停，并于 2026 年 11 月 16 日被法院撤销。该规则从未生效。F-1 学生、J-1 学生和学者及其符合条件的家属，通常仍按 D/S 获准停留。",
  whoApplies: "未来持 F-1/J-1 赴美留学的中国学生（含专科背景申请人）",
  effectiveWhen:
    "原定以固定停留期取代 D/S 的规则，在生效前已被法院叫停，并于 2026 年 11 月 16 日被法院撤销。该规则从未生效。F-1 学生、J-1 学生和学者及其符合条件的家属，通常仍按 D/S 获准停留。",
  cardTagLabel: "美国签证政策｜D/S 继续适用",
  decisionDateLabel: "法院裁决日期：2026 年 11 月 16 日",
  eligibility: "diploma_eligible",
  isImmigration: false,
  identityLabel: null,
  points: [
    "D/S 继续适用：F-1 学生、J-1 学生与学者及其 F-2、J-2 家属，一般仍按 D/S（停留期限）入境停留，按录取与学业期限合法在美，无需采取任何行动。",
    "被推翻的固定停留期规则原定 2026-09-15 生效，9 月 14 日已被法院禁令拦下，从未生效——D/S 从未中断过，所以是继续适用。",
    "耶鲁 OISS 该页面（2026-11-17 更新，本次核对 2026-11-22）附有法院命令 PDF 链接；国土安全部可能上诉，但仅上诉本身不会让该规则生效。",
  ],
  policyStatus: "enacted",
  policyStatusLabel: "D/S 继续适用",
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
 * Curated, verified item (2026-11-22, added at the user's request as a
 * FUTURE PATH): New Zealand's new Short-term Graduate Work Visa — a
 * 6-month open work visa for graduates who completed an NZQCF Level 5–7
 * qualification full-time in New Zealand (at least 24 weeks, excluding
 * English-language, foundation and bridging courses) and do NOT qualify
 * for the Post-Study Work Visa. At least NZ$5,000 in funds; apply within
 * 3 months of the NZ student visa expiring; the applicant must not have
 * previously held a Short-term or Post-Study Work Visa; granted once
 * only, cannot be extended. This is a DIFFERENT visa from the PSWV
 * expansion carried by NZ_PSWV_ITEM (Level 7 Graduate Diploma + a
 * bachelor's degree) — the two must not be conflated.
 * Effective date: 2026-11-23 per Amendment Circular 2026-36 (the INZ
 * landing page still says 16 November — the pre-delay date, before the
 * Microsoft-outage postponement). Source is Immigration New Zealand's own
 * announcement page, URL supplied verified in the user's brief.
 * Applicability, stated plainly in the item: the user cannot use this
 * now — his Jiangxi 大专 studied in China does not itself qualify, and
 * INZ does not state how a Chinese 大专 maps to NZQCF levels; the route
 * only becomes usable after completing a Level 5–7 qualification in New
 * Zealand. It is labelled 「未来路径」, never presented as currently
 * applicable. Eligibility stays 'unclear' (not bachelor_only — no degree
 * is required — and not diploma_eligible, since his current diploma does
 * not qualify him today). As a hand-verified curated pin it is exempt
 * from the rotating list's foreign-applicant filter, like the Yale /
 * Singapore / Japan pins (see mergePinnedVisaItems); the applicability
 * rule still governs it, and its wording deliberately avoids the
 * not-applicable phrasings that rule keys on because it IS a path open
 * to him later, unlike the bachelor-only items.
 */
const NZ_SGWV_ITEM: OverseasItem = {
  title: "Short-term Graduate Work Visa（新西兰短期毕业工签 · 未来路径）",
  url: "https://www.immigration.govt.nz/about-us/news-centre/new-and-updated-post-study-work-visa-options/",
  source: "新西兰移民局（Immigration New Zealand）",
  publishedAt: null,
  country: "新西兰",
  whatChanged:
    "新西兰自 2026 年 11 月 23 日起新设短期毕业工签（Short-term Graduate Work Visa）：在新西兰全日制读满至少 24 周、取得 NZQCF 5–7 级学历（不含语言、预科、桥梁课程）、且不符合毕业后工签（PSWV）申请条件的人，可获 6 个月开放工作签证，只批一次、不能续签；申请时须有至少 5,000 新元资金，并在新西兰学生签证到期后 3 个月内提交，此前不能持有过短期毕业工签或毕业后工签。生效日以修正指令 Amendment Circular 2026-36 为准——移民局落地页仍写 11 月 16 日，那是因微软故障推迟前的旧日期。这条与同日生效的 PSWV 扩大是两条不同的签证：PSWV 扩大针对 7 级研究生文凭另加学士学位者，本条针对够不上 PSWV 的 5–7 级毕业生。",
  whoApplies:
    "未来路径，我现在还申请不了：适用对象是以后在新西兰全日制读完 NZQCF 5–7 级学历的毕业生；我在江西读的大专本身不算，中国大专对应新西兰哪一级移民局没有写明——只有先去新西兰读完一个 5–7 级学历，这条才用得上",
  effectiveWhen: "2026 年 11 月 23 日起（修正指令 Amendment Circular 2026-36 确认；移民局落地页上的 11 月 16 日是推迟前的旧日期）",
  eligibility: "unclear",
  isImmigration: false,
  identityLabel: "未来路径：在新西兰完成 5–7 级学历后的毕业生（学生签证转工签）",
  points: [
    "条件：在新西兰全日制读满至少 24 周并取得 NZQCF 5–7 级学历；语言课程、预科和桥梁课程不算。",
    "只给不符合毕业后工签（PSWV）申请条件的人；之前拿过短期毕业工签或毕业后工签的不能再申请。",
    "资金至少 5,000 新元；须在新西兰学生签证到期后 3 个月内申请；一生只批一次，6 个月开放工签，可为任何雇主工作，不能续签。",
    "这不是 PSWV 扩大：PSWV 扩大要求 7 级研究生文凭另加学士学位；本条是给 5–7 级、够不上 PSWV 的毕业生留的另一条路。",
    "对我而言是未来路径：江西的大专学历本身不算，中国大专对应 NZQCF 哪一级移民局没有写明；先去新西兰读完 5–7 级学历后才谈得上。",
    "本条链接即新西兰移民局官网原文；页面上的 11 月 16 日是旧日期，生效日以修正指令 Amendment Circular 2026-36 的 11 月 23 日为准。",
  ],
  titleOnly: false,
  readUrl: "https://www.immigration.govt.nz/about-us/news-centre/new-and-updated-post-study-work-visa-options/",
  needsLogin: false,
  blockedReason: null,
  official: true,
  visa: true,
  pinned: true,
  kind: "policy",
  // No stored status verdict (user fix, 2026-11-22): the label is computed
  // at read time from the effective date vs the CURRENT DATE IN NEW
  // ZEALAND (Pacific/Auckland) — before 2026-11-23 it reads 「即将生效」,
  // on/after it 「已生效」. The old hardcoded "enacted" showed 「已生效」
  // while the card itself said 「11 月 23 日起」 and New Zealand was still
  // on 22 November. See policyStatusOnDate / normalizeOverseas.
  policyStatus: null,
  effectiveDate: "2026-11-23",
  effectiveTimeZone: "Pacific/Auckland",
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
  effectiveParts: ["新申请：2027-01-01 起", "续签：2028-01-01 起到期者"],
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
  NZ_SGWV_ITEM,
  UK_GRADUATE_VISA_ITEM,
  SG_WORK_PASS_ITEM,
  JP_LANGUAGE_SCHOOL_ITEM,
  KR_TECH_PILOT_ITEM,
];

/** URLs of the hand-verified curated pins (used for filter exemptions). */
const CURATED_VISA_URLS = new Set(CURATED_VISA_ITEMS.map((it) => it.url));

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

const PINNED_VISA_KEY = "overseas:visa:pinned:v11";
/** Non-curated pinned visa items expire this long after their publish date. */
const PINNED_VISA_MAX_AGE_MS = 365 * 24 * 3600 * 1000;

/**
 * Applicability comes BEFORE pinning (user rule, 2026-11-22): an item that
 * clearly does not apply to the user — eligibility bachelor_only, or its
 * own text says so （不适用于我 / 不含信息安全技术应用） — leaves the
 * homepage entirely. It is never pinned, however decision-changing it is
 * for other people. This is what takes the NZ post-study expansion
 * (bachelor_only), the UK Graduate-visa shortening (bachelor_only) and the
 * Korea technical pilot (its own whoApplies ends with 「所以这条不适用于我」)
 * out of the fixed zone, while the Yale D/S ruling （含专科背景申请人）,
 * the Singapore MOM thresholds (eligibility unstated) and the Japan
 * language-school rule (a route a 专科 student can still take) stay.
 */
function isNotApplicableToUser(it: OverseasItem): boolean {
  if (it.eligibility === "bachelor_only") return true;
  const text = `${it.whoApplies ?? ""} ${it.whatChanged ?? ""} ${it.points.join(" ")}`;
  return /不适用于我|不适用于中国|不含信息安全|不适用于[^。]{0,12}专科/.test(text);
}

/**
 * Homepage selection, applicability first (user rule, 2026-11-22, second
 * pass): before anything else, an overseas item must either involve
 * Chinese applicants or state a rule that applies to applicants of all
 * countries. Reporting whose subject is ONE other nationality's
 * applicants — Indian applicants' NZ approval-rate data, a work visa
 * "for Indians", Indian PhD students' post-study rights, Ireland refusal
 * figures for Indian applicants, a jobs guide for Nigerians — leaves the
 * homepage by default, however often it is retold. This is homepage
 * display only: nothing is deleted from the category archive, and the
 * fixed visa zone is not exempt (it simply contains no such item today).
 * Deterministic — title, the item's own applicability statement and its
 * summary text decide; no model judgement is involved.
 *
 * A bare comparison mention does NOT count as involving Chinese
 * applicants: "India lags behind China" uses China as the baseline of an
 * Indian data story, so the piece still leaves. Chinese applicants count
 * only when they are named as applicants/students themselves, and an
 * all-applicant scope counts only when the text says so (international
 * students / 各国申请人 / 不限国籍…).
 */
const FOREIGN_NATIONALITY_ADJ =
  "Indian|Nigerian|Pakistani|Bangladeshi|Nepalese|Sri Lankan|Ghanaian|Kenyan|Filipino|Indonesian|Malaysian|Thai|Vietnamese";

function foreignApplicantSignal(text: string): boolean {
  // "Indian applicants", "Nigerian job seekers", "Indian PhD students"…
  if (
    new RegExp(
      `\\b(${FOREIGN_NATIONALITY_ADJ})\\s+(students?|applicants?|nationals?|graduates?|Ph\\.?D|doctoral|workers?|job ?seekers?|professionals?|candidates?)`,
      "i",
    ).test(text)
  )
    return true;
  // "for Indians", "How Nigerians can apply"…
  if (/\b(Indians|Nigerians|Pakistanis|Bangladeshis|Nepalese|Ghanaians|Kenyans|Filipinos|Indonesians|Malaysians)\b/.test(text))
    return true;
  // The country itself as the applicant subject of a visa-statistics
  // story: "New Zealand student visa: India lags behind China…".
  if (
    /\b(India|Nigeria|Pakistan|Bangladesh|Nepal|Ghana|Kenya)\b/.test(text) &&
    /(student visa|visa approval|visa refusal|学生签证|获批率|拒签率)/i.test(text)
  )
    return true;
  // Chinese headline shape "X国留学生 / X国申请人": X is the APPLICANT's
  // nationality, NOT the destination — 《越南留学生如何在加拿大申请留学》
  // is about Vietnamese applicants applying to Canada (a country this
  // column does not even track); the earlier pass missed it because 越南
  // is also a tracked destination and was read as one. The signal fires
  // only when the text ALSO names a different country as the place being
  // applied to (在加拿大申请 / 赴美留学 / 英国留学签证…): when the named
  // country is itself the destination （去越南留学 / 越南学生签证新规 —
  // Vietnam's own rules, open to applicants of any nationality) no other
  // country is cast as where "X国留学生" are heading, so those pieces
  // never match. This is also why 越南 stays out of the plain nationality
  // branch below: there, "越南学生签证" names a destination's rules.
  const natMatch = text.match(
    /(越南|柬埔寨|老挝|缅甸|蒙古|俄罗斯|乌克兰|斯里兰卡|哈萨克斯坦)(留学生|申请人)/,
  );
  if (natMatch) {
    const nat = natMatch[1];
    const destNames =
      "加拿大|美国|英国|新西兰|澳大利亚|澳洲|新加坡|日本|韩国|爱尔兰|越南|印度|泰国|马来西亚|菲律宾|印尼|印度尼西亚|尼日利亚|巴基斯坦|孟加拉|尼泊尔|中国";
    const destRes = [
      new RegExp(`(?:在|去|赴|前往|申请)(${destNames})`, "g"),
      new RegExp(`(${destNames})(?:留学|签证|大学|学院)`, "g"),
    ];
    for (const re of destRes) {
      for (const m of text.matchAll(re)) {
        if (m[1] !== nat) return true;
      }
    }
  }
  // Chinese text: nationality + applicant noun （印度申请人/尼日利亚求职者…).
  // 越南 is deliberately absent here: "越南学生签证" names Vietnam's own
  // student-visa rules (a destination), not Vietnamese applicants abroad.
  if (/(印度|尼日利亚|巴基斯坦|孟加拉|尼泊尔|加纳|肯尼亚|菲律宾|印尼|马来西亚|泰国)(申请人|留学生|学生|博士生|博士|公民|求职者|籍)/.test(text))
    return true;
  if (/(仅限|只面向|仅面向|只针对|专为).{0,10}(印度|尼日利亚|巴基斯坦|孟加拉|尼泊尔|加纳|肯尼亚|菲律宾)/.test(text)) return true;
  return false;
}

/** Chinese applicants named as applicants/students themselves (a bare "China" used as a comparison baseline does not match). */
function chinaApplicantSignal(text: string): boolean {
  return (
    /Chinese\s+(students?|applicants?|nationals?|graduates?|citizens?)/i.test(text) ||
    /students?\s+from\s+China/i.test(text) ||
    /中国(学生|申请人|留学生|公民|籍)/.test(text) ||
    /华人(学生|留学生|申请)/.test(text) ||
    /来自中国/.test(text)
  );
}

/** The rule is stated for applicants of all countries, not one nationality. */
function allApplicantsSignal(text: string): boolean {
  return (
    /international\s+students?/i.test(text) ||
    /all\s+(international\s+)?(students|applicants|nationalities)/i.test(text) ||
    /of\s+all\s+nationalities/i.test(text) ||
    /foreign\s+students?/i.test(text) ||
    /各国(申请人|学生|留学生)/.test(text) ||
    /所有(国际)?(学生|申请人)/.test(text) ||
    /国际学生/.test(text) ||
    /不限国籍/.test(text)
  );
}

/**
 * True when an item is only about one foreign nationality's applicants.
 * `applies` is the item's own applicability statement when one exists
 * (enriched whoApplies): if IT names Chinese or all applicants, the item
 * stays whatever the headline emphasises. Otherwise the headline decides
 * first; a generic headline falls back to the whole text.
 */
function isForeignApplicantsOnlyFields(title: string, applies: string, body: string): boolean {
  if (chinaApplicantSignal(applies) || allApplicantsSignal(applies)) return false;
  if (foreignApplicantSignal(title) && !chinaApplicantSignal(title) && !allApplicantsSignal(title)) return true;
  const all = `${title} ${applies} ${body}`;
  return foreignApplicantSignal(all) && !chinaApplicantSignal(all) && !allApplicantsSignal(all);
}

function isForeignApplicantsOnlyItem(it: OverseasItem): boolean {
  return isForeignApplicantsOnlyFields(it.title, it.whoApplies ?? "", `${it.whatChanged ?? ""} ${it.points.join(" ")}`);
}

/**
 * Text-level matcher for the New Zealand student-visa statistics event
 * (Nov 2026 release): one dataset — approval rates by nationality, with
 * the Indian rate at 64.1% — retold by Moneycontrol ("approval rate for
 * Indians falls to 64.1%"), Newspoint ("India lags behind China") and
 * others. One event, one entry (user rule, 2026-11-22); the surviving
 * entry is then subject to the foreign-applicant rule above, which takes
 * the whole event off the homepage. The NZ Indian-PhD post-study story
 * deliberately does NOT match (no student-visa statistics) — it is a
 * different event, removed by the applicant rule on its own.
 */
function isNzIndiaVisaStatsEventText(text: string): boolean {
  return (
    /(new zealand|新西兰)/i.test(text) &&
    /(india|indian|印度)/i.test(text) &&
    /(student visa|学生签证)/i.test(text) &&
    /(approval|获批|拒签|refusal|rate|数据|统计|lags?|falls?|declin|behind)/i.test(text)
  );
}

/** Whole-title normalized key for exact-duplicate detection (titleKey() truncates to 14 chars for topic supersede; duplicates need the full title). */
function fullTitleKey(title: string): string {
  return title.toLowerCase().replace(/[\s\p{P}]/gu, "");
}

/**
 * Text-level matcher for the India–New Zealand FTA event (in force
 * 2026-10): the agreement's new work visas and longer post-study rights
 * for Indians. Financial Express ("New Zealand launches 2 new work visas
 * for Indians") and Indiatimes ("India-New Zealand FTA brings in new work
 * visas and longer post-study rights for Indians") are the same event —
 * the generic same-event test misses them because neither title carries
 * a 2+-digit number ("2 new work visas" is a single digit). One event,
 * one entry, official/newest first (user rule, 2026-11-22).
 */
function isIndiaNzFtaEventText(text: string): boolean {
  return (
    /(india|indian|印度)/i.test(text) &&
    /(new zealand|新西兰)/i.test(text) &&
    // The FTA itself or its NEW work-visa categories — a bare "post-study
    // work visa" mention is a different NZ story and must not match.
    /(\bFTA\b|free trade|自贸|自由贸易|new work visas|新增.{0,6}工作签证|新设.{0,6}工作签证)/i.test(text)
  );
}

/**
 * Same-event test for the rotating list: identical normalized titles are
 * the same event at any date; otherwise the two titles must be about the
 * same country, share a distinctive number (a fee, a salary threshold, a
 * year…) and most of their characters, and be published within 7 days of
 * each other — the shape of one story retold by several outlets.
 */
function sameOverseasEvent(a: OverseasItem, b: OverseasItem): boolean {
  // The NIC Winter Internship project: retellings (NDTV / India.com /
  // Moneycontrol / JagranJosh…) share neither wording nor a common
  // distinctive title number, so the project matcher decides — any two
  // items of this project are the same event.
  if (isNicWinterInternship(a) && isNicWinterInternship(b)) return true;
  // Named cross-outlet events whose titles share no distinctive number.
  if (
    isIndiaNzFtaEventText(`${a.title} ${a.whatChanged ?? ""}`) &&
    isIndiaNzFtaEventText(`${b.title} ${b.whatChanged ?? ""}`)
  )
    return true;
  // The NZ student-visa statistics release (Indian approval rate 64.1%):
  // Moneycontrol's number-led title and Newspoint's "India lags behind
  // China" title share neither a distinctive number nor enough wording
  // for the generic test below, but they are one dataset, one event.
  if (
    isNzIndiaVisaStatsEventText(`${a.title} ${a.whatChanged ?? ""}`) &&
    isNzIndiaVisaStatsEventText(`${b.title} ${b.whatChanged ?? ""}`)
  )
    return true;
  // The D/S fixed-period event: the Yale OISS pin and any outlet's
  // retelling of it are one event, so a retelling that escaped the
  // pinned zone still cannot sit in the rotating list next to the pin.
  if (
    isDsRulingEventText(`${a.title} ${a.whatChanged ?? ""}`) &&
    isDsRulingEventText(`${b.title} ${b.whatChanged ?? ""}`)
  )
    return true;
  if (a.country !== b.country) return false;
  const ka = fullTitleKey(a.title);
  const kb = fullTitleKey(b.title);
  if (ka === kb) return true;
  const numsA = new Set(a.title.match(/\d{2,}/g) ?? []);
  if (![...numsA].some((n) => b.title.includes(n))) return false;
  const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : null;
  const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : null;
  if (ta === null || tb === null || Math.abs(ta - tb) > 7 * 24 * 3600 * 1000) return false;
  const setA = new Set(ka);
  const setB = new Set(kb);
  let inter = 0;
  for (const ch of setA) if (setB.has(ch)) inter++;
  const union = setA.size + setB.size - inter;
  return union > 0 && inter / union >= 0.6;
}

/**
 * Statistics-only visa news never pins (user rule, 2026-11-23): the fixed
 * zone is for policy CHANGES — a rule that actually moved, with what
 * changed and when it takes effect. A kind=news item whose substance is
 * visa DATA moving (application / issuance volumes （申请量/发放量/签发量）, refusal / approval rates going
 * up or down) changes no rule, and neither does an item whose only
 * forward-looking content is a measure merely proposed / warned of, with
 * no enacted change and no effective date: the Times of India piece on UK
 * student-visa applications plunging 31% in October 2026 — statistics
 * plus a proposed £925 levy — reached the public site's fixed zone on
 * 2026-11-23 because every earlier filter passed it (the Muse pool never
 * carried it; the Muse zone stayed at exactly 4). Deterministic and
 * text-only, over the same title + whatChanged + points text the other
 * pinned filters use. kind=policy items are NEVER affected, and a news
 * item carrying an enacted rule change (a fee / threshold / duration /
 * requirement actually rising, falling, being cancelled or tightened) or
 * a stated effective date still pins. An effective date counts only as a
 * FULL date carrying an effective marker （…日起 / …生效 / from /
 * effective / takes effect + date): a statistics month ("October",
 * 「10月份」) is not an effective date, and neither is publishedAt.
 */
export function isVisaStatisticsOnlyNews(it: OverseasItem): boolean {
  if (it.kind !== "news") return false;
  const text = `${it.title} ${it.whatChanged ?? ""} ${it.points.join(" ")}`;
  // A signal is required: visa statistics moving, or a proposal-only item.
  const statsZh =
    /(申请量|申请人数|申请数|拒签率|获签率|获批率|批准率|通过率|发放量|签发量)/.test(text) &&
    /(下降|上升|增长|减少|同比|环比|%|％)/.test(text);
  const statsEn =
    /\b(visa applications?|visa refusals?|visa approvals?|visa grants?|application volumes?)\b/i.test(text) &&
    /(%|\b(?:fell|fall|falls|falling|plunge[sd]?|drop(?:s|ped)?|rose|rise[sn]?|risen|declin\w+|increas\w+|slump\w*|surg\w+)\b)/i.test(text);
  const proposalOnly = /(\bpropos\w+\b|\bwarn\w*\s+of\b|拟议|提议|提案)/i.test(text);
  if (!statsZh && !statsEn && !proposalOnly) return false;
  // An enacted rule change disqualifies: a fee / threshold / duration /
  // requirement actually moving. A merely proposed one does not count.
  const ruleChangeZh =
    /(签证费|申请费|费用|门槛|期限|时长|要求|费率|收费|薪资|存款|保证金|配额).{0,12}(上调|下调|提高|降低|调高|调低|取消|废除|收紧|放宽|缩短|延长|调整)/.test(text) ||
    /(上调|下调|提高|降低|取消|废除|收紧|放宽|缩短|延长|新设|新增).{0,12}(签证费|申请费|费用|门槛|期限|时长|要求|签证|工签|学签)/.test(text);
  const ruleChangeEn =
    /\b(?:cuts?|cutting|rais\w+|increas\w+|reduc\w+|lower\w+|abolish\w+|scrap\w+|tighten\w+|extend\w+|shorten\w+|introduc\w+|impos\w+)\b[^.]{0,60}\b(?:visa|fees?|threshold|requirements?|levy|cap|months?|years?|weeks?)\b/i.test(text) ||
    /\b(?:fees?|threshold|requirements?|levy|cap|salary)\b[^.]{0,40}\b(?:ris\w+|increas\w+|rais\w+|cut|reduc\w+|lower\w+|abolish\w+|scrap\w+|tighten\w+)\b/i.test(text);
  if (ruleChangeZh || ruleChangeEn) return false;
  // A stated effective date disqualifies: full date + effective marker.
  const months = "january|february|march|april|may|june|july|august|september|october|november|december";
  const effectiveZh =
    /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日\s*(起|生效|实施|执行)/.test(text) ||
    /\d{4}-\d{1,2}-\d{1,2}\s*(起|生效|实施|执行)/.test(text) ||
    /(生效|实施|执行)\s*(日期|日)?\s*[:：]?\s*\d{4}-\d{1,2}-\d{1,2}/.test(text);
  const effectiveEn = new RegExp(
    `\\b(?:from|effective|takes? effect|in force from)\\b[^.;]{0,40}?\\b(?:\\d{1,2}\\s+(?:${months})\\s+\\d{4}|(?:${months})\\s+\\d{1,2},?\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})`,
    "i",
  ).test(text);
  if (effectiveZh || effectiveEn) return false;
  return true;
}

/**
 * Policy items with no dated effective change do not pin
 * (user, 2026-11-24 w-round): a kind="policy" item only earns a pinned
 * visa card when it states a real rule change WITH a dated effective
 * change. The named case is the 2026-08-18 EdSource commentary
 * "Trump's visa policies are not deterring international students
 * from California universities" (kind=policy, pinned=true on re-fetch):
 * it describes a general situation ("foreign students find it harder
 * to study in the US", "1,000+ visas revoked last year") but names no
 * rule change and no effective date — decisionDateLabel, effectiveParts
 * and effectiveWhen are all null. A dated signal is any of: a
 * decisionDateLabel, an effectiveParts entry, or an effectiveWhen
 * containing a year-month date (YYYY-MM-DD or YYYY 年 M 月...). The
 * four good cards all carry one: Yale D/S (decisionDateLabel
 * "法院裁决日期：2026 年 11 月 16 日"), NZ SGWV (effectiveWhen
 * "2026 年 11 月 23 日起…"), Singapore MOM (effectiveParts
 * "新申请：2027-01-01 起" / "续签：2028-01-01 起到期者"), Japan ISA
 * (3 effectiveParts with 2026-10 / 2026-07-01 dates). kind=news items
 * are never affected by this helper (statistics-only news is already
 * covered by isVisaStatisticsOnlyNews).
 */
function isPolicyWithoutDatedEffectiveChange(item: {
  kind?: string | null;
  decisionDateLabel?: string | null;
  effectiveParts?: string[] | null;
  effectiveWhen?: string | null;
}): boolean {
  if (item.kind !== "policy") return false;
  const hasDate = (s: string | null | undefined): boolean =>
    !!s && /\d{4}\s*[-年]\s*\d{1,2}/.test(s);
  if (hasDate(item.decisionDateLabel)) return false;
  if ((item.effectiveParts ?? []).some((p) => hasDate(p))) return false;
  if (hasDate(item.effectiveWhen)) return false;
  return true;
}

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
    // Applicability before pinning (user rule, 2026-11-22): an item that
    // clearly does not apply to the user never enters — or stays in — the
    // fixed zone, curated items included.
    if (isNotApplicableToUser(it)) return false;
    // Same homepage selection as the rotating list: a story only about
    // one foreign nationality's applicants never pins either. Hand-verified
    // curated pins are exempt from this nationality filter (user rule,
    // 2026-11-22): they are selected entries, not search results — the
    // NZ Short-term Graduate Work Visa future-path item stands alongside
    // the Yale / Singapore / Japan pins and must not be rotated out by a
    // filter written for the search-fed list. The applicability check
    // above still governs curated items.
    if (!curatedUrls.has(it.url) && isForeignApplicantsOnlyItem(it)) return false;
    // Blocked hosts (third-party explainers, no official original) never pin.
    if (PINNED_VISA_BLOCKED_HOSTS.some((h) => it.url.includes(h) || (it.readUrl ?? "").includes(h))) return false;
    if (curatedUrls.has(it.url)) return true;
    // Retelling checks run over title + whatChanged + points: an
    // enrichment can leave whatChanged a single thin sentence (the Inside
    // Higher Ed D/S retelling's was just 「联邦法官暂缓执行了该规定」) while
    // the points carry the event's actual signals.
    const text = `${it.title} ${it.whatChanged ?? ""} ${it.points.join(" ")}`;
    // Petitions / protests ABOUT visa rules are not themselves visa
    // changes (requirements, fees, stay length, opening or tightening):
    // the Stanford graduate union's petition for international students
    // was auto-pinned by one enrichment run's visa classification, but a
    // petition changes no rule and never enters the fixed zone.
    if (/(请愿|联署|抗议|petition|protest)/i.test(text)) return false;
    // Statistics-only visa news never pins (user rule, 2026-11-23): visa
    // data moving — or a measure merely proposed — with no enacted rule
    // change and no effective date is not a policy change. Curated items
    // already returned true above and are kind=policy besides, so this
    // check only ever reaches non-curated discoveries.
    if (isVisaStatisticsOnlyNews(it)) return false;
    // Policy items with no dated effective change never pin (user rule,
    // 2026-11-24): a kind=policy item earns the fixed zone only when it
    // states a rule change WITH a dated effective change in
    // decisionDateLabel / effectiveParts / effectiveWhen — the 2026-08-18
    // EdSource commentary (all three null) was re-pinned by a refresh
    // re-fetch. The item itself stays in the rotating pool; only the pin
    // is withheld. Curated items already returned true above, and the
    // four good cards carry dated signals besides.
    if (isPolicyWithoutDatedEffectiveChange(it)) return false;
    // Retellings of events a curated item already covers never stay pinned.
    if (
      isDsRulingEventText(text) ||
      isNzPswvEventText(text) ||
      isUkGraduateCutEventText(text) ||
      isJpLanguageSchoolEventText(text) ||
      isKrTechPilotEventText(text) ||
      isSgWorkPassEventText(text)
    )
      return false;
    if (!it.publishedAt) return true;
    return now - new Date(it.publishedAt).getTime() < PINNED_VISA_MAX_AGE_MS;
  });
  // Supersede: same country + same normalized topic key → keep the newest.
  // The India–NZ FTA event collapses to one shared key whatever country
  // label or title wording each outlet's version carries.
  const byTopic = new Map<string, OverseasItem>();
  for (const it of fresh) {
    const key = isIndiaNzFtaEventText(`${it.title} ${it.whatChanged ?? ""}`)
      ? "event|india-nz-fta"
      : `${it.country}|${titleKey(it.title)}`;
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
    /(injunction|fixed[- ](?:period|stay|term|length)|end(?:ing)?\s+(?:of\s+)?duration)/i.test(hay)
  )
    return true;
  // Old-news retellings of the injunction stage itself (user rule,
  // 2026-11-22): Inside Higher Ed's September piece "5 Things to Know
  // About New International Student Visa Limits" (2026-09-13) names
  // neither "duration of status", the case, nor D/S — its whole signal
  // is the title's "visa limits" phrasing plus a judge pausing the rule
  // （联邦法官暂缓执行了该规定，针对该政策的诉讼仍在继续）, and it still
  // reached the fixed zone as an auto-pinned visa discovery. A judge
  // pausing / halting a student-visa rule, or a "student visa limits"
  // headline discussed together with the litigation or the fixed-period
  // rule, IS this event: the Yale item covers it end-to-end (proposal →
  // 2026-09-14 injunction → 2026-11-16 vacatur), so these retellings
  // merge into it and never pin or rotate separately.
  if (
    /(student visa|international student|foreign student|学生签证|留学生|国际学生)/i.test(hay) &&
    /(judge|court|法官|法院)/i.test(hay) &&
    /(paus|block|halt|enjoin|injunction|暂缓|叫停|拦下|阻止|暂停)/i.test(hay)
  )
    return true;
  if (
    /(student visa|international student|foreign student)/i.test(hay) &&
    /visa limits?\b/i.test(hay) &&
    /(judge|court|lawsuit|litigation|fixed|duration|dhs|trump|法官|法院|诉讼|暂缓|固定)/i.test(hay)
  )
    return true;
  // Announcement-side retellings of the same fixed-period rule (no court
  // mention): limiting how long student-visa holders may stay IS the D/S
  // rule the Yale item covers end-to-end.
  if (/(学生签证|留学生|F-1)/.test(hay) && /(居留|停留).{0,3}(时长|期限)/.test(hay) && /(限制|新规|特朗普|国土安全部|DHS)/.test(hay)) return true;
  // Fixed-term phrasing of the same rule (user rule, 2026-11-22): capping
  // student stays at a fixed number of years — "US puts 4-year cap on
  // student visas" (TimesNow, carried by MSN, 2026-07-17) — or a Chinese
  // 固定期限 / 固定停留期 wording IS the D/S replacement rule. The Yale
  // item covers the event end-to-end (proposal → injunction → vacatur),
  // so these retellings merge into it and never pin or rotate separately.
  if (
    /(student visa|international student|foreign student|学生签证|留学生|国际学生)/i.test(hay) &&
    (/((4|four)[- ]year|四年).{0,24}(cap|limit|上限|最长|固定)/i.test(hay) ||
      /(cap|limit).{0,24}((4|four)[- ]year|四年)/i.test(hay) ||
      /固定期限|固定停留期/.test(hay))
  )
    return true;
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

/**
 * True when text retells the Singapore work-pass salary-threshold rise
 * carried once by SG_WORK_PASS_ITEM (the MOM factsheet: EP S$5,600→S$6,000
 * and S Pass S$3,300→S$3,600 for new applications from 2027-01-01, renewals
 * expiring from 2028-01-01). Roundups that fold the EP threshold rise into a
 * general "Singapore study policy update" retell this same event — one
 * event, one entry, and the entry is the MOM official document.
 */
function isSgWorkPassEventText(text: string): boolean {
  const sg = /(新加坡|singapore)/i.test(text);
  const pass = /(EP\b|就业准证|employment pass|S\s*准证|S Pass)/i.test(text);
  const rise = /(门槛|上调|提高|调高|薪资|salary|threshold|6,?000|3,?600)/i.test(text);
  return sg && pass && rise;
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
/** Category-3 sweep: internships and IT jobs (infosec / network ops / IT support first) across the eight tracked countries. */
const OVERSEAS_JOB_QUERIES = [
  "信息安全 网络运维 IT技术支持 实习 招聘 海外",
  "cybersecurity internship international students apply",
  "IT support network engineer jobs visa sponsorship international applicants",
  "日本 韩国 新加坡 IT 工程师 招聘 外国人",
];

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

const overseasEnrichItemSchema = z.object({
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
  category: z.enum(["study", "work_visa"]).catch("study"),
  stage: z.enum(["prepare", "diploma", "bachelor", "intern", "direct", "overseas_job", "general"]).catch("general"),
  kind: z.enum(["news", "job", "policy"]).catch("news"),
  majorMatch: z.string().nullable().catch(null),
  languageReq: z.string().nullable().catch(null),
  deadline: z.string().nullable().catch(null),
  tuition: z.string().nullable().catch(null),
  livingCost: z.string().nullable().catch(null),
  scholarship: z.string().nullable().catch(null),
  location: z.string().nullable().catch(null),
  remoteFromChina: z.boolean().nullable().catch(null),
  eduReq: z.string().nullable().catch(null),
  expReq: z.string().nullable().catch(null),
  acceptsOverseas: z.boolean().nullable().catch(null),
  visaSupport: z.enum(["yes", "no", "unstated"]).catch("unstated"),
  policyStatus: z.enum(["enacted", "proposal", "unstated"]).nullable().catch(null),
});

export const overseasEnrichSchema = z.object({
  items: z.array(overseasEnrichItemSchema),
});

// Loose contract (p-round, 2026-11-23): strict object OR a bare array of
// the same items — see the note on learningEnrichLooseSchema.
export const overseasEnrichLooseSchema = z.union([overseasEnrichSchema, z.array(overseasEnrichItemSchema)]);

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
  category: OverseasCategory;
  stage: OverseasStage;
  kind: "news" | "job" | "policy";
  majorMatch: string | null;
  languageReq: string | null;
  deadline: string | null;
  tuition: string | null;
  livingCost: string | null;
  scholarship: string | null;
  location: string | null;
  remoteFromChina: boolean | null;
  eduReq: string | null;
  expReq: string | null;
  acceptsOverseas: boolean | null;
  visaSupport: "yes" | "no" | "unstated";
  policyStatus: "enacted" | "proposal" | "unstated" | null;
}

/**
 * Homepage selection for the overseas column, applied on EVERY read —
 * including payloads cached before a rule existed — so a tightened rule
 * takes effect on stored items immediately, not at the next refresh:
 * not-applicable-to-the-user items and foreign-applicant-only stories
 * never reach the homepage list.
 */
/**
 * Study-column selection (user rule, 2026-11-22): the study column
 * shows PROGRAMMES — ideally with the institution's own stated
 * conditions. A generic study-abroad trend/news piece (kind=news from
 * a non-official source, eligibility unstated, and not one condition
 * field — no deadline, major match, language requirement, tuition or
 * scholarship) is not a study opportunity and does not display as one.
 * Applied at ingest and on every read.
 */
function isStudyTrendNoise(it: {
  category?: OverseasCategory;
  kind?: string;
  official: boolean;
  eligibility: OverseasEligibility;
  deadline?: string | null;
  majorMatch?: string | null;
  languageReq?: string | null;
  tuition?: string | null;
  scholarship?: string | null;
}): boolean {
  if (it.category !== "study" || it.kind !== "news" || it.official) return false;
  if (it.eligibility !== "unclear") return false;
  return !it.deadline && !it.majorMatch && !it.languageReq && !it.tuition && !it.scholarship;
}

function overseasHomepageItems(items: OverseasItem[]): OverseasItem[] {
  return items.filter(
    (it) =>
      !isNotApplicableToUser(it) &&
      // Curated pins are exempt from the foreign-applicant filter (they are
      // hand-verified selections, not search results) — same exemption as
      // in mergePinnedVisaItems.
      (CURATED_VISA_URLS.has(it.url) || !isForeignApplicantsOnlyItem(it)),
  );
}

async function loadOverseas(
  ctx: Ctx,
  force: boolean,
  budget: RunBudget = newRunBudget(),
): Promise<{ items: OverseasItem[]; asOf: string }> {
  if (!force) {
    const cached = await readCache<OverseasItem[]>(ctx, "overseas:all:v20", OVERSEAS_TTL_MS);
    if (cached) return { items: overseasHomepageItems(cached.data), asOf: cached.asOf };
  }
  const raw: FeedItem[] = [];
  await Promise.all(
    [...OVERSEAS_QUERIES, ...OVERSEAS_VISA_QUERIES, ...OVERSEAS_JOB_QUERIES].map(async (q) => {
      try {
        raw.push(...(await fetchBingItems(q, "Bing News", 12)));
      } catch {
        // ignore
      }
    }),
  );
  const seen = new Set<string>();
  const seenExact = new Set<string>();
  const cutoff = Date.now() - 150 * 24 * 3600 * 1000;
  const deduped = raw
    .filter((it) => {
      const direct = decodeBingClick(it.url);
      it.url = direct;
      if (isGnRelay(direct) || isBingClick(direct) || seen.has(direct)) return false;
      seen.add(direct);
      // Exact duplicates — same title, same source, same publish day under
      // different syndication URLs (the user's example: two identical
      // reports of Indian students' NZ visas) — are one item, kept once.
      const exactKey = `${fullTitleKey(it.title)}|${it.source}|${it.publishedAt ? it.publishedAt.slice(0, 10) : ""}`;
      if (seenExact.has(exactKey)) return false;
      seenExact.add(exactKey);
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
        isKrTechPilotEventText(hay) ||
        isSgWorkPassEventText(hay)
      )
        return false;
      // UK visa-funds item written for African applicants — not relevant here.
      if (isUkAfricaFundsItem(it)) return false;
      // Stale student-visa opinion/commentary (incl. the two Aug 2026 pieces
      // named by the user) is not decision-changing news — dropped here so
      // no refresh can bring it back.
      if (isStaleVisaOpinionItem(it)) return false;
      // Homepage selection at ingest (user rule, 2026-11-22): a story only
      // about one foreign nationality's applicants (Indian approval-rate
      // data, visas "for Indians", a jobs guide for Nigerians) never
      // enters the column — it neither involves Chinese applicants nor
      // states a rule for applicants of all countries.
      if (isForeignApplicantsOnlyFields(it.title, "", it.summary ?? "")) return false;
      return true;
    })
    .sort((a, b) => {
      const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return tb - ta;
    })
    .slice(0, 32);

  if (deduped.length === 0) {
    await noteRefreshFailure(ctx, "海外");
    const stale = await readCacheStale<OverseasItem[]>(ctx, "overseas:all:v20");
    if (stale) return { items: overseasHomepageItems(stale.data), asOf: stale.asOf };
    // Even with no fresh search results, the fixed visa zone stands.
    const pinnedOnly = await mergePinnedVisaItems(ctx, []);
    const asOf = await writeCache(ctx, "overseas:all:v20", pinnedOnly);
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

  const store = (await readCacheStale<Record<string, OverseasEnrichEntry>>(ctx, "overseas:enrich:v2"))?.data ?? {};

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
      const columns = (prev.columns as Record<string, ColumnStatus> | undefined) ?? {};
      const cur = columns.overseas ?? { ...EMPTY_COLUMN_STATUS };
      // One timestamp for both stamps, plus the column tag: a later reader
      // must be able to tell that this top-level error IS the overseas
      // column's error (2026-11-24 status fix).
      const message = `海外栏摘要：${(e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 400)}`;
      const now = new Date().toISOString();
      columns.overseas = {
        ...cur,
        error: message,
        errorAt: now,
        recovered: false,
      };
      await writeCache(ctx, "meta:status", {
        ...prev,
        enrichError: message,
        enrichErrorAt: now,
        enrichErrorColumn: "overseas",
        columns,
      });
    } catch {
      // bookkeeping only — never break a load over it
    }
  };
  // Whether the loose (object-or-array) contract is still in use for this
  // run — see the learning column's note on the union-schema fallback.
  let looseSchemaOk = true;
  const enrichBatch = async (batch: FeedItem[], offset: number): Promise<void> => {
    if (!budgetCanStartBatch(budget)) return;
    const listing = batch
      .map((it, j) => {
        const has = !!(it.summary && it.summary.trim());
        return `[${offset + j}] 来源:${it.source} | 标题:${it.title} | 摘要:${has ? (it.summary as string).slice(0, 200) : "（无摘要，仅有标题）"}`;
      })
      .join("\n");
    const prompt = `你在为一位中国专科（大专）学生（信息安全技术应用专业，预计 2028 年毕业）筛选「海外机会与政策变化」。只保留会改变他决策的消息：某校开始接受中国大专学历申请、学分认定/转学分变化、面向专科生的奖学金开放、学生签证要求调整、影响留学生的安全提醒。逐条判断：\n` +
          `- keep：符合上面任一类才 true。留学中介广告、论坛帖子、泛泛的留学介绍、与专科生无关的普通新闻 keep=false。评论、观点、社论类文章（opinion/commentary/editorial）不是政策变化本身，哪怕评论的正是学生签证政策，keep=false。只面向其他国家或地区申请人（例如仅面向非洲申请人）、与中国学生无关的条目 keep=false。注意：标题里「X国留学生／X国申请人」的 X 是申请人国籍，不是留学目的地——例如《越南留学生如何在加拿大申请留学》讲的是越南籍申请人，目的地是加拿大，与中国申请人无关，keep=false；反过来讲去越南留学、越南学生签证规则的条目，越南是目的地，不要按申请人国籍误判。跟踪国家只有：美国、新西兰、新加坡、越南、日本、韩国、爱尔兰、英国；其他国家 keep=false。\n` +
          `- country：从这八个国家里选一个最贴切的中文名；实在判断不了填「其他」。\n` +
          `- whatChanged：一句中文说明变了什么，只能依据摘要已有信息；无摘要留空字符串，绝不根据标题猜。\n` +
          `- whoApplies：一句中文说明适用于谁，依据摘要写；摘要没写清就如实写「来源未写明适用人群」。\n` +
          `- effectiveWhen：何时生效，只有摘要明确写出时间时才填原文说法（如「2027年1月起」），没写填 null。同一政策对不同人群有多个生效节点时（例如新申请与续签日期不同），逐个写清并用「；」分隔，每个节点都带对应人群与日期，不要挤成一句。\n` +
          `- eligibility：摘要明确说大专/专科可申请或接受大专学历，才填 diploma_eligible；明确只面向本科毕业生填 bachelor_only；没写清学历要求一律填 unclear——绝不能把不明确的标成能申请。\n` +
          `- isImmigration：是否属于移民/居留政策（不是学生签证本身的教学类消息）。是移民政策时 identityLabel 必填，写明适用身份（如「毕业生工签申请人」「学生签证持有者」）；不是则填 null。\n` +
          `- visa：这条是否属于学生签证或毕业后工作签证方面的变化——签证申请要求变了、费用变了、可停留期限变了、毕业后工作签证开放或收紧。属于填 true（这类条目会进入固定签证区长期展示）；奖学金、招生、学分认定等非签证消息填 false。\n` +
          `- pointsZh：2-3 条中文要点，全部来自摘要；无摘要留空数组。\n` +
          `- category：这条的主栏目，只能选一个。升学、招生、学分衔接、奖学金、语言学校等求学路径填 study；实习、就业岗位、工作许可、学生签证与毕业后工签政策填 work_visa。标题或要点讲实习（实习 / Internship Programme）的条目一律填 work_visa 且 stage 填 intern，绝不进 study。\n` +
          `- stage：study 时按适用阶段填 prepare（在读期间可准备）/ diploma（专科毕业可申请）/ bachelor（本科毕业才可申请，如硕士项目）；work_visa 时填 intern（在读实习）/ direct（专科毕业后从中国直接求职）/ overseas_job（海外留学期间及毕业后在当地就业）/ general（阶段不限的签证与移民政策）。\n` +
          `- kind：具体的招聘岗位填 job；政府发布的工作许可、签证或移民政策填 policy（政策不是岗位，绝不能标成 job）；其他填 news。\n` +
          `- majorMatch / languageReq / deadline / tuition / livingCost / scholarship：只填摘要明确写出的内容，金额保留原币种并注明按年还是整个项目（如「NZ$32,000/年」）；摘要没写的填 null，绝不估算或编造。deadline 只填摘要明确写出的申请截止说法。\n` +
          `- 岗位类（kind=job）再填 location（工作地点）、remoteFromChina（能否在中国境内远程参加，摘要没写填 null）、eduReq（学历要求）、expReq（经验要求）、acceptsOverseas（是否接受境外申请，没写填 null）、visaSupport（雇主明确提供签证支持填 yes，明确不提供填 no，没写填 unstated）。\n` +
          `- 政策类（kind=policy）再填 policyStatus：已生效填 enacted，只是提案/计划/拟议填 proposal，没写清填 unstated。\n\n只返回一个 JSON 对象，形状固定为 {"items":[...]}，不要输出其他任何文字；每条结果保留输入编号对应的 id（即 [n] 中的 n），结果顺序可以与输入不同。\n\n${listing}`;
    const attempt = async (schema: typeof overseasEnrichSchema | typeof overseasEnrichLooseSchema) =>
      completeEnrichment(
        (timeoutSecs) => completeInference(ctx, prompt, { schema, timeout_secs: timeoutSecs }),
        budget,
      );
    let raw: z.infer<typeof overseasEnrichLooseSchema>;
    try {
      raw = looseSchemaOk ? await attempt(overseasEnrichLooseSchema) : await attempt(overseasEnrichSchema);
    } catch (e) {
      if (looseSchemaOk && isSchemaContractError(e)) {
        looseSchemaOk = false;
        try {
          raw = await attempt(overseasEnrichSchema);
        } catch (e2) {
          await recordOverseasEnrichError(e2);
          return;
        }
      } else {
        await recordOverseasEnrichError(e);
        return;
      }
    }
    // p-round, 2026-11-23: a failed batch ends at once — deterministic
    // errors never retry, 429s retry once inside completeEnrichment when
    // the budget allows, and there is no split-half retry any more. Items
    // stay fresh, so the next run resumes from them.
    let batchEnriched = 0;
    for (const [idx, r] of backfillEnrichResults(looseItems(raw), offset, batch.length)) {
      const it = fresh[idx];
      if (!it) continue;
      const has = !!(it.summary && it.summary.trim());
      const existing = store[it.url];
      const newWhat = has ? r.whatChanged.trim() || null : null;
      // A retry that still yields no Chinese summary must not erase a
      // previously stored good one.
      if (r.keep && existing?.keep && existing.whatChanged && !newWhat) continue;
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
        category: r.category,
        stage: r.stage,
        kind: r.kind,
        majorMatch: r.majorMatch?.trim() || null,
        languageReq: r.languageReq?.trim() || null,
        deadline: r.deadline?.trim() || null,
        tuition: r.tuition?.trim() || null,
        livingCost: r.livingCost?.trim() || null,
        scholarship: r.scholarship?.trim() || null,
        location: r.location?.trim() || null,
        remoteFromChina: r.remoteFromChina,
        eduReq: r.eduReq?.trim() || null,
        expReq: r.expReq?.trim() || null,
        acceptsOverseas: r.acceptsOverseas,
        visaSupport: r.visaSupport,
        policyStatus: r.policyStatus,
      };
      batchEnriched++;
    }
    // Save this batch's results NOW: the old code only wrote the store at
    // the end of the load, so a kill mid-run lost every finished batch.
    if (batchEnriched > 0) {
      await writeCache(ctx, "overseas:enrich:v2", boundedEnrichStore(store, resolved.map((d) => d.url)));
      await markColumnEnrichSuccess(ctx, "overseas");
    }
  };
  // Batches of 3, run sequentially: the 08:02 timeout came from larger
  // parallel batches; small sequential batches are slower but finish.
  // Since 2026-11-23 they are also paced with a pause between batches —
  // see the pacing note at completeEnrichment. Out of budget: stop
  // starting batches; the rest stay fresh for the next run.
  const batches: FeedItem[][] = [];
  for (let s = 0; s < fresh.length; s += 3) batches.push(fresh.slice(s, s + 3));
  for (const [bi, b] of batches.entries()) {
    if (!budgetCanStartBatch(budget)) break;
    if (bi > 0) await sleepMs(ENRICH_BATCH_GAP_MS);
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
        (has && /[一-鿿]/.test(it.summary as string) ? truncateAtBoundary(it.summary as string, 90) : null),
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
      category: entry?.category ?? (entry?.visa || entry?.isImmigration ? "work_visa" : "study"),
      stage: entry?.stage ?? "general",
      kind: entry?.kind ?? (entry?.visa || entry?.isImmigration ? "policy" : "news"),
      majorMatch: entry?.majorMatch ?? null,
      languageReq: entry?.languageReq ?? null,
      deadline: entry?.deadline ?? null,
      tuition: entry?.tuition ?? null,
      livingCost: entry?.livingCost ?? null,
      scholarship: entry?.scholarship ?? null,
      location: entry?.location ?? null,
      remoteFromChina: entry?.remoteFromChina ?? null,
      eduReq: entry?.eduReq ?? null,
      expReq: entry?.expReq ?? null,
      acceptsOverseas: entry?.acceptsOverseas ?? null,
      visaSupport: entry?.visaSupport ?? "unstated",
      policyStatus: entry?.policyStatus ?? null,
    });
  }
  // Deterministic corrections at ingest (same correction also runs on
  // every read inside normalizeOverseas): the NIC Winter Internship is an
  // internship, not a study programme — see correctOverseasItem.
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    const fixed = correctOverseasItem(item);
    if (fixed !== item) items[i] = fixed;
  }
  items.sort((a, b) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  });
  // Applicability first (user rule, 2026-11-22): items that clearly do not
  // apply to the user leave the homepage entirely — not pinned, not in the
  // rotating list, not behind the bachelor-only toggle. Foreign-applicant-
  // only stories (Indian visa statistics, Indian-PhD post-study rights…)
  // leave the same way, judged on title + the enriched applicability
  // fields, so an unenriched headline and an enriched one are held to the
  // same deterministic rule.
  // Project-level merge (user rule, 2026-11-22): all retellings of the
  // NIC Winter Internship project collapse to ONE entry at ingest —
  // the NDTV item stays as representative — before the generic
  // same-event dedupe below runs.
  const applicable = collapseNicProjectItems(
    items.filter(
      (it) => !isNotApplicableToUser(it) && !isForeignApplicantsOnlyItem(it) && !isStudyTrendNoise(it),
    ),
  );
  // One event, one entry — also across the rotating list: same-event
  // retellings collapse to one, preferring the official source, then the
  // newest version.
  const dedupedEvents: OverseasItem[] = [];
  const byPreference = [...applicable].sort((a, b) => {
    if (a.official !== b.official) return a.official ? -1 : 1;
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  });
  for (const it of byPreference) {
    if (dedupedEvents.some((kept) => sameOverseasEvent(kept, it))) continue;
    dedupedEvents.push(it);
  }
  dedupedEvents.sort((a, b) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  });
  // Fixed visa zone: visa-classified discoveries join the pinned store and
  // stay across refreshes; the curated items anchor it ONLY when they pass
  // the applicability check above (mergePinnedVisaItems applies the same
  // rule) — since 2026-11-22 the zone holds the Yale D/S ruling, the
  // Singapore MOM thresholds, the Japan language-school rule and the NZ
  // Short-term Graduate Work Visa as a labelled future path; the NZ PSWV
  // expansion / UK bachelor-only items and the Korea pilot are out
  // because they clearly do not apply to the user. Pinned items are removed from the
  // rotating list so each appears exactly once.
  const pinned = await mergePinnedVisaItems(ctx, dedupedEvents.filter((it) => it.visa));
  const pinnedUrls = new Set(pinned.map((it) => it.url));
  // One event, one entry across BOTH zones: a rotating item that retells
  // an event a pinned item already carries (same event, different URL —
  // e.g. a second outlet's India–NZ FTA piece) is dropped, not shown twice.
  const rotating = dedupedEvents.filter(
    (it) => !pinnedUrls.has(it.url) && !pinned.some((p) => sameOverseasEvent(p, it)),
  );
  const all = [...pinned, ...rotating];

  await writeCache(ctx, "overseas:enrich:v2", boundedEnrichStore(store, resolved.map((d) => d.url)));
  const asOf = await writeCache(ctx, "overseas:all:v20", all);
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

/**
 * Local festival / traffic notices (user rule, 2026-11-22): a travel or
 * traffic advisory written for ONE locality's residents around a local
 * festival or holiday — e.g. 搜狐 2026-11-21 《@大理的小伙伴们 州庆+秋假
 * 将至 这份交通安全出行提示请收好！》 — leaves 国内外要闻 when that
 * locality is neither 江西 nor one of his study destinations （美国、
 * 新西兰、新加坡、越南、日本、韩国、爱尔兰、英国）. Nationwide notices,
 * and travel-safety items about 江西 or a destination, stay. A festival
 * NEWS report without an advisory (no 交通/出行提示 content) is not
 * caught: the rule targets the advisory, not festival coverage.
 * Deterministic: local-festival/local-address signals + a traffic or
 * travel-advisory headline + the absence of any relevant scope.
 */
const WORLD_RELEVANT_SCOPE_RE = /江西|南昌|九江|赣州|宜春|上饶|吉安|抚州|景德镇|萍乡|新余|鹰潭|全国|美国|新西兰|新加坡|越南|日本|韩国|爱尔兰|英国/;
const WORLD_LOCAL_FESTIVAL_RE = /州庆|县庆|市庆|区庆|庙会|泼水节|火把节|秋假|的小伙伴|本地(居民|市民|群众)|当地(居民|市民)/;
const WORLD_TRAFFIC_ADVISORY_RE = /交通(安全|出行|管制|提示)|出行提示|出行安全|道路(交通)?(管制|封闭)|交通管制/;

function isLocalFestivalTrafficNotice(it: { title: string; summary: string | null }): boolean {
  const text = `${it.title} ${it.summary ?? ""}`;
  if (WORLD_RELEVANT_SCOPE_RE.test(text)) return false;
  // Local festival / holiday + a traffic or travel advisory in the headline.
  if (WORLD_LOCAL_FESTIVAL_RE.test(text) && /交通|出行|管制|提示/.test(it.title)) return true;
  // A traffic advisory explicitly addressed to one locality's own people.
  if (WORLD_TRAFFIC_ADVISORY_RE.test(it.title) && /@|的小伙伴|本地|当地|辖区/.test(it.title)) return true;
  return false;
}

async function loadMyWorld(ctx: Ctx, force: boolean): Promise<{ daily: WorldItem[]; weekly: WorldItem[]; all: WorldItem[]; asOf: string }> {
  if (!force) {
    const cached = await readCache<{ daily: WorldItem[]; weekly: WorldItem[]; all: WorldItem[] }>(ctx, "world:all:v3", WORLD_TTL_MS);
    if (cached) return { ...cached.data, asOf: cached.asOf };
  }
  const pool: WorldItem[] = [];
  const pushDedup = (items: FeedItem[], topic: string, weekly: boolean) => {
    for (const it of items) {
      // Local festival/traffic advisories for an unrelated locality never
      // enter the pool (see isLocalFestivalTrafficNotice).
      if (isLocalFestivalTrafficNotice(it)) continue;
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
    await noteRefreshFailure(ctx, "我关注的世界");
    const stale = await readCacheStale<{ daily: WorldItem[]; weekly: WorldItem[]; all: WorldItem[] }>(ctx, "world:all:v3");
    if (stale) return { ...stale.data, asOf: stale.asOf };
    return { daily: [], weekly: [], all: [], asOf: new Date().toISOString() };
  }
  const asOf = await writeCache(ctx, "world:all:v3", { daily, weekly, all });
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
  relevance: z.string(),
  enrichState: z.enum(["new", "stored", "original"]).catch("original"),
  /** For curated anytime resources: the first lesson/practice to start with (2026-11-23). */
  startHint: z.string().nullable().default(null),
  /** Display group: anytime （随时可学） / upcoming （近期可报名）; null = other opportunity (2026-11-23). */
  group: z.enum(["anytime", "upcoming"]).nullable().default(null),
  /** True only for the hand-verified AI-learning curated courses — drives the 「AI 学习」 topic filter (2026-11-23). Pool items never carry it, so the Coursera blog stays out of the AI filter by construction. */
  aiTopic: z.boolean().optional(),
  /** True only for hand-verified English curated courses — drives the 「英语」 topic filter (2026-11-26). Pool items never carry it. */
  englishTopic: z.boolean().optional(),
  /** True only for hand-verified 高等数学 curated courses — drives the 「高等数学」 topic filter (2026-11-26). Pool items never carry it. */
  mathTopic: z.boolean().optional(),
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
  tag: z.enum(["报名", "考试科目", "专业对照", "招生简章", "录取", "其他"]),
  applicableYear: z.string().nullable(),
  relevance: z.string(),
  actionNeeded: z.string(),
  isReference: z.boolean(),
  official: z.boolean(),
  repost: z.boolean(),
  noticeKind: z.enum(["formal2028", "reference", "unconfirmed"]),
  canApplyMajor: z.boolean().nullable(),
  /** Official attachment (PDF/docx) URL for archive items, alongside the notice page (2026-11-23). */
  attachmentUrl: z.string().nullable().default(null),
  /** Document kind badge for archive items （真题/大纲样题/大纲/目录/通知） (2026-11-23). */
  docKind: z.enum(["真题", "大纲样题", "大纲", "目录", "通知"]).nullable().default(null),
});

// ---------------------------------------------------------------------------
// 江西「往年官方备考资料」(2026-11-23): hand-verified official archive for
// the most recent exam year with formal documents (2026). Every URL was
// opened and checked by the researcher (browser.open / curl); the 教育厅
// domain is jyt.jiangxi.gov.cn (the old jxedu.gov.cn no longer resolves).
// The 2026 unified exam was held on 2026-03-29 (NOT April) and the score
// lines were published 2026-04-18. Verified honest gap: neither jxeea.cn
// nor jyt.jiangxi.gov.cn publishes 2026 专升本 真题, and the 《考试说明》
// contains no 例题/样题 either — the client shows that as a static note;
// no 真题 entry is fabricated here. The 对照 conclusion is written into
// the item body, NOT the canApplyMajor badge, because the 目录 table
// itself only goes down to "51 电子与信息大类" and never prints the
// major name 信息安全技术应用 verbatim.
// ---------------------------------------------------------------------------

type JiangxiArchiveItem = z.infer<typeof jiangxiItemSchema>;

const JIANGXI_ARCHIVE_ITEMS: JiangxiArchiveItem[] = [
  {
    title: "关于做好江西省2026年普通高校专升本考试报名工作的通知",
    url: "http://www.jxeea.cn/jxsjyksy/tzgg14/content/content_2003741286481268736.html",
    readUrl: "http://www.jxeea.cn/jxsjyksy/tzgg14/content/content_2003741286481268736.html",
    source: "江西省教育考试院",
    publishedAt: "2025-12-24",
    tag: "报名",
    docKind: "通知",
    attachmentUrl: null,
    summaryZh:
      "2026 年专升本报名通知：江西省普通高校高职（专科）应届毕业生及符合条件的退役大学生士兵报名，网上报名 2026 年 1 月 6 日 9:00 至 11 日 17:00，报名费 130 元/人，分 9 大类按专业对照目录填报志愿。",
    points: [
      "报名条件：江西省 2026 年普通高校高职（专科）应届毕业生（2026 年 7 月 31 日前可取得毕业证，在校期间无记过及以上处分或报名前已解除）及符合条件的退役大学生士兵。",
      "网上报名：2026 年 1 月 6 日 9:00—11 日 17:00，登录考试院网站“专升本管理系统”。",
      "分 9 大类填报志愿，依据高职（专科）毕业专业对照《江西省2026年普通高校专升本考试对应专业（类）指导目录》选报；报名费 130 元/人，于志愿填报期间缴纳。",
      "本通知无独立附件文件，报名条件与流程均为正文内容。",
    ],
    relevance:
      "这是 2026 年江西专升本报名条件与流程的官方通知原文，关系到你 2028 年报名前核对自己是否符合报考条件、熟悉报名步骤与时间节奏。",
    actionNeeded: "现在只需了解往年报名条件与流程，2028 年的正式报名通知出来后再按新通知办。",
    titleOnly: false,
    needsLogin: false,
    isReference: true,
    official: true,
    repost: false,
    noticeKind: "reference",
    applicableYear: "2026年",
    canApplyMajor: null,
  },
  {
    title: "江西省2026年普通高等学校专升本考试各科目考试说明",
    url: "http://jyt.jiangxi.gov.cn/jxjyw/tzgg785/content/content_2005943874253492224.html",
    readUrl: "http://jyt.jiangxi.gov.cn/jxjyw/tzgg785/content/content_2005943874253492224.html",
    source: "江西省教育厅",
    publishedAt: "2025-12-30",
    tag: "考试科目",
    docKind: "大纲",
    attachmentUrl: "http://jyt.jiangxi.gov.cn/jxjyw/tzgg785/2005943874253492224/EWHDl1ln.pdf",
    summaryZh:
      "2026 年专升本全部 12 个科目的考试说明合订本：公共基础课政治+英语+信息技术合卷（300 分/150 分钟），专业基础课 150 分/120 分钟；信息安全技术应用对应理工类，专业基础课为《高等数学及其应用》（说明第 83–88 页）。",
    points: [
      "公共基础课：政治+英语+信息技术合卷，300 分/150 分钟；专业基础课：150 分/120 分钟。",
      "理工类专业基础课为《高等数学及其应用》，在本说明第 83–88 页：函数、极限、连续、一元函数微分学及其应用、一元函数积分学及其应用、常微分方程、多元函数微分学及其应用、二重积分及其应用；题型为单项选择题、填空题、计算题、解答题、应用题。",
      "本说明 12 个科目均只有考试内容与要求、考试形式与题型、参考书目三部分，无例题、样题、样卷。",
      "考试院 2025-12-31 转发：http://www.jxeea.cn/jxsjyksy/tzgg14/content/content_2007652411455311872.html",
    ],
    relevance:
      "这是 2026 年全部 12 科的官方考试大纲，关系到你备考要复习哪些科目、每科考什么范围与题型；理工类看《高等数学及其应用》第 83–88 页。",
    actionNeeded: "按这份说明规划复习：公共课政治、英语、信息技术合卷，专业课高等数学；2028 年以当年新版说明为准。",
    titleOnly: false,
    needsLogin: false,
    isReference: true,
    official: true,
    repost: false,
    noticeKind: "reference",
    applicableYear: "2026年",
    canApplyMajor: null,
  },
  {
    title: "江西省2026年普通高等学校专升本考试对应专业（类）指导目录",
    url: "http://jyt.jiangxi.gov.cn/jxjyw/tzgg785/content/content_2001500515568979968.html",
    readUrl: "http://jyt.jiangxi.gov.cn/jxjyw/tzgg785/content/content_2001500515568979968.html",
    source: "江西省教育厅",
    publishedAt: "2025-12-18",
    tag: "专业对照",
    docKind: "目录",
    attachmentUrl: "http://jyt.jiangxi.gov.cn/jxjyw/tzgg785/2001500515568979968/7Ul8fxAy.docx",
    summaryZh:
      "指导目录见《实施方案》附件 5：本条链接是《江西省2026年普通高等学校专升本考试招生实施方案》的通知页，指导目录是该《实施方案》的附件 5，不是独立通知页。目录内容：信息安全技术应用（510203）属 51 电子与信息大类，对应理工类（序号 5），专业基础课为《高等数学及其应用》，可报本科方向为 0809 计算机类普通本科与 3102 计算机类职业本科。",
    points: [
      "位置：指导目录第 2–3 页、序号 5 理工类；“0809 计算机类、3102 计算机类（职业本科）”一行对应高职（专科）专业（类）栏写有“51 电子与信息大类”。",
      "报考类别：理工类（序号 5），不可跨类；公共基础课政治+英语+信息技术合卷（300 分）；专业基础课《高等数学及其应用》（150 分，见考试说明第 83–88 页）。",
      "可报本科方向（该行）：0809 计算机类普通本科（如计算机科学与技术、信息安全）、3102 计算机类职业本科；具体某本科专业当年是否招生、以各校招生简章为准。",
      "诚实说明：目录表内没有逐字出现“信息安全技术应用”这个专业名称，表只到“51 电子与信息大类”这一级；“510203 属 51 大类”一步来自国家《职业教育专业目录》体系，非目录原文。附件 docx 经核实可下载（HTTP 200、docx、约 556KB），表格内容经景德镇艺术职业大学官网转载同名文件与江西警察学院 2026 年招生简章交叉核对一致。",
    ],
    relevance:
      "专业对照决定信息安全技术应用能报考哪个本科专业——这是 2026 年的官方目录，理工类序号 5 的 0809/3102 计算机类一行对应 51 电子与信息大类，与你能不能报、报哪个专业直接相关。",
    actionNeeded:
      "确认自己在理工类、专业课考高等数学；2028 年对照目录重新发布后按当年版本复核“51 电子与信息大类”是否仍对应理工类。",
    titleOnly: false,
    needsLogin: false,
    isReference: true,
    official: true,
    repost: false,
    noticeKind: "reference",
    applicableYear: "2026年",
    canApplyMajor: null,
  },
  {
    title: "江西省2026年普通高校专升本录取控制分数线及网上录取安排",
    url: "http://www.jxeea.cn/jxsjyksy/tzgg14/content/content_2046062825781657600.html",
    readUrl: "http://www.jxeea.cn/jxsjyksy/tzgg14/content/content_2046062825781657600.html",
    source: "江西省教育考试院",
    publishedAt: "2026-04-18",
    tag: "录取",
    docKind: "通知",
    attachmentUrl: null,
    summaryZh:
      "2026 年专升本录取控制分数线（总分 450 分）：理工类 214 分；文史哲类 325、经济类 214、法学类 279、教育类 291、农医药类 328、医学类 332、管理类 283、艺术类 236；征集志愿降分录取时各大类均不得低于 180 分。",
    points: [
      "2026 年统一考试于 3 月 29 日举行（公共基础课 9:00—11:30，专业基础课 15:00—17:00）；分数线 2026 年 4 月 18 日公布。",
      "理工类 214 分（总分 450）；文史哲类 325、经济类 214、法学类 279、教育类 291、农医药类 328、医学类 332、管理类 283、艺术类 236。",
      "征集志愿降分录取时，各大类均不得低于 180 分。",
      "本通知无独立附件文件，分数线表为正文内容；第三方转载数字与官网不符的，以官网为准。",
    ],
    relevance:
      "这是 2026 年江西专升本录取分数线的官方通知，理工类 214 分，关系到你给 2028 年定目标分数时参考的往年录取门槛。",
    actionNeeded: "以理工类 214 分为往年参考定目标，2028 年分数线以当年公布为准。",
    titleOnly: false,
    needsLogin: false,
    isReference: true,
    official: true,
    repost: false,
    noticeKind: "reference",
    applicableYear: "2026年",
    canApplyMajor: null,
  },
  {
    title: "关于做好全省2026年普通高校专升本考试招生工作的通知",
    url: "http://www.jxeea.cn/jxsjyksy/tzgg14/content/content_2017128634308890624.html",
    readUrl: "http://www.jxeea.cn/jxsjyksy/tzgg14/content/content_2017128634308890624.html",
    source: "江西省教育厅",
    publishedAt: "2026-01-27",
    tag: "招生简章",
    docKind: "通知",
    attachmentUrl: null,
    summaryZh:
      "2026 年专升本考试招生工作通知：统一考试 2026 年 3 月 29 日，志愿填报 3 月 6 日 9:00 至 9 日 17:00，成绩 4 月 14 日后可查；9 类与专业基础课对应表中理工类对应《高等数学及其应用》。",
    points: [
      "统一考试 2026 年 3 月 29 日：公共基础课 9:00—11:30，专业基础课 15:00—17:00。",
      "志愿填报 3 月 6 日 9:00—9 日 17:00；成绩 4 月 14 日后可查。",
      "9 类与专业基础课对应：文史哲—大学语文及应用文写作、经济—经济学基础与应用、法学—法律基础与法律实务、教育—教育学及教学设计、理工—高等数学及其应用、农医药—化学基础与分析检验、医学—人体解剖学、管理—管理学原理及应用、艺术—艺术概论与欣赏。",
    ],
    relevance:
      "这是 2026 年专升本考试招生工作的官方通知，关系到你了解往年考试时间、志愿填报节奏和 9 类对应的专业基础课。",
    actionNeeded: "了解往年时间节奏即可，2028 年以当年通知为准。",
    titleOnly: false,
    needsLogin: false,
    isReference: true,
    official: true,
    repost: false,
    noticeKind: "reference",
    applicableYear: "2026年",
    canApplyMajor: null,
  },
];

// ---------------------------------------------------------------------------
// 学习栏「随时可学」精选 (2026-11-23): hand-verified free resources a
// 专科在读生 can start right now — 网络安全/英语公开课， authorised CTF
// practice and a university lecture recording. Every URL was opened and
// checked by the researcher; each carries a startHint naming the first
// lesson or exercise. publishedAt is null: these are standing resources,
// not news. 2026-11-26 扩充：新增 6 项已核实免费资源（哈佛 CS50x、freeCodeCamp、TryHackMe 免费房间、PortSwigger Web 安全学院、MIT OCW 6.858 进阶、江苏农林高等数学（一）），本数组共 12 项；同日第二轮扩充又新增 2 项已核实免费资源（哈佛 CS50's Introduction to Cybersecurity、思科 Introduction to Cybersecurity），本数组共 15 项。福州大学《网络空间安全概论》与上交《信息安全数学基础》未通过 matcher（条目文本无免费证据），不加；北理工 smartedu 入口已从本数组移出（与 AI 精选的 MOOC 入口为同一门课，去重后只留一处），合并列表 34 项、AI 筛选仍 7 项。同日第三轮扩充（英语/高数筛选）：新增可汗学院中文站 1 项（mathTopic，覆盖高数全部 6 阶段）；国防科大《大学英语（口语）》补 englishTopic（日常英语方向），江苏农林《高等数学（一）》补 mathTopic（高数路线第 1–3 阶段）。同日第四轮扩充（英语/高数 Tier 2，用户 22:54 批准「加上，标清平台免费」）：再新增 10 项 MOOC 课（A1–A5 专升本英语、B2 日常英语听力、M1–M4 高数），本数组共 25 项；费用口径统一为「平台课程学习免费，仅认证证书付费」，每条 points 末尾照抄完整批准句（课程页未写‘免费’二字）。清华《生活英语听说》因链接未验证暂缓，不加。同日第五轮扩充（江西理工高数，用户 23:25 批准「加江西理工那两门，标清是通用课」）：再新增 2 项智慧教育平台/学银在线课程（江西理工大学《高等数学（一）》《高等数学（二）》，mathTopic，第 1–3 / 第 4–6 阶段），本数组共 27 项；费用口径按课程页原文核实：课程页未写‘免费’二字、也未标价，平台课程学习免费，证书是否收费未说明；（二）已结课、回放未确认；两门均为江西高校通用高数课，绝不标成“江西专升本高数课”。 「近期可报名」 has NO curated entries this round — the check
// found no official page explicitly open for free registration, so that
// group honestly stays empty (pool items can still land there via the
// deadlines rule in getLearning).
// ---------------------------------------------------------------------------

type CuratedLearningItem = z.infer<typeof learningItemSchema>;

export const CURATED_LEARNING_ANYTIME: CuratedLearningItem[] = [
  {
    title: "网络安全入门与实战（湖南铁道职业技术学院）",
    url: "https://www.icourse163.org/course/HNRPC-1466016178",
    readUrl: "https://www.icourse163.org/course/HNRPC-1466016178",
    officialUrl: "https://www.icourse163.org/course/HNRPC-1466016178",
    source: "中国大学MOOC / 湖南铁道职业技术学院",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "最贴合专科的网络安全课，湖南铁道职业技术学院开设：14 个项目、33 个任务、74 个子任务，分基础、进阶、管理、实战四层；常见问题明写没有基础也能学会。",
    points: [
      "学习视频免费，需免费注册账号选课。",
      "14 个项目、33 个任务、74 个子任务，分基础、进阶、管理、实战四层；学校课程页显示进行至第 2 周。",
    ],
    relevance: "适合没有基础的专科在读生，从项目实操入门网络安全，能直接选课开始学。",
    startHint: "从模块 1“遵章办事，有的放矢——课程定位与基础”之 1.1《课程定位》开始",
    fee: "免费",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
  },
  {
    title: "计算机系统与网络安全技术（电子科技大学）",
    url: "https://www.icourse163.org/course/UESTC-235006?tid=272013",
    readUrl: "https://www.icourse163.org/course/UESTC-235006?tid=272013",
    officialUrl: "https://www.icourse163.org/course/UESTC-235006?tid=272013",
    source: "中国大学MOOC / 电子科技大学",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "理论进阶的网络安全课，电子科技大学周世杰教授开设；国家高等教育智慧教育平台镜像页显示开课中，2026/08/30–2026/12/27。",
    points: ["学习视频免费，需免费注册账号选课。", "开课中：2026/08/30–2026/12/27。"],
    relevance: "适合学完基础课后进阶理论的专科在读生，能直接选课开始学计算机系统与网络安全技术。",
    startHint: "从第一章《信息安全概述》之“网络安全的定义”开始",
    fee: "免费",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
  },
  {
    title: "大学英语（口语）（国防科技大学）",
    url: "https://higher.smartedu.cn/course/6aeb9d2eb44e493c76486902",
    readUrl: "https://higher.smartedu.cn/course/6aeb9d2eb44e493c76486902",
    officialUrl: "https://higher.smartedu.cn/course/6aeb9d2eb44e493c76486902",
    source: "中国大学MOOC / 国防科技大学（国家高等教育智慧教育平台）",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "练口语和日常话题的大学英语公开课，国防科技大学刘源源开设；开课中，2026/10/22 起；100 万+人选课；适用对象为有一定英语基础、希望在口语单项上有所突破的学生。",
    points: [
      "方向：日常英语（2026 年考试说明不考听力口语，这门课练日常口语）",
      "学习视频免费，需免费注册账号选课。",
      "开课中：2026/10/22 起；100 万+人选课。",
    ],
    englishTopic: true,
    relevance: "适合有一定英语基础、想练口语的专科在读生，能直接选课从日常话题开始练。",
    startHint: "从 Week 1 Unit 1《Hometown》开始（接着是 Unit 2 Campus life）",
    fee: "免费",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
  },
  {
    title: "CyLab Security Academy（原 picoCTF，美国卡内基梅隆大学）",
    url: "https://cylabacademy.org/",
    readUrl: "https://cylabacademy.org/",
    officialUrl: "https://cylabacademy.org/",
    source: "美国卡内基梅隆大学 CyLab",
    publishedAt: null,
    category: "resources",
    summaryZh:
      "免费的 CTF 练习平台，美国卡内基梅隆大学 CyLab 开设：500+ 挑战，General Skills 等 8 个方向；页面明写 Always free，每道题都是为被攻破而设计的，练习本身合法。",
    points: [
      "免费，需免费注册账号（邮箱验证）才能做题、记进度并使用网页版 Linux shell。",
      "授权范围：只在平台指定的靶场内做题；入门指南 https://primer.cylabacademy.org/ 。",
      "原站 https://picoctf.org/ 已迁移至此。",
    ],
    relevance: "适合想练 CTF 的专科在读生，在合法授权的平台靶场内做题，能直接注册开始练。",
    startHint: "先读入门指南 Primer 的 2.3《Get a Shell》，完成 2.5.3《Shell Nav Exercise 1》，再进平台 General Skills 分类做入门题",
    fee: "免费",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
  },
  {
    title: "OverTheWire：Bandit（面向纯新手的网络安全靶场）",
    url: "https://overthewire.org/wargames/bandit/",
    readUrl: "https://overthewire.org/wargames/bandit/",
    officialUrl: "https://overthewire.org/wargames/bandit/",
    source: "OverTheWire（志愿者社区）",
    publishedAt: null,
    category: "resources",
    summaryZh:
      "面向纯新手的免费网络安全靶场：无账号、无报名，用 SSH 直接连靶场做题；规则页明写平台免费向玩家提供这些资源。",
    points: [
      "免费，无需注册；用 SSH 直连靶场 bandit.labs.overthewire.org（端口 2220）。",
      "授权范围：练习只在平台指定的 Bandit 服务器上做，不要把学到的手法用于其他未授权系统；规则页 https://overthewire.org/rules/ 。",
    ],
    relevance: "适合零基础想练 Linux 与网络安全基本功的专科在读生，无需注册，能直接连靶场开始。",
    startHint: "从 Level 0 开始：用用户名和密码均为 bandit0 登录，读 home 目录里的 readme 文件，拿到进入 Level 1 的密码",
    fee: "免费",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
  },
  {
    title: "剑桥大学计算机系《Security》课程录像（2020–21）",
    url: "https://www.cl.cam.ac.uk/teaching/2021/Security/video/",
    readUrl: "https://www.cl.cam.ac.uk/teaching/2021/Security/video/",
    officialUrl: "https://www.cl.cam.ac.uk/teaching/2021/Security/video/",
    source: "英国剑桥大学计算机科学与技术系",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "剑桥大学计算机系《Security》课程录像（2020–21 学年），直接点 mp4 链接即可看或下载，无需注册；全英文、偏理论进阶。",
    points: [
      "免费，无需注册，直接点 mp4 链接即可看或下载。",
      "全英文、偏理论进阶，适合在基础课之后看；不是中文讲座。",
    ],
    relevance: "适合学完基础课后想进阶理论的专科在读生，能直接点开录像看。",
    startHint: "从“1 Introduction”（约 23 分钟）开始，接着是“2 Security targets”",
    fee: "免费",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
  },
  {
    title: "CS50x：计算机科学导论（哈佛大学）",
    url: "https://cs50.harvard.edu/x/",
    readUrl: "https://cs50.harvard.edu/x/",
    officialUrl: "https://cs50.harvard.edu/x/",
    source: "哈佛大学 CS50 / edX",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "哈佛大学零基础编程入门课，11 周自定进度：C、Python、SQL、网页开发一条线，含安全、密码学、取证主题；哈佛官网写明可经 OpenCourseWare 免费学，仅验证证书收费。",
    points: [
      "免费学习：哈佛官网写明可经 OpenCourseWare 免费学；edX 旁听免费，仅验证证书 219 美元。",
      "零基础可学，无先修要求；自定进度，11 周，每周 10–20 小时。",
      "全英文，无中文字幕（讲座另有葡语/西语配音）。",
    ],
    relevance: "适合零基础补编程基础的信息安全专业学生，能直接从第 0 周开始学；C 语言与 Python 都是后续安全课的地基。",
    startHint: "从 Lecture 0 – Scratch（第 0 周）开始",
    fee: "免费（需免费注册；验证证书付费）",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
  },
  {
    title: "freeCodeCamp 免费编程课程",
    url: "https://www.freecodecamp.org/learn",
    readUrl: "https://www.freecodecamp.org/learn",
    officialUrl: "https://www.freecodecamp.org/learn",
    source: "freeCodeCamp.org（美国非营利组织）",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "免费自定进度的编程课平台：全栈网页开发与机器学习课程完全免费，同一账号还能练 A2/B1 开发者英语；官网写明课程完全免费、部分含免费认证。",
    points: [
      "免费：官网写明课程完全免费，部分含免费认证；登录保存进度也是免费的。",
      "自定进度，从推荐课程第一课开始；完成 5 个项目并通过考试可获免费认证。",
      "全英文，无中文字幕；另有 A2/B1 开发者英语认证可同步练英语。",
    ],
    relevance: "适合想练编程又想练英语的专科在读生，一个账号同时练全栈开发与开发者英语，读写正好补口语之外的短板。",
    startHint: "从推荐课程第一项 Responsive Web Design 的第一课开始；想练英语可同步看 A2 English for Developers",
    fee: "免费",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
  },
  {
    title: "TryHackMe：Pre Security 学习路径（免费房间）",
    url: "https://tryhackme.com/path/outline/presecurity",
    readUrl: "https://tryhackme.com/path/outline/presecurity",
    officialUrl: "https://tryhackme.com/path/outline/presecurity",
    source: "TryHackMe（英国网络安全实训平台）",
    publishedAt: null,
    category: "resources",
    summaryZh:
      "信息安全实训平台的免费入门路径：Linux、网络、Web 安全、密码学等数百间免费房间，浏览器内 AttackBox 每天免费 1 小时；官网写明免费账号可进数百间免费房间。",
    points: [
      "免费：免费账号可进数百间免费房间，浏览器内 AttackBox 每天 1 小时；无需银行卡。",
      "零基础可学，路径从 Introduction to Cyber Security 开始。",
      "注意：路径中途有付费房间，完成路径的证书需付费订阅；只用免费部分即可。",
    ],
    relevance: "适合想动手练信息安全的专科在读生，不用自己搭环境，在浏览器里就能练 Linux、网络与 Web 安全。",
    startHint: "从 Pre Security 路径第 1 节 Introduction to Cyber Security 的第一间房 Learning Cyber Security 开始",
    fee: "免费（免费房间；部分房间与证书付费）",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
  },
  {
    title: "PortSwigger Web Security Academy（Web 安全学院）",
    url: "https://portswigger.net/web-security",
    readUrl: "https://portswigger.net/web-security",
    officialUrl: "https://portswigger.net/web-security",
    source: "PortSwigger（Burp Suite 开发商）",
    publishedAt: null,
    category: "resources",
    summaryZh:
      "免费的 Web 应用安全实训中心：31 个主题、数百个交互实验全部免费，官网写明 100% 免费；SQL 注入、XSS、SSRF 直接对应 OWASP Top 10。",
    points: [
      "免费：官网写明学院 100% 免费，全部课程与实验免费，无时间限制。",
      "从服务端主题开始，首选 SQL 注入主题，Apprentice 级为初学者设计。",
      "全英文，无中文字幕；部分实验可用免费的 Burp Suite Community Edition。",
    ],
    relevance: "适合想练 Web 安全的专科在读生，全部实验免费，是信息安全专业最对口的动手练场。",
    startHint: "从 Server-side topics（服务端主题）的 SQL 注入主题开始，第一实验是 Apprentice 级 SQL 注入取隐藏数据",
    fee: "免费（需免费注册才保存进度；可选 BSCP 认证考试收费）",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
  },
  {
    title: "MIT OCW 6.858 计算机系统安全（进阶）",
    url: "https://ocw.mit.edu/courses/6-858-computer-systems-security-fall-2014/",
    readUrl: "https://ocw.mit.edu/courses/6-858-computer-systems-security-fall-2014/",
    officialUrl: "https://ocw.mit.edu/courses/6-858-computer-systems-security-fall-2014/",
    source: "麻省理工学院 MIT OpenCourseWare",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "MIT 计算机系统安全课（2014 年归档）：操作系统安全、能力、信息流控制、语言安全、网络协议与 Web 应用安全；讲义、录像、实验、试卷全部免费下载，无登录与付费墙。",
    points: [
      "免费：OCW 课程全部免费共享，无登录、无付费墙，Creative Commons 许可。",
      "进阶课：先修课为 MIT 6.033，面向高年级与硕士；实验涉及 x86 汇编、C、Python、JavaScript。",
      "2014 年归档课，部分技术已旧；无证书、无答疑；实验环境需自己搭建。",
    ],
    relevance: "适合学完基础课后想进阶理论的专科在读生，先看前几讲（威胁模型、控制劫持、缓冲区溢出、权限分离），不要一开始就做全套实验。",
    startHint: "从 Lecture 1: Introduction, Threat Models 开始，先看 Lecture 1–4",
    fee: "免费",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
  },
  {
    title: "高等数学（一）— 江苏农林职业技术学院",
    url: "https://www.icourse163.org/course/JASFC-1001755293?from=searchPage&outVendor=zw_mooc_pcssjg_",
    readUrl: "https://www.icourse163.org/course/JASFC-1001755293?from=searchPage&outVendor=zw_mooc_pcssjg_",
    officialUrl: "https://www.icourse163.org/course/JASFC-1001755293?from=searchPage&outVendor=zw_mooc_pcssjg_",
    source: "中国大学MOOC / 江苏农林职业技术学院",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "按专升本《高等数学》考试大纲上限要求设置的课：函数、极限与连续、导数与微分、中值定理与导数的应用、不定积分、定积分；课程页写明免费供校内外学生选课使用；开课中 2026/09/01–2027/01/15。",
    points: [
      "免费：课程页写明免费供校内外学生选课使用，需免费注册账号选课。",
      "开课中：2026/09/01–2027/01/15，20 周，60 课时。",
      "按江苏省专转本《高等数学》考试大纲设置，与江西《高等数学及其应用》前半部分高度重合，但以江西考试说明为准对照取舍；本课只覆盖一元微积分，不含常微分方程、多元微分、二重积分。",
    ],
    relevance: "适合备考专升本的专科在读生，按专升本大纲编排的一元微积分课，能直接选课从函数开始学。",
    mathTopic: true,
    startHint: "从第 1 周“函数、极限与连续（一）”开始",
    fee: "免费（需免费注册；认证证书付费）",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
  },
  {
    title: "CS50's Introduction to Cybersecurity（哈佛大学）",
    url: "https://cs50.harvard.edu/cybersecurity/#how-to-take-this-course",
    readUrl: "https://cs50.harvard.edu/cybersecurity/#how-to-take-this-course",
    officialUrl: "https://cs50.harvard.edu/cybersecurity/#how-to-take-this-course",
    source: "哈佛大学 CS50",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "哈佛大学网络安全入门课程，5 周，无先修要求；哈佛官网写明非哈佛学生也可经 OpenCourseWare 免费学这门课，交作业需免费 edX 账号，verified 证书付费。",
    points: [
      "免费学习：哈佛官网写明可经 OpenCourseWare 免费学；交作业需免费 edX 账号，仅 verified 证书付费。",
      "5 周课程，无先修要求；自定进度。",
      "全英文，无中文字幕。",
    ],
    relevance: "适合零基础想系统学网络安全的专科在读生，哈佛 CS50 的课可直接从第 1 周开始；英文授课，顺带练专业英语。",
    startHint: "从第 1 周开始",
    fee: "免费（需免费注册 edX 账号；verified 证书付费）",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
  },
  {
    title: "Introduction to Cybersecurity（思科 Networking Academy）",
    url: "https://www.cisco.com/site/us/en/learn/training-certifications/training/netacad/index.html",
    readUrl: "https://www.cisco.com/site/us/en/learn/training-certifications/training/netacad/index.html",
    officialUrl: "https://www.cisco.com/site/us/en/learn/training-certifications/training/netacad/index.html",
    source: "思科 Networking Academy",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "思科网络安全入门课，初级，约 6 小时自定进度；思科官网写明免费的自定进度在线课程，需先免费注册 NetAcad 账号再选课，完成后有 Credly 数字徽章。",
    points: [
      "免费：思科官网写明 It's free，免费自定进度在线课程；需先免费注册 NetAcad 账号再选课。",
      "初级，约 6 小时，自定进度；完成后有 Credly 数字徽章。",
      "全英文，无中文字幕。",
    ],
    relevance: "适合零基础想快速入门网络安全的专科在读生，6 小时能走完一遍，还能拿一个数字徽章；英文授课。",
    startHint: "先免费注册 NetAcad 账号，再从第一模块开始",
    fee: "免费（需免费注册 NetAcad 账号）",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
  },
  {
    title: "可汗学院中文站（微分学 / 积分学 / 多变量微积分）",
    url: "https://zh.khanacademy.org/",
    readUrl: "https://zh.khanacademy.org/",
    officialUrl: "https://zh.khanacademy.org/",
    source: "可汗学院（非营利）",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "免费的数学讲解+练习平台，中文界面：微分学、积分学、多变量微积分覆盖江西《高等数学及其应用》全部 6 个阶段；每技能做对 4 题中的 3 题升级，做题即时反馈+提示，另有测验与单元测试；视频为英文讲解配中文字幕/中文讲稿，练习题为中文。",
    points: [
      "免费：首页写明‘免费在线课程，讲解以及练习’‘对学生、教师和家庭永远免费’。",
      "第 1 阶段（函数、极限和连续）：站内进‘微分学 Unit 1 极限与连续’。",
      "第 2 阶段（一元函数微分学）：导数的定义视频（中文字幕）https://zh.khanacademy.org/math/differential-calculus/dc-diff-intro/dc-derivative-intro/v/calculus-derivatives-2-5-new-hd-version ；函数分析单元（中值定理、极值、单调、凹凸拐点）https://zh.khanacademy.org/math/differential-calculus/dc-analytic-app/dc-candidates-test 。",
      "第 3 阶段（一元函数积分学）：积分单元 https://zh.khanacademy.org/math/integral-calculus/ic-integration/ic-common-indefinite-integrals 。",
      "第 4 阶段（常微分方程）：站内进‘积分学·微分方程’。",
      "第 5 阶段（多元函数微分学）：站内进‘多变量微积分·偏导数’。",
      "第 6 阶段（二重积分）：双积分文章 https://zh.khanacademy.org/math/multivariable-calculus/integrating-multivariable-functions/double-integrals-a/a/double-integrals ，含‘自己试试！’练习。",
      "注意：从中国访问可能加载偏慢，视频流畅播放未实测。",
    ],
    relevance: "适合按江西《高等数学及其应用》顺序自学的专科在读生，6 个阶段都有讲解+即时反馈练习，能直接从第 1 阶段开始。",
    startHint: "从‘微分学 Unit 1 极限与连续’开始（第 1 阶段）",
    fee: "免费",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
    mathTopic: true,
  },
  {
    title: "大学英语（四）",
    url: "https://www.icourse163.org/course/HAUST-1205788802",
    readUrl: "https://www.icourse163.org/course/HAUST-1205788802",
    officialUrl: "https://www.icourse163.org/course/HAUST-1205788802",
    source: "中国大学MOOC · 河南科技大学",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "河南科技大学《大学英语（四）》：专升本英语方向，练词汇与结构、阅读理解、写作和段落翻译；每单元分导入、文化背景、文章分析、写作技巧、词汇与结构五部分，配单元测试，适用年份 2026·往年参考。",
    points: [
      "专升本英语方向，练词汇与结构、阅读理解、写作和段落翻译，适用年份 2026·往年参考。",
      "每单元分导入、文化背景、文章分析、写作技巧、词汇与结构五部分，配单元测试，属配套练习（非真题）。",
      "授课目标明确含翻译能力（可借助词典翻译议论性材料），直接对齐段落翻译（汉英互译）考项。",
      "中国大学 MOOC 平台课程学习免费，仅认证证书付费；课程页未写‘免费’二字。",
    ],
    englishTopic: true,
    relevance: "适合备考专升本英语的专科在读生，词汇、阅读、写作、翻译都练，能直接从第一单元开始。",
    startHint: "第一单元，从 Lead-in Activities（导入）开始",
    fee: "平台课程学习免费，仅认证证书付费",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
  },
  {
    title: "大学英语读写（一）",
    url: "https://www.icourse163.org/course/CHD-1473164170",
    readUrl: "https://www.icourse163.org/course/CHD-1473164170",
    officialUrl: "https://www.icourse163.org/course/CHD-1473164170",
    source: "中国大学MOOC · 长安大学",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "长安大学《大学英语读写（一）》：专升本英语方向，练词汇与语法、阅读理解和写作；共 8 个主题单元，基于《新视野大学英语 1（第四版）读写教程》，每单元后有单元项目检测，适用年份 2026·往年参考。",
    points: [
      "专升本英语方向，练词汇与语法、阅读理解和写作，每单元后有单元项目检测，适用年份 2026·往年参考。",
      "共 8 个主题单元，基于《新视野大学英语 1（第四版）读写教程》，属配套练习（非真题）。",
      "覆盖词汇结构、阅读、写作三项考项，不含段落翻译专项，需与第 5 条搭配使用。",
      "中国大学 MOOC 平台课程学习免费，仅认证证书付费；课程页未写‘免费’二字。",
    ],
    englishTopic: true,
    relevance: "适合备考专升本英语的专科在读生，练词汇语法、阅读和写作，能直接从第 1 单元开始；段落翻译需与英汉互译课搭配。",
    startHint: "第 1 单元，从 Overview（主题导入）开始",
    fee: "平台课程学习免费，仅认证证书付费",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
  },
  {
    title: "新通用大学英语（一）",
    url: "https://www.icourse163.org/course/JLXY-1461316178",
    readUrl: "https://www.icourse163.org/course/JLXY-1461316178",
    officialUrl: "https://www.icourse163.org/course/JLXY-1461316178",
    source: "中国大学MOOC · 南京大学金陵学院",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "南京大学金陵学院《新通用大学英语（一）》：专升本英语方向，练词汇、阅读技能、写作和听说读写译综合技能；共 10 个单元，起点低（完成高中英语、掌握 1500 词即可），适用年份 2026·往年参考。",
    points: [
      "专升本英语方向，练词汇、阅读技能、写作和听说读写译综合技能，适用年份 2026·往年参考。",
      "共 10 个单元（Unit 1 Meeting people 起），每单元含口语交际、知识拓展、听力技巧、阅读技能模块及单元测试，属配套练习（非真题）。",
      "起点低（完成高中英语、掌握 1500 词即可），适合做专升本英语入门第一课；含听力口语内容，考试不考听力口语，听力部分只作日常积累。",
      "中国大学 MOOC 平台课程学习免费，仅认证证书付费；课程页未写‘免费’二字。",
    ],
    englishTopic: true,
    relevance: "适合刚起步备考专升本英语的专科在读生，起点低，可作入门第一课，能直接从 Unit 1 开始。",
    startHint: "Unit 1 Meeting people → 1.1 Oral Communication: Getting to know people",
    fee: "平台课程学习免费，仅认证证书付费",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
  },
  {
    title: "大学英语学术阅读与写作（王海啸）",
    url: "https://www.icourse163.org/course/NJU-1002227016",
    readUrl: "https://www.icourse163.org/course/NJU-1002227016",
    officialUrl: "https://www.icourse163.org/course/NJU-1002227016",
    source: "中国大学MOOC · 南京大学",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "南京大学《大学英语学术阅读与写作（王海啸）》：专升本英语方向，主练阅读理解的学术阅读策略；共 11 个单元，另有第二部分学术写作，难度高于入门课，适合阅读进阶，适用年份 2026·往年参考。",
    points: [
      "专升本英语方向，主练阅读理解（略读、扫读、找主旨、辨主次、推断、修辞结构等学术阅读策略），适用年份 2026·往年参考。",
      "共 11 个单元，另有第二部分学术写作（同一系列课程），属配套练习（非真题）。",
      "难度高于第 1–3 条（起点要求达《大学英语课程教学要求》一般要求水平），适合阅读进阶，不适合做第一课。",
      "中国大学 MOOC 平台课程学习免费，仅认证证书付费；课程页未写‘免费’二字。",
    ],
    englishTopic: true,
    relevance: "适合已有基础、想进阶阅读的专科在读生，不适合做第一课，能直接从第一部分 Unit 1 开始。",
    startHint: "第一部分学术英语阅读，Unit 1 → 1 Introduction to the Course",
    fee: "平台课程学习免费，仅认证证书付费",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
  },
  {
    title: "英汉互译方法与技巧",
    url: "https://www.icourse163.org/course/NJU-1002331010",
    readUrl: "https://www.icourse163.org/course/NJU-1002331010",
    officialUrl: "https://www.icourse163.org/course/NJU-1002331010",
    source: "中国大学MOOC · 南京大学",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "南京大学《英汉互译方法与技巧》：专升本英语方向，专练段落翻译（汉英互译），英译汉和汉译英并重；按字词、句子、段落、篇章由简到繁讲翻译过程与技巧，适用年份 2026·往年参考。",
    points: [
      "专升本英语方向，专练段落翻译（汉英互译），英译汉和汉译英并重，适用年份 2026·往年参考。",
      "按字词、句子、段落、篇章由简到繁讲翻译过程与技巧，含科技、法律、文学、演讲等多类文体实例，属配套练习（非真题）。",
      "直接对齐考试“段落翻译（汉英互译）”考项，是 5 门专升本英语课中唯一翻译专项。",
      "中国大学 MOOC 平台课程学习免费，仅认证证书付费；课程页未写‘免费’二字。",
    ],
    englishTopic: true,
    relevance: "适合备考专升本英语的专科在读生，是 5 门专升本英语课中唯一翻译专项，直接对齐段落翻译考项，能直接从简介开始。",
    startHint: "Brief Introduction to Translation → 1.1 Why Translate",
    fee: "平台课程学习免费，仅认证证书付费",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
  },
  {
    title: "英语听力技能与实践",
    url: "https://www.icourse163.org/course/JMU-1002922010",
    readUrl: "https://www.icourse163.org/course/JMU-1002922010",
    officialUrl: "https://www.icourse163.org/course/JMU-1002922010",
    source: "中国大学MOOC · 集美大学",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "集美大学《英语听力技能与实践》：日常英语方向，专练听力技能；共 6 章、每章若干 6–10 分钟微课视频，预计 10–12 周，第三批国家级一流本科线上课程，适用年份 2026·往年参考。",
    points: [
      "日常英语方向，专练听力技能（听力过程、听力技巧与方法、笔记、复述、新闻英语、听歌看电影练听力），考试不考听力，本课只作日常积累，适用年份 2026·往年参考。",
      "共 6 章、每章若干 6–10 分钟微课视频，预计 10–12 周，配大量技能与实践训练，属配套练习（非真题）。",
      "第三批国家级一流本科线上课程；起点要求中级以上听力水平，另有 CET、TEM-4 听力测试章节。",
      "中国大学 MOOC 平台课程学习免费，仅认证证书付费；课程页未写‘免费’二字。（配套教材修订版需自行购买，不影响课程免费）",
    ],
    englishTopic: true,
    relevance: "适合想练日常听力的专科在读生，考试不考听力，本课只作日常积累，能直接从第一章开始。",
    startHint: "第一章 英语听力综合技能，从“英语听力过程”开始",
    fee: "平台课程学习免费，仅认证证书付费",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
  },
  {
    title: "高等数学（一）",
    url: "https://www.icourse163.org/course/TONGJI-53004",
    readUrl: "https://www.icourse163.org/course/TONGJI-53004",
    officialUrl: "https://www.icourse163.org/course/TONGJI-53004",
    source: "中国大学MOOC · 同济大学",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "同济大学《高等数学（一）》：高数第 1–2 阶段（一元极限与连续、导数和微分及其应用）；共 10 讲，从函数与极限讲到函数图形描绘与曲率，每讲配测验，适用年份 2026·往年参考。",
    points: [
      "高数第 1–2 阶段（一元极限与连续、导数和微分及其应用），按官方 6 阶段顺序定位，适用年份 2026·往年参考。",
      "共 10 讲，从函数与极限讲到函数图形描绘与曲率，每讲配测验，属配套练习（非真题）。",
      "教材为同济《高等数学》（第七/八版），与考试说明《高等数学及其应用》的阶段划分可对应。",
      "中国大学 MOOC 平台课程学习免费，仅认证证书付费；课程页未写‘免费’二字。",
    ],
    mathTopic: true,
    relevance: "适合按官方 6 阶段顺序学高数的专科在读生，从第 1–2 阶段开始，能直接从第一周第一讲开始。",
    startHint: "第一周第一讲 函数与极限",
    fee: "平台课程学习免费，仅认证证书付费",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
  },
  {
    title: "高等数学（二）",
    url: "https://www.icourse163.org/course/detail.htm?cid=217012",
    readUrl: "https://www.icourse163.org/course/detail.htm?cid=217012",
    officialUrl: "https://www.icourse163.org/course/detail.htm?cid=217012",
    source: "中国大学MOOC · 同济大学",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "同济大学《高等数学（二）》：高数第 3–4 阶段（一元函数积分学及其应用、常微分方程），常微分方程在第 5–6 周；共 10 讲，从不定积分讲到二阶微分方程，每讲配测验，适用年份 2026·往年参考。",
    points: [
      "高数第 3–4 阶段（一元函数积分学及其应用、常微分方程），常微分方程在第 5–6 周（第九、十讲），与官方顺序一致，适用年份 2026·往年参考。",
      "共 10 讲，从不定积分讲到二阶微分方程，每讲配测验，属配套练习（非真题）。",
      "费用口径经课程页原文核实：证书要求栏写明“完成在线付费申请”的是认证证书，课程学习本身未提收费。",
      "中国大学 MOOC 平台课程学习免费，仅认证证书付费；课程页未写‘免费’二字。",
    ],
    mathTopic: true,
    relevance: "适合已学完第 1–2 阶段的专科在读生，接第 3–4 阶段，能直接从第一周第一讲开始。",
    startHint: "第一周第一讲 不定积分的概念和性质",
    fee: "平台课程学习免费，仅认证证书付费",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
  },
  {
    title: "高等数学（下）",
    url: "https://www.icourse163.org/course/detail.htm?cid=1002535001",
    readUrl: "https://www.icourse163.org/course/detail.htm?cid=1002535001",
    officialUrl: "https://www.icourse163.org/course/detail.htm?cid=1002535001",
    source: "中国大学MOOC · 开课高校未确认",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "《高等数学（下）》：高数第 5–6 阶段为主（多元函数微分学在第 3–6 周、二重积分在第 7–8 周），常微分方程在第 15–16 周最后讲授；共 46 讲，另含超纲内容，学习时只取第 5、6 阶段及常微分方程部分，适用年份 2026·往年参考。",
    points: [
      "高数第 5–6 阶段为主（多元函数微分学在第 3–6 周、二重积分在第 7–8 周），常微分方程在第 15–16 周最后讲授（第 42–46 讲），适用年份 2026·往年参考。",
      "共 46 讲，另含超纲内容（空间解析几何、三重积分、曲线曲面积分、无穷级数），学习时只取第 5、6 阶段及常微分方程部分，属配套练习（非真题）。",
      "成绩组成为平时 40%（作业、单元测验、互动）+期末 60%，每章配测验。",
      "中国大学 MOOC 平台课程学习免费，仅认证证书付费；课程页未写‘免费’二字。",
    ],
    mathTopic: true,
    relevance: "适合学到第 5–6 阶段的专科在读生，只取多元微分、二重积分及常微分方程部分，能直接从第一周第 1 讲开始。",
    startHint: "第一周第 1 讲 向量及其线性运算",
    fee: "平台课程学习免费，仅认证证书付费",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
  },
  {
    title: "高等数学（一）",
    url: "https://www.icourse163.org/course/NJTECH-1449608162",
    readUrl: "https://www.icourse163.org/course/NJTECH-1449608162",
    officialUrl: "https://www.icourse163.org/course/NJTECH-1449608162",
    source: "中国大学MOOC · 南京工业大学",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "南京工业大学《高等数学（一）》：高数第 1–4 阶段全覆盖（极限与连续、导数、中值定理及导数应用、一元函数积分学、常微分方程），一门顶同济（一）+（二）；每章均配习题课视频和单元测验，江苏省省级一流线上课程，适用年份 2026·往年参考。",
    points: [
      "高数第 1–4 阶段全覆盖（极限与连续、导数、中值定理及导数应用、一元函数积分学、常微分方程），一门顶同济（一）+（二），适用年份 2026·往年参考。",
      "每章均配习题课视频和单元测验，习题课讲各类型题目解法，是已确认带解析的练习形式，属配套练习（非真题）。",
      "江苏省省级一流线上课程，讲解思路清晰、便于自学，起点只需高中数学基础。",
      "中国大学 MOOC 平台课程学习免费，仅认证证书付费；课程页未写‘免费’二字。",
      "已结课（2025/08/24–2026/01/09）；课程页可打开，回放是否可看未验证。",
    ],
    mathTopic: true,
    relevance: "适合想一门课覆盖高数第 1–4 阶段的专科在读生，起点只需高中数学基础，能直接从第零章预备知识开始。",
    startHint: "第零章 预备知识（函数复习）→ 第一章 1.1 数列的极限",
    fee: "平台课程学习免费，仅认证证书付费",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
  },
  {
    title: "高等数学（一）— 江西理工大学",
    url: "https://www.chinaooc.com.cn/course/6a7b9b1eb44e493c76d1994f",
    readUrl: "https://www.chinaooc.com.cn/course/6a7b9b1eb44e493c76d1994f",
    officialUrl: "https://www.chinaooc.com.cn/course/6a7b9b1eb44e493c76d1994f",
    source: "国家高等教育智慧教育平台（学银在线）· 江西理工大学",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "江西理工大学《高等数学（一）》：江西高校免费通用高数、按江西大纲 6 阶段拼用，本课覆盖第 1–3 阶段（函数与极限、一元函数微分学、一元函数积分学）；每章配习题课、提高练习和测验；开课中 2026/08/11–2026/12/31，4万+ 人选课，适用年份 2026·往年参考。",
    points: [
      "江西高校免费通用高数、按江西大纲 6 阶段拼用：本课覆盖第 1–3 阶段（函数、极限和连续；一元函数微分学及其应用；一元函数积分学及其应用），第 4–6 阶段见同校《高等数学（二）》，适用年份 2026·往年参考。",
      "从第 1 章“函数与极限”开始：1.1 课程导论 映射与函数；第 2 章导数与微分、第 3 章微分中值定理与导数的应用、第 4 章不定积分、第 5 章定积分、第 6 章定积分的应用。",
      "每章配习题课、提高练习和单元测验，另有期中、期终复习直播课，属配套练习（非真题）。",
      "开课中：2026/08/11–2026/12/31，21 周，4万+ 人选课。",
      "费用口径经课程页原文核实：课程页未写‘免费’二字，也未标价；智慧教育平台（学银在线）为国家高等教育智慧教育平台，平台课程学习免费，证书是否收费未说明。",
      "课程简介未提“专升本”：这是江西高校通用高数课，不是江西专升本高数课，按江西考试说明对照取舍。",
    ],
    mathTopic: true,
    relevance: "适合按官方 6 阶段顺序学高数的专科在读生，从第 1 阶段开始，能直接从第 1 章 1.1 开始。",
    startHint: "第 1 章 1.1 课程导论 映射与函数",
    fee: "智慧教育平台免费课程，学习免费；课程页未写‘免费’二字，也未标价",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
  },
  {
    title: "高等数学（二）— 江西理工大学",
    url: "https://www.chinaooc.com.cn/course/69b48a9b95df98bb27cf3851",
    readUrl: "https://www.chinaooc.com.cn/course/69b48a9b95df98bb27cf3851",
    officialUrl: "https://www.chinaooc.com.cn/course/69b48a9b95df98bb27cf3851",
    source: "国家高等教育智慧教育平台（学银在线）· 江西理工大学",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "江西理工大学《高等数学（二）》：江西高校免费通用高数、按江西大纲 6 阶段拼用，本课覆盖第 4–6 阶段（常微分方程、多元函数微分学、二重积分）；含超纲章节，学习时跳过第 2、5、6 章及第 4 章三重积分部分；已结课 2026/03/01–2026/09/01，回放未确认，适用年份 2026·往年参考。",
    points: [
      "江西高校免费通用高数、按江西大纲 6 阶段拼用：本课覆盖第 4–6 阶段（常微分方程、多元函数微分学及其应用、二重积分及其应用），第 1–3 阶段见同校《高等数学（一）》，适用年份 2026·往年参考。",
      "从第 1 章“微分方程”开始：1.1 高数（二）导论 微分方程的基本概念 可分离变量微分方程；第 3 章多元函数微分法及其应用、第 4 章重积分中的二重积分部分（4.1–4.3）。",
      "超纲章节请跳过：第 2 章“向量代数与空间解析几何”、第 5 章“曲线积分与曲面积分”、第 6 章“无穷级数”；第 4 章“重积分”中 4.4–4.6 三重积分部分也超纲，只学 4.1–4.3 二重积分。",
      "每章配综合练习、综合练习讲评和单元测验，另有期中、期终复习直播课，属配套练习（非真题）。",
      "已结课（2026/03/01–2026/09/01）；课程页只写“已结课”，未写视频是否仍可观看，回放未确认。",
      "费用口径经课程页原文核实：课程页未写‘免费’二字，也未标价；智慧教育平台（学银在线）为国家高等教育智慧教育平台，平台课程学习免费，证书是否收费未说明。",
      "课程简介可读文字中未提“专升本”（“这门课会讲什么？”一节为图片，文字版无法核对）：这是江西高校通用高数课，不是江西专升本高数课，按江西考试说明对照取舍。",
    ],
    mathTopic: true,
    relevance: "适合已学完第 1–3 阶段的专科在读生，接第 4–6 阶段，能直接从第 1 章 1.1 微分方程开始；注意跳过超纲章节。",
    startHint: "第 1 章 1.1 高数（二）导论 微分方程的基本概念 可分离变量微分方程",
    fee: "智慧教育平台免费课程，学习免费；课程页未写‘免费’二字，也未标价",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
  },
];

// ---------------------------------------------------------------------------
// 学习栏「AI 学习」精选 (2026-11-23): seven hand-verified FREE Chinese AI
// courses for a 专科在读生， carried as persistent curated content (they
// never rotate with the daily fetch) and flagged aiTopic so the client's
// 「AI 学习」 topic filter shows exactly this set inside the usual
// 随时可学 / 近期可报名 groups. Every URL was opened and checked by the
// researcher; all seven are free to learn (only the optional certificate
// is paid) and need a free account, which each card states. Each card
// states 能学什么 (summaryZh), 需要什么基础 (first point) and 从哪一课
// 开始 (startHint). Deliberately NOT in this set: the Coursera blog post
// 《Introducing AI Series on Coursera》 (it fronts a Coursera Plus paid
// subscription — $49/月， 7-day trial needs payment details first — names
// no single free course with Chinese subtitles, and targets working
// professionals; it keeps its existing pool place in 随时可学 but never
// enters the AI filter), and 吴恩达《AI for Everyone》 (only unofficial
// Bilibili re-uploads were found; the official Coursera page's free-audit
// entry and Chinese subtitles could not be verified). Honest gap, also
// stated in the client's AI-filter note: no free Chinese course devoted
// to "using AI to read security logs / verify model answers" was found —
// the working order is Python basics (item 6) → verification method via
// the DeepSeek / generative-AI courses (item 5 ch.3, item 4 ch.5 §5.9)
// → the BIT security course's system view (item 7 ch.6 & 8).
// ---------------------------------------------------------------------------

export const CURATED_LEARNING_AI: CuratedLearningItem[] = [
  {
    title: "人工智能应用基础（北京电子科技职业学院）",
    url: "https://www.icourse163.org/course/DKY-1460382164",
    readUrl: "https://www.icourse163.org/course/DKY-1460382164",
    officialUrl: "https://www.icourse163.org/course/DKY-1460382164",
    source: "中国大学MOOC / 北京电子科技职业学院",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "能学什么：用生活案例加 Excel 手动计算，讲清监督学习、非监督学习、强化学习共 10 种常见算法——kNN、贝叶斯、决策树、支持向量机、集成学习、K-means、线性回归、神经网络、卷积网络、Q-learning。",
    points: [
      "需要什么基础：零基础可学，仅要求高中数学、统计学知识。",
      "费用：免费学习，需免费注册账号选课；仅认证证书付费。",
    ],
    relevance: "适合零基础的专科在读生入门 AI：先把 10 种常见算法的基本思想弄懂，之后学任何 AI 工具都有底。",
    startHint: "从第一章“距离的应用——k近邻算法”开始",
    fee: "免费（需免费注册；认证证书付费）",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
    aiTopic: true,
  },
  {
    title: "人工智能应用素养（南京信息职业技术学院）",
    url: "https://www.icourse163.org/course/NJCIT-1468667162",
    readUrl: "https://www.icourse163.org/course/NJCIT-1468667162",
    officialUrl: "https://www.icourse163.org/course/NJCIT-1468667162",
    source: "中国大学MOOC / 南京信息职业技术学院",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "能学什么：面向大专在校生的 AI 通识课，讲 AI 概念与产业生态，用 6 个典型行业场景加入门实战，讲 AI 如何与本专业结合。",
    points: [
      "需要什么基础：掌握一门高级编程语言（如 Python，具基本编程思维）、会用 Windows 或 Linux、会检索资料；适合已接触过一点 Python 的学生。",
      "费用：免费学习，需免费注册账号选课；仅认证证书付费。",
    ],
    relevance: "专为大专在校生设计的 AI 通识课，能帮你想清楚 AI 怎么和信息安全技术应用这个专业结合。",
    startHint: "从第一章“人工智能应用生态概述——何为人工智能”开始",
    fee: "免费（需免费注册；认证证书付费）",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
    aiTopic: true,
  },
  {
    title: "人工智能基础（合肥工业大学）",
    url: "https://www.icourse163.org/course/HFUT-1473162171?from=searchPage&outVendor=zw_mooc_pcssjg_",
    readUrl: "https://www.icourse163.org/course/HFUT-1473162171?from=searchPage&outVendor=zw_mooc_pcssjg_",
    officialUrl: "https://www.icourse163.org/course/HFUT-1473162171?from=searchPage&outVendor=zw_mooc_pcssjg_",
    source: "中国大学MOOC / 合肥工业大学",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "能学什么：面向非计算机专业学生的通识课，六部分覆盖计算机基础、AI 概述、常用大模型工具（提示词工程、AI 协同、辅助办公/多媒体/编程）、大模型原理（Transformer、DeepSeek 本地部署）、AI 创新应用（含信息安全拓展）、生成式 AI 大学生使用指南（隐私、学术诚信）。",
    points: [
      "需要什么基础：不要求 AI 或计算机专业背景。",
      "费用：免费学习，需免费注册账号选课；仅认证证书付费。",
    ],
    relevance: "从大模型工具到原理都讲，还带信息安全拓展与隐私、学术诚信指南，适合专科在读生系统补一遍 AI 通识。",
    startHint: "从第一讲“计算机基础”开始；已有计算机基础可直接跳到第三讲“常用大模型工具”",
    fee: "免费（需免费注册；认证证书付费）",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
    aiTopic: true,
  },
  {
    title: "生成式人工智能应用基础（杭州电子科技大学 林菲）",
    url: "https://higher.smartedu.cn/course/agc3/69b56a1ff74ce762ce35271c?type=training",
    readUrl: "https://higher.smartedu.cn/course/agc3/69b56a1ff74ce762ce35271c?type=training",
    officialUrl: "https://higher.smartedu.cn/course/agc3/69b56a1ff74ce762ce35271c?type=training",
    source: "国家高等教育智慧教育平台 / 杭州电子科技大学（林菲）",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "能学什么：从 DeepSeek、Stable Diffusion 等工具实操到智能体搭建；重点是第 5 章“AIGC 赋能学习与研究”（AI 辅助阅读、论文高效解读、试题辅导、代码生成与优化）和第 6 章“AIGC 赋能办公与管理”。",
    points: [
      "需要什么基础：通识课，未见编程硬性要求，会用电脑即可。",
      "费用：免费学习，需免费注册平台账号；仅认证证书付费。",
    ],
    relevance: "第 5 章直接教用 AI 辅助阅读、解读论文和生成优化代码，是把 AI 用到日常学习里最对口的一门。",
    startHint:
      "从第 1 章 1.1“什么是生成式人工智能”开始；只想立刻上手学习应用的，可先看第 3 章“提示词工程及其技巧”（3.1–3.6），再回看第 5 章",
    fee: "免费（需免费注册平台账号；认证证书付费）",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
    aiTopic: true,
  },
  {
    title: "AI实战：从零精通DeepSeek（杭州电子科技大学）",
    url: "https://www.icourse163.org/course/HDU-1472762176?outVendor=zw_mooc_pcsybzkcph_",
    readUrl: "https://www.icourse163.org/course/HDU-1472762176?outVendor=zw_mooc_pcsybzkcph_",
    officialUrl: "https://www.icourse163.org/course/HDU-1472762176?outVendor=zw_mooc_pcsybzkcph_",
    source: "中国大学MOOC / 杭州电子科技大学",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "能学什么：以 DeepSeek 为工具的实战课，讲提示词设计、文本/图像/视频生成、用 DeepSeek 辅助代码编写与软件测试、搭建学业问答智能体，并有第 5 讲 AI 伦理与安全。",
    points: [
      "需要什么基础：基本计算机操作能力、对 AI 有初步兴趣、有初步编程概念即可。",
      "费用：免费学习，需免费注册账号选课；仅认证证书付费。",
    ],
    relevance: "教你用 DeepSeek 辅助写代码与软件测试；第 3 讲正是练习“让 AI 生成代码、再核查它给的是否正确”的地方。",
    startHint:
      "从第 1 讲 1.1“智能路径的初步探索”开始；第 2 讲 2.1“提示词设计的核心原则”、第 3 讲 3.2“使用DeepSeek生成代码”与日常学习最直接相关",
    fee: "免费（需免费注册；认证证书付费）",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
    aiTopic: true,
  },
  {
    title: "Python编程基础与项目实践（重庆工商职业学院）",
    url: "https://www.icourse163.org/course/CQTBI-1464043181?tid=1468391446",
    readUrl: "https://www.icourse163.org/course/CQTBI-1464043181?tid=1468391446",
    officialUrl: "https://www.icourse163.org/course/CQTBI-1464043181?tid=1468391446",
    source: "中国大学MOOC / 重庆工商职业学院",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "能学什么：零基础 Python 课，项目导向——环境安装、数据类型、流程控制、函数与模块、面向对象、扩展模块、网络爬虫；项目包括学生成绩管理系统、人脸识别考勤系统等，还融入网络爬虫犯罪、网络安全意识案例。",
    points: [
      "需要什么基础：针对 Python 初学者，零基础可学，只需先装好 Python 运行环境。",
      "学完本课后，再用《AI实战：从零精通DeepSeek》第 3 讲练习“让 AI 解释/生成 Python 代码并核查它给的是否正确”。",
      "费用：免费学习，需免费注册账号选课；仅认证证书付费。",
    ],
    relevance: "AI 学习路线的第一步：先有 Python 基础，才能判断 AI 给的代码对不对；课程案例还贴着网络安全。",
    startHint: "先看“1.2 搭建Python编程环境”，再进项目一“学生成绩管理系统”",
    fee: "免费（需免费注册；认证证书付费）",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
    aiTopic: true,
  },
  {
    title: "网络安全——应用技术与工程实践（北京理工大学）",
    url: "https://www.icourse163.org/course/0809BIT074-1449611164?outVendor=zw_mooc_pclszykctj_",
    readUrl: "https://www.icourse163.org/course/0809BIT074-1449611164?outVendor=zw_mooc_pclszykctj_",
    officialUrl: "https://www.icourse163.org/course/0809BIT074-1449611164?outVendor=zw_mooc_pclszykctj_",
    source: "中国大学MOOC / 北京理工大学（国家一流课程）",
    publishedAt: null,
    category: "courses",
    summaryZh:
      "能学什么：从加密认证、防火墙、入侵检测到量子密码、区块链的网络安全技术体系与工程实践；其中与 AI 直接相关的是第 6 章“网络安全智能分析与反制技术”（风险评估、态势感知）和第 8 章 8.6“人工智能与网络安全”。同一门课在国家高等教育智慧教育平台（学堂在线聚合）另有入口，开课中（2026/07/23–2027/01/12），页面明写也适用于零基础和社会人士。",
    points: [
      "需要什么基础：建议具备计算机、网络、软件工程等信息化方面基础知识；零基础也可循序渐进，但建议有计算机/网络基础后再重点看第 6、8 章。",
      "费用：免费学习，需免费注册账号选课；仅认证证书付费。",
      "另一入口（同一门课）：国家高等教育智慧教育平台 https://higher.smartedu.cn/course/66a033b5711dc30c34ab8067 ，两个入口任选其一。",
    ],
    relevance: "AI 学习路线的最后一步：在安全体系里看 AI 的位置——第 6 章态势感知与 8.6 人工智能与网络安全，与你的专业最对口。",
    startHint:
      "从“网络安全应用技术与工程实践基础”开始；已有网络基础的，可直接从第 6 章 6.1“智能分析与反制的概念及技术体系”进入 AI+安全部分",
    fee: "免费（需免费注册；认证证书付费）",
    needsApplication: false,
    deadline: null,
    needsLogin: false,
    blockedReason: null,
    chineseUrl: null,
    titleOnly: false,
    enrichState: "stored",
    group: "anytime",
    audienceStage: "专科在读",
    aiTopic: true,
  },
];

// ---------------------------------------------------------------------------
// 健身栏 (2026-11-23): hand-verified free Chinese video tutorials
// for basic exercises — 动作教学 only, deliberately NO training plan and
// NO check-in feature. Persistent curated content (never rotates with
// the daily fetch), served by getFitness. Every card carries 动作名称、
// 所需器械、起始姿势、动作要点 (2–3)、一个常见错误、示范直达链接
// (Bilibili 中文讲解； the plank video is an English-narrated upload
// with Chinese subtitles, noted on its card), plus the video's
// 讲解者 / 标题 when the tutorial is by a verified athlete.
// Groups (19 cards): 胸 4、背 2、腿臀 7、肩 2、核心 4.
// y-round (2026-11-24): three cards now link to 谭成义 tutorials
// (哑铃推举、哑铃侧平举、哑铃划船); the other nine keep their existing
// links as 过渡保留 and are flagged athletePending (选手教学待补充).
// 谭成义's chest/leg compilations were checked by playback sampling and
// do NOT contain 平板哑铃卧推 / 杠铃深蹲， so those two cards stayed
// athletePending in y-round; z-round found 交替哑铃卧推 in a different
// 谭成义 upper-limb video (BV1CAaR6rECN), while 杠铃深蹲 is still
// unfound and stays pending.
// z-round (2026-11-24): three cards swapped to 谭成义 tutorials verified
// by playback sampling （交替哑铃卧推 BV1CAaR6rECN 约 11:00–13:20、
// 弓步蹲 BV1tRhs6hE8j 约 19:00–21:30、卷腹 BV1z8Th6BEij 约 06:40–12:00),
// and seven new 谭成义 cards added （罗马尼亚硬拉、健腹轮、高脚杯深蹲、
// 杠铃卧推、上斜哑铃卧推、保加利亚蹲、臀推 — the last three from
// 凯圣王-account videos co-presented by 谭成义， noted on the card).
// 13 of the 19 cards are 谭成义 tutorials; the remaining six
// （俯卧撑、引体向上、杠铃深蹲、臀桥、平板支撑、死虫式） still carry
// athletePending （选手教学待补充） with their old links kept as 过渡保留.
// 单腿硬拉 was NOT added: the only playback evidence is its title card
// (BV17aovBqEdg at 10:06 / 20:06) — no verified equipment or movement
// detail, so no card was invented for it. Card points not shown in the
// video are marked 编辑补充 in videoNote, never presented as the
// instructor's own words.
// ---------------------------------------------------------------------------

const fitnessItemSchema = z.object({
  name: z.string(),
  group: z.enum(["胸", "背", "腿臀", "肩", "核心"]),
  equipment: z.string(),
  startPosition: z.string(),
  points: z.array(z.string()),
  commonMistake: z.string(),
  videoUrl: z.string(),
  /** Note about the demo video itself (时间点 / 字幕 / 过渡保留说明); null when none. */
  videoNote: z.string().nullable().default(null),
  /** 讲解者 of the linked tutorial; null when the card has no verified athlete tutorial. */
  instructor: z.string().nullable().default(null),
  /** Title of the linked tutorial video; null when not recorded. */
  videoTitle: z.string().nullable().default(null),
  /** True when no verified athlete tutorial has been found yet （选手教学待补充）. */
  athletePending: z.boolean().default(false),
  /** True when the linked tutorial is by 谭成义 (own account or co-presented); drives the client's 「只看谭成义」 filter. */
  tanChengyi: z.boolean().default(false),
});

type FitnessItemData = z.infer<typeof fitnessItemSchema>;

export const FITNESS_ITEMS: FitnessItemData[] = [
  {
    name: "俯卧撑",
    group: "胸",
    equipment: "徒手（瑜伽垫可选）",
    startPosition: "双手撑地、间距略宽于肩，双腿伸直，头、髋、脚跟成一条直线",
    points: [
      "下放时手肘与身体约成 45°，不要外展成 T 形",
      "全程收紧核心、夹紧臀部，身体保持一条直线",
      "下放吸气、胸口贴近地面，推起呼气，手肘微屈不锁死",
    ],
    commonMistake: "塌腰或撅臀，身体呈波浪线上下抖动",
    videoUrl: "https://www.bilibili.com/video/BV1vDaz6WEDA/",
    videoNote: "现有链接为过渡保留，非选手教学",
    instructor: null,
    videoTitle: null,
    athletePending: true,
    tanChengyi: false,
  },
  {
    name: "交替哑铃卧推",
    group: "胸",
    equipment: "哑铃一对＋小角度斜板",
    startPosition: "仰卧于小角度斜板，双脚踩稳地面，右臂持哑铃上举、左臂屈于胸前，两侧交替",
    points: [
      "两侧交替上推，一侧上举时另一侧屈于胸前",
      "肩胛骨后收下沉、贴紧斜板，全程不松掉",
      "呼气上推、吸气下放，上推时手肘微屈不锁死",
    ],
    commonMistake: "两侧节奏不一、身体左右晃动，或肩胛骨松掉耸肩推起",
    videoUrl: "https://www.bilibili.com/video/BV1CAaR6rECN/",
    videoNote: "交替卧推段约 11:00–13:20；卡片要点为编辑补充，非讲解者原话",
    instructor: "谭成义",
    videoTitle: "希望对大家有所帮助！！",
    athletePending: false,
    tanChengyi: true,
  },
  {
    name: "杠铃卧推",
    group: "胸",
    equipment: "杠铃＋卧推凳",
    startPosition: "仰卧于平板凳，双脚踩稳地面，双手握杠置于胸部上方",
    points: [
      "肩胛骨后收下沉、贴紧凳面，全程不松掉",
      "前臂始终垂直地面，不左右晃动",
      "呼气上推、吸气下放，上推时手肘微屈不锁死",
    ],
    commonMistake: "肩胛骨松掉、耸肩推起，杠铃晃动、前臂歪斜",
    videoUrl: "https://www.bilibili.com/video/BV1CSoKBaEgK/",
    videoNote: "凯圣王账号发布、谭成义联合讲解；杠铃卧推段约开场–27:00；卡片要点为编辑补充，非讲解者原话",
    instructor: "谭成义（与凯圣王联合讲解）",
    videoTitle: "凯圣王-谭成义三分化②——跟练胸肩三头",
    athletePending: false,
    tanChengyi: true,
  },
  {
    name: "上斜哑铃卧推",
    group: "胸",
    equipment: "哑铃一对＋上斜卧推凳",
    startPosition: "仰卧于上斜凳，双脚踩稳地面，双手各握一哑铃置于胸部两侧",
    points: [
      "肩胛骨后收下沉、贴紧斜板，全程不松掉",
      "前臂始终垂直地面，不左右晃动",
      "呼气上推、吸气下放，上推时手肘主动往中间靠拢",
    ],
    commonMistake: "肩胛骨松掉、耸肩推起，哑铃晃动、前臂歪斜",
    videoUrl: "https://www.bilibili.com/video/BV1CSoKBaEgK/",
    videoNote: "凯圣王账号发布、谭成义联合讲解；上斜卧推段约 27:00–47:00；卡片要点为编辑补充，非讲解者原话",
    instructor: "谭成义（与凯圣王联合讲解）",
    videoTitle: "凯圣王-谭成义三分化②——跟练胸肩三头",
    athletePending: false,
    tanChengyi: true,
  },
  {
    name: "引体向上",
    group: "背",
    equipment: "单杠（健身房高杠或小区单杠）",
    startPosition: "双手正握单杠、略宽于肩，身体悬垂伸直，肩胛先下沉",
    points: [
      "先沉肩再拉，用背阔肌发力而非只靠手臂",
      "拉至下巴过杠",
      "缓慢有控制地下放，不自由落体",
    ],
    commonMistake: "耸肩硬拉，或靠摆动借力、只做半程",
    videoUrl: "https://www.bilibili.com/video/BV1Guh667E4P/",
    videoNote: "现有链接为过渡保留，非选手教学",
    instructor: null,
    videoTitle: null,
    athletePending: true,
    tanChengyi: false,
  },
  {
    name: "哑铃划船",
    group: "背",
    equipment: "哑铃（单臂版另需一张平板凳支撑）",
    startPosition: "一手撑哑铃架（或凳），另一手持一只哑铃，充分屈髋俯身，挺胸收背、腰背挺直、收紧核心",
    points: [
      "身体与地面夹角小于 45°",
      "呼气时肩胛骨后夹、手肘往后拉至大腿根部",
      "吸气缓慢放回，身体不上下摆动",
    ],
    commonMistake: "弯腰弓背、核心松掉，或靠身体摆动借力拉起",
    videoUrl: "https://www.bilibili.com/video/BV1E8un61EVg/",
    videoNote: "划船段约 01:07–12:57；反飞鸟约 13:00 开始",
    instructor: "谭成义",
    videoTitle: "哑铃划船，哑铃反飞鸟动作教学，希望对大家有所帮助！！",
    athletePending: false,
    tanChengyi: true,
  },
  {
    name: "杠铃深蹲",
    group: "腿臀",
    equipment: "杠铃＋深蹲架",
    startPosition: "杠铃置于上背部斜方肌上，双脚与肩同宽、脚尖微向外展，挺胸收腹",
    points: [
      "先屈髋再屈膝，臀部向后坐",
      "膝盖沿脚尖方向移动，不内扣",
      "下蹲吸气、起身呼气，全程脚跟踩实发力",
    ],
    commonMistake: "膝盖内扣，或塌腰弓背、蹲太低出现“骨盆眨眼”",
    videoUrl: "https://www.bilibili.com/video/BV1FU9LB5EGf/",
    videoNote: "现有链接为过渡保留，非选手教学",
    instructor: null,
    videoTitle: null,
    athletePending: true,
    tanChengyi: false,
  },
  {
    name: "臀桥",
    group: "腿臀",
    equipment: "徒手（进阶可用哑铃/杠铃负重）",
    startPosition: "仰卧屈膝，双脚平放与肩同宽，手臂放于身体两侧",
    points: [
      "臀部发力，快起慢下",
      "顶峰收紧臀部稍作停顿",
      "腰背保持稳定，不用腰代偿",
    ],
    commonMistake: "腰部反弓、过度顶髋借力，或动作速度过快",
    videoUrl: "https://www.bilibili.com/video/BV1Jg4y1z7Nm/",
    videoNote: "现有链接为过渡保留，非选手教学",
    instructor: null,
    videoTitle: null,
    athletePending: true,
    tanChengyi: false,
  },
  {
    name: "弓步蹲",
    group: "腿臀",
    equipment: "哑铃一对",
    startPosition: "站立、躯干正直，双手持哑铃于肩，双臂可上举持哑铃",
    points: [
      "向前迈步、脚跟先着地，重心放前脚跟",
      "前膝沿脚尖方向下蹲至约 90°，后膝弯曲但不触地",
      "推起后交替换步，双脚始终朝向前方",
    ],
    commonMistake: "步幅太小，或双脚踩在一条直线上像走钢丝，失去平衡",
    videoUrl: "https://www.bilibili.com/video/BV1tRhs6hE8j/",
    videoNote: "弓步蹲段约 19:00–21:30；卡片要点为编辑补充，非讲解者原话",
    instructor: "谭成义",
    videoTitle: "下肢功能加肌力训练，希望对大家有所帮助！！",
    athletePending: false,
    tanChengyi: true,
  },
  {
    name: "罗马尼亚硬拉",
    group: "腿臀",
    equipment: "哑铃一对",
    startPosition: "双脚与肩同宽站立，双手持哑铃置于大腿前，挺胸收腹",
    points: [
      "屈髋后移、膝盖微屈，哑铃沿大腿下放至膝下",
      "躯干俯至近水平，腰背挺直不弓背",
      "臀部与腘绳肌发力站直，顶峰收紧臀部",
    ],
    commonMistake: "弓背弯腰、用腰拉起，或膝盖锁死全程直腿",
    videoUrl: "https://www.bilibili.com/video/BV1tRhs6hE8j/",
    videoNote: "罗马尼亚硬拉段约 16:10–19:00；卡片要点为编辑补充，非讲解者原话",
    instructor: "谭成义",
    videoTitle: "下肢功能加肌力训练，希望对大家有所帮助！！",
    athletePending: false,
    tanChengyi: true,
  },
  {
    name: "高脚杯深蹲",
    group: "腿臀",
    equipment: "哑铃一只",
    startPosition: "双脚与肩同宽站立，双手持一只哑铃于胸前，挺胸收腹",
    points: [
      "先屈髋再屈膝，臀部向后坐",
      "膝盖沿脚尖方向移动，不内扣",
      "下蹲吸气、起身呼气，全程脚跟踩实发力",
    ],
    commonMistake: "膝盖内扣，或塌腰弓背、蹲太低出现“骨盆眨眼”",
    videoUrl: "https://www.bilibili.com/video/BV17aovBqEdg/",
    videoNote: "凯圣王账号发布、谭成义联合讲解；高脚杯深蹲段约 34:00–44:00；卡片要点为编辑补充，非讲解者原话",
    instructor: "谭成义（与凯圣王联合讲解）",
    videoTitle: "凯圣王-谭成义三分化⑤——跟练腿股四头肌腘绳肌",
    athletePending: false,
    tanChengyi: true,
  },
  {
    name: "保加利亚蹲",
    group: "腿臀",
    equipment: "哑铃一对＋矮凳（后脚垫高）",
    startPosition: "前脚站立、后脚脚背垫于身后矮凳，双手各握一哑铃垂于体侧，躯干挺直",
    points: [
      "前膝沿脚尖方向下蹲，后膝弯曲但不触地",
      "重心放前脚跟，全程躯干挺直不前倾",
      "缓慢有控制地起身，双脚始终朝向前方",
    ],
    commonMistake: "重心跑到后脚，或前膝内扣、身体大幅前倾",
    videoUrl: "https://www.bilibili.com/video/BV17aovBqEdg/",
    videoNote: "凯圣王账号发布、谭成义联合讲解；保加利亚蹲段约 23:00–34:00；卡片要点为编辑补充，非讲解者原话",
    instructor: "谭成义（与凯圣王联合讲解）",
    videoTitle: "凯圣王-谭成义三分化⑤——跟练腿股四头肌腘绳肌",
    athletePending: false,
    tanChengyi: true,
  },
  {
    name: "臀推",
    group: "腿臀",
    equipment: "低凳（徒手）",
    startPosition: "坐地、肩靠低凳，双腿屈膝、双脚平放着地",
    points: [
      "臀部发力抬髋，至躯干与大腿成一条直线",
      "顶峰收紧臀部稍作停顿",
      "缓慢有控制地下放，腰背保持稳定不用腰代偿",
    ],
    commonMistake: "腰部反弓、过度顶髋借力，或动作速度过快",
    videoUrl: "https://www.bilibili.com/video/BV1tRhs6hE8j/",
    videoNote: "臀推段约 13:05–13:50；双腿臀推（无单腿、无跳）；卡片要点为编辑补充，非讲解者原话",
    instructor: "谭成义",
    videoTitle: "下肢功能加肌力训练，希望对大家有所帮助！！",
    athletePending: false,
    tanChengyi: true,
  },
  {
    name: "哑铃推举（坐姿哑铃推肩）",
    group: "肩",
    equipment: "哑铃一对＋有靠背的坐凳",
    startPosition: "坐于有靠背的凳上，哑铃放于膝盖远端，核心收紧、交替抬至肩部两侧",
    points: [
      "躯干微后仰、核心收紧",
      "沿肩胛面画弧推起，小臂全程垂直地面",
      "下落至眼睛位置即可，主动控制下放",
    ],
    commonMistake: "下落失控、被哑铃压下去，或推起时腰部大幅反弓借力",
    videoUrl: "https://www.bilibili.com/video/BV1csj36CEf9/",
    videoNote: "21:16 开始（约 21:16–29:00）；卡片要点为编辑补充，非讲解者原话",
    instructor: "谭成义",
    videoTitle: "私教系列之肩部教学，希望对大家有所帮助！！",
    athletePending: false,
    tanChengyi: true,
  },
  {
    name: "哑铃侧平举",
    group: "肩",
    equipment: "哑铃一对（宜选轻重量）",
    startPosition: "站立，双手各握一哑铃垂于体侧、掌心向内，躯干挺直、微屈膝、收紧核心",
    points: [
      "保持肩高于肘、肘高于手，向两侧抬至与肩齐平",
      "匀速抬起，避免斜方肌代偿",
      "缓慢有控制地下放至大腿根部附近",
    ],
    commonMistake: "耸肩借力，或用大重量甩动哑铃",
    videoUrl: "https://www.bilibili.com/video/BV128bX6eExV/",
    videoNote: "单动作专讲，时长 07:59；起始姿势为编辑修正",
    instructor: "谭成义",
    videoTitle: "哑铃侧平举动作讲解，希望对大家有所帮助！！",
    athletePending: false,
    tanChengyi: true,
  },
  {
    name: "平板支撑",
    group: "核心",
    equipment: "徒手（瑜伽垫）",
    startPosition: "俯卧，双肘撑地位于肩关节正下方，前臂贴地，脚尖着地",
    points: [
      "手肘对准肩正下方，不前伸也不后移",
      "头、肩、髋、脚踝成一条直线，收紧腹部和臀部",
      "全程自然呼吸，不憋气",
    ],
    commonMistake: "下背塌陷或屁股抬高，身体不在一条直线上",
    videoUrl: "https://www.bilibili.com/video/BV1mD4y1d7NF/",
    videoNote: "英配中文字幕译制视频；现有链接为过渡保留，非选手教学",
    instructor: null,
    videoTitle: null,
    athletePending: true,
    tanChengyi: false,
  },
  {
    name: "卷腹",
    group: "核心",
    equipment: "徒手（瑜伽垫）",
    startPosition: "仰卧屈膝，双脚平放与肩同宽，双手置于脑后",
    points: [
      "下背始终贴地，只卷起上背、肩胛骨离地即可",
      "呼气卷起，顶端收紧腹肌停 1 秒",
      "吸气缓慢有控制地下放",
    ],
    commonMistake: "双手抱头用力拉脖子借力，或幅度过大做成仰卧起坐、下背离地",
    videoUrl: "https://www.bilibili.com/video/BV1z8Th6BEij/",
    videoNote: "卷腹段约 06:40–12:00；卡片要点为编辑补充，非讲解者原话",
    instructor: "谭成义",
    videoTitle: "腹肌动作教学，希望对大家有所帮助！！",
    athletePending: false,
    tanChengyi: true,
  },
  {
    name: "健腹轮",
    group: "核心",
    equipment: "健腹轮（瑜伽垫）",
    startPosition: "跪姿，双手握健腹轮置于身前地面，收紧核心",
    points: [
      "先深吸一口气，再缓慢向前推出健腹轮",
      "全程收紧核心、腰背不塌陷",
      "用腹肌发力收回，动作放慢不借惯性",
    ],
    commonMistake: "腰部塌陷反弓，或推出过远失控、收不回来",
    videoUrl: "https://www.bilibili.com/video/BV1z8Th6BEij/",
    videoNote: "健腹轮段约 12:00–16:48；卡片要点为编辑补充，非讲解者原话",
    instructor: "谭成义",
    videoTitle: "腹肌动作教学，希望对大家有所帮助！！",
    athletePending: false,
    tanChengyi: true,
  },
  {
    name: "死虫式",
    group: "核心",
    equipment: "徒手（瑜伽垫）",
    startPosition: "仰卧，双臂伸直指向天花板，双腿抬起、髋膝各弯曲约 90°",
    points: [
      "全程腰背贴地不拱起",
      "对侧手脚缓慢交替伸展",
      "动作放慢，核心始终收紧",
    ],
    commonMistake: "腰部拱起离地、出现弹响髋，或动作过快失控",
    videoUrl: "https://www.bilibili.com/video/BV1tZ4y1q7qM/",
    videoNote: "现有链接为过渡保留，非选手教学",
    instructor: null,
    videoTitle: null,
    athletePending: true,
    tanChengyi: false,
  },
];

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
  category: z.enum(["study", "work_visa"]),
  stage: z.enum(["prepare", "diploma", "bachelor", "intern", "direct", "overseas_job", "general"]),
  kind: z.enum(["news", "job", "policy"]),
  relevance: z.string(),
  majorMatch: z.string().nullable(),
  languageReq: z.string().nullable(),
  deadline: z.string().nullable(),
  tuition: z.string().nullable(),
  livingCost: z.string().nullable(),
  scholarship: z.string().nullable(),
  location: z.string().nullable(),
  remoteFromChina: z.boolean().nullable(),
  eduReq: z.string().nullable(),
  expReq: z.string().nullable(),
  acceptsOverseas: z.boolean().nullable(),
  visaSupport: z.enum(["yes", "no", "unstated"]),
  policyStatus: z.enum(["enacted", "proposal", "unstated", "upcoming"]).nullable(),
  policyStatusLabel: z.string().nullable(),
  cardTagLabel: z.string().nullable(),
  decisionDateLabel: z.string().nullable(),
  effectiveParts: z.array(z.string()).nullable(),
});

const worldItemSchema = feedItemSchema.extend({
  topic: z.string(),
  weekly: z.boolean(),
  relevance: z.string(),
});

// ---------------------------------------------------------------------------
// Boundary normalizers: cached/internal rows may predate the 2026-11-22
// five-category restructure; the response schemas always carry the new
// fields, filled honestly (null / "unstated") when the source never stated
// them — never guessed.
// ---------------------------------------------------------------------------

/**
 * Policy status from the policy LOCATION's own calendar (user rule,
 * 2026-11-22): compare the policy's effective date (YYYY-MM-DD) with
 * today's date IN THE POLICY'S TIME ZONE — never the page date and never
 * an unzoned server date. Before the effective date the policy is
 * 「即将生效」 (upcoming); on the day itself and after, 「已生效」
 * (enacted). Pure function of (effectiveDate, timeZone, now) so the rule
 * is unit-testable with fixed instants.
 */
export function policyStatusOnDate(
  effectiveDate: string,
  timeZone: string,
  now: Date,
): "upcoming" | "enacted" {
  const localToday = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return localToday < effectiveDate ? "upcoming" : "enacted";
}

/**
 * Project-level matcher for the NIC (National Informatics Centre, under
 * India's MeitY) Winter Internship 2026 — ONE programme retold by many
 * outlets whose headlines share almost no wording (user-verified
 * 2026-11-22 by reading the NDTV original: its article opens "NIC Winter
 * Internship 2026: The National Informatics Centre (NIC), under the
 * Ministry of Electronics and Information Technology (MeitY)… two-month
 * Winter Internship Programme 2026", and its facts match the India.com
 * piece exactly — NIC under MeitY, winter 2026, two months
 * 2026-12-01 → 2027-01-31, 50 seats, Rs 10,000/month = Rs 20,000 total,
 * registration via dii.nic.in from Nov 2, offline at NIC HQ, New Delhi).
 * The NDTV headline itself — "Ministry Of Electronics And IT Offers
 * Two-Month Internship With Rs 20,000 Stipend" — never says "NIC", so a
 * title-only NIC match misses the very item the user keeps as the
 * representative. Matching therefore runs over title + summary text and
 * accepts any of the programme's distinctive shapes: the NIC winter
 * internship name, the National Informatics Centre as organiser of an
 * internship, or the MeitY / Ministry of Electronics internship carrying
 * the programme's stipend / two-month / winter signals (the shape of
 * Moneycontrol / JagranJosh retellings too).
 */
export function isNicInternshipProjectText(text: string): boolean {
  const t = text ?? "";
  if (/nic[\s-]+winter[\s-]+internship/i.test(t)) return true;
  if (/national informatics centre/i.test(t) && /internship/i.test(t)) return true;
  if (
    /(ministry of electronics|\bmeity\b)/i.test(t) &&
    /internship/i.test(t) &&
    /(20,?000|two[\s-]?month|winter|stipend)/i.test(t)
  )
    return true;
  if (/\bnic\b/i.test(t) && /internship/i.test(t) && /(20,?000|winter|stipend)/i.test(t)) return true;
  return false;
}

export function isNicWinterInternship(it: {
  title: string;
  url: string;
  whatChanged?: string | null;
  points?: string[];
}): boolean {
  if (/nic-winter-internship/i.test(it.url)) return true;
  return isNicInternshipProjectText(`${it.title} ${it.whatChanged ?? ""} ${(it.points ?? []).join(" ")}`);
}

/**
 * One project, one entry (user rule, 2026-11-22): when several retellings
 * of the NIC internship project are present, keep exactly one — the
 * NDTV item as representative (the user verified the project against the
 * NDTV original), else an official source, else the newest. Applied at
 * ingest in loadOverseas and again on every getOverseas read, so a
 * cached payload holding two retellings can never show the project
 * twice; a later India.com / Moneycontrol / JagranJosh retelling is
 * collapsed the same way instead of appearing as a second entry.
 */
export function collapseNicProjectItems<T extends { title: string; url: string; source: string; publishedAt: string | null; official: boolean; whatChanged?: string | null; points?: string[] }>(
  items: T[],
): T[] {
  const nicIdx = items.map((it, i) => (isNicWinterInternship(it) ? i : -1)).filter((i) => i >= 0);
  if (nicIdx.length <= 1) return items;
  const rank = (it: T): [number, number, number] => [
    /ndtv/i.test(it.source) || /ndtv\.com/i.test(it.url) ? 0 : 1,
    it.official ? 0 : 1,
    -(it.publishedAt ? new Date(it.publishedAt).getTime() : 0),
  ];
  let repIdx = nicIdx[0] as number;
  for (const i of nicIdx) {
    const a = rank(items[i] as T);
    const b = rank(items[repIdx] as T);
    if (a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))) repIdx = i;
  }
  const nicSet = new Set(nicIdx);
  return items.filter((_, i) => !nicSet.has(i) || i === repIdx);
}

/**
 * User-verified correction (2026-11-22) for the NIC Winter Internship
 * project: the enrichment pass filed this INTERNSHIP under 海外升学
 * (study). It belongs in 海外实习、工作与签证 as an in-study internship
 * (kind=job, stage=intern). Facts verified by the user against the NDTV
 * original (which itself opens with the NIC Winter Internship 2026
 * announcement) and the India.com retelling — identical on every point:
 * the internship is OFFLINE at NIC Headquarters, New Delhi
 * (2026-12-01 → 2027-01-31, 50 seats, Rs 10,000/month, Rs 20,000 total,
 * registration via the official portal dii.nic.in from Nov 2) — so
 * location is New Delhi and it is NOT remote from China. Whether a
 * student enrolled at a Chinese institution may apply is NOT stated:
 * the coverage states only Indian local degree-programme / enrolment
 * requirements, with no nationality restriction and no statement that
 * overseas applications are accepted — so applicability stays honestly
 * unstated: eligibility "unclear" and acceptsOverseas null （未说明） —
 * never presented as applicable or as not applicable. Registration
 * opened Nov 2 but the closing date is officially unconfirmed, so
 * deadline is forced to null — never a fabricated date — and
 * getDailyDigest excludes the project from 「近期可申请」. The merged
 * entry carries the verified facts below (including the official entry
 * dii.nic.in) whichever outlet's retelling survives as representative.
 * Applied at ingest and inside normalizeOverseas, so cached payloads
 * are corrected on every read too.
 */
export function correctOverseasItem(it: OverseasItem): OverseasItem {
  // Yale OISS D/S card (user-verified wording, 2026-11-22): the curated
  // DS_RULING_ITEM is the single source of truth for this one card —
  // reapply it on every read so a payload cached before a wording fix
  // can never serve the old tag/body again. No other card is touched.
  if (it.url === DS_RULING_ITEM.url || it.readUrl === DS_RULING_ITEM.url) return { ...it, ...DS_RULING_ITEM };
  // Singapore MOM card (user rule, 2026-11-22): the two effective-date
  // nodes (new applications from 2027-01-01; renewals expiring from
  // 2028-01-01) are displayed as separate lines — reapply the split
  // parts on every read so a cached payload cannot serve the old
  // crammed one-line string.
  if (it.url === SG_WORK_PASS_ITEM.url || it.readUrl === SG_WORK_PASS_ITEM.url) {
    return { ...it, effectiveWhen: SG_WORK_PASS_ITEM.effectiveWhen, effectiveParts: SG_WORK_PASS_ITEM.effectiveParts ?? null };
  }
  if (!isNicWinterInternship(it)) {
    // Internship recategorization (user rule, 2026-11-22, GENERAL — not
    // tied to any one programme): an item whose title is about an
    // internship （实习 / Internship), or whose body is about one while
    // it sits in the study column, belongs in 「海外实习、工作与签证」
    // as an in-study internship — never in 「海外升学」. The
    // Moneycontrol Indian Army Internship Programme item is the named
    // case; the rule is the shape, not the programme. Curated visa pins
    // are exempt (none is an internship posting).
    if (!CURATED_VISA_URLS.has(it.url)) {
      const titleIsInternship = /实习|internship/i.test(it.title);
      const bodyIsInternship = /实习|internship/i.test(
        `${it.whatChanged ?? ""} ${(it.points ?? []).join(" ")}`,
      );
      if (titleIsInternship || (it.category === "study" && bodyIsInternship)) {
        if (it.category !== "work_visa" || it.stage === "prepare" || it.stage === "diploma" || it.stage === "bachelor") {
          return {
            ...it,
            category: "work_visa",
            stage: "intern",
            kind: it.kind === "policy" && !/签证|visa/i.test(it.title) ? "job" : it.kind,
          };
        }
      }
    }
    return it;
  }
  return {
    ...it,
    country: "印度",
    category: "work_visa",
    stage: "intern",
    kind: "job",
    eligibility: "unclear",
    location: "印度新德里（NIC 总部，线下进行）",
    remoteFromChina: false,
    acceptsOverseas: null,
    visaSupport: "unstated",
    deadline: null,
    effectiveWhen: null,
    whatChanged:
      "印度国家信息中心（NIC，隶属电子信息技术部 MeitY）2026 年冬季实习项目：为期两个月（2026 年 12 月 1 日至 2027 年 1 月 31 日），共 50 个名额，津贴每月 10,000 卢比、两个月共 20,000 卢比；线下在印度新德里 NIC 总部进行，11 月 2 日起通过官方门户 dii.nic.in 注册。",
    whoApplies:
      "原文只写了印度本地学位课程与在读要求，没有写国籍限制，也没有写是否接受境外申请——中国境内学生能否申请，官方未确认。",
    points: [
      "主办：印度国家信息中心（NIC），隶属印度电子信息技术部（MeitY）；2026 年冬季实习项目，为期两个月（2026 年 12 月 1 日至 2027 年 1 月 31 日），共 50 个名额。",
      "津贴：每月 10,000 卢比，两个月共 20,000 卢比。",
      "地点：印度新德里 NIC 总部，线下进行；不能在中国境内远程参加。",
      "报名：11 月 2 日起通过官方门户 dii.nic.in 注册；截止日期官方未确认。",
      "中国境内学生能否申请：原文只写了印度本地学位课程与在读要求，没有写国籍限制，也没有写接受境外申请——官方未确认，适用性未说明。",
    ],
    titleOnly: false,
  };
}

function overseasRelevance(it: OverseasItem): string {
  const kind: "news" | "job" | "policy" = it.kind ?? (it.visa || it.isImmigration ? "policy" : "news");
  // Policy cards FIRST (user rule, 2026-11-22): a policy only states whom
  // it affects — never application wording （专科可申请 / 看条件和截止日期）,
  // even when the underlying eligibility field says diploma_eligible (the
  // Yale OISS D/S card hit exactly that bug).
  if (kind === "policy")
    return `这是${it.country}的政策动态，不是岗位；它影响的是：${it.identityLabel ?? it.whoApplies ?? "见原文"}，会影响你之后去${it.country}读书或工作的安排。`;
  if (it.eligibility === "diploma_eligible")
    return "来源明确接受专科背景，与你直接相关，可点开看条件和截止日期。";
  if (kind === "job") {
    // The relevance line must be grounded in THIS item's own text
    // (user rule, 2026-11-22): claim an infosec/network/IT-support fit
    // only when the item itself says so.
    const infosecFit = /信息安全|网络安全|网络运维|网络工程师|IT\s*支持|网络|security|infosec/i.test(
      `${it.title} ${it.whatChanged ?? ""} ${it.eduReq ?? ""}`,
    );
    return infosecFit
      ? `岗位在${it.location ?? it.country}，与信息安全、网络运维或 IT 支持方向相关；签证支持${it.visaSupport === "yes" ? "雇主已明确提供" : it.visaSupport === "no" ? "雇主明确不提供" : "未说明"}，点开看完整要求。`
      : `岗位在${it.location ?? it.country}；签证支持${it.visaSupport === "yes" ? "雇主已明确提供" : it.visaSupport === "no" ? "雇主明确不提供" : "未说明"}，点开看地点、学历和经验要求。`;
  }
  return it.whoApplies
    ? `适用于：${it.whoApplies}。适用学历${it.eligibility === "bachelor_only" ? "仅限本科毕业生" : "未写清"}，点开核对再决定。`
    : "来源未写清适用人群，点开看原文再判断和你的关系。";
}

function normalizeOverseas(raw: OverseasItem): z.infer<typeof overseasItemSchema> {
  const it = correctOverseasItem(raw);
  const category: OverseasCategory = it.category ?? (it.visa || it.isImmigration ? "work_visa" : "study");
  const kind: "news" | "job" | "policy" = it.kind ?? (it.visa || it.isImmigration ? "policy" : "news");
  // A policy with a structured effective date gets its status COMPUTED
  // from the policy location's local date (NZ SGWV: 2026-11-23,
  // Pacific/Auckland) — never a stored verdict, never the page date.
  const computedStatus =
    kind === "policy" && it.effectiveDate && it.effectiveTimeZone
      ? policyStatusOnDate(it.effectiveDate, it.effectiveTimeZone, new Date())
      : null;
  return {
    title: decodeEntities(it.title),
    url: it.url,
    source: it.source,
    publishedAt: it.publishedAt,
    country: it.country,
    whatChanged: it.whatChanged ? trimPartialTailWord(decodeEntities(it.whatChanged), 90) : it.whatChanged,
    whoApplies: it.whoApplies ? decodeEntities(it.whoApplies) : it.whoApplies,
    effectiveWhen: it.effectiveWhen,
    // Per-matter effective-date lines (user rule, 2026-11-22): explicit
    // parts win (curated cards); otherwise an effectiveWhen carrying
    // several 「；」-separated nodes is split into one line per node.
    effectiveParts:
      it.effectiveParts && it.effectiveParts.length > 0
        ? it.effectiveParts
        : (() => {
            // Split only when EVERY segment carries its own full date —
            // otherwise the ； is mid-sentence punctuation (the NZ SGWV
            // note's parenthetical) and the string stays whole.
            if (!it.effectiveWhen || !/[；;]/.test(it.effectiveWhen)) return null;
            const parts = it.effectiveWhen
              .split(/[；;]/)
              .map((p) => p.trim())
              .filter(Boolean);
            return parts.length >= 2 && parts.every((p) => /\d{4}\s*年|\d{4}-\d{2}-\d{2}/.test(p))
              ? parts
              : null;
          })(),
    eligibility: it.eligibility,
    isImmigration: it.isImmigration,
    identityLabel: it.identityLabel,
    points: dedupeSentences(it.points.map((p) => decodeEntities(p))),
    titleOnly: it.titleOnly,
    readUrl: it.readUrl,
    needsLogin: it.needsLogin,
    blockedReason: it.blockedReason,
    official: it.official,
    visa: it.visa,
    // Read-time pin correction (user rule, 2026-11-24): a kind=policy item
    // with no dated effective change never displays as pinned, even when a
    // cached payload still carries pinned=true from an earlier refresh —
    // the stored EdSource commentary is corrected on every read, without
    // waiting for the next re-fetch or the pinned-store rewrite. The item
    // itself stays in the pool. getDailyDigest reads through this same
    // normalize, so the homepage digest shares the pin decision.
    // 统计新闻同理（user rule, 2026-11-23/2026-11-26）：kind=news 且仅为签证数据变动、无规则变更、无带日期生效变更的条目，缓存仍带 pinned=true 时也在每次读回时纠正为 false，条目本身留在池内。
    pinned:
      it.pinned &&
      !isVisaStatisticsOnlyNews({ ...it, kind }) &&
      !isPolicyWithoutDatedEffectiveChange({
        kind,
        decisionDateLabel: it.decisionDateLabel ?? null,
        effectiveParts: it.effectiveParts ?? null,
        effectiveWhen: it.effectiveWhen ?? null,
      }),
    category,
    stage: it.stage ?? (kind === "policy" ? "general" : category === "study" ? "diploma" : "general"),
    kind,
    relevance: overseasRelevance(it),
    majorMatch: it.majorMatch ?? null,
    languageReq: it.languageReq ?? null,
    // Policy cards carry no application fields (user rule, 2026-11-22):
    // no deadline is ever exposed for a policy, whatever enrichment stored.
    deadline: kind === "policy" ? null : (it.deadline ?? null),
    tuition: it.tuition ?? null,
    livingCost: it.livingCost ?? null,
    scholarship: it.scholarship ?? null,
    location: it.location ?? null,
    remoteFromChina: it.remoteFromChina ?? null,
    eduReq: it.eduReq ?? null,
    expReq: it.expReq ?? null,
    acceptsOverseas: it.acceptsOverseas ?? null,
    visaSupport: it.visaSupport ?? "unstated",
    policyStatus: computedStatus ?? it.policyStatus ?? (kind === "policy" ? "unstated" : null),
    policyStatusLabel: it.policyStatusLabel ?? null,
    cardTagLabel: it.cardTagLabel ?? null,
    decisionDateLabel: it.decisionDateLabel ?? null,
  };
}

/**
 * 「和我有什么关系」 for the world column (user rule, 2026-11-22): the
 * line must be grounded in THIS item's own title/summary — never a
 * per-topic template that contradicts the item. The named failure: an
 * Indonesia candy-factory FIRE （新华网） carried the politics template
 * 「国际政治变化可能影响签证、留学与出行安排」 — a fire is not a visa
 * story. Order matters: concrete content signals first (a disaster /
 * accident is a safety event, full stop), the visa/study/travel claim
 * only when the item's own text actually involves visas, study abroad
 * or travel, and an honest neutral line when nothing in the item
 * supports a stronger claim.
 */
function worldRelevanceFor(it: WorldItem): string {
  const text = `${it.title} ${it.summary ?? ""}`;
  if (/火灾|爆炸|地震|洪水|台风|海啸|事故|伤亡|遇难|尸袋|坠毁|坠机|枪击|踩踏/.test(text))
    return "这是一起海外安全事故报道，先看事发经过与当地的安全状况；它和签证、留学申请没有直接关系。";
  if (/网络安全|黑客|漏洞|数据泄露|勒索软件|网络攻击|信息安全/.test(text))
    return "与你的信息安全技术应用专业直接相关，也是你以后求职的核心领域。";
  if (/留学生|中国学生|留学安全/.test(text) && /安全|遇害|袭击|失踪|诈骗|歧视/.test(text))
    return "关系到中国留学生在海外的安全与权益，与你可能的出国计划直接相关。";
  if (/签证|移民|出入境|居留|领事/.test(text))
    return "这条涉及签证或出入境安排，可能影响你之后留学与出行，先了解背景。";
  if (/出行安全|旅行安全|旅游安全|航班|铁路|交通安全/.test(text))
    return "关系到你以后出国读书、实习和旅行时的人身安全。";
  if (/冲突|战争|停火|导弹|空袭|制裁|军事/.test(text))
    return "地区局势会影响留学目的地选择和出行安全，先了解背景。";
  if (/经济|股市|汇率|通胀|贸易|央行|利率|GDP|物价|就业数据/i.test(text))
    return "经济走向会影响你毕业时的就业环境与留学成本。";
  if (/科技|人工智能|芯片|机器人|航天|新能源|互联网/.test(text))
    return "科技动态与你的信息安全专业学习方向相关。";
  if (it.topic === "书籍" || it.topic === "历史")
    return "本周阅读精选，适合利用课余时间拓展视野。";
  if (it.topic === "语言学习")
    return "语言能力是出国和求职的门槛，读物精选放在每周；具体课程和考试报名在学习栏。";
  return "按重要性筛出的国内外要闻，了解背景即可；这条和你的升学、出行没有直接关系。";
}

function normalizeWorld(it: WorldItem): z.infer<typeof worldItemSchema> {
  return {
    ...it,
    title: decodeEntities(it.title),
    summary: it.summary ? decodeEntities(it.summary) : it.summary,
    relevance: worldRelevanceFor(it),
  };
}

function normalizeLearning(it: LearningItem): z.infer<typeof learningItemSchema> {
  const fixed = correctLearningItem(it);
  // Text hygiene on every read (user rules, 2026-11-22 + 2026-11-23):
  // entities decoded in title, points AND summary (the m-round decoded
  // titles only — a Coursera item's points still carried `&#160;`);
  // no duplicated sentence inside the points; and a summary an older
  // slice cut loses its partial tail word instead of displaying it.
  const points = dedupeSentences(fixed.points.map((p) => decodeEntities(p)));
  let summaryZh = fixed.summaryZh ? decodeEntities(fixed.summaryZh) : fixed.summaryZh;
  // A relevance/summary line cut mid-SENTENCE is rebuilt from the
  // item's OWN fuller text (user rule, 2026-11-23): when the stored
  // summary does not end a sentence and one of the item's points is
  // the same text uncut (the unenriched fallback stores the full
  // source summary as the point), take complete sentences from that
  // point instead. The Coursera case: "Every job across every industry
  // is being reshaped by AI, but many professionals struggle" becomes
  // the source's complete first sentence — English, because no model
  // translation exists on the no-key deployment; never fabricated.
  if (summaryZh && !/[。！？.!?…；;」』）)]$/.test(summaryZh.trim())) {
    const probe = summaryZh.trim().slice(0, 40);
    const fuller = points.find((p) => p.trim().length > summaryZh!.trim().length && p.trim().startsWith(probe));
    if (fuller) summaryZh = completeSentences(fuller, 110);
  }
  summaryZh = summaryZh ? trimPartialTailWord(summaryZh, 90) : summaryZh;
  return {
    ...fixed,
    title: decodeEntities(fixed.title),
    summaryZh,
    points,
    relevance: summaryZh ?? "点开看适合谁、能学到什么；学段、费用和截止日期都以官方入口为准。",
    // Payloads cached before the p-round carry no enrichState: a stored
    // Chinese summary means an earlier enrichment ("stored"), otherwise
    // the item is showing its original text.
    enrichState: fixed.enrichState ?? (summaryZh ? "stored" : "original"),
    startHint: fixed.startHint ?? null,
    group: fixed.group ?? null,
  };
}

// ---------------------------------------------------------------------------
// 综合热榜 (restored 2026-11-22 at the user's request: kept at the bottom
// of the homepage, collapsed by default; the entertainment category is
// NOT restored). Direct platform JSON APIs, as originally tested.
// ---------------------------------------------------------------------------

interface HotItem { rank: number; title: string; url: string; heat: string | null }
interface HotSourceData { id: string; label: string; items: HotItem[] }

const HOT_TTL_MS = 45 * 60 * 1000;

async function fetchJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers: { "User-Agent": UA, ...(headers ?? {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as unknown;
}

async function loadHotLists(ctx: Ctx, force: boolean): Promise<{ sources: HotSourceData[]; asOf: string }> {
  if (!force) {
    const cached = await readCache<HotSourceData[]>(ctx, "hot:all:v1", HOT_TTL_MS);
    if (cached) return { sources: cached.data, asOf: cached.asOf };
  }
  const sources: HotSourceData[] = [];
  const jobs: Array<Promise<HotSourceData | null>> = [
    (async () => {
      const j = (await fetchJson("https://weibo.com/ajax/side/hotSearch", { Referer: "https://weibo.com/" })) as {
        data?: { realtime?: Array<{ word_scheme?: string; note?: string; num?: number }> };
      };
      const items = (j.data?.realtime ?? []).slice(0, 20).map((r, i) => ({
        rank: i + 1,
        title: (r.word_scheme ?? r.note ?? "").replace(/^#|#$/g, ""),
        url: `https://s.weibo.com/weibo?q=${encodeURIComponent(r.word_scheme ?? r.note ?? "")}`,
        heat: r.num ? String(r.num) : null,
      })).filter((it) => it.title);
      return items.length ? { id: "weibo", label: "微博热搜", items } : null;
    })(),
    (async () => {
      const j = (await fetchJson("https://top.baidu.com/api/board?platform=wise&tab=realtime")) as {
        data?: { cards?: Array<{ content?: Array<{ word?: string; url?: string }> }> };
      };
      const flat = (j.data?.cards ?? []).flatMap((c) => c.content ?? []);
      const items = flat.slice(0, 20).map((r, i) => ({
        rank: i + 1,
        title: r.word ?? "",
        url: r.url ?? `https://www.baidu.com/s?wd=${encodeURIComponent(r.word ?? "")}`,
        heat: null,
      })).filter((it) => it.title);
      return items.length ? { id: "baidu", label: "百度热搜", items } : null;
    })(),
    (async () => {
      const j = (await fetchJson("https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc")) as {
        data?: Array<{ Title?: string; Url?: string }> };
      const items = (j.data ?? []).slice(0, 20).map((r, i) => ({
        rank: i + 1,
        title: r.Title ?? "",
        url: r.Url ?? "",
        heat: null,
      })).filter((it) => it.title && it.url);
      return items.length ? { id: "toutiao", label: "今日头条", items } : null;
    })(),
    (async () => {
      const j = (await fetchJson("https://api.bilibili.com/x/web-interface/popular?ps=15&pn=1")) as {
        code?: number;
        data?: { list?: Array<{ title?: string; bvid?: string }> };
      };
      const items = (j.data?.list ?? []).slice(0, 15).map((r, i) => ({
        rank: i + 1,
        title: r.title ?? "",
        url: r.bvid ? `https://www.bilibili.com/video/${r.bvid}` : "",
        heat: null,
      })).filter((it) => it.title && it.url);
      return items.length ? { id: "bilibili", label: "B站热门", items } : null;
    })(),
  ];
  for (const r of await Promise.allSettled(jobs)) {
    if (r.status === "fulfilled" && r.value) sources.push(r.value);
  }
  if (sources.length === 0) {
    const stale = await readCacheStale<HotSourceData[]>(ctx, "hot:all:v1");
    if (stale) return { sources: stale.data, asOf: stale.asOf };
    return { sources: [], asOf: new Date().toISOString() };
  }
  const asOf = await writeCache(ctx, "hot:all:v1", sources);
  return { sources, asOf };
}

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
      const r = await loadCategory(ctx, args.category, args.force);
      // Titles and summaries are entity-decoded on every read too, so a
      // payload cached before the entity fixes cannot show raw
      // &#163; / &#183; / &#160;.
      return {
        asOf: r.asOf,
        items: r.items.map((it) => ({
          ...it,
          title: decodeEntities(it.title),
          summary: it.summary ? decodeEntities(it.summary) : it.summary,
        })),
      };
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

  // --- getStatus response shapes for the 2026-11-24 status fix -----------
  // currentErrors: errors still open, per column — the ONLY basis for a
  // "currently failing" banner. lastError: the most recent enrich error
  // overall; recovered is true only on a same-column success, false while
  // open, and null (未确认) when the record predates the column tag and
  // cannot be matched to any column. errorHistory: retired errors with
  // occurred + recovered times. lastRefreshRun / lastCronRun: run records
  // written by refreshAll itself; only lastCronRun proves a scheduled
  // 08:02 run completed — a column's contentAt never proves that.
  getStatus: defineAction({
    description:
      "Returns the last successful refresh time across all caches and the daily refresh schedule, plus per-column status (content time, enrichment success time, latest enrichment error and whether it has recovered), the currently-open errors per column, the most recent error with its recovery state (null = unconfirmed), retired error history, and the last refresh run / last scheduled (cron) run records — so the page can answer whether anything is still failing, whether the last error recovered, and whether the last 08:02 scheduled refresh is confirmed complete.",
    request: z.object({}),
    response: z.object({
      lastUpdatedAt: z.string().nullable(),
      lastFailureAt: z.string().nullable(),
      lastFailureSource: z.string().nullable(),
      enrichError: z.string().nullable(),
      enrichErrorAt: z.string().nullable(),
      enrichErrorColumn: z.enum(["learning", "jiangxi", "overseas"]).nullable(),
      refreshTimeLabel: z.string(),
      refreshTimezone: z.string(),
      refreshScheduleLabel: z.string(),
      columns: z.object({
        learning: columnStatusSchema,
        jiangxi: columnStatusSchema,
        overseas: columnStatusSchema,
      }),
      currentErrors: z.array(
        z.object({
          column: z.enum(["learning", "jiangxi", "overseas"]),
          error: z.string(),
          errorAt: z.string().nullable(),
        }),
      ),
      lastError: z
        .object({
          message: z.string(),
          column: z.enum(["learning", "jiangxi", "overseas"]).nullable(),
          errorAt: z.string().nullable(),
          recovered: z.boolean().nullable(),
          recoveredAt: z.string().nullable(),
        })
        .nullable(),
      errorHistory: z.array(
        z.object({
          message: z.string(),
          column: z.enum(["learning", "jiangxi", "overseas"]).nullable(),
          errorAt: z.string().nullable(),
          recoveredAt: z.string().nullable(),
        }),
      ),
      lastRefreshRun: refreshRunSchema.nullable(),
      lastCronRun: refreshRunSchema.nullable(),
    }),
    async handler(ctx) {
      const db = ctx.db;
      const rows = await db.select().from(schema.cacheSnapshots);
      let max: Date | null = null;
      let lastFailureAt: string | null = null;
      let lastFailureSource: string | null = null;
      let enrichError: string | null = null;
      let enrichErrorAt: string | null = null;
      let enrichErrorColumn: ColumnKey | null = null;
      let errorHistory: HistoryErrorEntry[] = [];
      let lastRefreshRun: RefreshRunRecord | null = null;
      let lastCronRun: RefreshRunRecord | null = null;
      const columns: Record<ColumnKey, ColumnStatus> = {
        learning: { ...EMPTY_COLUMN_STATUS },
        jiangxi: { ...EMPTY_COLUMN_STATUS },
        overseas: { ...EMPTY_COLUMN_STATUS },
      };
      // Each column's content time is its own cache row's write time.
      const contentKey: Record<ColumnKey, string> = {
        learning: "learning:all:v3",
        jiangxi: "jiangxi:all:v5",
        overseas: "overseas:all:v20",
      };
      for (const r of rows) {
        if (r.key === "meta:status") {
          try {
            const meta = JSON.parse(r.payload) as {
              lastFailureAt?: string;
              lastFailureSource?: string;
              enrichError?: string;
              enrichErrorAt?: string;
              enrichErrorColumn?: string;
              errorHistory?: unknown;
              lastRefreshRun?: unknown;
              lastCronRun?: unknown;
              columns?: Record<string, ColumnStatus>;
            };
            lastFailureAt = meta.lastFailureAt ?? null;
            lastFailureSource = typeof meta.lastFailureSource === "string" ? meta.lastFailureSource : null;
            enrichError = meta.enrichError ?? null;
            enrichErrorAt = meta.enrichErrorAt ?? null;
            enrichErrorColumn = asColumn(meta.enrichErrorColumn);
            errorHistory = parseHistoryErrors(meta.errorHistory);
            lastRefreshRun = parseRefreshRun(meta.lastRefreshRun);
            lastCronRun = parseRefreshRun(meta.lastCronRun);
            for (const k of ["learning", "jiangxi", "overseas"] as const) {
              const saved = meta.columns?.[k];
              if (saved) {
                columns[k] = {
                  ...columns[k],
                  enrichAt: saved.enrichAt ?? null,
                  error: saved.error ?? null,
                  errorAt: saved.errorAt ?? null,
                  recovered: saved.recovered ?? false,
                };
              }
            }
          } catch {
            lastFailureAt = null;
          }
          continue;
        }
        for (const k of ["learning", "jiangxi", "overseas"] as const) {
          if (r.key === contentKey[k]) columns[k].contentAt = r.fetchedAt.toISOString();
        }
        // Only content caches count as a successful update (not detail lookups).
        if (!/^(news:|feed:|learning:|jiangxi:|overseas:|world:|hot:)/.test(r.key)) continue;
        if (r.key.includes(":enrich:") || r.key.includes(":dropped:")) continue;
        if (!max || r.fetchedAt.getTime() > max.getTime()) max = r.fetchedAt;
      }
      // Currently-open errors + most recent error (see deriveStatusErrors):
      // only a column's own open error counts as "currently failing"; the
      // stale top-level enrichError is history, matched to a column only by
      // its timestamp, and recovered only on a same-column later success.
      const { currentErrors, lastError } = deriveStatusErrors({
        enrichError,
        enrichErrorAt,
        enrichErrorColumn,
        columns,
        errorHistory,
      });
      return {
        lastUpdatedAt: max ? max.toISOString() : null,
        lastFailureAt,
        lastFailureSource,
        enrichError,
        enrichErrorAt,
        enrichErrorColumn,
        refreshTimeLabel: "08:02",
        refreshTimezone: "Asia/Shanghai",
        refreshScheduleLabel: "每天 08:02 · Asia/Shanghai (UTC+8)",
        columns,
        currentErrors,
        lastError,
        errorHistory,
        lastRefreshRun,
        lastCronRun,
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
        items: items.slice(0, 60).map((it) => ({
          ...it,
          title: decodeEntities(it.title),
          summary: it.summary ? decodeEntities(it.summary) : it.summary,
        })),
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

  // Dismissed ("ignored") items are hidden everywhere on the client and
  // synced across devices via this table. Each handler first runs an
  // idempotent lazy CREATE TABLE so the feature works even if the
  // drizzle/0003 migration was never applied to the live database.
  getDismissed: defineAction({
    description: "Lists the user's dismissed (ignored) items, newest dismissed first.",
    request: z.object({}),
    response: z.object({
      items: z.array(
        z.object({
          itemKey: z.string(),
          title: z.string(),
          dismissedAt: z.string(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db;
      await db.run(
        sql`CREATE TABLE IF NOT EXISTS dismissed_items (item_key TEXT PRIMARY KEY, title TEXT NOT NULL, dismissed_at TEXT NOT NULL)`,
      );
      const rows = await db.select().from(schema.dismissedItems).orderBy(desc(schema.dismissedItems.dismissedAt));
      return {
        items: rows.map((r) => ({ itemKey: r.itemKey, title: r.title, dismissedAt: r.dismissedAt })),
      };
    },
  }),

  dismissItem: defineAction({
    description: "Hides an item everywhere (matched by its key: URL, or title::source for linkless items).",
    request: z.object({
      itemKey: z.string().min(1).max(1000),
      title: z.string().min(1).max(300),
    }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db;
      await db.run(
        sql`CREATE TABLE IF NOT EXISTS dismissed_items (item_key TEXT PRIMARY KEY, title TEXT NOT NULL, dismissed_at TEXT NOT NULL)`,
      );
      await db
        .insert(schema.dismissedItems)
        .values({ itemKey: args.itemKey, title: args.title, dismissedAt: new Date().toISOString() })
        .onConflictDoUpdate({
          target: schema.dismissedItems.itemKey,
          set: { title: args.title, dismissedAt: new Date().toISOString() },
        });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  restoreDismissed: defineAction({
    description: "Restores one dismissed item so it shows again.",
    request: z.object({
      itemKey: z.string().min(1).max(1000),
    }),
    response: z.object({ ok: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db;
      await db.run(
        sql`CREATE TABLE IF NOT EXISTS dismissed_items (item_key TEXT PRIMARY KEY, title TEXT NOT NULL, dismissed_at TEXT NOT NULL)`,
      );
      await db.delete(schema.dismissedItems).where(eq(schema.dismissedItems.itemKey, args.itemKey));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  clearDismissed: defineAction({
    description: "Restores all dismissed items so they show again.",
    request: z.object({}),
    response: z.object({ ok: z.boolean(), cleared: z.number() }),
    async handler(ctx) {
      const db = ctx.db;
      await db.run(
        sql`CREATE TABLE IF NOT EXISTS dismissed_items (item_key TEXT PRIMARY KEY, title TEXT NOT NULL, dismissed_at TEXT NOT NULL)`,
      );
      const rows = await db.select({ itemKey: schema.dismissedItems.itemKey }).from(schema.dismissedItems);
      await db.delete(schema.dismissedItems);
      ctx.invalidateQueries();
      return { ok: true, cleared: rows.length };
    },
  }),

  getLearning: defineAction({
    description:
      "Returns the 学习 (learning) column: courses/lectures, learning resources and student opportunities for students, newest first, with a Chinese one-line summary per item, plus stage and application deadline when the source states them. Only still-actionable items are returned (2026-11-22): the strict filter applies to the FULL list on every response — expired-deadline opportunities, reports of already-finished events （研讨会/收官/获奖名单）, wrong-stage items （中小学/高中， 博士/硕士研究生招生； since 2026-11-23 the stage signals — middle school(s), 中小学， 初中， 高中生， 中六， JUPAS, DSE, 研究生/硕士研究生 — are matched against title + summary + points + audienceStage together, so an item whose stage is stated only in its body, e.g. an HKU undergraduate item naming JUPAS/中六 in its points, is excluded too), pure news reports, industry forums, offers restricted to one foreign country's own students （只限巴基斯坦/马来西亚等）, offers restricted to one specific employer's employees or their children (only for employees / employees' children / child of an employee, incl. \"employee or child of an employee\" / 只限…员工（子女）, e.g. the WCMA dairy-company scholarships), activity write-ups whose summary dates the event in the past (\"X月X日……举行/举办/召开\" with no replay and no sign-up, e.g. the 东湖大咖公开课 report), 专硕/学硕 master's-stage items (e.g. the 专硕 dorm-policy news), scholarships limited to one local school district's students or to high-school students only (school district / juniors and seniors / high school football / high school athlete / 学区 / 高中生， e.g. the St. Joseph scholarship and the People high-school athlete scholarship story) and expired intakes are all filtered out, so the list may honestly be empty. 自 2026-11-23 起另有两条规则：只有宣传博客、限时试听或无法核实免费范围的内容不进学习栏（课程卡必须直接链接到可免费学习的具体课程、练习或讲座回放；免费注册、仅证书收费的课程保留）；已发放/已颁发类报道不进可报名列表且 needsApplication 纠正为 false，只有官方页面确认报名已开放、报名免费且申请范围包含中国专科在读生时才列入，官方明确滚动报名或常年开放的项目即使没有截止日期也可保留。 HTML entities (&#…; and &…;, incl. double-encoded forms) are decoded in titles, points and summaries at ingest and on every read (2026-11-23), and an unenriched item's summary/relevance line is rebuilt from complete sentences of its own source summary — never cut mid-sentence and never a fabricated translation. Also returns upcoming deadlines (next 30 days, soonest first) for the reminder strip. Since 2026-11-23 the list is split into two display groups via each item's group field: twenty-seven hand-verified free resources that can be started right now (CURATED_LEARNING_ANYTIME — 网络安全/英语公开课， authorised CTF practice, a Cambridge lecture recording, plus CS50/编程、Web 安全实训、高等数学； each with a startHint naming the first lesson or exercise) lead the items array as group=anytime, followed by pool courses/resources (also anytime); pool opportunities with a deadline in the next 30 days and a confirmed official entry are group=upcoming （近期可报名）; a rolling / long-term-open opportunity in the 近期可报名 class is group=upcoming even without a deadline, and after the z-round two-class gate no pool item keeps group=null. The curated 近期可报名 set is empty this round — no official page was verified as explicitly open and free — so that group may honestly show its empty state. 自 2026-11-23 起，池内条目只有含真实可学内容（课程/讲座/回放/练习/实验）才进随时可学；纯政策新闻（征求意见稿、管理条例/办法类通知，如《教材管理条例（征求意见稿）》）由学习栏规则滤掉，永不为 group=anytime。自 2026-11-23 起另有 7 门人工核实的免费中文 AI 课程（CURATED_LEARNING_AI）作为持久精选随随时可学一同返回，每门带 aiTopic=true 供客户端的「AI 学习」话题筛选使用（能学什么/需要什么基础/从哪一课开始都写在卡上；全部免费学习、需免费注册、仅认证证书付费）；池内条目永不带 aiTopic。自 2026-11-23 起，Coursera 博客《Introducing AI Series on Coursera》（背后是 Coursera Plus 付费订阅、无单门免费带中文字幕课程、面向在职人士）由宣传博客规则从学习栏整个移除，不再保留随时可学位置；吴恩达《AI for Everyone》因只有非官方搬运、正版免费旁听与中文字幕未核实而不收录。自 2026-11-24 起另有一条确定性规则：标题含「夜校」、费用未说明、无 startHint、无截止日期且链接不在课程/学习平台域名上的条目，按纯新闻滤掉（如广州日报大洋网的青年夜校生活方式报道——没有任何具体课程、报名入口或免费学习入口）；带费用说明或开始提示的真实夜校课程不受影响。自 2026-11-24 起另有两类守门规则（z-round）：池内条目只有符合随时可学（有明确的免费课程、练习或回放入口；免费注册、仅证书收费保留）或近期可报名（有主办方官方报名入口、确认当前开放、报名免费且专科在读符合条件；官方明确长期/滚动开放的项目可以没有截止日期）才保留，两类都不满足的条目从学习列表彻底移除，不再进入「其他学习机会」；仅 needsApplication=true、未核实费用的招生/奖学金汇总、已颁发获奖名单、论坛邀请、博客文章和天气新闻等均被滤掉。自 2026-11-24 起再收紧（aa-round）：opportunities 类条目只能经「近期可报名」类合格，不能再靠「随时可学」的文本碎片混入后以 group=null 落进「其他学习机会」；随时可学的免费证据须由 免费 直接绑定课程/练习/回放等可学入口（裸「免费开放」和「免费…（隔字）…课程」不再算数），可学信号不再认裸字「课」（停课不算课程）；标题为天气/气象预报预警类且无自身学习入口的条目按纯新闻滤掉；汇总/盘点类标题不算单项官方报名入口，Outlook safelinks 跳转链接不算主办方官方入口，范围证据里的裸「不限」须为学历/专业/学校/年级不限才算。学习缓存键升至 learning:all:v3，旧缓存不再被读到。自 2026-11-24 起同一课程在两个平台的入口去重（`collapseSameCourseEntries`，入库 `loadLearning` 与每次 `getLearning` 读回都执行，`getDailyDigest` 经 `loadLearning` 同样去重）：北理工《网络安全——应用技术与工程实践》曾在学堂在线与 MOOC 各有一条精选，去重只保留带 `aiTopic` 的 MOOC 条目（2026-11-26 起学堂在线入口已从随时可学精选移出）；合并列表 34 条、AI 筛选仍 7 条；去重键为归一化标题（去标点/空白/横线变体）＋学校（标题末尾括号里的学校优先，否则取来源末段的学校，均须含“大学/学院/学校”字样）。自 2026-11-26 起另有「英语」「高等数学」话题筛选：englishTopic 标 7 门：国防科大《大学英语（口语）》（日常英语方向；2026 年考试说明不考听力口语，不标为对齐考试）与集美《英语听力技能与实践》（日常英语），另有 5 门专升本英语课（河南科大《大学英语（四）》、长安《大学英语读写（一）》、新通用大学英语（一）、南京大学《大学英语学术阅读与写作》与《英汉互译方法与技巧》）；mathTopic 标 8 门：江苏农林《高等数学（一）》（高数路线第 1–3 阶段）、可汗学院中文站（覆盖全部 6 阶段）、同济《高等数学（一）》（第 1–2 阶段）、同济《高等数学（二）》（第 3–4 阶段）、《高等数学（下）》（第 5–6 阶段为主，附带第 4 阶段）与南京工大《高等数学（一）》（第 1–4 阶段）、江西理工大学《高等数学（一）》（第 1–3 阶段）与江西理工大学《高等数学（二）》（第 4–6 阶段）；池内条目永不带这两个字段。2026-11-26 Tier 2（用户 22:54 批准）：上述 10 门 MOOC 课按平台免费口径上架（平台课程学习免费，仅认证证书付费；课程页未写‘免费’二字），清华《生活英语听说》因链接未验证暂缓，福州大学《网络空间安全概论》与上交《信息安全数学基础》不加。任何条目都不标「江西专升本真题」。",
    request: z.object({ force: z.boolean().default(false) }),
    response: z.object({
      asOf: z.string(),
      items: z.array(learningItemSchema),
      deadlines: z.array(learningItemSchema),
    }),
    async handler(ctx, args) {
      const loaded = await loadLearning(ctx, args.force);
      const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
      // The strict 只留能参加的 filter applies to the FULL list on every
      // response (2026-11-22), not only at ingest: a cached payload written
      // before a rule existed — pure news reports, industry forums,
      // foreign-country-only offers, expired intakes — is filtered here
      // too, so the 学习 tab and the homepage 本周学习 strip always agree.
      const items = loaded.items
        .map(normalizeLearning)
        .filter((it) => !isLearningNotActionable(it, todayStr));
      const asOf = loaded.asOf;
      // "可报名" list: only deadlines from today (Asia/Shanghai) through the
      // next 30 days — expired opportunities are excluded here and badged
      // 已截止 in the full list. Application-type items (scholarships,
      // competitions, summer schools…) additionally need a CONFIRMED
      // official entry: an opportunity whose officialUrl was never
      // confirmed does not enter this list at all. Courses/lectures and
      // learning resources are unaffected — they are not application
      // items and keep showing in the full list as before.
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
      // Two display groups (2026-11-23): pool courses/resources are
      // 随时可学 ("anytime"); pool opportunities whose deadline falls in
      // the next 30 days with a confirmed official entry — exactly the
      // deadlines list above — are 近期可报名 ("upcoming"); any other
      // opportunity keeps group=null and is listed separately by the
      // client, never silently dropped. The hand-verified curated
      // anytime resources go FIRST and bypass normalizeLearning (its
      // relevance rebuild would overwrite their curated lines) and the
      // actionable filter above.
      const upcomingUrls = new Set(deadlines.map((d) => d.url));
      const grouped = items.map((it) => ({
        ...it,
        // Defense in depth (2026-11-23): a pool courses/resources item
        // only becomes 随时可学 when it is not pure policy news without
        // learnable content — the actionable filter above already drops
        // those, and this guard keeps the grouping honest even if a
        // cached item ever reaches here unfiltered. The curated anytime
        // resources are prepended below and never pass through here.
        // z-round (2026-11-24): an item in the 近期可报名 class is
        // group=upcoming even without a deadline in the next 30 days —
        // a rolling / long-term-open project may have no deadline at
        // all, and it must never fall through to group=null, which the
        // client renders under 「其他学习机会」. After the two-class
        // gate above, group=null is unreachable for pool items.
        group: ((it.category === "courses" || it.category === "resources") &&
        !isPolicyNewsWithoutLearnableContent(it)
          ? "anytime"
          : upcomingUrls.has(it.url) || isUpcomingClass(it, todayStr)
            ? "upcoming"
            : null) as "anytime" | "upcoming" | null,
      }));
      // The seven hand-verified AI-learning courses (CURATED_LEARNING_AI,
      // aiTopic=true) ride along as persistent curated anytime content,
      // right after the original seven anytime resources — they bypass
      // the pool pipeline exactly like those do, and the client's
      // 「AI 学习」 topic filter selects on aiTopic, which pool items
      // never carry (so the Coursera blog keeps its pool place in
      // 随时可学 but never enters the AI filter).
      return { items: collapseSameCourseEntries([...CURATED_LEARNING_ANYTIME, ...CURATED_LEARNING_AI, ...grouped]), deadlines, asOf };
    },
  }),

  getFitness: defineAction({
    description:
      "Returns the 健身 (fitness) column: nineteen hand-verified free Chinese video tutorials for basic exercises, grouped 胸 (4) / 背 (2) / 腿臀 (7) / 肩 (2) / 核心 (4), covering bodyweight and common gym equipment. Each card carries 动作名称、所需器械、起始姿势、动作要点 (2–3)、一个常见错误、示范直达链接 (Bilibili; the plank demo is English-narrated with Chinese subtitles, noted on the card), plus 讲解者 and 视频标题 when the tutorial is a verified athlete's. Thirteen cards link to 谭成义 tutorials (nine from his own account, four co-presented on the 凯圣王 account); the other six keep their existing links as 过渡保留 and carry athletePending=true （选手教学待补充）. Persistent curated content: it never rotates with the daily refresh, and the column is 动作教学 only — deliberately no training plan and no check-in feature.",
    request: z.object({}),
    response: z.object({
      items: z.array(fitnessItemSchema),
    }),
    handler: async (): Promise<{ items: FitnessItemData[] }> => ({ items: FITNESS_ITEMS }),
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
      if (cached)
        return {
          ...cached.data,
          introZh: cached.data.introZh ? decodeEntities(cached.data.introZh) : cached.data.introZh,
          points: dedupeSentences(cached.data.points.map((p) => decodeEntities(p))),
        };

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
        points: dedupeSentences(base.points),
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
      "Returns the 江西专升本 column for a Jiangxi 专科 student （信息安全技术应用， 2028 年毕业）: official-first notices about 报名/考试科目/专业对照/招生简章， each with applicable year, relevance to the major and what to do. Training-institution marketing （机构评测/测评等） and 高考择校 content for gaokao students choosing a 专科 school are hidden at ingest — he is already a second-year student. Ended exam-administration reminders （考区/考点/考场提醒、准考证提示 whose sitting has passed, e.g. the 2026 九江考区温馨提醒） are moved to history — filtered at ingest AND on every read so cached payloads obey too — while lasting-value material （考试科目/专业对照/招生方案/实施方案/报名流程/分数线） stays visible. Past-year items are flagged isReference （备考参考）; the pending list marks each 2028 matter as 待公布 until a 2028 notice covers it. Tags are content-derived deterministically at ingest and on every read (2026-11-22): 分数线/录取控制线/投档线/录取结果 → 录取， 报名流程/报名通知/报考 → 报名， 考试时间/科目安排/准考证 → 考试科目 — a score-line announcement can never stay tagged 报名. A missing applicable year is derived from the title, then the summary, then the publish date, so dated past-year material always shows its year. Relevance lines are per-item, grounded in the item's own tag/title/year; the old shared template (or any relevance repeated verbatim across items) is replaced on every read. Within a tag the line follows the title's own content signal (2026-11-23): 报名条件/报考指南 vs 报名流程/详细报考步骤 get different lines, as do 分数线/录取控制线 vs 录取人数/录取结果 — and a final column-level pass guarantees no two items in the column carry the identical relevance sentence, appending a clause built from the item's own title phrase when a repeat survives. Official sources (jxeea.cn / .gov.cn / .edu.cn) sort first inside each group. Since 2026-11-23 the response also carries archive: five hand-verified 2026 official documents （往年官方备考资料 — 报名通知/考试说明/专业对照目录/录取控制分数线/考试招生工作通知， from jxeea.cn and jyt.jiangxi.gov.cn, each with docKind and, where one exists, an attachmentUrl next to the notice page). Verified: the 2026 exam was held 2026-03-29 and score lines published 2026-04-18; neither official site publishes 2026 真题 and the 考试说明 has no 例题/样题， so no 真题 item exists — the client states that honestly above the archive. Since 2026-11-23 the WHOLE column (homepage first column, this action and the archive) shows ONLY originals published on the two official sites — 江西省教育考试院 jxeea.cn and 江西省教育厅 jyt.jiangxi.gov.cn (the dead jxedu.gov.cn is never used): the deterministic official-only filter runs at ingest in loadJiangxi and again on every read of this action, so reposts (eol.cn、搜狐、新浪、腾讯、人民网…) never appear even when they quote an official notice, and an empty pool is the expected result on days with no new official notice (the UI then shows 「暂无新的官方公告」 above the archive).",
    request: z.object({ force: z.boolean().default(false) }),
    response: z.object({
      asOf: z.string(),
      items: z.array(jiangxiItemSchema),
      archive: z.array(jiangxiItemSchema),
      pending: z.array(z.object({ label: z.string(), status: z.string() })),
      hasTodayUpdate: z.boolean(),
    }),
    async handler(ctx, args) {
      const loaded = await loadJiangxi(ctx, args.force);
      const asOf = loaded.asOf;
      // Read-time application of two rules, so a payload cached before
      // a rule existed is corrected on every response too:
      // (1) official-only (2026-11-23) — the pool may contain ONLY
      // originals from 江西省教育考试院 jxeea.cn and 江西省教育厅
      // jyt.jiangxi.gov.cn; every repost is dropped here even if it
      // entered the cache earlier (the pre-rule cache held 11 reposts;
      // an empty pool after this filter is the expected outcome and
      // the UI shows 「暂无新的官方公告」).
      // (2) ended 考区/考点/准考证 reminders leave the visible list,
      // while 考试科目/专业对照/招生方案 material stays （备考参考）.
      const items = fixJiangxiList(
        loaded.items.filter(
          (it) => isJiangxiOfficialUrl(it.url) && !isJiangxiEndedExamReminder(it.title, it.publishedAt),
        ),
      );
      const current = items.filter((it) => !it.isReference);
      const covers = (tag: JiangxiTag) => current.some((it) => it.tag === tag);
      const pending = [
        { label: "2028 年报名通知", status: covers("报名") ? "已有 2028 年消息，见下方" : "待公布" },
        { label: "2028 年考试科目", status: covers("考试科目") ? "已有 2028 年消息，见下方" : "待公布" },
        { label: "2028 年专业对照表", status: covers("专业对照") ? "已有 2028 年消息，见下方" : "待公布" },
        { label: "2028 年招生简章", status: covers("招生简章") ? "已有 2028 年消息，见下方" : "待公布" },
      ];
      // The hand-verified 2026 archive is returned verbatim in its own
      // field (2026-11-23): it does NOT pass through fixJiangxiList or
      // the ended-reminder filter, and it never counts toward the 2028
      // pending covers() check above — the four 2028 items stay 待公布
      // until a real 2028 notice appears in the fetched pool.
      return {
        // Pool items predate the archive fields: fill the schema
        // defaults (null) at the response boundary only — the pool
        // pipeline above is unchanged.
        items: items.map((it) => ({
          ...it,
          attachmentUrl: it.attachmentUrl ?? null,
          docKind: it.docKind ?? null,
        })),
        archive: JIANGXI_ARCHIVE_ITEMS,
        pending,
        asOf,
        hasTodayUpdate: items.some((it) => isTodayShanghai(it.publishedAt)),
      };
    },
  }),

  getOverseas: defineAction({
    description:
      "Returns decision-changing overseas opportunities and policy changes for a Chinese 专科 (diploma) student across the US, New Zealand, Singapore, Vietnam, Japan, South Korea, Ireland and the UK: what changed, who it applies to and when it takes effect, with the original university/government link. Applicability is checked BEFORE pinning (2026-11-22): an item that clearly does not apply to the user — bachelor_only, or its own text says 不适用于我 / 不含信息安全技术应用 — is excluded from the column entirely, fixed visa zone included (so the zone holds the Yale D/S ruling, Singapore MOM thresholds, the Japan language-school rule and — since 2026-11-22, as a hand-verified curated pin exempt from the rotating list's nationality filter — the NZ Short-term Graduate Work Visa labelled as a future path (usable only after completing an NZQCF Level 5–7 qualification in NZ; the user's Jiangxi diploma does not itself qualify, and it is a different visa from the bachelor-only NZ PSWV expansion); the bachelor-only NZ PSWV/UK items and the Korea pilot are out). Homepage selection also requires the item to involve Chinese applicants or state a rule for applicants of all countries (2026-11-22): stories only about one foreign nationality's applicants (Indian NZ approval-rate data at 64.1%, Indian PhD post-study rights, visas 'for Indians', Ireland refusals of Indian applicants, a jobs guide for Nigerians) are excluded from the homepage list at ingest, after enrichment, in the pinned-zone merge and on every read of a cached payload — homepage display only, the category archive keeps its data. A bare comparison mention ('India lags behind China') does not count as involving Chinese applicants. In Chinese headlines of the shape 'X国留学生 / X国申请人', X is the applicants' nationality, not the destination (2026-11-22): 《越南留学生如何在加拿大申请留学》 is about Vietnamese applicants applying to Canada and leaves the homepage, while pieces treating Vietnam as the destination （去越南留学 / 越南学生签证规则） and all-applicant content (a Stanford graduate-union petition, a Bowdoin international-student admissions page) stay. One event, one entry: exact duplicates (same title/source/day) and same-event retellings are merged, keeping the official/newest version; the NZ student-visa statistics release is one named event, so its retellings collapse to a single entry before the applicant rule is applied. Student-visa and post-study-work-visa changes carry visa=true and live in a fixed zone (pinned=true): they persist across daily refreshes and are only removed when superseded by a newer item on the same topic, expired, or ruled not applicable. Unclear eligibility stays 'unclear' and is never presented as diploma-eligible. Immigration items carry an identityLabel. Policy cards (kind=policy) state only whom the policy affects (2026-11-22): their relevance text never uses application wording, no application deadline is exposed for them, and the client hides the eligibility badge and deadline fields — only genuinely open programmes/jobs show those. The NZ Short-term Graduate Work Visa's status label is computed at read time from its effective date 2026-11-23 against the current date in Pacific/Auckland (before that date it reads 即将生效， on/after it 已生效）; its 「11月23日起」 wording and 未来路径 note are unchanged. The NIC Winter Internship 2026 is ONE project however many outlets retell it (user-verified 2026-11-22 against the NDTV original, whose article opens with the NIC announcement): NDTV's 'Ministry Of Electronics And IT Offers Two-Month Internship With Rs 20,000 Stipend', India.com's 'NIC Winter Internship 2026' and any Moneycontrol / JagranJosh retelling are the same programme, so the project is merged at ingest and on every read to a single entry with the NDTV item as representative, carrying the verified facts (NIC under MeitY; two months, 2026-12-01 to 2027-01-31; 50 seats; Rs 10,000/month, Rs 20,000 total; official entry dii.nic.in, registration open since Nov 2, closing date officially unconfirmed so no deadline is ever shown). It is deterministically filed under 海外实习、工作与签证 (category work_visa, stage intern, kind job), never 海外升学： verified offline at NIC Headquarters, New Delhi, not remote from China; whether students in China may apply is unstated in the source (it states only Indian local degree/enrolment requirements, no nationality rule either way), so eligibility stays 'unclear' / acceptsOverseas unstated — neither applicable nor not applicable — and it is excluded from the 近期可申请 digest. The Yale OISS D/S card carries the user-dictated verbatim combined tag 「美国签证政策｜D/S 继续适用」 (cardTagLabel, replacing the generic 签证/移民政策 stage chip and the separate status suffix; the 「政策 · 非岗位」 chip stays), the user's verbatim body text taken from the Yale page's 2026-11-17 update (the fixed-period rule was stopped before taking effect and set aside on 2026-11-16; it never took effect; F-1/J-1 students, scholars and eligible dependants generally remain admitted for D/S — never worded as 恢复）, and a standalone 「法院裁决日期：2026 年 11 月 16 日」 line (decisionDateLabel); publishedAt is the source update date 2026-11-17 and the points keep the 2026-11-22 check date. correctOverseasItem reapplies the curated entry on every read so a cached payload cannot serve the older wording; the NZ/Singapore/Japan policy cards are unchanged. Internship recategorization is a general deterministic rule (2026-11-22): any item whose title is about an internship （实习 / Internship), or whose body is about one while filed under study, is moved to 海外实习、工作与签证 as stage=intern at ingest and on every read — the Moneycontrol Indian Army Internship Programme is the named case, not a special case. The study column prioritizes programmes with an institution's own stated conditions (official source + deadline/major-match/language-requirement first) and hides generic study-abroad trend news (kind=news, non-official, eligibility unclear, no condition fields at all). Policy effective dates are carried per matter in effectiveParts: the Singapore MOM card shows 「新申请：2027-01-01 起」 and 「续签：2028-01-01 起到期者」 as separate lines (reapplied on every read), and any multi-node effectiveWhen is split the same way. A job whose eligibility is unclear and which states no education/experience requirement never enters the 近期可申请 digest. Job relevance lines claim an infosec/network/IT-support fit only when the item's own text supports it.",
    request: z.object({ force: z.boolean().default(false) }),
    response: z.object({
      asOf: z.string(),
      items: z.array(overseasItemSchema),
      hasTodayUpdate: z.boolean(),
    }),
    async handler(ctx, args) {
      const { items, asOf } = await loadOverseas(ctx, args.force);
      // Read-time project merge (user rule, 2026-11-22): even a payload
      // cached before the merge rule existed collapses the NIC Winter
      // Internship project's retellings to the single NDTV
      // representative on every read.
      const normalized = collapseNicProjectItems(items.map(normalizeOverseas)).filter(
        (it) => !isStudyTrendNoise(it),
      );
      // Display order (user rule, 2026-11-22): the fixed visa zone keeps
      // its order first; inside 海外升学， programmes carrying an
      // institution's own stated conditions (official source + a stated
      // deadline / major match / language requirement) come first —
      // official sources before the rest, then items with deadlines.
      // The two category sections filter this list, so regrouping here
      // cannot move an item across categories.
      const studyRank = (it: (typeof normalized)[number]): number =>
        it.official && (it.deadline || it.majorMatch || it.languageReq)
          ? 0
          : it.official
            ? 1
            : it.deadline || it.majorMatch || it.languageReq
              ? 2
              : 3;
      const ordered = [
        ...normalized.filter((it) => it.pinned),
        ...normalized
          .filter((it) => !it.pinned && it.category === "study")
          .sort((a, b) => studyRank(a) - studyRank(b)),
        ...normalized.filter((it) => !it.pinned && it.category !== "study"),
      ];
      return { items: ordered, asOf, hasTodayUpdate: items.some((it) => isTodayShanghai(it.publishedAt)) };
    },
  }),

  getMyWorld: defineAction({
    description:
      "Returns 我关注的世界： daily picks (at most 5, same event merged, across 国内经济/国外经济/政治/科技/网络安全/出行安全/地区冲突）, weekly picks （书籍/历史/语言学习）, and the full topic-browsable list. Local festival/traffic advisories written for one unrelated locality's residents (e.g. 大理州庆交通安全出行提示） are excluded at ingest and on every read; nationwide notices and travel-safety items about 江西 or a study destination （美国/新西兰/新加坡/越南/日本/韩国/爱尔兰/英国） stay. Each item's 「和我有什么关系」 line is derived deterministically from the item's OWN title/summary (2026-11-22), never from a per-topic template: a disaster/accident report (e.g. the Indonesia candy-factory fire) is labelled a safety event with no visa claim, and the visa/study/travel wording is used only when the item's own text involves visas, study abroad or travel. Titles are HTML-entity-decoded (&#163; → £, &#183; → ·) at ingest and on every read, and a Google News multi-outlet headline list is never stored as a summary — the item is title-only instead of splicing several outlets' reports into one.",
    request: z.object({ force: z.boolean().default(false) }),
    response: z.object({
      asOf: z.string(),
      daily: z.array(worldItemSchema),
      weekly: z.array(worldItemSchema),
      all: z.array(worldItemSchema),
    }),
    async handler(ctx, args) {
      const r = await loadMyWorld(ctx, args.force);
      // Read-time application of the local festival/traffic rule, so a
      // payload cached before the rule existed is filtered on every
      // response too (ingest applies the same rule to fresh pools).
      const keep = (it: WorldItem) => !isLocalFestivalTrafficNotice(it);
      return {
        asOf: r.asOf,
        daily: r.daily.filter(keep).map(normalizeWorld),
        weekly: r.weekly.filter(keep).map(normalizeWorld),
        all: r.all.filter(keep).map(normalizeWorld),
      };
    },
  }),

  getHotLists: defineAction({
    description: "Returns the 综合热榜： platform hot lists （微博/百度/头条/B站） with each platform's own ranking. Shown at the bottom of the homepage, collapsed by default (restored 2026-11-22 at the user's request; the entertainment news category stays removed).",
    request: z.object({ force: z.boolean().default(false) }),
    response: z.object({
      asOf: z.string(),
      sources: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          items: z.array(z.object({ rank: z.number(), title: z.string(), url: z.string(), heat: z.string().nullable() })),
        }),
      ),
    }),
    async handler(ctx, args) {
      return await loadHotLists(ctx, args.force);
    },
  }),

  getDailyDigest: defineAction({
    description: "Returns the homepage 近期可申请 strip: at most 5 currently-applicable opportunities merged across 海外升学 / 海外实习、工作与签证 / 学习与实践. An item qualifies only when it clearly applies to the user (not bachelor-only, not self-described as 不适用于我）, has a usable entry link, and — preferred — a stated application deadline; official sources rank first, then items with deadlines, then newest. Policies are never listed as 岗位可申请. When nothing qualifies the list is honestly empty and the homepage shows 「暂无符合条件的新机会」.",
    request: z.object({ force: z.boolean().default(false) }),
    response: z.object({
      asOf: z.string(),
      items: z.array(
        z.object({
          title: z.string(),
          url: z.string(),
          source: z.string(),
          publishedAt: z.string().nullable(),
          deadline: z.string().nullable(),
          effectiveWhen: z.string().nullable(),
          relevance: z.string(),
          categoryLabel: z.string(),
          country: z.string().nullable(),
          stage: z.string(),
          official: z.boolean(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const [ov, le] = await Promise.all([loadOverseas(ctx, args.force), loadLearning(ctx, args.force)]);
      type DigestItem = {
        title: string; url: string; source: string; publishedAt: string | null;
        deadline: string | null; effectiveWhen: string | null; relevance: string;
        categoryLabel: string; country: string | null; stage: string; official: boolean;
      };
      const pool: DigestItem[] = [];
      for (const raw of ov.items) {
        const it = normalizeOverseas(raw);
        if (it.kind === "policy") continue; // a policy is never an application target
        // NIC Winter Internship (user rule, 2026-11-22): whether a student
        // in China may apply is unstated in the official notification, so
        // it is never presented as currently applicable.
        if (isNicWinterInternship(it)) continue;
        // Only genuinely actionable items qualify: an actual job posting, a
        // stated application deadline, or a source-confirmed diploma-eligible
        // opening. Plain news about overseas study never counts as 可申请.
        if (it.kind !== "job" && !it.deadline && it.eligibility !== "diploma_eligible") continue;
        // A job whose application eligibility is unclear AND which states
        // no education/experience requirement at all is not shown as
        // currently applicable (user rule, 2026-11-22): there is no
        // grounded basis to say he can apply.
        if (it.kind === "job" && it.eligibility === "unclear" && !it.eduReq && !it.expReq) continue;
        if (it.eligibility === "bachelor_only") continue;
        if (!it.readUrl && !it.url) continue;
        if (it.blockedReason) continue;
        pool.push({
          title: it.title,
          url: it.readUrl ?? it.url,
          source: it.source,
          publishedAt: it.publishedAt,
          deadline: it.deadline,
          effectiveWhen: it.effectiveWhen,
          relevance: it.relevance,
          categoryLabel: it.category === "study" ? "海外升学" : "海外实习、工作与签证",
          country: it.country,
          stage: it.stage,
          official: it.official,
        });
      }
      const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
      for (const raw of le.items) {
        const it = normalizeLearning(raw);
        // The learning column's strict filter (incl. the wrong-stage
        // signals, 2026-11-23) governs this strip too — a middle-school
        // or 研究生-stage item never counts as 近期可申请.
        if (isLearningNotActionable(it, todayStr)) continue;
        if (!it.needsApplication || !it.officialUrl) continue;
        if (!it.deadline || it.deadline < todayStr) continue;
        pool.push({
          title: it.title,
          url: it.officialUrl,
          source: it.source,
          publishedAt: it.publishedAt,
          deadline: it.deadline,
          effectiveWhen: null,
          relevance: it.relevance,
          categoryLabel: "学习与实践",
          country: null,
          stage: it.audienceStage ?? "",
          official: true,
        });
      }
      const seen = new Set<string>();
      const deduped = pool.filter((it) => {
        const k = fullTitleKey(it.title);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      deduped.sort((a, b) => {
        if (a.official !== b.official) return a.official ? -1 : 1;
        const ad = a.deadline ? 0 : 1;
        const bd = b.deadline ? 0 : 1;
        if (ad !== bd) return ad - bd;
        const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
        const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
        return tb - ta;
      });
      return { items: deduped.slice(0, 5), asOf: new Date().toISOString() };
    },
  }),

  refreshAll: defineAction({
    description:
      "Refreshes every cache: the five homepage categories, the learning column, all news categories, the platform hot lists, and every followed feed. Used by the daily schedule and first-load warm-up. `source` names the caller (cron = the scheduled 08:02 run, manual = the homepage button, unknown = anything else) and is recorded with the run, so getStatus can tell a confirmed scheduled run apart from a manual refresh or a plain column update.",
    request: z.object({ source: z.enum(["cron", "manual", "unknown"]).default("unknown") }),
    response: z.object({ ok: z.literal(true), refreshedAt: z.string() }),
    async handler(ctx, args): Promise<{ ok: true; refreshedAt: string }> {
      // One shared run budget for the whole execution (p-round, 2026-11-23):
      // 55s, targeting the 60s self-hosted function cap, with time reserved
      // for cache writes. Each column's enrichment loop gates every batch
      // on the remaining budget and derives its per-call timeout from it,
      // so a slow learning column can no longer starve the columns after
      // it — unfinished items stay fresh and the next run resumes them.
      const budget = newRunBudget();
      // Run record (2026-11-24 status fix): written at start ("running",
      // per-column "pending") and again at finish, so the homepage can
      // prove — or honestly say it cannot prove — that a scheduled 08:02
      // run completed. A column's contentAt alone never proves that: it
      // can also come from a manual refresh or a TTL-expired page open.
      const startedAt = new Date().toISOString();
      const runColumns: Record<ColumnKey, RefreshRunColumnResult> = {
        learning: "pending",
        jiangxi: "pending",
        overseas: "pending",
      };
      await recordRefreshRun(ctx, {
        startedAt,
        finishedAt: null,
        source: args.source,
        status: "running",
        columns: { ...runColumns },
      });
      let runStatus: "completed" | "failed" = "completed";
      try {
        // Column isolation: a slow or failing column must not block the
        // others — each still gets its own refresh chance and writes its own
        // cache. Failures are recorded per column (see getStatus) and by
        // noteRefreshFailure inside the loaders; the run still reports ok so
        // one column's failure cannot hide the others' fresh caches.
        const runColumn = async (fn: () => Promise<unknown>): Promise<boolean> => {
          try {
            await fn();
            return true;
          } catch {
            // isolated — the next column still runs
            return false;
          }
        };
        // Learning first: its model enrichment is the slowest, most
        // deadline-sensitive step, so it must not queue behind nine sequential
        // category fetches (that ordering is what starved it of inference time).
        runColumns.learning = (await runColumn(() => loadLearning(ctx, true, budget))) ? "ok" : "failed";
        // The other two model-enriched columns also run one after another,
        // never in parallel with each other (2026-11-23 pacing — see
        // completeEnrichment); 我关注的世界 and the hot lists make no model
        // calls and still load together. Every column keeps writing its own
        // cache the moment it finishes.
        runColumns.jiangxi = (await runColumn(() => loadJiangxi(ctx, true, budget))) ? "ok" : "failed";
        runColumns.overseas = (await runColumn(() => loadOverseas(ctx, true, budget))) ? "ok" : "failed";
        await runColumn(() => Promise.all([loadMyWorld(ctx, true), loadHotLists(ctx, true)]));
        await runColumn(() => Promise.all(CATEGORIES.map((cat) => loadCategory(ctx, cat.id, true))));
        const db = ctx.db;
        const subs = await db.select().from(schema.subscriptions);
        for (const s of subs) {
          await runColumn(() => loadFeedItems(ctx, s.feedKey, s.name, s.url, true));
        }
        // Run status (2026-11-24, Muse v62 rule): the run is "failed" when
        // any of the three enriched columns failed, even though the other
        // columns still wrote their caches (column isolation above).
        runStatus =
          runColumns.learning === "failed" ||
          runColumns.jiangxi === "failed" ||
          runColumns.overseas === "failed"
            ? "failed"
            : "completed";
        ctx.invalidateQueries();
        return { ok: true, refreshedAt: new Date().toISOString() };
      } catch (e) {
        runStatus = "failed";
        throw e;
      } finally {
        // The finish record is written even when an unexpected error escapes
        // the isolated columns (Muse v62 leaves lastRefreshRun "running" in
        // that case; the self-hosted copy records it "failed" instead, so an
        // interrupted run is never mistaken for one still in progress).
        await recordRefreshRun(ctx, {
          startedAt,
          finishedAt: new Date().toISOString(),
          source: args.source,
          status: runStatus,
          columns: { ...runColumns },
        });
      }
    },
  }),
};
