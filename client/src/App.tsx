import { useState, type FormEvent } from "react";
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

function ArticleRow({ item, relevance }: { item: NewsItem; relevance?: string }) {
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
      </div>
      {open ? <ItemDetail item={item} /> : null}
    </li>
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
          <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
            <span className="font-medium text-[var(--text)]">和我有什么关系：</span>
            {item.relevance}
          </p>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--dim)]">
            <span className="rounded-full border border-[var(--border)] px-2 py-0.5 font-medium text-[var(--text)]">{catLabel}</span>
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
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${open ? "收起" : "展开"}：${item.title}`}
        className="block w-full text-left"
      >
        <p className="font-headline text-[17px] font-bold leading-snug text-[var(--text)]">{item.title}</p>
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
  const items = (q.data?.items ?? []).filter((it) => it.category === category);
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
        <p className="py-6 text-sm text-[var(--dim)]">暂时没取到这一栏的新消息，点刷新再试。</p>
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
                  <OverseasRow key={item.url} item={item} />
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
  const items: DigestItem[] = q.data?.items ?? [];
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
              <a href={item.url} target="_blank" rel="noreferrer" className="font-headline text-[17px] font-bold leading-snug text-[var(--text)] underline-offset-2 hover:underline">
                {item.title}
              </a>
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
  const all = q.data?.all ?? [];
  const topics = ["今日精选", ...Array.from(new Set(all.map((it) => it.topic)))];
  const list: WorldItem[] =
    topic === "今日精选" ? (q.data?.daily ?? []) : all.filter((it) => it.topic === topic && !it.weekly).slice(0, 10);
  const weekly = q.data?.weekly ?? [];
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
      <p className="mt-1 text-xs text-[var(--dim)]">国内经济，以及国际经济、政治、科技、网络安全、地区冲突、留学与出行安全 · 按重要性筛选，每天最多精选 5 条，同一事件已合并 · 全球覆盖，不受海外机会八国名单限制</p>
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
