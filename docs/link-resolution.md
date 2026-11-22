# 链接解析、去重与屏蔽规则说明

对应代码：`server/src/actions.ts` 的 `parseFeed`、`decodeBingClick`、`resolveGnUrl` / `resolveGnShared`、`resolveMsnUrl`、`resolveCategoryIngest`、`verifyPublisherPage`、`fetchArticleMeta`、`cnBlockedReason`、各栏目的事件匹配器和 `mergePinnedVisaItems`。

核心原则：**任何中转链接都不入库**。所有分类、所有栏目在存进缓存之前，都要把链接解析成发布方的直达地址；解析不到的，要么丢弃条目（学习/海外），要么只保留标题和摘要、链接留空（分类新闻，页面只给「复制标题」）。

## 三种中转链接怎么解

| 中转形式 | 解法 | 代码 |
| --- | --- | --- |
| Bing 资讯点击链接 `bing.com/news/apiclick.aspx?...&url=<编码后的发布方地址>` | 解析时直接取 `url` 参数解码，就是发布方直达地址 | `decodeBingClick`（在 `parseFeed` 里调用） |
| Google 新闻 `news.google.com/rss/articles/<token>` | 取文章页里的 `data-n-a-id/ts/sg` 参数，走 `_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je` 换出发布方地址；8 秒超时，解不出来返回 null | `resolveGnUrl`；结果缓存在 `gn:resolved:v2`，分类/详情/学习共用 |
| MSN 转载 `msn.com` / `msn.cn` | 用爬虫 UA 打开文章页，读 `<link rel="canonical">`，它指向原发布方的文章地址；来源名去掉「 on MSN」后缀 | `resolveMsnUrl` |

## 分类新闻的入库四步（`resolveCategoryIngest`，全站 9 个分类都走）

1. 并行批解：Google 新闻中转按每批 5 条并行 batchexecute 解码（走共享缓存）。
2. 顺序重试：Google 会对并行突发限流（间歇 429/验证码），没解出的逐条带间隔重试。
3. 验证直达地址：`verifyPublisherPage` 打开每个解出的地址，只有 404/410、最终仍跳回 Google 域名、或 2xx/3xx 却不是 HTML 时才判死并清掉链接；403/5xx/网络错误保留地址（沙箱环境证明不了它对读者打不开）。
4. 补真实描述：有直达地址但没摘要的条目，取文章页自己的 meta 描述当摘要（`fetchArticleMeta`，含乱码防护）；仍没有就保持「仅有标题」。

四步之后还带着中转 token 的条目，链接存空字符串 `url: ""`，页面渲染为无链接行（摘要 + 复制标题，没有展开详情、没有收藏按钮）。

学习、江西、海外三栏在各自的加载函数里做等价处理：学习栏解不出的中转条目直接丢弃不入库；海外栏的 MSN 转载在入库前解析。

## 同一事件只留一条（去重）

- 通用层：按链接去重；「我关注的世界」再按标题归一化键（去空格标点取前 14 字）合并同一事件。
- 签证固定区有五个「同一事件只留一条」的事件匹配器，命中转述就在入库和固定区合并两处丢弃：美国 D/S 裁决（`isDsRulingEventText`，含「学生签证 + 禁令/固定期限」的英文形态；2026-11-22 起也识别「4-year cap / 4 年上限」这类对固定期限提案的说法，MSN 等转载的同事件旧闻并入耶鲁那条、不单独置顶）、新西兰毕业后工签扩大（`isNzPswvEventText`）、英国毕业生签证缩短（`isUkGraduateCutEventText`）、日本语言学校 A1 证明新规（`isJpLanguageSchoolEventText`）、韩国 16 专业技术试点（`isKrTechPilotEventText`）。每个事件只保留人工核实的那一条（见 `config/columns.json` 的 `pinnedVisaItems`）。
- 海外轮换列表 2026-11-22 起按事件去重（`sameOverseasEvent`）：标题归一化（去空格标点、小写）完全相同即同事件，不限日期（这条治的是标题、来源、日期都相同的重复报道）；否则要求同国家、共享一个 2 位以上显著数字、标题字符集相似度 ≥0.6、发布日期相差 7 天以内。印度–新西兰自贸协定的两篇报道标题没有显著数字，另有具名匹配器 `isIndiaNzFtaEventText`（印度 + 新西兰 + FTA/自贸/新增工作签证），命中只留官方/最新一条。

## 屏蔽与禁用名单

- **中国境内打不开**（`CN_BLOCKED_DOMAINS`）：目前只有 `wfyi.org`（Amazon CloudFront 配置为屏蔽中国访问，用户 2026-11-21 在中国境内实测 403 确认）。命中条目保留页内中文摘要、标「中国境内打不开」、不给出打不开的原文按钮；有已验证可访问的官方/替代链接时给替代链接。这份名单只收用户在中国境内实测确认的域名——境外服务器抓取结果证明不了中国境内能不能打开，不要凭抓取结果往里加。
- **固定区禁用来源**（`PINNED_VISA_BLOCKED_HOSTS`）：`dayonekorea.com`、`gistreel.com`。前者是商业博客冒充韩国法务部原文，后者是新西兰工签事件的转述且生效日期写错；两个域名被硬性禁止进入签证固定区（按条目链接和阅读链接双查）。
- **海外栏旧评论清理**（`isStaleVisaOpinionItem`）：意见/评论/社论类的学生签证文章超过 45 天不收；另有两篇 2026 年 8 月的评论（Good Men Project、independent.org）按标题+来源点名删除，入库前就丢弃，刷新不会把它们带回来。
- **江西栏首页隐藏**（`isJiangxiHiddenNoise`，2026-11-22）：培训机构营销标题（机构评测/测评、十大机构、哪家好、选机构、排行榜）和高考择校文章（面向高考生选大专，含 gaokao.eol.cn 及一切 gaokao.* 域名）入库时丢弃。
- **江西已结束考区提醒**（`isJiangxiEndedExamReminder`，2026-11-22c）：考区/考点/考场/准考证/温馨提醒类条目，考试年份不是未来年份且发布超过 45 天的，移出可见列表；考试科目/专业对照/招生方案等有备考价值的内容豁免保留。
- **海外只讲单一外国国籍申请人**（`isForeignApplicantsOnlyItem`，2026-11-22c）：主题只涉及一个外国国籍申请人、又不涉及中国申请人、也没写明适用于各国申请人的条目，移出首页（分类归档不动）；新西兰—印度签证获批率统计另有具名事件合并 `isNzIndiaVisaStatsEventText`，先并成一个事件再整体移出。国籍与目的地辨析见 `docs/summary-logic.md` 第 6 节。
- **观察栏地方节庆交通提示**（`isLocalFestivalTrafficNotice`，2026-11-22c）：面向单一地方居民的节庆/假期交通出行提示（州庆/县庆/庙会/秋假等信号 + 交通提示性质），且与江西、全国或八个留学目的地无关的，从「国内外观察与阅读」移除；纯节庆新闻报道不处理。
- **需要登录提示**：标题或来源命中纽约时报、华尔街日报、金融时报、经济学人、彭博、财新等关键词时，条目标 `needsLogin`，页面在原文按钮旁提示「该来源可能需要登录/订阅」（只是提示，不屏蔽）。
