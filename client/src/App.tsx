import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";


type NewsItem = ApiResponse<typeof api, "getCategoryNews">["items"][number];
type LearningItem = ApiResponse<typeof api, "getLearning">["items"][number];
type LearningCategory = LearningItem["category"];
type JiangxiItem = ApiResponse<typeof api, "getJiangxi">["items"][number];
type OverseasItem = ApiResponse<typeof api, "getOverseas">["items"][number];
type WorldItem = ApiResponse<typeof api, "getMyWorld">["daily"][number];
type DigestItem = ApiResponse<typeof api, "getDailyDigest">["items"][number];
type HotSource = ApiResponse<typeof api, "getHotLists">["sources"][number];
type FitnessItem = ApiResponse<typeof api, "getFitness">["items"][number];

/** Key under which the last "mark all as seen" time is kept (localStorage only, per device). */
const LAST_SEEN_KEY = "xinwenye_last_seen_at";

/** Last-seen time for NEW badges; null until the first visit is recorded. */
const LastSeenContext = createContext<string | null>(null);
/** Sections report whether they currently show any NEW item, keyed by section id. */
const NewReportContext = createContext<(section: string, has: boolean) => void>(() => {});
/** Lets a DismissButton anywhere report the just-dismissed item for the undo toast. */
const DismissNotifyContext = createContext<(item: { itemKey: string; title: string }) => void>(() => {});

/** Stable identity for dismissing: the URL, or title::source for linkless items. */
function itemKeyFor(item: { url?: string | null; title: string; source?: string }): string {
  return item.url ? item.url : `${item.title}::${item.source ?? ""}`;
}

/** NEW when published after the last "mark all as seen" time. */
function isNewItem(publishedAt: string | null | undefined, lastSeenAt: string | null): boolean {
  if (!publishedAt || !lastSeenAt) return false;
  const t = new Date(publishedAt).getTime();
  const seen = new Date(lastSeenAt).getTime();
  return !Number.isNaN(t) && !Number.isNaN(seen) && t > seen;
}

/** Restrained NEW tag next to a title (outline pill, smaller than the filled badges). */
function NewBadge() {
  return (
    <span className="rounded-full border border-[var(--accent)] px-1.5 py-px text-[11px] font-medium leading-tight text-[var(--accent)]">
      NEW
    </span>
  );
}

/** Shared dismissed-items query, as a Set of keys for render-time filtering. */
function useDismissedKeys(): Set<string> {
  const q = useQuery({ queryKey: ["dismissed"], queryFn: () => api.getDismissed({}) });
  return useMemo(() => new Set((q.data?.items ?? []).map((it) => it.itemKey)), [q.data]);
}

/** A section reports whether any of its (already dismiss-filtered) items is NEW. */
function useReportHasNew(section: string, items: Array<{ publishedAt: string | null }>) {
  const lastSeenAt = useContext(LastSeenContext);
  const reportHasNew = useContext(NewReportContext);
  const hasNew = items.some((it) => isNewItem(it.publishedAt, lastSeenAt));
  useEffect(() => {
    reportHasNew(section, hasNew);
    return () => reportHasNew(section, false);
  }, [section, hasNew, reportHasNew]);
}

const OVERSEAS_COUNTRIES = ["美国", "新西兰", "新加坡", "越南", "日本", "韩国", "爱尔兰", "英国"];
const STUDY_STAGES: Array<{ id: string; label: string }> = [
  { id: "prepare", label: "在读可准备" },
  { id: "diploma", label: "专科毕业可申请" },
  { id: "bachelor", label: "本科毕业可申请" },
];
const WORK_STAGES: Array<{ id: string; label: string }> = [
  { id: "intern", label: "在读实习" },
  { id: "direct", label: "专科毕业后从中国直接求职" },
  { id: "overseas_job", label: "海外留学期间及毕业后就业" },
];
function stageLabel(item: OverseasItem): string {
  const map = item.category === "study" ? STUDY_STAGES : WORK_STAGES;
  return map.find((x) => x.id === item.stage)?.label ?? (item.category === "work_visa" && item.kind === "policy" ? "签证/移民政策" : "阶段未说明");
}
type Tab = "home" | "news" | "learning" | "fitness" | "feeds" | "saved";

const LEARNING_CATEGORIES: Array<{ id: LearningCategory; label: string }> = [
  { id: "courses", label: "课程与讲座" },
  { id: "resources", label: "学习资源" },
  { id: "opportunities", label: "学生机会" },
];

function formatDateOnly(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function daysUntil(dateOnly: string): number | null {
  const d = new Date(`${dateOnly}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

// All times on this page are Beijing time (Asia/Shanghai, UTC+8), stated
// explicitly instead of relying on the viewer's local timezone (2026-11-24
// status fix — the old code used local-time getters, so the same timestamp
// could render in a different timezone on another device).
const BEIJING_TZ = "Asia/Shanghai";

function beijingParts(date: Date): { year: string; month: string; day: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: BEIJING_TZ,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = beijingParts(d);
  return `${p.hour}:${p.minute}`;
}

function formatPubTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = beijingParts(d);
  return `${p.month}月${p.day}日 ${p.hour}:${p.minute}`;
}

function formatFullDateTime(iso: string | null): string {
  if (!iso) return "尚未更新";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "尚未更新";
  const p = beijingParts(d);
  return `${p.year}年${p.month}月${p.day}日 ${p.hour}:${p.minute}`;
}

function todayLine(): string {
  const p = beijingParts(new Date());
  const dow = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day))).getUTCDay();
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][dow] ?? "";
  return `${p.year} 年 ${p.month} 月 ${p.day} 日 · 星期${weekday}`;
}

function BookmarkButton({ item }: { item: NewsItem }) {
  const queryClient = useQueryClient();
  const bookmarks = useQuery({ queryKey: ["bookmarks"], queryFn: () => api.getBookmarks({}) });
  const saved = (bookmarks.data?.bookmarks ?? []).some((b) => b.url === item.url);
  const toggle = useMutation({
    mutationFn: async () =>
      await api.toggleBookmark({
        title: item.title,
        url: item.url,
        source: item.source,
        publishedAt: item.publishedAt,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["bookmarks"] }),
    onError: () => {},
  });
  return (
    <button
      type="button"
      aria-label={saved ? `取消收藏：${item.title}` : `收藏：${item.title}`}
      onClick={() => toggle.mutate()}
      className={`shrink-0 px-2 text-lg leading-none ${saved ? "text-[var(--accent)]" : "text-[var(--dim)]"}`}
    >
      {saved ? "★" : "☆"}
    </button>
  );
}

/** Restrained "ignore" button: hides the item everywhere at once (optimistic,
 * with rollback on failure) and reports it for the undo toast. */
function DismissButton({ item }: { item: { url?: string | null; title: string; source?: string } }) {
  const queryClient = useQueryClient();
  const notifyDismissed = useContext(DismissNotifyContext);
  const itemKey = itemKeyFor(item);
  const dismiss = useMutation({
    mutationFn: async () => await api.dismissItem({ itemKey, title: item.title }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["dismissed"] });
      const prev = queryClient.getQueryData<ApiResponse<typeof api, "getDismissed">>(["dismissed"]);
      queryClient.setQueryData<ApiResponse<typeof api, "getDismissed">>(["dismissed"], {
        items: [...(prev?.items ?? []), { itemKey, title: item.title, dismissedAt: new Date().toISOString() }],
      });
      return { prev };
    },
    onError: (_err, _vars, context) => {
      if (context) queryClient.setQueryData(["dismissed"], context.prev);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dismissed"] });
      notifyDismissed({ itemKey, title: item.title });
    },
  });
  return (
    <button
      type="button"
      aria-label={`忽略：${item.title}`}
      onClick={() => dismiss.mutate()}
      className="shrink-0 px-1 text-sm leading-none text-[var(--dim)]"
    >
      ✕
    </button>
  );
}

function ViewOriginalButton({ url, label = "查看原文" }: { url: string; label?: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-block rounded-full bg-[var(--text)] px-4 py-1.5 text-sm font-semibold text-[var(--bg)]"
    >
      {label} ↗
    </a>
  );
}

function CopyTitleButton({ title }: { title: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(title);
      setCopied(true);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = title;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopied(true);
      } catch {
        setCopied(false);
      }
      document.body.removeChild(ta);
    }
    window.setTimeout(() => setCopied(false), 2000);
  }
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`复制标题：${title}`}
      className="rounded-full border border-[var(--border)] px-4 text-sm font-medium text-[var(--text)]"
    >
      {copied ? "已复制 ✓" : "复制标题"}
    </button>
  );
}

function LoginNote() {
  return <span className="text-xs text-[var(--dim)]">该来源可能需要登录/订阅</span>;
}

/** Label for an original confirmed (by the user, from inside China) to be unreachable from mainland China. */
function BlockedBadge() {
  return (
    <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 text-xs font-medium text-white">中国境内打不开</span>
  );
}

/** Expanded in-page reading panel for a news/feed row: Chinese points from the RSS summary only. */
function ItemDetail({ item }: { item: NewsItem }) {
  const detail = useQuery({
    queryKey: ["detail", item.url],
    queryFn: () => api.getItemDetail({ url: item.url, title: item.title, source: item.source, summary: item.summary }),
    enabled: !!item.url,
  });
  // Linkless item (a world story whose Google News relay token could not be
  // resolved to the publisher): no detail lookup is possible — keep only
  // the source's own summary plus a 复制标题 button, never a relay link.
  if (!item.url) {
    return (
      <div className="mt-2 rounded-[var(--radius)] bg-[var(--space-surface-alt)] p-3">
        {item.summary ? (
          <p className="text-sm leading-relaxed text-[var(--dim)]">{item.summary}</p>
        ) : (
          <>
            <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs font-medium text-[var(--dim)]">仅有标题</span>
            <p className="mt-2 text-sm leading-relaxed text-[var(--dim)]">这条暂时只有标题，没有拿到公开摘要，所以不猜正文。</p>
          </>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <CopyTitleButton title={item.title} />
          <span className="text-xs text-[var(--dim)]">原文直达链接暂时确认不了，可复制标题去搜索原文</span>
        </div>
      </div>
    );
  }
  if (detail.isPending) {
    return <p className="mt-2 pl-1 text-sm text-[var(--dim)]">正在整理要点…</p>;
  }
  const d = detail.data;
  const linkRow = d ? (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {d.blockedReason ? (
        <>
          <BlockedBadge />
          <CopyTitleButton title={item.title} />
          <span className="text-xs text-[var(--dim)]">
            {d.blockedReason}，原文在中国境内打不开，页内只保留摘要；可复制标题去搜索。
          </span>
        </>
      ) : d.readUrl ? (
        <>
          <ViewOriginalButton url={d.readUrl} />
          {d.needsLogin ? <LoginNote /> : null}
        </>
      ) : (
        <>
          <CopyTitleButton title={item.title} />
          <span className="text-xs text-[var(--dim)]">原文直达链接暂时确认不了，可复制标题去搜索原文</span>
        </>
      )}
    </div>
  ) : null;
  if (!d || d.titleOnly) {
    return (
      <div className="mt-2 rounded-[var(--radius)] bg-[var(--space-surface-alt)] p-3">
        <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs font-medium text-[var(--dim)]">仅有标题</span>
        <p className="mt-2 text-sm leading-relaxed text-[var(--dim)]">这条暂时只有标题，没有拿到公开摘要，所以不猜正文。</p>
        {linkRow}
      </div>
    );
  }
  return (
    <div className="mt-2 rounded-[var(--radius)] bg-[var(--space-surface-alt)] p-3">
      {d.introZh ? <p className="text-sm font-medium leading-relaxed text-[var(--text)]">{d.introZh}</p> : null}
      {d.points.length > 0 ? (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-[var(--dim)]">
          {d.points.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      ) : null}
      <p className="mt-2 text-xs text-[var(--dim)]">要点来自该条的公开 RSS 摘要整理 · 来源：{item.source}</p>
      {linkRow}
    </div>
  );
}

function ArticleRow({ item, relevance }: { item: NewsItem; relevance?: string }) {
  const [open, setOpen] = useState(false);
  const lastSeenAt = useContext(LastSeenContext);
  const isNew = isNewItem(item.publishedAt, lastSeenAt);
  return (
    <li className="border-b border-[var(--border)] py-3">
      <div className="flex items-start gap-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`${open ? "收起" : "展开"}：${item.title}`}
          className="min-w-0 flex-1 text-left"
        >
          <p className="font-headline text-[17px] font-bold leading-snug text-[var(--text)]">
            {item.title} {isNew ? <NewBadge /> : null}
          </p>
          {relevance ? (
            <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
              <span className="font-medium text-[var(--text)]">和我有什么关系：</span>
              {relevance}
            </p>
          ) : null}
          <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-xs text-[var(--dim)]">
            <span className="font-medium text-[var(--text)]">{item.source}</span>
            {item.publishedAt ? (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  发布于 {formatPubTime(item.publishedAt)} · {relativeTime(item.publishedAt)}
                </span>
              </>
            ) : null}
            <span aria-hidden="true">·</span>
            <span className="text-[var(--accent)]">{open ? "收起 ▴" : "展开看要点 ▾"}</span>
          </p>
        </button>
        {item.url ? <BookmarkButton item={item} /> : null}
        <DismissButton item={item} />
      </div>
      {open ? <ItemDetail item={item} /> : null}
    </li>
  );
}

function LearningRow({ item }: { item: LearningItem }) {
  const [open, setOpen] = useState(false);
  const lastSeenAt = useContext(LastSeenContext);
  const isNew = isNewItem(item.publishedAt, lastSeenAt);
  const catLabel = LEARNING_CATEGORIES.find((c) => c.id === item.category)?.label ?? "";
  const left = item.deadline ? daysUntil(item.deadline) : null;
  const urgent = left !== null && left >= 0 && left <= 7;
  return (
    <li className="border-b border-[var(--border)] py-3">
      <div className="flex items-start gap-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`${open ? "收起" : "展开"}：${item.title}`}
          className="min-w-0 flex-1 text-left"
        >
          <p className="font-headline text-[17px] font-bold leading-snug text-[var(--text)]">
            {item.title} {isNew ? <NewBadge /> : null}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
            <span className="font-medium text-[var(--text)]">和我有什么关系：</span>
            {item.relevance}
          </p>
          {item.startHint ? (
            <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
              <span className="font-medium text-[var(--text)]">从哪开始：</span>
              {item.startHint}
            </p>
          ) : null}
          <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--dim)]">
            <span className="rounded-full border border-[var(--border)] px-2 py-0.5 font-medium text-[var(--text)]">{catLabel}</span>
            {item.aiTopic ? (
              <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 font-medium text-white">AI 学习</span>
            ) : null}
            {!item.titleOnly && item.enrichState === "new" ? (
              <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 font-medium text-white">本次新整理</span>
            ) : !item.titleOnly && item.enrichState === "stored" ? (
              <span className="rounded-full bg-[var(--space-surface-alt)] px-2 py-0.5 font-medium text-[var(--text)]">已整理</span>
            ) : !item.titleOnly ? (
              <span className="rounded-full border border-[var(--border)] px-2 py-0.5 font-medium text-[var(--dim)]">原文展示</span>
            ) : null}
            <span className="font-medium text-[var(--text)]">{item.source}</span>
            {item.publishedAt ? (
              <span>
                · 发布于 {formatDateOnly(item.publishedAt)} · {relativeTime(item.publishedAt)}
              </span>
            ) : null}
            {item.titleOnly ? (
              <span className="rounded-full border border-[var(--border)] px-2 py-0.5 font-medium text-[var(--dim)]">仅有标题</span>
            ) : null}
            {item.blockedReason ? <BlockedBadge /> : null}
            <span className="text-[var(--accent)]">· {open ? "收起 ▴" : "展开看要点 ▾"}</span>
          </p>
          <p className="mt-1.5 flex flex-wrap gap-1.5 text-xs">
            <span className="rounded-full bg-[var(--space-surface-alt)] px-2 py-0.5 text-[var(--text)]">
              学段：{item.audienceStage ?? "未公布"}
            </span>
            <span className="rounded-full bg-[var(--space-surface-alt)] px-2 py-0.5 text-[var(--text)]">
              费用：{item.fee ?? "未公布"}
            </span>
            {item.needsApplication ? (
              item.deadline ? (
                left !== null && left < 0 ? (
                  <span className="rounded-full bg-[var(--space-surface-alt)] px-2 py-0.5 font-medium text-[var(--dim)]">
                    已截止：{formatDateOnly(item.deadline)}
                  </span>
                ) : (
                  <span
                    className={`rounded-full px-2 py-0.5 font-medium ${
                      urgent ? "bg-[var(--accent)] text-white" : "bg-[var(--space-surface-alt)] text-[var(--text)]"
                    }`}
                  >
                    截止：{formatDateOnly(item.deadline)}
                    {left !== null && left >= 0 ? `（还剩 ${left} 天）` : ""}
                  </span>
                )
              ) : (
                <span className="rounded-full bg-[var(--space-surface-alt)] px-2 py-0.5 text-[var(--text)]">截止：未公布</span>
              )
            ) : null}
          </p>
        </button>
        <BookmarkButton
          item={{
            title: item.title,
            url: item.url,
            source: item.source,
            publishedAt: item.publishedAt,
            summary: item.summaryZh,
          }}
        />
        <DismissButton item={item} />
      </div>
      {open ? (
        <div className="mt-2 rounded-[var(--radius)] bg-[var(--space-surface-alt)] p-3">
          {item.titleOnly ? (
            <>
              <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs font-medium text-[var(--dim)]">仅有标题</span>
              <p className="mt-2 text-sm leading-relaxed text-[var(--dim)]">
                {item.blockedReason
                  ? "这条暂时只有标题，没有拿到公开摘要，所以不猜正文；而且原文站在中国境内打不开，下面只保留标题。"
                  : "这条暂时只有标题，没有拿到公开摘要，所以不猜正文。想看详情，点下面的「查看原文」。"}
              </p>
            </>
          ) : item.points.length > 0 ? (
            <>
              <p className="text-xs font-semibold text-[var(--text)]">要点（来自公开摘要）</p>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm leading-relaxed text-[var(--dim)]">
                {item.points.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </>
          ) : item.summaryZh ? (
            <p className="text-sm leading-relaxed text-[var(--dim)]">{item.summaryZh}</p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {item.officialUrl ? <ViewOriginalButton url={item.officialUrl} label="官方入口" /> : null}
            {item.readUrl && item.readUrl !== item.officialUrl && !item.blockedReason ? (
              <ViewOriginalButton url={item.readUrl} />
            ) : null}
            {item.blockedReason ? (
              <>
                <BlockedBadge />
                <CopyTitleButton title={item.title} />
                <span className="text-xs text-[var(--dim)]">
                  原文（{item.source}）{item.blockedReason}，在中国境内打不开，页内只保留中文摘要
                  {item.officialUrl ? "；可从上面的官方入口查看" : ""}。
                </span>
              </>
            ) : null}
            {!item.readUrl ? <CopyTitleButton title={item.title} /> : null}
            {item.chineseUrl ? <ViewOriginalButton url={item.chineseUrl} label="中文版" /> : null}
            {item.needsLogin ? <LoginNote /> : null}
            {!item.officialUrl && item.readUrl && !item.blockedReason ? (
              <span className="text-xs text-[var(--dim)]">官方入口未确认</span>
            ) : null}
            {!item.readUrl ? <span className="text-xs text-[var(--dim)]">原文直达链接暂时确认不了，可复制标题去搜索</span> : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

function DeadlineAlerts({ deadlines }: { deadlines: LearningItem[] }) {
  if (deadlines.length === 0) return null;
  return (
    <div className="rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--space-surface-alt)] p-4" role="note" aria-label="快截止提醒">
      <p className="font-headline text-base font-bold text-[var(--accent)]">⏰ 快截止 · 别错过报名</p>
      <ul className="mt-2 space-y-2">
        {deadlines.map((it) => {
          const left = it.deadline ? daysUntil(it.deadline) : null;
          // A China-blocked original is never used as the link; fall back to
          // the official entry, or render the title as plain text.
          const href = it.officialUrl ?? (it.blockedReason ? null : it.readUrl ?? it.url);
          return (
            <li key={it.url} className="text-sm">
              {href ? (
                <a href={href} target="_blank" rel="noreferrer" className="font-medium text-[var(--text)] underline decoration-[var(--accent)] underline-offset-2">
                  {it.title}
                </a>
              ) : (
                <span className="font-medium text-[var(--text)]">{it.title}</span>
              )}
              <span className="text-[var(--dim)]">
                {" "}· {it.deadline ? formatDateOnly(it.deadline) : ""}截止
                {left !== null && left >= 0 ? `，还剩 ${left} 天` : ""}
                {it.audienceStage ? ` · 学段：${it.audienceStage}` : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type LearningTopic = "all" | "ai" | "english" | "math" | "politics" | "it";

type LearningItemLike = { aiTopic?: boolean; englishTopic?: boolean; mathTopic?: boolean; politicsTopic?: boolean; itTopic?: boolean };

function matchesTopic(item: LearningItemLike, topic: LearningTopic): boolean {
  if (topic === "all") return true;
  if (topic === "ai") return item.aiTopic === true;
  if (topic === "english") return item.englishTopic === true;
  if (topic === "politics") return item.politicsTopic === true;
  if (topic === "it") return item.itTopic === true;
  return item.mathTopic === true;
}

function LearningTopicFilter({
  topic,
  onChange,
}: {
  topic: LearningTopic;
  onChange: (t: LearningTopic) => void;
}) {
  const chips: Array<{ id: LearningTopic; label: string }> = [
    { id: "all", label: "全部话题" },
    { id: "ai", label: "AI 学习" },
    { id: "english", label: "英语" },
    { id: "math", label: "高等数学" },
    { id: "politics", label: "政治" },
    { id: "it", label: "信息技术" },
  ];
  return (
    <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="学习话题筛选">
      {chips.map((c) => (
        <button
          key={c.id}
          type="button"
          role="tab"
          aria-selected={topic === c.id}
          onClick={() => onChange(c.id)}
          className={`rounded-full px-3.5 text-sm ${
            topic === c.id
              ? "bg-[var(--accent)] font-semibold text-white"
              : "border border-[var(--border)] text-[var(--text)]"
          }`}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

function AiLearningNote() {
  return (
    <div className="mt-3 rounded-[var(--radius)] bg-[var(--space-surface-alt)] p-3 text-sm leading-relaxed text-[var(--dim)]" role="note" aria-label="AI 学习筛选说明">
      <p>
        <span className="font-medium text-[var(--text)]">先说清楚：</span>
        没有找到一门专门讲「用 AI 解读安全日志 / 核查模型回答是否正确」的免费中文课程，这 7 门不冒充有。正确的使用顺序是：先学 Python 基础（第 6 门《Python编程基础与项目实践》）→ 再用 DeepSeek / 生成式课程学核查方法（第 5 门第 3 讲、第 4 门第 5 章 5.9「代码生成与优化」）→ 最后用北理工安全课学安全体系（第 7 门第 6、8 章）。7 门全部免费学习、需免费注册，仅认证证书付费。
      </p>
      <p className="mt-2">
        <span className="font-medium text-[var(--text)]">复核记录：</span>
        Coursera 博客《Introducing AI Series on Coursera》背后是 Coursera Plus 付费订阅（$49/月，7 天试用要先绑支付信息，属限时试听），没有指向某一门可直接进入、免费、带中文字幕的具体课程，且系列面向已有本领域工作经验的在职专业人士、不适合专科在读入门。已从「随时可学」和「AI 学习」中移除该博客，因为它没有提供已核实可免费学习的具体课程入口。吴恩达《AI for Everyone》仅有 B 站非官方搬运合集，正版 Coursera 页未能核实到免费旁听入口与中文字幕说明，本次也不纳入。
      </p>
    </div>
  );
}

function EnglishTopicNote() {
  return (
    <div className="mt-3 rounded-[var(--radius)] bg-[var(--space-surface-alt)] p-3 text-sm leading-relaxed text-[var(--dim)]" role="note" aria-label="英语筛选说明">
      <p>
        英语分<span className="font-medium text-[var(--text)]">专升本英语</span>和<span className="font-medium text-[var(--text)]">日常英语</span>两个方向。按江西 2026 年考试说明（往年参考，2028 版尚未发布），专升本英语考词汇与结构、阅读理解、完形填空、段落翻译和写作，<span className="font-medium text-[var(--text)]">不考听力和口语</span>——听力口语资源只归日常英语，不标为对齐考试。目前带此筛选的有 5 门对齐考试的专升本英语课（河南科大《大学英语（四）》、长安《大学英语读写（一）》、新通用大学英语（一）、南京大学《大学英语学术阅读与写作》与《英汉互译方法与技巧》）和 2 门日常英语课（国防科大《大学英语（口语）》、集美《英语听力技能与实践》）；这 5 门专升本英语课按平台免费口径上架（平台课程学习免费，仅认证证书付费；课程页未写‘免费’二字），每张卡片都如实标注。
      </p>
    </div>
  );
}

function MathTopicNote() {
  return (
    <div className="mt-3 rounded-[var(--radius)] bg-[var(--space-surface-alt)] p-3 text-sm leading-relaxed text-[var(--dim)]" role="note" aria-label="高等数学筛选说明">
      <p>
        高数按江西《高等数学及其应用》考试说明的官方顺序共 <span className="font-medium text-[var(--text)]">6 个阶段</span>：函数、极限和连续 → 一元函数微分学 → 一元函数积分学 → 常微分方程 → 多元函数微分学 → 二重积分。江苏农林《高等数学（一）》覆盖第 1–3 阶段，同济《高等数学（一）》覆盖第 1–2 阶段、《高等数学（二）》覆盖第 3–4 阶段，南京工大《高等数学（一）》覆盖第 1–4 阶段，《高等数学（下）》以第 5–6 阶段为主（附带第 4 阶段），可汗学院中文站覆盖全部 6 阶段；每张卡片都写了第一次打开从哪节开始。2028 年考试说明发布后再按新版调整。
      </p>
    </div>
  );
}

function PoliticsTopicNote() {
  return (
    <div className="mt-3 rounded-[var(--radius)] bg-[var(--space-surface-alt)] p-3 text-sm leading-relaxed text-[var(--dim)]" role="note" aria-label="政治筛选说明">
      <p>
        政治按江西 2026 年考试说明（往年参考，2028 版尚未发布）分 <span className="font-medium text-[var(--text)]">4 个部分</span>：思想道德与法治、毛泽东思想和中国特色社会主义理论体系概论、习近平新时代中国特色社会主义思想概论、二十大/四中全会与时事政治。3 门课各管一块：首都经济贸易大学《思想道德与法治》覆盖第 1 部分全部，桂林电子科技大学《毛泽东思想和中国特色社会主义理论体系概论》覆盖第 2 部分全部（另含习概早期章节），南京大学《习近平新时代中国特色社会主义思想概论》覆盖第 3 部分全部、且是唯一明确覆盖第 4 部分的课；时事政治没有合适的免费 MOOC，未硬凑。开课状态与回放未验证的项已在每张卡片上注明。
      </p>
    </div>
  );
}

function ItTopicNote() {
  return (
    <div className="mt-3 rounded-[var(--radius)] bg-[var(--space-surface-alt)] p-3 text-sm leading-relaxed text-[var(--dim)]" role="note" aria-label="信息技术筛选说明">
      <p>
        信息技术按江西 2026 年考试说明（往年参考，2028 版尚未发布）共 <span className="font-medium text-[var(--text)]">7 个要点</span>。商丘职业技术学院《计算机应用基础》覆盖要点一、二、要点三（几乎全）、要点四部分；东北石油大学《大学计算机基础》覆盖要点一、二、四、五、七，要点三部分覆盖，<span className="font-medium text-[var(--text)]">不覆盖要点六信息安全</span>，另有数据库、数据结构、Python 超纲内容。两门教材版本都较旧（Windows 10 + Office 2016 / Windows 7），要点六需另找资料。
      </p>
    </div>
  );
}

function LearningSection({ onGoLearning }: { onGoLearning: () => void }) {
  const queryClient = useQueryClient();
  const learning = useQuery({ queryKey: ["learning"], queryFn: () => api.getLearning({ force: false }) });
  const refresh = useMutation({
    mutationFn: async () => await api.getLearning({ force: true }),
    onSuccess: (data) => {
      queryClient.setQueryData(["learning"], data);
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
    onError: () => {},
  });
  const [topic, setTopic] = useState<LearningTopic>("all");
  const dismissedKeys = useDismissedKeys();
  const allItems = (learning.data?.items ?? [])
    .filter((it) => matchesTopic(it, topic))
    .filter((it) => !dismissedKeys.has(itemKeyFor(it)));
  useReportHasNew("learning", allItems);
  const anytime = allItems.filter((it) => it.group === "anytime");
  const upcoming = allItems.filter((it) => it.group === "upcoming");
  const others = allItems.filter((it) => it.group !== "anytime" && it.group !== "upcoming");

  return (
    <section aria-label="学习栏目" className="mt-10 border-t-2 border-[var(--text)] pt-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-headline text-xl font-black text-[var(--text)]">本周学习 · 学习与实践</h3>
        <div className="flex shrink-0 items-center gap-2">
          {learning.data ? <span className="hidden text-xs text-[var(--dim)] sm:inline">更新于 {clockTime(learning.data.asOf)}</span> : null}
          <button
            type="button"
            aria-label="刷新学习栏目"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="rounded-full border border-[var(--border)] px-3 text-sm text-[var(--text)] disabled:opacity-50"
          >
            {refresh.isPending ? "刷新中…" : "刷新"}
          </button>
        </div>
      </div>
      <p className="mt-1 text-xs text-[var(--dim)]">技能竞赛、免费课程或实验、语言学习和语言考试报名 · 只保留现在还能报名、能看回放或能直接开始学的内容 · 实习岗位统一在「海外实习、工作与签证」栏，
        <button type="button" className="font-medium text-[var(--accent)]" onClick={() => document.getElementById("overseas-work")?.scrollIntoView({ behavior: "smooth" })}>点这里去看实习与岗位 →</button>
      </p>

      <LearningTopicFilter topic={topic} onChange={setTopic} />
      {topic === "ai" ? <AiLearningNote /> : null}
      {topic === "english" ? <EnglishTopicNote /> : null}
      {topic === "math" ? <MathTopicNote /> : null}
      {topic === "politics" ? <PoliticsTopicNote /> : null}
      {topic === "it" ? <ItTopicNote /> : null}

      {topic === "all" ? (
        <div className="mt-4">
          <DeadlineAlerts deadlines={(learning.data?.deadlines ?? []).filter((it) => !dismissedKeys.has(itemKeyFor(it)))} />
        </div>
      ) : null}

      {learning.isPending ? (
        <p className="py-8 text-sm text-[var(--dim)]">正在取学习资讯…</p>
      ) : (
        <>
          <div className="mt-5">
            <h4 className="font-headline text-base font-bold text-[var(--text)]">随时可学</h4>
            <p className="mt-0.5 text-xs text-[var(--dim)]">现在就能开始的免费课程、练习与讲座回放，精选在前。</p>
            {anytime.length === 0 ? (
              <p className="py-4 text-sm text-[var(--dim)]">暂时没取到可直接开始的学习资源，点刷新再试。</p>
            ) : (
              <ul>
                {anytime.map((item) => (
                  <LearningRow key={item.url} item={item} />
                ))}
              </ul>
            )}
          </div>
          <div className="mt-6">
            <h4 className="font-headline text-base font-bold text-[var(--text)]">近期可报名</h4>
            {upcoming.length === 0 ? (
              <p className="mt-1 py-2 text-sm text-[var(--dim)]">
                暂无符合条件的活动——官方明确开放报名且免费的课程或讲座出现时会显示在这里。
              </p>
            ) : (
              <ul>
                {upcoming.map((item) => (
                  <LearningRow key={item.url} item={item} />
                ))}
              </ul>
            )}
          </div>
          {others.length > 0 ? (
            <div className="mt-6">
              <h4 className="font-headline text-sm font-bold text-[var(--dim)]">其他学习机会</h4>
              <ul>
                {others.map((item) => (
                  <LearningRow key={item.url} item={item} />
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
      <button type="button" onClick={onGoLearning} className="mt-4 text-sm font-medium text-[var(--accent)]">
        查看全部学习资讯 →
      </button>
    </section>
  );
}

function LearningView() {
  const queryClient = useQueryClient();
  const learning = useQuery({ queryKey: ["learning"], queryFn: () => api.getLearning({ force: false }) });
  const refresh = useMutation({
    mutationFn: async () => await api.getLearning({ force: true }),
    onSuccess: (data) => {
      queryClient.setQueryData(["learning"], data);
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
    onError: () => {},
  });
  const [topic, setTopic] = useState<LearningTopic>("all");
  const dismissedKeys = useDismissedKeys();
  const items = (learning.data?.items ?? [])
    .filter((it) => matchesTopic(it, topic))
    .filter((it) => !dismissedKeys.has(itemKeyFor(it)));
  useReportHasNew("learning", items);
  const anytime = items.filter((it) => it.group === "anytime");
  const upcoming = items.filter((it) => it.group === "upcoming");
  const others = items.filter((it) => it.group !== "anytime" && it.group !== "upcoming");

  return (
    <section>
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-headline text-lg font-bold text-[var(--text)]">学习 · 给学生的最新消息</h3>
        <div className="flex shrink-0 items-center gap-2">
          {learning.data ? <span className="text-xs text-[var(--dim)]">更新于 {clockTime(learning.data.asOf)}</span> : null}
          <button
            type="button"
            aria-label="刷新学习栏目"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="rounded-full border border-[var(--border)] px-3 text-sm text-[var(--text)] disabled:opacity-50"
          >
            {refresh.isPending ? "刷新中…" : "刷新"}
          </button>
        </div>
      </div>
      <p className="mt-1 text-xs text-[var(--dim)]">每条一句中文说清适合谁、能学到什么，并标出学段、费用和官方入口；官方没公布的写「未公布」。需要报名的显示截止日期，已截止的会标注并不进入快截止提醒。最新发布的排在前面。</p>

      <LearningTopicFilter topic={topic} onChange={setTopic} />
      {topic === "ai" ? <AiLearningNote /> : null}
      {topic === "english" ? <EnglishTopicNote /> : null}
      {topic === "math" ? <MathTopicNote /> : null}
      {topic === "politics" ? <PoliticsTopicNote /> : null}
      {topic === "it" ? <ItTopicNote /> : null}

      {topic === "all" ? (
        <div className="mt-4">
          <DeadlineAlerts deadlines={(learning.data?.deadlines ?? []).filter((it) => !dismissedKeys.has(itemKeyFor(it)))} />
        </div>
      ) : null}

      {learning.isPending ? (
        <p className="py-8 text-sm text-[var(--dim)]">正在取学习资讯…</p>
      ) : items.length === 0 ? (
        <p className="py-8 text-sm text-[var(--dim)]">暂时没取到学习资讯，点刷新再试。</p>
      ) : (
        <>
          <div className="mt-8">
            <h4 className="font-headline border-b-2 border-[var(--text)] pb-2 text-lg font-black text-[var(--text)]">随时可学</h4>
            <p className="mt-1 text-xs text-[var(--dim)]">现在就能开始的免费课程、练习与讲座回放，精选在前；每条都写了打开后从哪一课或哪项练习开始。</p>
            {anytime.length === 0 ? (
              <p className="py-4 text-sm text-[var(--dim)]">暂时没取到可直接开始的学习资源，点刷新再试。</p>
            ) : (
              <ul>
                {anytime.map((item) => (
                  <LearningRow key={item.url} item={item} />
                ))}
              </ul>
            )}
          </div>
          <div className="mt-8">
            <h4 className="font-headline border-b-2 border-[var(--text)] pb-2 text-lg font-black text-[var(--text)]">近期可报名</h4>
            {upcoming.length === 0 ? (
              <p className="mt-1 py-2 text-sm text-[var(--dim)]">
                暂无符合条件的活动——官方明确开放报名且免费的课程或讲座出现时会显示在这里。
              </p>
            ) : (
              <ul>
                {upcoming.map((item) => (
                  <LearningRow key={item.url} item={item} />
                ))}
              </ul>
            )}
          </div>
          {others.length > 0 ? (
            <div className="mt-8">
              <h4 className="font-headline text-sm font-bold text-[var(--dim)]">其他学习机会</h4>
              <ul>
                {others.map((item) => (
                  <LearningRow key={item.url} item={item} />
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

const FITNESS_GROUPS: Array<{ id: string; label: string }> = [
  { id: "全部", label: "全部" },
  { id: "胸", label: "胸" },
  { id: "背", label: "背" },
  { id: "腿臀", label: "腿臀" },
  { id: "肩", label: "肩" },
  { id: "核心", label: "核心" },
];

function FitnessCard({ item }: { item: FitnessItem }) {
  return (
    <li className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-headline text-[17px] font-bold leading-snug text-[var(--text)]">{item.name}</span>
        <span className="rounded-full bg-[var(--space-surface-alt)] px-2 py-0.5 text-xs font-medium text-[var(--text)]">{item.group}</span>
        {item.athletePending ? (
          <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs font-medium text-[var(--dim)]">选手教学待补充</span>
        ) : null}
      </p>
      {item.instructor || item.videoTitle ? (
        <p className="mt-1.5 text-xs text-[var(--dim)]">
          {item.instructor ? <>讲解者：{item.instructor}</> : null}
          {item.instructor && item.videoTitle ? " · " : null}
          {item.videoTitle ? <>《{item.videoTitle}》</> : null}
        </p>
      ) : null}
      <dl className="mt-2 space-y-1.5 text-sm leading-relaxed">
        <div>
          <dt className="inline font-medium text-[var(--text)]">所需器械：</dt>
          <dd className="inline text-[var(--dim)]">{item.equipment}</dd>
        </div>
        <div>
          <dt className="inline font-medium text-[var(--text)]">起始姿势：</dt>
          <dd className="inline text-[var(--dim)]">{item.startPosition}</dd>
        </div>
        <div>
          <dt className="font-medium text-[var(--text)]">动作要点：</dt>
          <dd>
            <ol className="list-decimal space-y-0.5 pl-5 text-[var(--dim)]">
              {item.points.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ol>
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-[var(--text)]">常见错误：</dt>
          <dd className="inline text-[var(--dim)]">{item.commonMistake}</dd>
        </div>
      </dl>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ViewOriginalButton url={item.videoUrl} label="观看教学" />
        {item.videoNote ? <span className="text-xs text-[var(--dim)]">{item.videoNote}</span> : null}
      </div>
    </li>
  );
}

function FitnessBrowser() {
  const [group, setGroup] = useState("全部");
  const [tanOnly, setTanOnly] = useState(false);
  const q = useQuery({ queryKey: ["fitness"], queryFn: () => api.getFitness({}) });
  const all = q.data?.items ?? [];
  const tanCount = all.filter((it) => it.tanChengyi).length;
  const base = tanOnly ? all.filter((it) => it.tanChengyi) : all;
  const items = base.filter((it) => group === "全部" || it.group === group);
  return (
    <>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          aria-pressed={tanOnly}
          onClick={() => setTanOnly(!tanOnly)}
          className={`rounded-full px-3.5 text-sm ${
            tanOnly
              ? "bg-[var(--accent)] font-semibold text-white"
              : "border border-[var(--border)] text-[var(--text)]"
          }`}
        >
          只看谭成义
          {tanCount > 0 ? ` ${tanCount}` : ""}
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-2" role="tablist" aria-label="健身按部位筛选">
        {FITNESS_GROUPS.map((g) => {
          const count = g.id === "全部" ? base.length : base.filter((it) => it.group === g.id).length;
          return (
            <button
              key={g.id}
              type="button"
              role="tab"
              aria-selected={group === g.id}
              onClick={() => setGroup(g.id)}
              className={`rounded-full px-3.5 text-sm ${
                group === g.id
                  ? "bg-[var(--accent)] font-semibold text-white"
                  : "border border-[var(--border)] text-[var(--text)]"
              }`}
            >
              {g.label}
              {count > 0 ? ` ${count}` : ""}
            </button>
          );
        })}
      </div>
      {q.isPending ? (
        <p className="py-6 text-sm text-[var(--dim)]">正在取动作教学…</p>
      ) : items.length === 0 ? (
        <p className="py-6 text-sm text-[var(--dim)]">这个部位暂时没有动作，换个部位看看。</p>
      ) : (
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {items.map((item) => (
            <FitnessCard key={item.name} item={item} />
          ))}
        </ul>
      )}
    </>
  );
}

function FitnessSection() {
  return (
    <section aria-label="健身栏目" className="mt-10 border-t-2 border-[var(--text)] pt-5">
      <h3 className="font-headline text-xl font-black text-[var(--text)]">健身 · 动作教学</h3>
      <p className="mt-1 text-xs text-[var(--dim)]">
        只做动作教学：选一个动作，看懂起始姿势和要点，再打开示范视频跟着练。徒手与常见健身房器械，示范均为免费中文讲解视频。B 站播放时可能弹出登录框，关掉即可继续观看，无需登录，视频免费。
      </p>
      <FitnessBrowser />
    </section>
  );
}

function FitnessView() {
  return (
    <section>
      <h3 className="font-headline text-lg font-bold text-[var(--text)]">健身 · 动作教学</h3>
      <p className="mt-1 text-xs text-[var(--dim)]">
        只做动作教学，没有训练计划和打卡：按部位选一个动作，看懂怎么做，再打开示范视频开始练习。每张卡只放跟练要用的内容：器械、起始姿势、动作要点、常见错误和示范链接，另有讲解者与视频标题。B 站播放时可能弹出登录框，关掉即可继续观看，无需登录，视频免费。
      </p>
      <FitnessBrowser />
    </section>
  );
}

function JiangxiRow({ item }: { item: JiangxiItem }) {
  const [open, setOpen] = useState(false);
  const lastSeenAt = useContext(LastSeenContext);
  const isNew = isNewItem(item.publishedAt, lastSeenAt);
  return (
    <li className="border-b border-[var(--border)] py-3">
      <div className="flex items-start gap-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${open ? "收起" : "展开"}：${item.title}`}
        className="min-w-0 flex-1 text-left"
      >
        <p className="font-headline text-[17px] font-bold leading-snug text-[var(--text)]">
          {item.title} {isNew ? <NewBadge /> : null}
        </p>
        {item.summaryZh ? <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">{item.summaryZh}</p> : null}
        <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--dim)]">
          <span className="rounded-full border border-[var(--border)] px-2 py-0.5 font-medium text-[var(--text)]">{item.tag}</span>
          {item.docKind ? (
            <span className="rounded-full bg-[var(--space-surface-alt)] px-2 py-0.5 font-medium text-[var(--text)]">{item.docKind}</span>
          ) : null}
          <span className="rounded-full bg-[var(--space-surface-alt)] px-2 py-0.5 text-[var(--text)]">
            适用年份：{item.applicableYear ?? "未注明"}
          </span>
          {item.noticeKind === "formal2028" ? (
            <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 font-medium text-white">2028 届正式通知</span>
          ) : item.noticeKind === "reference" ? (
            <span className="rounded-full bg-[var(--space-surface-alt)] px-2 py-0.5 font-medium text-[var(--dim)]">往年备考参考</span>
          ) : (
            <span className="rounded-full border border-[var(--border)] px-2 py-0.5 font-medium text-[var(--dim)]">尚待确认的动态</span>
          )}
          {item.canApplyMajor === true ? (
            <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 font-medium text-white">按正式专业对照：我的专业可报考</span>
          ) : item.canApplyMajor === false ? (
            <span className="rounded-full bg-[var(--space-surface-alt)] px-2 py-0.5 font-medium text-[var(--dim)]">按正式专业对照：我的专业不可报考</span>
          ) : null}
          {item.official ? (
            <span className="rounded-full bg-[var(--space-surface-alt)] px-2 py-0.5 text-[var(--text)]">官方来源</span>
          ) : item.repost ? (
            <span className="rounded-full border border-[var(--border)] px-2 py-0.5 font-medium text-[var(--dim)]">转载</span>
          ) : null}
          <span className="font-medium text-[var(--text)]">{item.source}</span>
          {item.publishedAt ? <span>· 发布于 {formatDateOnly(item.publishedAt)}</span> : null}
          {item.titleOnly ? (
            <span className="rounded-full border border-[var(--border)] px-2 py-0.5 font-medium text-[var(--dim)]">仅有标题</span>
          ) : null}
          <span className="text-[var(--accent)]">· {open ? "收起 ▴" : "展开看要点 ▾"}</span>
        </p>
        <p className="mt-1.5 text-sm leading-relaxed text-[var(--dim)]">
          <span className="font-medium text-[var(--text)]">和我有什么关系：</span>
          {item.relevance}
        </p>
        <p className="mt-0.5 text-sm leading-relaxed text-[var(--dim)]">
          <span className="font-medium text-[var(--text)]">我需要做什么：</span>
          {item.actionNeeded}
        </p>
      </button>
      <DismissButton item={item} />
      </div>
      {open ? (
        <div className="mt-2 rounded-[var(--radius)] bg-[var(--space-surface-alt)] p-3">
          {item.titleOnly ? (
            <p className="text-sm leading-relaxed text-[var(--dim)]">这条暂时只有标题，没有拿到公开摘要，所以不猜正文。点「查看原文」看官方原文。</p>
          ) : item.points.length > 0 ? (
            <>
              <p className="text-xs font-semibold text-[var(--text)]">要点（来自公开摘要）</p>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm leading-relaxed text-[var(--dim)]">
                {item.points.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {item.readUrl ? (
              <ViewOriginalButton url={item.readUrl} label="查看通知页" />
            ) : (
              <CopyTitleButton title={item.title} />
            )}
            {item.attachmentUrl ? <ViewOriginalButton url={item.attachmentUrl} label="官方附件" /> : null}
            {item.needsLogin ? <LoginNote /> : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

function JiangxiSection() {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ["jiangxi"], queryFn: () => api.getJiangxi({ force: false }) });
  const refresh = useMutation({
    mutationFn: async () => await api.getJiangxi({ force: true }),
    onSuccess: (data) => {
      queryClient.setQueryData(["jiangxi"], data);
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
    onError: () => {},
  });
  const dismissedKeys = useDismissedKeys();
  const items = (q.data?.items ?? []).filter((it) => !dismissedKeys.has(itemKeyFor(it)));
  const archive = (q.data?.archive ?? []).filter((it) => !dismissedKeys.has(itemKeyFor(it)));
  useReportHasNew("jiangxi", [...items, ...archive]);
  const current = items.filter((it) => !it.isReference);
  const reference = items.filter((it) => it.isReference).slice(0, 8);
  return (
    <section aria-label="江西专升本" className="border-t-2 border-[var(--text)] pt-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-headline text-xl font-black text-[var(--text)]">江西专升本</h3>
        <div className="flex shrink-0 items-center gap-2">
          {q.data ? <span className="hidden text-xs text-[var(--dim)] sm:inline">更新于 {clockTime(q.data.asOf)}</span> : null}
          <button
            type="button"
            aria-label="刷新江西专升本"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="rounded-full border border-[var(--border)] px-3 text-sm text-[var(--text)] disabled:opacity-50"
          >
            {refresh.isPending ? "刷新中…" : "刷新"}
          </button>
        </div>
      </div>
      <p className="mt-1 text-xs text-[var(--dim)]">
        为信息安全技术应用专业、2028 年毕业的你固定置顶 · 本栏只展示两个官网发布的原文：江西省教育考试院 www.jxeea.cn（站内「专升本考试」栏目）与江西省教育厅 jyt.jiangxi.gov.cn · 转载文章即使引用了官方通知也不收录，找不到官网原文就跳过
      </p>
      {(q.data?.pending ?? []).length > 0 ? (
        <ul className="mt-3 space-y-1.5" aria-label="2028年待公布事项">
          {(q.data?.pending ?? []).map((p) => (
            <li key={p.label} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-[var(--text)]">{p.label}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  p.status === "待公布" ? "bg-[var(--space-surface-alt)] text-[var(--dim)]" : "bg-[var(--accent)] text-white"
                }`}
              >
                {p.status}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {q.isPending ? (
        <p className="py-6 text-sm text-[var(--dim)]">正在取专升本通知…</p>
      ) : items.length === 0 ? (
        <div className="py-6">
          <p className="text-sm font-medium text-[var(--text)]">暂无新的官方公告</p>
          <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
            本栏只收江西省教育考试院与江西省教育厅官网的原文，转载不收录；有新公告时会出现在这里。2028 年的报名、考试科目、专业对照和招生简章公布后也会出现在这里，下面的往年官方备考资料可先作参考。
          </p>
        </div>
      ) : (
        <>
          {current.length > 0 ? (
            <ul>
              {current.map((item) => (
                <JiangxiRow key={item.url} item={item} />
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-[var(--dim)]">还没有 2028 年的正式通知，下面的往年材料先作备考参考。</p>
          )}
          {reference.length > 0 ? (
            <div className="mt-5">
              <h4 className="font-headline text-base font-bold text-[var(--text)]">备考参考（往年材料）</h4>
              <ul>
                {reference.map((item) => (
                  <JiangxiRow key={item.url} item={item} />
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
      {archive.length > 0 ? (
        <div className="mt-5">
          <h4 className="font-headline text-base font-bold text-[var(--text)]">往年官方备考资料</h4>
          <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
            官方真题：截至 2026 年 11 月 23 日，暂未在这两个官网查到可免费下载的官方真题（已查考试院专升本栏目站内搜索、教育厅站内搜索与 5 条官方通知全文，找到的都是第三方回忆卷）。大纲样题同样没有：《考试说明》PDF 全文检索「例题」「样题」「示例」「题型示例」均为 0 命中。备考以《考试说明》的考试范围、题型与参考书目为准。
          </p>
          <ul>
            {archive.map((item) => (
              <JiangxiRow key={item.url} item={item} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function OverseasRow({ item, hideDismiss = false }: { item: OverseasItem; hideDismiss?: boolean }) {
  const [open, setOpen] = useState(false);
  const lastSeenAt = useContext(LastSeenContext);
  const isNew = isNewItem(item.publishedAt, lastSeenAt);
  // Yale D/S card only (the one item carrying decisionDateLabel): its
  // effectiveWhen repeats the full body text verbatim, so in the expanded
  // view the 「政策生效」 and 「何时生效」 lines are not rendered — the
  // body stays exactly once, under 「变了什么」 — and the court-decision
  // date is not repeated inside the expanded panel (it already shows in
  // the header line above). The collapsed rendering and the underlying
  // data fields are unchanged.
  const dedupeExpanded = open && item.decisionDateLabel != null;
  // Policy effective dates are shown per matter (user rule, 2026-11-22):
  // a policy with several effective nodes (Singapore MOM: new
  // applications vs renewals) lists each node on its own line instead
  // of one crammed string. Job cards never show policy fields at all.
  const effParts = item.kind === "policy" ? (item.effectiveParts ?? []) : [];
  return (
    <li className="border-b border-[var(--border)] py-3">
      <div className="flex items-start gap-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${open ? "收起" : "展开"}：${item.title}`}
        className="min-w-0 flex-1 text-left"
      >
        <p className="font-headline text-[17px] font-bold leading-snug text-[var(--text)]">
          {item.title} {isNew ? <NewBadge /> : null}
        </p>
        <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
          <span className="font-medium text-[var(--text)]">和我有什么关系：</span>
          {item.relevance}
        </p>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--dim)]">
          <span className="rounded-full border border-[var(--border)] px-2 py-0.5 font-medium text-[var(--text)]">{item.country}</span>
          <span className="rounded-full border border-[var(--border)] px-2 py-0.5 font-medium text-[var(--text)]">{item.cardTagLabel ?? stageLabel(item)}</span>
          {item.kind === "policy" ? (
            <span className="rounded-full bg-[var(--space-surface-alt)] px-2 py-0.5 font-medium text-[var(--text)]">
              {item.cardTagLabel ? "政策 · 非岗位" : <>政策 · 非岗位{" · "}{item.policyStatusLabel ?? (item.policyStatus === "enacted" ? "已生效" : item.policyStatus === "upcoming" ? "即将生效" : item.policyStatus === "proposal" ? "提案/计划" : "生效状态未说明")}</>}
            </span>
          ) : item.kind === "job" ? (
            <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 font-medium text-white">岗位</span>
          ) : null}
          {item.visa ? (
            <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 font-medium text-white">签证{item.pinned ? " · 固定" : ""}</span>
          ) : null}
          {item.kind === "policy" ? null : item.eligibility === "diploma_eligible" ? (
            <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 font-medium text-white">专科可申请</span>
          ) : item.eligibility === "bachelor_only" ? (
            <span className="rounded-full bg-[var(--space-surface-alt)] px-2 py-0.5 font-medium text-[var(--dim)]">仅本科毕业生</span>
          ) : (
            <span className="rounded-full bg-[var(--space-surface-alt)] px-2 py-0.5 text-[var(--text)]">适用学历不明确</span>
          )}
          {item.isImmigration ? (
            <span className="rounded-full bg-[var(--space-surface-alt)] px-2 py-0.5 font-medium text-[var(--text)]">
              移民政策 · 适用身份：{item.identityLabel ?? "见原文"}
            </span>
          ) : null}
          {item.official ? (
            <span className="rounded-full bg-[var(--space-surface-alt)] px-2 py-0.5 text-[var(--text)]">大学/政府原文</span>
          ) : null}
          <span className="font-medium text-[var(--text)]">{item.source}</span>
          {item.publishedAt ? <span>· 发布于 {formatDateOnly(item.publishedAt)}</span> : null}
          {item.titleOnly ? (
            <span className="rounded-full border border-[var(--border)] px-2 py-0.5 font-medium text-[var(--dim)]">仅有标题</span>
          ) : null}
          {item.blockedReason ? <BlockedBadge /> : null}
          <span className="text-[var(--accent)]">· {open ? "收起 ▴" : item.kind === "policy" ? "展开详情 ▾" : "展开看条件 ▾"}</span>
        </p>
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[var(--dim)]">
          {item.kind === "policy" && effParts.length === 0 && !dedupeExpanded ? (
            <span>政策生效：{item.effectiveWhen ?? "未公布"}</span>
          ) : null}
          {item.decisionDateLabel ? <span className="font-medium text-[var(--text)]">{item.decisionDateLabel}</span> : null}
          {item.kind === "policy" ? null : <span>申请截止：{item.deadline ?? "未说明"}</span>}
        </p>
        {effParts.length > 0 ? (
          <div className="mt-1 space-y-0.5 text-xs text-[var(--dim)]">
            <p className="font-medium text-[var(--text)]">生效安排（按事项分开）：</p>
            {effParts.map((p) => (
              <p key={p}>· {p}</p>
            ))}
          </div>
        ) : null}
        <dl className="mt-1.5 space-y-0.5 text-sm leading-relaxed text-[var(--dim)]">
          <div>
            <dt className="inline font-medium text-[var(--text)]">变了什么：</dt>
            <dd className="inline">
              {item.whatChanged ??
                (item.titleOnly
                  ? "来源只有标题，未说明变化内容，点原文核对。"
                  : "中文摘要这次没生成出来，展开可看公开摘要，点原文核对。")}
            </dd>
          </div>
          <div>
            <dt className="inline font-medium text-[var(--text)]">适用于谁：</dt>
            <dd className="inline">{item.whoApplies ?? "来源未写明适用人群"}</dd>
          </div>
          {dedupeExpanded || item.kind === "job" || effParts.length > 0 ? null : (
            <div>
              <dt className="inline font-medium text-[var(--text)]">何时生效：</dt>
              <dd className="inline">{item.effectiveWhen ?? "未公布"}</dd>
            </div>
          )}
        </dl>
      </button>
      {hideDismiss ? null : <DismissButton item={item} />}
      </div>
      {open ? (
        <div className="mt-2 rounded-[var(--radius)] bg-[var(--space-surface-alt)] p-3">
          {item.titleOnly ? (
            <p className="text-sm leading-relaxed text-[var(--dim)]">
              {item.blockedReason
                ? "这条暂时只有标题，没有拿到公开摘要，所以不猜正文；而且原文站在中国境内打不开，下面只保留标题。"
                : "这条暂时只有标题，没有拿到公开摘要，所以不猜正文。点「查看原文」看大学或政府原文。"}
            </p>
          ) : item.points.length > 0 ? (
            <>
              <p className="text-xs font-semibold text-[var(--text)]">要点（来自公开摘要）</p>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm leading-relaxed text-[var(--dim)]">
                {item.points.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </>
          ) : null}
          <dl className="mt-3 space-y-1 border-t border-[var(--border)] pt-2 text-sm leading-relaxed text-[var(--dim)]">
            {item.category === "study" && item.kind !== "policy" ? (
              <>
                <div><dt className="inline font-medium text-[var(--text)]">专业匹配：</dt><dd className="inline">{item.majorMatch ?? "未说明"}</dd></div>
                <div><dt className="inline font-medium text-[var(--text)]">语言要求：</dt><dd className="inline">{item.languageReq ?? "未说明"}</dd></div>
                <div><dt className="inline font-medium text-[var(--text)]">学费：</dt><dd className="inline">{item.tuition ?? "未说明（暂不按价格过滤，先展示）"}</dd></div>
                <div><dt className="inline font-medium text-[var(--text)]">预计生活费：</dt><dd className="inline">{item.livingCost ?? "未说明"}</dd></div>
                <div><dt className="inline font-medium text-[var(--text)]">奖学金：</dt><dd className="inline">{item.scholarship ?? "未说明"}</dd></div>
              </>
            ) : item.kind === "job" ? (
              <>
                <div><dt className="inline font-medium text-[var(--text)]">工作地点：</dt><dd className="inline">{item.location ?? item.country}</dd></div>
                <div><dt className="inline font-medium text-[var(--text)]">能否在中国境内远程参加：</dt><dd className="inline">{item.remoteFromChina === true ? "可以" : item.remoteFromChina === false ? "不可以" : "未说明"}</dd></div>
                <div><dt className="inline font-medium text-[var(--text)]">学历要求：</dt><dd className="inline">{item.eduReq ?? "未说明"}</dd></div>
                <div><dt className="inline font-medium text-[var(--text)]">经验要求：</dt><dd className="inline">{item.expReq ?? "未说明"}</dd></div>
                <div><dt className="inline font-medium text-[var(--text)]">是否接受境外申请：</dt><dd className="inline">{item.acceptsOverseas === true ? "接受" : item.acceptsOverseas === false ? "不接受" : "未说明"}</dd></div>
                <div><dt className="inline font-medium text-[var(--text)]">签证支持：</dt><dd className="inline">{item.visaSupport === "yes" ? "雇主明确提供" : item.visaSupport === "no" ? "雇主明确不提供" : "未说明"}</dd></div>
              </>
            ) : item.kind === "policy" ? (
              <>
                <div><dt className="inline font-medium text-[var(--text)]">适用身份：</dt><dd className="inline">{item.identityLabel ?? item.whoApplies ?? "见原文"}</dd></div>
                {effParts.length > 0 ? (
                  <div>
                    <dt className="font-medium text-[var(--text)]">生效安排：</dt>
                    <dd>
                      {effParts.map((p) => (
                        <span key={p} className="block">{p}</span>
                      ))}
                    </dd>
                  </div>
                ) : null}
                <div><dt className="inline font-medium text-[var(--text)]">状态：</dt><dd className="inline">{item.policyStatusLabel ?? (item.policyStatus === "enacted" ? "已生效" : item.policyStatus === "upcoming" ? "即将生效（尚未到生效日）" : item.policyStatus === "proposal" ? "提案/计划，尚未生效" : "未说明是提案还是已生效")}</dd></div>
                <div><dt className="inline font-medium text-[var(--text)]">说明：</dt><dd className="inline">这是政府政策，不是招聘岗位，不能按「岗位可申请」理解。</dd></div>
              </>
            ) : null}
          </dl>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {item.blockedReason ? (
              <>
                <BlockedBadge />
                <CopyTitleButton title={item.title} />
                <span className="text-xs text-[var(--dim)]">
                  原文（{item.source}）{item.blockedReason}，在中国境内打不开，页内只保留中文摘要。
                </span>
              </>
            ) : item.readUrl ? (
              <ViewOriginalButton url={item.readUrl} label={item.official ? "官方原文" : "查看原文"} />
            ) : (
              <CopyTitleButton title={item.title} />
            )}
            {item.needsLogin ? <LoginNote /> : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

function OverseasCategorySection({ category }: { category: "study" | "work_visa" }) {
  const [country, setCountry] = useState<string>("全部国家");
  const [stage, setStage] = useState<string>("全部阶段");
  const [showBachelorOnly, setShowBachelorOnly] = useState(false);
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ["overseas"], queryFn: () => api.getOverseas({ force: false }) });
  const refresh = useMutation({
    mutationFn: async () => await api.getOverseas({ force: true }),
    onSuccess: (data) => {
      queryClient.setQueryData(["overseas"], data);
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
    onError: () => {},
  });
  const isStudy = category === "study";
  const stages = isStudy ? STUDY_STAGES : WORK_STAGES;
  const dismissedKeys = useDismissedKeys();
  const items = (q.data?.items ?? [])
    .filter((it) => it.category === category)
    .filter((it) => !dismissedKeys.has(itemKeyFor(it)));
  useReportHasNew(isStudy ? "overseas-study" : "overseas-work", items);
  // Fixed visa zone lives inside the work/visa category; applicability was
  // already checked server-side before pinning.
  const visaItems = isStudy ? [] : items.filter((it) => it.visa && it.pinned);
  const rotating = items.filter((it) => !(it.visa && it.pinned));
  const byBachelor = rotating.filter((it) => showBachelorOnly || it.eligibility !== "bachelor_only");
  const hiddenCount = rotating.length - rotating.filter((it) => it.eligibility !== "bachelor_only").length;
  const filtered = byBachelor.filter(
    (it) =>
      (country === "全部国家" || it.country === country) &&
      (stage === "全部阶段" || it.stage === stage || (stage === "policy" && it.kind === "policy")),
  );
  const title = isStudy ? "海外升学" : "海外实习、工作与签证";
  return (
    <section id={isStudy ? "overseas-study" : "overseas-work"} aria-label={title} className="mt-10 border-t-2 border-[var(--text)] pt-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-headline text-xl font-black text-[var(--text)]">{title}</h3>
        <div className="flex shrink-0 items-center gap-2">
          {q.data ? <span className="hidden text-xs text-[var(--dim)] sm:inline">更新于 {clockTime(q.data.asOf)}</span> : null}
          <button
            type="button"
            aria-label={`刷新${title}`}
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="rounded-full border border-[var(--border)] px-3 text-sm text-[var(--text)] disabled:opacity-50"
          >
            {refresh.isPending ? "刷新中…" : "刷新"}
          </button>
        </div>
      </div>
      <p className="mt-1 text-xs text-[var(--dim)]">
        {isStudy
          ? "覆盖提前出国、本科衔接或转学分，以及以后读硕士 · 费用保留原币并注明按年还是整个项目，预算未定所以不按价格过滤 · 点开看专业匹配、语言要求、截止日期、学费、生活费和奖学金"
          : "岗位优先信息安全、网络运维和 IT 技术支持 · 岗位与政策分开标记：政策链接官方原文，注明适用身份、生效日期和提案还是已生效，政策本身不算「岗位可申请」 · 跟踪美国、新西兰、新加坡、越南、日本、韩国、爱尔兰、英国"}
      </p>
      <div className="mt-3 flex flex-wrap gap-2" role="tablist" aria-label={`${title}按国家筛选`}>
        {["全部国家", ...OVERSEAS_COUNTRIES].map((c) => (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={country === c}
            onClick={() => setCountry(c)}
            className={`rounded-full px-3 text-sm ${country === c ? "bg-[var(--text)] font-semibold text-[var(--bg)]" : "border border-[var(--border)] text-[var(--text)]"}`}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-2" role="tablist" aria-label={`${title}按阶段筛选`}>
        {["全部阶段", ...stages.map((x) => x.label), ...(isStudy ? [] : ["签证/移民政策"])].map((label) => {
          const id = label === "全部阶段" ? "全部阶段" : label === "签证/移民政策" ? "policy" : (stages.find((x) => x.label === label)?.id ?? label);
          return (
            <button
              key={label}
              type="button"
              role="tab"
              aria-selected={stage === id}
              onClick={() => setStage(id)}
              className={`rounded-full px-3 text-sm ${stage === id ? "bg-[var(--accent)] font-semibold text-white" : "border border-[var(--border)] text-[var(--text)]"}`}
            >
              {label}
            </button>
          );
        })}
      </div>
      {q.isPending ? (
        <p className="py-6 text-sm text-[var(--dim)]">正在追踪海外消息…</p>
      ) : items.length === 0 ? (
        <p className="py-6 text-sm text-[var(--dim)]">
          {q.isError || !isStudy ? "暂时没取到这一栏的新消息，点刷新再试。" : "今天没有新的升学消息"}
        </p>
      ) : (
        <>
          {visaItems.length > 0 && country === "全部国家" && stage === "全部阶段" ? (
            <div className="mt-4">
              <h4 className="font-headline text-base font-bold text-[var(--text)]">签证新政 · 固定区</h4>
              <p className="mt-0.5 text-xs text-[var(--dim)]">
                会改变决策的学生签证与毕业后工签消息固定展示，不随每天刷新轮换；只有被更新的消息取代、过期、或确认不适用于你时才会撤下。
              </p>
              <ul>
                {visaItems.map((item) => (
                  <OverseasRow key={item.url} item={item} hideDismiss />
                ))}
              </ul>
            </div>
          ) : null}
          {filtered.length > 0 ? (
            <ul>
              {filtered.slice(0, 12).map((item) => (
                <OverseasRow key={item.url} item={item} />
              ))}
            </ul>
          ) : (
            <p className="py-6 text-sm text-[var(--dim)]">这个筛选下暂时没有条目，换个国家或阶段看看。</p>
          )}
        </>
      )}
      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setShowBachelorOnly((v) => !v)}
          aria-expanded={showBachelorOnly}
          className="mt-3 text-sm font-medium text-[var(--accent)]"
        >
          {showBachelorOnly ? "隐藏仅面向本科毕业生的项目" : `有 ${hiddenCount} 条仅面向本科毕业生的项目已默认隐藏，点这里查看`}
        </button>
      ) : null}
    </section>
  );
}

function RecentApplicableSection() {
  const q = useQuery({ queryKey: ["digest"], queryFn: () => api.getDailyDigest({ force: false }) });
  const dismissedKeys = useDismissedKeys();
  const lastSeenAt = useContext(LastSeenContext);
  const items: DigestItem[] = (q.data?.items ?? []).filter((it) => !dismissedKeys.has(itemKeyFor(it)));
  useReportHasNew("digest", items);
  return (
    <section aria-label="近期可申请" className="mt-10 border-t-2 border-[var(--text)] pt-5">
      <h3 className="font-headline text-xl font-black text-[var(--text)]">近期可申请</h3>
      <p className="mt-1 text-xs text-[var(--dim)]">最多 5 条 · 优先有明确申请对象、有效入口和截止日期的机会，官方来源优先 · 政策不算可申请，明确不适用于你的不进这里</p>
      {q.isPending ? (
        <p className="py-6 text-sm text-[var(--dim)]">正在汇总近期可申请的机会…</p>
      ) : items.length === 0 ? (
        <p className="py-6 text-sm font-medium text-[var(--text)]">暂无符合条件的新机会</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.url} className="border-b border-[var(--border)] py-3">
              <div className="flex items-start gap-1">
                <a href={item.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 font-headline text-[17px] font-bold leading-snug text-[var(--text)] underline-offset-2 hover:underline">
                  {item.title} {isNewItem(item.publishedAt, lastSeenAt) ? <NewBadge /> : null}
                </a>
                <DismissButton item={item} />
              </div>
              <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
                <span className="font-medium text-[var(--text)]">和我有什么关系：</span>
                {item.relevance}
              </p>
              <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--dim)]">
                <span className="rounded-full border border-[var(--border)] px-2 py-0.5 font-medium text-[var(--text)]">{item.categoryLabel}</span>
                {item.country ? <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[var(--text)]">{item.country}</span> : null}
                {item.official ? <span className="rounded-full bg-[var(--space-surface-alt)] px-2 py-0.5 text-[var(--text)]">官方来源</span> : null}
                <span className="font-medium text-[var(--text)]">{item.source}</span>
                {item.publishedAt ? <span>· 发布于 {formatDateOnly(item.publishedAt)}</span> : null}
                <span>· 申请截止：{item.deadline ?? "未说明"}</span>
                {item.effectiveWhen ? <span>· 生效：{item.effectiveWhen}</span> : null}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HotSection() {
  const [open, setOpen] = useState(false);
  const [sourceId, setSourceId] = useState<string>("weibo");
  const q = useQuery({ queryKey: ["hot"], queryFn: () => api.getHotLists({ force: false }), enabled: open });
  const sources: HotSource[] = q.data?.sources ?? [];
  const active = sources.find((x) => x.id === sourceId) ?? sources[0];
  return (
    <section aria-label="综合热榜" className="mt-10 border-t-2 border-[var(--text)] pt-5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-left"
      >
        <h3 className="font-headline text-xl font-black text-[var(--text)]">综合热榜</h3>
        <span className="text-sm font-medium text-[var(--accent)]">{open ? "收起 ▴" : "展开 ▾"}</span>
      </button>
      {open ? (
        q.isPending ? (
          <p className="py-6 text-sm text-[var(--dim)]">正在取热榜…</p>
        ) : sources.length === 0 ? (
          <p className="py-6 text-sm text-[var(--dim)]">热榜暂时没取到，稍后再展开试试。</p>
        ) : (
          <>
            <div className="mt-3 flex flex-wrap gap-2" role="tablist" aria-label="热榜平台">
              {sources.map((src) => (
                <button
                  key={src.id}
                  type="button"
                  role="tab"
                  aria-selected={active?.id === src.id}
                  onClick={() => setSourceId(src.id)}
                  className={`rounded-full px-3.5 text-sm ${active?.id === src.id ? "bg-[var(--text)] font-semibold text-[var(--bg)]" : "border border-[var(--border)] text-[var(--text)]"}`}
                >
                  {src.label}
                </button>
              ))}
            </div>
            {q.data ? <p className="mt-2 text-xs text-[var(--dim)]">更新于 {clockTime(q.data.asOf)} · 排名按各平台自己的顺序</p> : null}
            <ol>
              {(active?.items ?? []).map((it) => (
                <li key={`${active?.id}-${it.rank}`} className="border-b border-[var(--border)] py-2.5">
                  <a href={it.url} target="_blank" rel="noreferrer" className="flex items-baseline gap-3 text-left">
                    <span className="w-6 shrink-0 text-right font-headline text-base font-black text-[var(--accent)]">{it.rank}</span>
                    <span className="min-w-0 flex-1 text-[15px] font-medium leading-snug text-[var(--text)]">{it.title}</span>
                    {it.heat ? <span className="shrink-0 text-xs text-[var(--dim)]">{it.heat}</span> : null}
                  </a>
                </li>
              ))}
            </ol>
          </>
        )
      ) : null}
    </section>
  );
}

function WorldSection() {
  const [topic, setTopic] = useState<string>("今日精选");
  const [weeklyAll, setWeeklyAll] = useState(false);
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ["world"], queryFn: () => api.getMyWorld({ force: false }) });
  const refresh = useMutation({
    mutationFn: async () => await api.getMyWorld({ force: true }),
    onSuccess: (data) => {
      queryClient.setQueryData(["world"], data);
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
    onError: () => {},
  });
  const dismissedKeys = useDismissedKeys();
  const all = (q.data?.all ?? []).filter((it) => !dismissedKeys.has(itemKeyFor(it)));
  const daily = (q.data?.daily ?? []).filter((it) => !dismissedKeys.has(itemKeyFor(it)));
  const topics = ["今日精选", ...Array.from(new Set(all.map((it) => it.topic)))];
  const list: WorldItem[] =
    topic === "今日精选" ? daily : all.filter((it) => it.topic === topic && !it.weekly).slice(0, 10);
  const weekly = (q.data?.weekly ?? []).filter((it) => !dismissedKeys.has(itemKeyFor(it)));
  useReportHasNew("world", [...list, ...weekly]);
  return (
    <section aria-label="国内外要闻" className="mt-10 border-t-2 border-[var(--text)] pt-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-headline text-xl font-black text-[var(--text)]">国内外要闻 · 观察与阅读</h3>
        <div className="flex shrink-0 items-center gap-2">
          {q.data ? <span className="hidden text-xs text-[var(--dim)] sm:inline">更新于 {clockTime(q.data.asOf)}</span> : null}
          <button
            type="button"
            aria-label="刷新我关注的世界"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="rounded-full border border-[var(--border)] px-3 text-sm text-[var(--text)] disabled:opacity-50"
          >
            {refresh.isPending ? "刷新中…" : "刷新"}
          </button>
        </div>
      </div>
      <p className="mt-1 text-xs text-[var(--dim)]">以国际经济、政治、科技、网络安全、地区冲突为主；国内只留国家级重大宏观与升学出境相关动态，首页精选国内最多 1 条 · 全球覆盖，不受海外机会八国名单限制</p>
      <div className="mt-3 flex flex-wrap gap-2" role="tablist" aria-label="世界主题">
        {topics.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={topic === t}
            onClick={() => setTopic(t)}
            className={`rounded-full px-3.5 text-sm ${
              topic === t ? "bg-[var(--text)] font-semibold text-[var(--bg)]" : "border border-[var(--border)] text-[var(--text)]"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      {q.isPending ? (
        <p className="py-6 text-sm text-[var(--dim)]">正在整理今日精选…</p>
      ) : list.length === 0 ? (
        <p className="py-6 text-sm text-[var(--dim)]">这个主题暂时没取到内容，点刷新再试。</p>
      ) : (
        <ul>
          {list.map((item, i) => (
            <ArticleRow key={`${item.url}-${i}`} item={item} relevance={item.relevance} />
          ))}
        </ul>
      )}
      {weekly.length > 0 ? (
        <div className="mt-6">
          <h4 className="font-headline text-base font-bold text-[var(--text)]">每周精选 · 书籍 / 历史 / 语言学习</h4>
          <ul>
            {(weeklyAll ? weekly : weekly.slice(0, 3)).map((item, i) => (
              <ArticleRow key={`${item.url}-${i}`} item={item} relevance={item.relevance} />
            ))}
          </ul>
          {weekly.length > 3 ? (
            <button
              type="button"
              onClick={() => setWeeklyAll((v) => !v)}
              aria-expanded={weeklyAll}
              aria-label={weeklyAll ? "收起每周精选" : `展开其余 ${weekly.length - 3} 条每周精选`}
              className="mt-2 text-sm font-medium text-[var(--accent)]"
            >
              {weeklyAll ? "收起 ▴" : `展开其余 ${weekly.length - 3} 条 ▾`}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function HomeView({ onGoLearning }: { onGoLearning: () => void }) {
  return (
    <div>
      <JiangxiSection />
      <RecentApplicableSection />
      <WorldSection />
      <LearningSection onGoLearning={onGoLearning} />
      <FitnessSection />
      <OverseasCategorySection category="study" />
      <OverseasCategorySection category="work_visa" />
      <HotSection />
    </div>
  );
}

const CATEGORY_FALLBACK = [
  { id: "top", label: "头条" },
  { id: "nation", label: "国内" },
  { id: "world", label: "国际" },
  { id: "business", label: "财经" },
  { id: "tech", label: "科技" },
  { id: "ai", label: "AI" },
  { id: "sports", label: "体育" },
  { id: "science", label: "科学" },
  { id: "health", label: "健康" },
] as const;

type CategoryId = (typeof CATEGORY_FALLBACK)[number]["id"];

function NewsView() {
  const [category, setCategory] = useState<CategoryId>("top");
  const queryClient = useQueryClient();
  const dismissedKeys = useDismissedKeys();
  const news = useQuery({
    queryKey: ["news", category],
    queryFn: () => api.getCategoryNews({ category, force: false }),
  });
  useReportHasNew("news", (news.data?.items ?? []).filter((it) => !dismissedKeys.has(itemKeyFor(it))));
  const refresh = useMutation({
    mutationFn: async () => await api.getCategoryNews({ category, force: true }),
    onSuccess: (data) => {
      queryClient.setQueryData(["news", category], data);
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
    onError: () => {},
  });

  return (
    <section>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="新闻分类">
        {CATEGORY_FALLBACK.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={category === c.id}
            onClick={() => setCategory(c.id)}
            className={`rounded-full px-3.5 text-sm ${
              category === c.id
                ? "bg-[var(--accent)] font-semibold text-white"
                : "border border-[var(--border)] text-[var(--text)]"
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="mt-2 flex items-center justify-end gap-2">
        {news.data ? <span className="text-xs text-[var(--dim)]">更新于 {clockTime(news.data.asOf)}</span> : null}
        <button
          type="button"
          aria-label="刷新本分类"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          className="rounded-full border border-[var(--border)] px-3 text-sm text-[var(--text)] disabled:opacity-50"
        >
          {refresh.isPending ? "刷新中…" : "刷新"}
        </button>
      </div>

      {news.isPending ? (
        <p className="py-8 text-sm text-[var(--dim)]">正在取新闻…</p>
      ) : !news.data || news.data.items.length === 0 ? (
        <p className="py-8 text-sm text-[var(--dim)]">这个分类暂时没取到新闻，点刷新再试。</p>
      ) : (
        <ul>
          {news.data.items
            .filter((item) => !dismissedKeys.has(itemKeyFor(item)))
            .map((item, i) => (
              <ArticleRow key={`${item.url}-${i}`} item={item} />
            ))}
        </ul>
      )}
    </section>
  );
}

function FeedsView() {
  const queryClient = useQueryClient();
  const subs = useQuery({ queryKey: ["subscriptions"], queryFn: () => api.getSubscriptions({}) });
  const myFeed = useQuery({ queryKey: ["myfeed"], queryFn: () => api.getMyFeed({ force: false }) });
  const [feedName, setFeedName] = useState("");
  const [feedUrl, setFeedUrl] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const toggle = useMutation({
    mutationFn: async (key: string) => await api.toggleCatalogFeed({ key }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["subscriptions"] });
      queryClient.invalidateQueries({ queryKey: ["myfeed"] });
    },
    onError: () => {},
  });
  const addFeed = useMutation({
    mutationFn: async () => await api.addCustomFeed({ name: feedName.trim(), url: feedUrl.trim() }),
    onSuccess: () => {
      setFeedName("");
      setFeedUrl("");
      setFormError(null);
      queryClient.invalidateQueries({ queryKey: ["subscriptions"] });
      queryClient.invalidateQueries({ queryKey: ["myfeed"] });
    },
    onError: (e) => setFormError(e instanceof Error ? e.message : "添加失败，再试一次"),
  });
  const removeFeed = useMutation({
    mutationFn: async (id: number) => await api.removeCustomFeed({ id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["subscriptions"] });
      queryClient.invalidateQueries({ queryKey: ["myfeed"] });
    },
    onError: () => {},
  });
  const refreshFeed = useMutation({
    mutationFn: async () => await api.getMyFeed({ force: true }),
    onSuccess: (data) => {
      queryClient.setQueryData(["myfeed"], data);
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
    onError: () => {},
  });

  function onAdd(e: FormEvent) {
    e.preventDefault();
    if (!feedName.trim()) {
      setFormError("先给这个订阅源起个名字");
      return;
    }
    if (!feedUrl.trim()) {
      setFormError("把 RSS 地址填上");
      return;
    }
    setFormError(null);
    addFeed.mutate();
  }

  const followedCount = myFeed.data?.followedCount ?? 0;
  const dismissedKeys = useDismissedKeys();
  const sortedFeedItems = [...(myFeed.data?.items ?? [])]
    .filter((it) => !dismissedKeys.has(itemKeyFor(it)))
    .sort((a, b) => {
      const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return tb - ta;
    });
  useReportHasNew("feeds", sortedFeedItems);

  return (
    <section>
      <div className="flex items-center justify-between">
        <h3 className="font-headline text-lg font-bold text-[var(--text)]">我的订阅流</h3>
        {followedCount > 0 ? (
          <button
            type="button"
            aria-label="刷新订阅流"
            onClick={() => refreshFeed.mutate()}
            disabled={refreshFeed.isPending}
            className="rounded-full border border-[var(--border)] px-3 text-sm text-[var(--text)] disabled:opacity-50"
          >
            {refreshFeed.isPending ? "刷新中…" : "刷新"}
          </button>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-[var(--dim)]">按原文发布时间从新到旧排列</p>

      {myFeed.isPending ? (
        <p className="py-6 text-sm text-[var(--dim)]">正在取订阅…</p>
      ) : followedCount === 0 ? (
        <p className="py-6 text-sm leading-relaxed text-[var(--dim)]">
          还没关注任何订阅源。在下面挑几个你常看的，或者贴一个自己的 RSS 地址，之后这里就是你的专属信息流。
        </p>
      ) : myFeed.data && myFeed.data.items.length === 0 ? (
        <p className="py-6 text-sm text-[var(--dim)]">关注的源暂时没取到新内容，点刷新再试。</p>
      ) : (
        <>
          {myFeed.data?.feedErrors.map((fe) => (
            <p key={fe.name} className="mt-2 text-xs text-[var(--accent)]">
              {fe.name}：{fe.error}
            </p>
          ))}
          <ul>
            {sortedFeedItems.map((item, i) => (
              <ArticleRow key={`${item.url}-${i}`} item={item} />
            ))}
          </ul>
        </>
      )}

      <h3 className="font-headline mt-8 border-t-2 border-[var(--text)] pt-4 text-lg font-bold text-[var(--text)]">
        订阅目录
      </h3>
      <ul>
        {(subs.data?.catalog ?? []).map((f) => (
          <li key={f.key} className="flex items-center gap-3 border-b border-[var(--border)] py-3">
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold text-[var(--text)]">{f.name}</p>
              <p className="mt-0.5 text-xs text-[var(--dim)]">
                {f.field} · {f.lang}
              </p>
            </div>
            <button
              type="button"
              aria-label={f.followed ? `取消关注 ${f.name}` : `关注 ${f.name}`}
              onClick={() => toggle.mutate(f.key)}
              disabled={toggle.isPending}
              className={`shrink-0 rounded-full px-4 text-sm ${
                f.followed
                  ? "border border-[var(--border)] text-[var(--dim)]"
                  : "bg-[var(--accent)] font-semibold text-white"
              }`}
            >
              {f.followed ? "已关注" : "关注"}
            </button>
          </li>
        ))}
      </ul>

      {(subs.data?.custom ?? []).length > 0 ? (
        <>
          <h4 className="font-headline mt-6 text-base font-bold text-[var(--text)]">我添加的源</h4>
          <ul>
            {(subs.data?.custom ?? []).map((f) => (
              <li key={f.id} className="flex items-center gap-3 border-b border-[var(--border)] py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-semibold text-[var(--text)]">{f.name}</p>
                  <p className="mt-0.5 truncate text-xs text-[var(--dim)]">{f.url}</p>
                </div>
                <button
                  type="button"
                  aria-label={`删除订阅源 ${f.name}`}
                  onClick={() => removeFeed.mutate(f.id)}
                  className="shrink-0 rounded-full border border-[var(--border)] px-3 text-sm text-[var(--dim)]"
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <form onSubmit={onAdd} className="mt-6 rounded-[var(--radius)] bg-[var(--space-surface-alt)] p-4">
        <p className="font-headline text-base font-bold text-[var(--text)]">添加自己的 RSS 源</p>
        <label htmlFor="feed-name" className="mt-3 block text-xs text-[var(--dim)]">
          名称
        </label>
        <input
          id="feed-name"
          name="name"
          value={feedName}
          onChange={(e) => setFeedName(e.target.value)}
          placeholder="比如：某博客"
          className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
        />
        <label htmlFor="feed-url" className="mt-3 block text-xs text-[var(--dim)]">
          RSS / Atom 地址
        </label>
        <input
          id="feed-url"
          name="url"
          value={feedUrl}
          onChange={(e) => setFeedUrl(e.target.value)}
          placeholder="https://example.com/feed.xml"
          inputMode="url"
          className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
        />
        {formError ? <p className="mt-2 text-sm text-[var(--accent)]">{formError}</p> : null}
        <button
          type="submit"
          disabled={addFeed.isPending}
          className="mt-4 w-full rounded-full bg-[var(--text)] py-2 text-sm font-semibold text-[var(--bg)] disabled:opacity-50"
        >
          {addFeed.isPending ? "正在验证…" : "添加订阅"}
        </button>
      </form>
    </section>
  );
}

/** Collapsed-by-default list of dismissed items with per-item restore + clear-all. */
function DismissedSection() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ["dismissed"], queryFn: () => api.getDismissed({}) });
  const items = q.data?.items ?? [];
  const restore = useMutation({
    mutationFn: async (itemKey: string) => await api.restoreDismissed({ itemKey }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dismissed"] }),
    onError: () => {},
  });
  const clear = useMutation({
    mutationFn: async () => await api.clearDismissed({}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dismissed"] }),
    onError: () => {},
  });
  return (
    <section aria-label="已忽略" className="mt-10 border-t-2 border-[var(--text)] pt-5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-left"
      >
        <h3 className="font-headline text-xl font-black text-[var(--text)]">已忽略（{items.length}）</h3>
        <span className="text-sm font-medium text-[var(--accent)]">{open ? "收起 ▴" : "展开 ▾"}</span>
      </button>
      {open ? (
        q.isPending ? (
          <p className="py-6 text-sm text-[var(--dim)]">正在取已忽略的条目…</p>
        ) : items.length === 0 ? (
          <p className="py-6 text-sm text-[var(--dim)]">还没有忽略的条目，点文章右边的 ✕ 可以忽略一条。</p>
        ) : (
          <>
            <ul>
              {items.map((it) => (
                <li key={it.itemKey} className="flex items-center gap-3 border-b border-[var(--border)] py-3">
                  <p className="min-w-0 flex-1 text-[15px] font-medium leading-snug text-[var(--text)]">{it.title}</p>
                  <button
                    type="button"
                    aria-label={`恢复：${it.title}`}
                    onClick={() => restore.mutate(it.itemKey)}
                    disabled={restore.isPending}
                    className="shrink-0 rounded-full border border-[var(--border)] px-3 text-sm text-[var(--text)] disabled:opacity-50"
                  >
                    恢复
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => clear.mutate()}
              disabled={clear.isPending}
              className="mt-3 text-sm text-[var(--dim)] underline underline-offset-2 disabled:opacity-50"
            >
              清空（全部恢复）
            </button>
          </>
        )
      ) : null}
    </section>
  );
}

function SavedView() {
  const bookmarks = useQuery({ queryKey: ["bookmarks"], queryFn: () => api.getBookmarks({}) });
  const dismissedKeys = useDismissedKeys();
  const list = (bookmarks.data?.bookmarks ?? []).filter((b) => !dismissedKeys.has(itemKeyFor(b)));
  return (
    <>
    <section>
      {bookmarks.isPending ? (
        <p className="py-6 text-sm text-[var(--dim)]">正在取收藏…</p>
      ) : list.length === 0 ? (
        <p className="py-6 text-sm leading-relaxed text-[var(--dim)]">
          还没有收藏。在资讯和订阅流里点文章右边的 ☆，就会存到这里，慢慢看。
        </p>
      ) : (
        <ul>
          {list.map((b) => (
            <ArticleRow
              key={b.id}
              item={{ title: b.title, url: b.url, source: b.source, publishedAt: b.publishedAt, summary: null }}
            />
          ))}
        </ul>
      )}
    </section>
    <DismissedSection />
    </>
  );
}

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "home", label: "首页" },
  { id: "news", label: "资讯" },
  { id: "learning", label: "学习" },
  { id: "fitness", label: "健身" },
  { id: "feeds", label: "订阅" },
  { id: "saved", label: "收藏" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("home");
  const queryClient = useQueryClient();
  // NEW badges: the last "mark all as seen" time, kept in localStorage only
  // (per device). First visit records now and shows no NEW badges.
  const [lastSeenAt, setLastSeenAt] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LAST_SEEN_KEY);
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (lastSeenAt === null) {
      const now = new Date().toISOString();
      try {
        localStorage.setItem(LAST_SEEN_KEY, now);
      } catch {
        // Private mode etc: NEW badges just stay off.
      }
      setLastSeenAt(now);
    }
    // Only on mount; never overwritten during this session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Per-section NEW reports feed the header "全部标为已看" button.
  const [newBySection, setNewBySection] = useState<Record<string, boolean>>({});
  const reportHasNew = useCallback((section: string, has: boolean) => {
    setNewBySection((prev) => (prev[section] === has ? prev : { ...prev, [section]: has }));
  }, []);
  const hasAnyNew = Object.values(newBySection).some(Boolean);
  const markAllSeen = useCallback(() => {
    const now = new Date().toISOString();
    try {
      localStorage.setItem(LAST_SEEN_KEY, now);
    } catch {
      // ignore
    }
    setLastSeenAt(now);
  }, []);
  // Dismiss undo toast (3s, timer cleared on unmount).
  const [dismissToast, setDismissToast] = useState<{ itemKey: string; title: string } | null>(null);
  const dismissToastTimer = useRef<number | null>(null);
  const notifyDismissed = useCallback((item: { itemKey: string; title: string }) => {
    if (dismissToastTimer.current) window.clearTimeout(dismissToastTimer.current);
    setDismissToast(item);
    dismissToastTimer.current = window.setTimeout(() => setDismissToast(null), 3000);
  }, []);
  useEffect(
    () => () => {
      if (dismissToastTimer.current) window.clearTimeout(dismissToastTimer.current);
    },
    [],
  );
  async function undoDismiss() {
    if (!dismissToast) return;
    const itemKey = dismissToast.itemKey;
    setDismissToast(null);
    try {
      await api.restoreDismissed({ itemKey });
      queryClient.invalidateQueries({ queryKey: ["dismissed"] });
    } catch {
      // Leave it dismissed; the entry stays under 已忽略.
    }
  }
  const status = useQuery({ queryKey: ["status"], queryFn: () => api.getStatus({}) });
  const refreshAll = useMutation({
    mutationFn: async () => await api.refreshAll({ source: "manual" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["status"] });
      queryClient.invalidateQueries({ queryKey: ["myfeed"] });
      queryClient.invalidateQueries({ queryKey: ["news"] });
      queryClient.invalidateQueries({ queryKey: ["learning"] });
      queryClient.invalidateQueries({ queryKey: ["jiangxi"] });
      queryClient.invalidateQueries({ queryKey: ["overseas"] });
      queryClient.invalidateQueries({ queryKey: ["world"] });
      queryClient.invalidateQueries({ queryKey: ["digest"] });
      queryClient.invalidateQueries({ queryKey: ["hot"] });
    },
    onError: () => {
      // Keep showing the previous version; just refresh the status line so a
      // recorded failure time becomes visible.
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });

  const lastUpdatedLabel = status.data?.lastUpdatedAt ? formatFullDateTime(status.data.lastUpdatedAt) : null;
  const scheduleLabel = status.data?.refreshScheduleLabel ?? "每天 08:02 / 13:02 / 19:02 · Asia/Shanghai (UTC+8)";
  const statusColumnLabel = (c: "learning" | "jiangxi" | "overseas" | null): string =>
    c === "learning" ? "学习" : c === "jiangxi" ? "江西专升本" : c === "overseas" ? "海外" : "未确认栏目";
  // The scheduled-run line reads ONLY lastCronRun (written by the daily
  // task's own refreshAll calls). A column's content time moving proves
  // the column updated — never that the 08:02 run completed.
  const cronRun = status.data?.lastCronRun ?? null;
  const cronRunLabel = !cronRun
    ? "未确认（暂无定时任务完成记录）"
    : cronRun.status === "failed"
      ? `未完成（开始于 ${formatFullDateTime(cronRun.startedAt)}）`
      : cronRun.status === "running" || !cronRun.finishedAt
        ? `进行中（开始于 ${formatFullDateTime(cronRun.startedAt)}）`
        : `已完成 ${formatFullDateTime(cronRun.finishedAt)}`;
  const currentErrors = status.data?.currentErrors ?? [];
  const lastError = status.data?.lastError ?? null;

  return (
    <LastSeenContext.Provider value={lastSeenAt}>
    <NewReportContext.Provider value={reportHasNew}>
    <DismissNotifyContext.Provider value={notifyDismissed}>
    <div className="min-h-screen bg-[var(--bg)]">
      <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg)] pt-safe">
        <div className="mx-auto max-w-6xl px-4">
          <p className="pt-3 text-center text-xs tracking-wide text-[var(--dim)]">{todayLine()}</p>

          <div className="mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center">
            <p className="text-xs text-[var(--dim)]">
              {lastUpdatedLabel ? (
                <>上次成功更新：<span className="font-medium text-[var(--text)]">{lastUpdatedLabel}</span></>
              ) : status.isPending ? (
                "正在确认上次更新时间…"
              ) : (
                "上次成功更新：尚未更新"
              )}
              <span className="mx-1.5" aria-hidden="true">·</span>
              <span>每天 {scheduleLabel.split("·")[0]?.replace("每天 ", "") ?? "08:02"} 自动刷新</span>
              <span className="mx-1" aria-hidden="true">·</span>
              <span>{status.data?.refreshTimezone ?? "Asia/Shanghai"} (UTC+8)</span>
            </p>
            <button
              type="button"
              aria-label="刷新全部内容"
              onClick={() => refreshAll.mutate()}
              disabled={refreshAll.isPending}
              className="rounded-full border border-[var(--border)] px-2.5 text-xs text-[var(--text)] disabled:opacity-50"
            >
              {refreshAll.isPending ? "刷新中…" : "刷新全部"}
            </button>
            {hasAnyNew ? (
              <button
                type="button"
                aria-label="全部标为已看"
                onClick={markAllSeen}
                className="rounded-full border border-[var(--border)] px-2.5 text-xs text-[var(--text)]"
              >
                全部标为已看
              </button>
            ) : null}
          </div>
          <p className="mt-0.5 text-center text-[11px] text-[var(--dim)]">
            定时刷新：{scheduleLabel}；最近一次定时任务：{cronRunLabel}
          </p>
          {status.data?.columns ? (
            <p className="mt-0.5 text-center text-[11px] text-[var(--dim)]">
              {(
                [
                  ["学习", status.data.columns.learning],
                  ["江西", status.data.columns.jiangxi],
                  ["海外", status.data.columns.overseas],
                ] as const
              ).map(([label, c], i) => (
                <span key={label}>
                  {i > 0 ? " · " : null}
                  {label} 更新 {c.contentAt ? clockTime(c.contentAt) : "—"}
                  {c.enrichAt ? ` · 整理 ${clockTime(c.enrichAt)}` : " · 未整理"}
                  {c.error ? " · 整理出错" : null}
                  {c.recovered ? " · 已恢复" : null}
                </span>
              ))}
            </p>
          ) : null}
          {currentErrors.length > 0 ? (
            <p className="mt-0.5 text-center text-[11px] font-medium text-[var(--accent)]">
              {currentErrors
                .map(
                  (e) =>
                    `${statusColumnLabel(e.column)}整理出错${e.errorAt ? `（最近失败 ${formatFullDateTime(e.errorAt)}）` : ""}`,
                )
                .join("；")}
              ，当前显示的是上一版内容
            </p>
          ) : null}
          {currentErrors.length === 0 && lastError ? (
            <p className="mt-0.5 text-center text-[11px] text-[var(--dim)]">
              历史错误：{statusColumnLabel(lastError.column)}
              {lastError.errorAt ? ` ${formatFullDateTime(lastError.errorAt)}` : ""}
              {lastError.recovered === true
                ? `，已恢复${lastError.recoveredAt ? ` ${formatFullDateTime(lastError.recoveredAt)}` : ""}`
                : lastError.recovered === false
                  ? "，仍未恢复"
                  : "，恢复情况未确认"}
            </p>
          ) : null}
          {status.data?.lastFailureAt ? (
            <p className="mt-0.5 text-center text-[11px] text-[var(--dim)]">
              最近一次抓取失败：{status.data.lastFailureSource ?? "未确认来源"}{" "}
              {formatFullDateTime(status.data.lastFailureAt)}
            </p>
          ) : null}

          <nav className="flex justify-center gap-1 pb-2 pt-1" aria-label="新闻版块">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-current={tab === t.id ? "page" : undefined}
                onClick={() => setTab(t.id)}
                className={`font-headline rounded-full px-4 text-[17px] ${
                  tab === t.id ? "font-black text-[var(--accent)]" : "font-bold text-[var(--dim)]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-10 pt-4">
        {tab === "home" ? <HomeView onGoLearning={() => setTab("learning")} /> : null}
        {tab === "news" ? <div className="mx-auto max-w-3xl"><NewsView /></div> : null}
        {tab === "learning" ? <div className="mx-auto max-w-3xl"><LearningView /></div> : null}
        {tab === "fitness" ? <div className="mx-auto max-w-3xl"><FitnessView /></div> : null}
        {tab === "feeds" ? <div className="mx-auto max-w-3xl"><FeedsView /></div> : null}
        {tab === "saved" ? <div className="mx-auto max-w-3xl"><SavedView /></div> : null}
      </main>
      {dismissToast ? (
        <div className="fixed inset-x-0 bottom-4 z-20 flex justify-center px-4" role="status">
          <div className="flex max-w-lg items-center gap-3 rounded-full bg-[var(--text)] px-4 py-2 text-sm text-[var(--bg)] shadow-lg">
            <span className="min-w-0 flex-1 truncate">已忽略「{dismissToast.title}」</span>
            <button type="button" onClick={undoDismiss} className="shrink-0 font-semibold underline underline-offset-2">
              撤销
            </button>
            <button type="button" aria-label="关闭提示" onClick={() => setDismissToast(null)} className="shrink-0">
              ✕
            </button>
          </div>
        </div>
      ) : null}
    </div>
    </DismissNotifyContext.Provider>
    </NewReportContext.Provider>
    </LastSeenContext.Provider>
  );
}
