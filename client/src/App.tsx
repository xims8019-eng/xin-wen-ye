import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
import { actionFields } from "@hatch/space-sdk/fields" with { type: "macro" };
import type { Actions } from "../../server/src/actions";

const FIELDS = actionFields<typeof Actions>();

type NewsItem = ApiResponse<typeof api, "getCategoryNews">["items"][number];
type LearningItem = ApiResponse<typeof api, "getLearning">["items"][number];
type LearningCategory = LearningItem["category"];
type JiangxiItem = ApiResponse<typeof api, "getJiangxi">["items"][number];
type OverseasItem = ApiResponse<typeof api, "getOverseas">["items"][number];
type WorldItem = ApiResponse<typeof api, "getMyWorld">["daily"][number];
type Tab = "home" | "news" | "learning" | "feeds" | "saved";

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

function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatPubTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

function formatFullDateTime(iso: string | null): string {
  if (!iso) return "尚未更新";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "尚未更新";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

function todayLine(): string {
  const d = new Date();
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()] ?? "";
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 星期${weekday}`;
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

function ArticleRow({ item }: { item: NewsItem }) {
  const [open, setOpen] = useState(false);
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
          <p className="font-headline text-[17px] font-bold leading-snug text-[var(--text)]">{item.title}</p>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-xs text-[var(--dim)]">
            <span className="font-medium text-[var(--text)]">{item.source}</span>
            {item.publishedAt ? (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  {formatPubTime(item.publishedAt)} · {relativeTime(item.publishedAt)}
                </span>
              </>
            ) : null}
            <span aria-hidden="true">·</span>
            <span className="text-[var(--accent)]">{open ? "收起 ▴" : "展开看要点 ▾"}</span>
          </p>
        </button>
        {item.url ? <BookmarkButton item={item} /> : null}
      </div>
      {open ? <ItemDetail item={item} /> : null}
    </li>
  );
}

function HeroStory({ item }: { item: NewsItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b-2 border-[var(--text)] pb-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${open ? "收起" : "展开"}：${item.title}`}
        className="block w-full text-left"
      >
        <p className="text-xs font-semibold tracking-widest text-[var(--accent)]">今日头条</p>
        <h2 className="font-headline mt-2 text-[26px] font-black leading-tight text-[var(--text)] lg:text-[30px]">{item.title}</h2>
        <p className="mt-2 flex flex-wrap gap-x-1.5 text-xs text-[var(--dim)]">
          <span className="font-medium text-[var(--text)]">{item.source}</span>
          {item.publishedAt ? <span>· {formatPubTime(item.publishedAt)} · {relativeTime(item.publishedAt)}</span> : null}
          <span className="text-[var(--accent)]">· {open ? "收起 ▴" : "展开看要点 ▾"}</span>
        </p>
      </button>
      {open ? <ItemDetail item={item} /> : null}
    </div>
  );
}

function LearningRow({ item }: { item: LearningItem }) {
  const [open, setOpen] = useState(false);
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
          <p className="font-headline text-[17px] font-bold leading-snug text-[var(--text)]">{item.title}</p>
          {item.summaryZh ? (
            <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">{item.summaryZh}</p>
          ) : null}
          <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--dim)]">
            <span className="rounded-full border border-[var(--border)] px-2 py-0.5 font-medium text-[var(--text)]">{catLabel}</span>
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

function LearningSection({ onGoLearning }: { onGoLearning: () => void }) {
  const [cat, setCat] = useState<LearningCategory>("courses");
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
  const items = (learning.data?.items ?? []).filter((it) => it.category === cat).slice(0, 6);

  return (
    <section aria-label="学习栏目" className="mt-10 border-t-2 border-[var(--text)] pt-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-headline text-xl font-black text-[var(--text)]">学习</h3>
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
      <p className="mt-1 text-xs text-[var(--dim)]">面向学生 · 课程与讲座 / 学习资源 / 学生机会 · 最新发布的排在前面</p>

      <div className="mt-4">
        <DeadlineAlerts deadlines={learning.data?.deadlines ?? []} />
      </div>

      <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="学习分类">
        {LEARNING_CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={cat === c.id}
            onClick={() => setCat(c.id)}
            className={`rounded-full px-3.5 text-sm ${
              cat === c.id ? "bg-[var(--accent)] font-semibold text-white" : "border border-[var(--border)] text-[var(--text)]"
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {learning.isPending ? (
        <p className="py-8 text-sm text-[var(--dim)]">正在取学习资讯…</p>
      ) : items.length === 0 ? (
        <p className="py-8 text-sm text-[var(--dim)]">这一类暂时没取到新内容，点刷新再试，或看看其他两类。</p>
      ) : (
        <ul>
          {items.map((item) => (
            <LearningRow key={item.url} item={item} />
          ))}
        </ul>
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
  const items = learning.data?.items ?? [];

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

      <div className="mt-4">
        <DeadlineAlerts deadlines={learning.data?.deadlines ?? []} />
      </div>

      {learning.isPending ? (
        <p className="py-8 text-sm text-[var(--dim)]">正在取学习资讯…</p>
      ) : items.length === 0 ? (
        <p className="py-8 text-sm text-[var(--dim)]">暂时没取到学习资讯，点刷新再试。</p>
      ) : (
        LEARNING_CATEGORIES.map((c) => {
          const group = items.filter((it) => it.category === c.id);
          if (group.length === 0) return null;
          return (
            <div key={c.id} className="mt-8">
              <h4 className="font-headline border-b-2 border-[var(--text)] pb-2 text-lg font-black text-[var(--text)]">{c.label}</h4>
              <ul>
                {group.map((item) => (
                  <LearningRow key={item.url} item={item} />
                ))}
              </ul>
            </div>
          );
        })
      )}
    </section>
  );
}

function JiangxiRow({ item }: { item: JiangxiItem }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b border-[var(--border)] py-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${open ? "收起" : "展开"}：${item.title}`}
        className="block w-full text-left"
      >
        <p className="font-headline text-[17px] font-bold leading-snug text-[var(--text)]">{item.title}</p>
        {item.summaryZh ? <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">{item.summaryZh}</p> : null}
        <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--dim)]">
          <span className="rounded-full border border-[var(--border)] px-2 py-0.5 font-medium text-[var(--text)]">{item.tag}</span>
          <span className="rounded-full bg-[var(--space-surface-alt)] px-2 py-0.5 text-[var(--text)]">
            适用年份：{item.applicableYear ?? "未注明"}
          </span>
          {item.isReference ? (
            <span className="rounded-full bg-[var(--space-surface-alt)] px-2 py-0.5 font-medium text-[var(--dim)]">备考参考</span>
          ) : (
            <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 font-medium text-white">与我相关 · 2028 年</span>
          )}
          {item.official ? (
            <span className="rounded-full bg-[var(--space-surface-alt)] px-2 py-0.5 text-[var(--text)]">官方来源</span>
          ) : item.repost ? (
            <span className="rounded-full border border-[var(--border)] px-2 py-0.5 font-medium text-[var(--dim)]">转载</span>
          ) : null}
          <span className="font-medium text-[var(--text)]">{item.source}</span>
          {item.publishedAt ? <span>· {formatDateOnly(item.publishedAt)}</span> : null}
          {item.titleOnly ? (
            <span className="rounded-full border border-[var(--border)] px-2 py-0.5 font-medium text-[var(--dim)]">仅有标题</span>
          ) : null}
          <span className="text-[var(--accent)]">· {open ? "收起 ▴" : "展开看要点 ▾"}</span>
        </p>
        <p className="mt-1.5 text-sm leading-relaxed text-[var(--dim)]">
          <span className="font-medium text-[var(--text)]">与我的关系：</span>
          {item.relevance}
        </p>
        <p className="mt-0.5 text-sm leading-relaxed text-[var(--dim)]">
          <span className="font-medium text-[var(--text)]">我需要做什么：</span>
          {item.actionNeeded}
        </p>
      </button>
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
            {item.readUrl ? <ViewOriginalButton url={item.readUrl} /> : <CopyTitleButton title={item.title} />}
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
  const items = q.data?.items ?? [];
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
        为信息安全技术应用专业、2028 年毕业的你固定置顶 · 优先江西省教育考试院、省教育厅和招生院校的通知 · 官方来源认准江西省教育考试院官网 www.jxeea.cn（站内「专升本考试」栏目），非官方条目标「转载」
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
        <p className="py-6 text-sm text-[var(--dim)]">暂时没取到专升本通知，点刷新再试。2028 年的报名、考试科目、专业对照和招生简章公布后会出现在这里。</p>
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
    </section>
  );
}

function OverseasRow({ item }: { item: OverseasItem }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b border-[var(--border)] py-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${open ? "收起" : "展开"}：${item.title}`}
        className="block w-full text-left"
      >
        <p className="font-headline text-[17px] font-bold leading-snug text-[var(--text)]">{item.title}</p>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--dim)]">
          <span className="rounded-full border border-[var(--border)] px-2 py-0.5 font-medium text-[var(--text)]">{item.country}</span>
          {item.visa ? (
            <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 font-medium text-white">签证{item.pinned ? " · 固定" : ""}</span>
          ) : null}
          {item.eligibility === "diploma_eligible" ? (
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
          {item.publishedAt ? <span>· {formatDateOnly(item.publishedAt)}</span> : null}
          {item.titleOnly ? (
            <span className="rounded-full border border-[var(--border)] px-2 py-0.5 font-medium text-[var(--dim)]">仅有标题</span>
          ) : null}
          {item.blockedReason ? <BlockedBadge /> : null}
          <span className="text-[var(--accent)]">· {open ? "收起 ▴" : "展开看要点 ▾"}</span>
        </p>
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
          <div>
            <dt className="inline font-medium text-[var(--text)]">何时生效：</dt>
            <dd className="inline">{item.effectiveWhen ?? "未公布"}</dd>
          </div>
        </dl>
      </button>
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
              <ViewOriginalButton url={item.readUrl} />
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

function OverseasSection() {
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
  const items = q.data?.items ?? [];
  // Fixed visa zone: pinned visa items always show (their eligibility badge
  // states any degree restriction); the bachelor-only toggle governs only
  // the rotating list below it.
  const visaItems = items.filter((it) => it.visa && it.pinned);
  const rotating = items.filter((it) => !(it.visa && it.pinned));
  const visible = rotating.filter((it) => showBachelorOnly || it.eligibility !== "bachelor_only");
  const hiddenCount = rotating.length - rotating.filter((it) => it.eligibility !== "bachelor_only").length;
  return (
    <section aria-label="中国专科生海外机会与政策变化" className="mt-10 border-t-2 border-[var(--text)] pt-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-headline text-xl font-black text-[var(--text)]">中国专科生海外机会与政策变化</h3>
        <div className="flex shrink-0 items-center gap-2">
          {q.data ? <span className="hidden text-xs text-[var(--dim)] sm:inline">更新于 {clockTime(q.data.asOf)}</span> : null}
          <button
            type="button"
            aria-label="刷新海外机会"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="rounded-full border border-[var(--border)] px-3 text-sm text-[var(--text)] disabled:opacity-50"
          >
            {refresh.isPending ? "刷新中…" : "刷新"}
          </button>
        </div>
      </div>
      <p className="mt-1 text-xs text-[var(--dim)]">
        跟踪美国、新西兰、新加坡、越南、日本、韩国、爱尔兰、英国 · 只放会改变你决策的消息：接受大专申请、学分认定、奖学金、学生签证、安全提醒
      </p>
      {q.isPending ? (
        <p className="py-6 text-sm text-[var(--dim)]">正在追踪海外机会与政策…</p>
      ) : items.length === 0 ? (
        <p className="py-6 text-sm text-[var(--dim)]">暂时没取到新的海外机会与政策消息，点刷新再试。</p>
      ) : (
        <>
          {visaItems.length > 0 ? (
            <div className="mt-4">
              <h4 className="font-headline text-base font-bold text-[var(--text)]">签证新政 · 固定区</h4>
              <p className="mt-0.5 text-xs text-[var(--dim)]">
                会改变决策的学生签证与毕业后工签消息固定展示，不随每天刷新轮换；只有被更新的消息取代、或过期后才会撤下。
              </p>
              <ul>
                {visaItems.map((item) => (
                  <OverseasRow key={item.url} item={item} />
                ))}
              </ul>
            </div>
          ) : null}
          {visible.length > 0 ? (
            <div className={visaItems.length > 0 ? "mt-6" : undefined}>
              {visaItems.length > 0 ? (
                <h4 className="font-headline text-base font-bold text-[var(--text)]">其他机会与政策</h4>
              ) : null}
              <ul>
                {visible.slice(0, 10).map((item) => (
                  <OverseasRow key={item.url} item={item} />
                ))}
              </ul>
            </div>
          ) : null}
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

function WorldSection() {
  const [topic, setTopic] = useState<string>("今日精选");
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
  const all = q.data?.all ?? [];
  const topics = ["今日精选", ...Array.from(new Set(all.map((it) => it.topic)))];
  const list: WorldItem[] =
    topic === "今日精选" ? (q.data?.daily ?? []) : all.filter((it) => it.topic === topic && !it.weekly).slice(0, 10);
  const weekly = q.data?.weekly ?? [];
  return (
    <section aria-label="我关注的世界" className="mt-10 border-t-2 border-[var(--text)] pt-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-headline text-xl font-black text-[var(--text)]">我关注的世界</h3>
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
      <p className="mt-1 text-xs text-[var(--dim)]">每天最多精选 5 条，同一事件已合并 · 按主题浏览，不凑数量</p>
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
            <ArticleRow key={`${item.url}-${i}`} item={item} />
          ))}
        </ul>
      )}
      {weekly.length > 0 ? (
        <div className="mt-6">
          <h4 className="font-headline text-base font-bold text-[var(--text)]">每周精选 · 书籍 / 历史 / 语言学习</h4>
          <ul>
            {weekly.map((item, i) => (
              <ArticleRow key={`${item.url}-${i}`} item={item} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function HomeView({ onGoLearning }: { onGoLearning: () => void }) {
  return (
    <div>
      <JiangxiSection />
      <OverseasSection />
      <WorldSection />
      <LearningSection onGoLearning={onGoLearning} />
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
  const news = useQuery({
    queryKey: ["news", category],
    queryFn: () => api.getCategoryNews({ category, force: false }),
  });
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
          {news.data.items.map((item, i) => (
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
  const sortedFeedItems = [...(myFeed.data?.items ?? [])].sort((a, b) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  });

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
          {...FIELDS.addCustomFeed.name}
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
          {...FIELDS.addCustomFeed.url}
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

function SavedView() {
  const bookmarks = useQuery({ queryKey: ["bookmarks"], queryFn: () => api.getBookmarks({}) });
  const list = bookmarks.data?.bookmarks ?? [];
  return (
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
  );
}

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "home", label: "首页" },
  { id: "news", label: "资讯" },
  { id: "learning", label: "学习" },
  { id: "feeds", label: "订阅" },
  { id: "saved", label: "收藏" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("home");
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["status"], queryFn: () => api.getStatus({}) });
  const refreshAll = useMutation({
    mutationFn: async () => await api.refreshAll({}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["status"] });
      queryClient.invalidateQueries({ queryKey: ["myfeed"] });
      queryClient.invalidateQueries({ queryKey: ["news"] });
      queryClient.invalidateQueries({ queryKey: ["learning"] });
      queryClient.invalidateQueries({ queryKey: ["jiangxi"] });
      queryClient.invalidateQueries({ queryKey: ["overseas"] });
      queryClient.invalidateQueries({ queryKey: ["world"] });
    },
    onError: () => {
      // Keep showing the previous version; just refresh the status line so a
      // recorded failure time becomes visible.
      queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });

  const lastUpdatedLabel = status.data?.lastUpdatedAt ? formatFullDateTime(status.data.lastUpdatedAt) : null;
  const lastFailureLabel = status.data?.lastFailureAt ? formatFullDateTime(status.data.lastFailureAt) : null;
  const showFailure =
    !!status.data?.lastFailureAt &&
    (!status.data.lastUpdatedAt || status.data.lastFailureAt > status.data.lastUpdatedAt);
  const scheduleLabel = status.data?.refreshScheduleLabel ?? "每天 08:02 · Asia/Shanghai (UTC+8)";

  return (
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
          </div>
          <p className="mt-0.5 text-center text-[11px] text-[var(--dim)]">定时刷新：{scheduleLabel}</p>
          {showFailure && lastFailureLabel ? (
            <p className="mt-0.5 text-center text-[11px] font-medium text-[var(--accent)]">
              最近一次更新失败：{lastFailureLabel}，当前显示的是上一版内容
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
        {tab === "feeds" ? <div className="mx-auto max-w-3xl"><FeedsView /></div> : null}
        {tab === "saved" ? <div className="mx-auto max-w-3xl"><SavedView /></div> : null}
      </main>
    </div>
  );
}
