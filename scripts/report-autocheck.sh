#!/usr/bin/env bash
# report-autocheck.sh — 巡检/验收的通知状态机（两工作流共用）。
# 用法：bash scripts/report-autocheck.sh check-result.json check-summary.md
# 依赖：gh（Actions 自带）、jq。
#
# 规则（用户要求）：
# - 正常时不通知，只留运行记录（本脚本不做任何事就退出 0）。
# - 首次确认异常：开一个 GitHub issue（标题含 [巡检] <问题键>），并退出 1
#   让本次工作流运行变红——issue 创建本身也会通知仓库关注者（通知收件箱
#   + 绑定邮箱）。两者指向同一问题。
# - 同一问题持续期间：不重复开 issue、不重复评论、不重复通知；退出 0。
# - 恢复时：评论“已恢复”并关闭 issue（关闭会通知一次），退出 0。
# - 只关闭本次检查评估过的问题（checkedProblems 里有、activeProblems 里
#   没有）；没评估到的 issue 不动。
set -euo pipefail

RESULT="${1:-check-result.json}"
SUMMARY="${2:-check-summary.md}"
LABEL="autocheck"
RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-xims8019-eng/xin-wen-ye}/actions/runs/${GITHUB_RUN_ID:-}"

if ! command -v gh >/dev/null 2>&1; then
  echo "report: gh 不可用，跳过 issue 处理。"
  exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "report: jq 不可用，跳过 issue 处理。"
  exit 0
fi

# 确保 autocheck 标签存在（不存在就建一个；已存在则忽略错误）。
gh label create "$LABEL" --color "5319e7" --description "新闻页自动巡检 / 部署验收发现的问题" 2>/dev/null || true

NEW_ISSUE=0

# 检查脚本没产出结果文件：本身就是一次故障。
if [ ! -f "$RESULT" ]; then
  echo "report: $RESULT 不存在，检查脚本没有产出结果。"
  EXISTING=$(gh issue list --label "$LABEL" --state open --limit 100 --json number,title --jq '.[].title' 2>/dev/null || true)
  if ! printf '%s\n' "$EXISTING" | grep -qF "[巡检] check-script-failed"; then
    gh issue create --label "$LABEL" \
      --title "[巡检] check-script-failed：检查脚本没有产出结果" \
      --body "巡检/验收运行没有产出 check-result.json（脚本可能崩溃或超时）。运行记录：$RUN_URL" \
      >/dev/null
    echo "report: 已为 check-script-failed 开 issue。"
    NEW_ISSUE=1
  else
    echo "report: check-script-failed 的 issue 已开着，不重复开。"
  fi
  exit "$NEW_ISSUE"
fi

STATUS=$(jq -r '.status // "anomaly"' "$RESULT")
BEIJING=$(jq -r '.checkedAtBeijing // ""' "$RESULT")
MODE=$(jq -r '.mode // ""' "$RESULT")

# 当前打开的 autocheck issue（编号 + 标题）。
OPEN_JSON=$(gh issue list --label "$LABEL" --state open --limit 100 --json number,title 2>/dev/null || echo "[]")

has_open_issue() {
  # $1 = 问题键；标题形如 “[巡检] <key>：...”
  local key="$1"
  printf '%s' "$OPEN_JSON" | jq -e --arg key "[巡检] $key" 'any(.[]; .title | startswith($key))' >/dev/null
}

issue_number_for() {
  local key="$1"
  printf '%s' "$OPEN_JSON" | jq -r --arg key "[巡检] $key" '.[] | select(.title | startswith($key)) | .number' | head -1
}

# -- 1. 活跃问题：没有已开 issue 就开一个 --
ACTIVE_KEYS=$(jq -r '.activeProblems[]?.key // empty' "$RESULT")
for key in $ACTIVE_KEYS; do
  if has_open_issue "$key"; then
    echo "report: $key 已有未关闭的 issue，不重复开。"
    continue
  fi
  TITLE=$(jq -r --arg k "$key" '.activeProblems[] | select(.key == $k) | .title' "$RESULT" | head -1)
  DETAIL=$(jq -r --arg k "$key" '.activeProblems[] | select(.key == $k) | .detail' "$RESULT" | head -1)
  BODY="## 问题

**$TITLE**

$DETAIL

## 本次检查

- 模式：$MODE
- 检查时间（北京时间）：$BEIJING
- 运行记录：$RUN_URL

## 完整摘要

$(cat "$SUMMARY" 2>/dev/null || echo "（无摘要文件）")"
  gh issue create --label "$LABEL" --title "[巡检] $key：$TITLE" --body "$BODY" >/dev/null
  echo "report: 已为 $key 开 issue。"
  NEW_ISSUE=1
  # 刷新已开列表，避免同一轮里重复开。
  OPEN_JSON=$(gh issue list --label "$LABEL" --state open --limit 100 --json number,title 2>/dev/null || echo "[]")
done

# -- 2. 已恢复：评估过且已不在活跃列表里的 issue，评论并关闭 --
CHECKED_KEYS=$(jq -r '.checkedProblems[]? // empty' "$RESULT")
OPEN_TITLES=$(printf '%s' "$OPEN_JSON" | jq -r '.[].title')
while IFS= read -r title; do
  [ -z "$title" ] && continue
  # 从 “[巡检] <key>：...” 里取 key。
  key=$(printf '%s' "$title" | sed -n 's/^\[巡检\] \([^：]*\)：.*/\1/p')
  [ -z "$key" ] && continue
  if ! printf '%s\n' $CHECKED_KEYS | grep -qx "$key"; then
    echo "report: $key 本次没评估到，issue 不动。"
    continue
  fi
  if printf '%s\n' $ACTIVE_KEYS | grep -qx "$key"; then
    continue # 还在活跃，不关闭。
  fi
  num=$(issue_number_for "$key")
  [ -z "$num" ] && continue
  gh issue close "$num" --reason completed --comment "已恢复：本次检查（北京时间 $BEIJING）未再发现该问题，关闭此 issue。如再次出现会重新开 issue。运行记录：$RUN_URL" >/dev/null \
    && echo "report: $key 已恢复，关闭 issue #$num。" \
    || echo "report: 关闭 issue #$num 失败（$key），请人工处理。"
done <<EOF
$OPEN_TITLES
EOF

if [ "$NEW_ISSUE" = "1" ]; then
  echo "report: 本轮新开了 issue，退出 1（本次运行变红，作首次异常通知）。"
  exit 1
fi
echo "report: 无新 issue（正常，或同一问题持续中，或已恢复并关闭）。"
exit 0
