#!/usr/bin/env bash
# 重建 Gitty 的演示仓库：
#   demo/origin.git    模拟远端（裸仓库）
#   demo/contributor   模拟另一位开发者（向远端推送新提交）
#   demo/showcase      被观察的本地仓库（含本地独有分支与本地提交）
# 直接运行: bash scripts/build-demo.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO="$ROOT/demo"

echo "清理旧的演示仓库…"
rm -rf "$DEMO/showcase" "$DEMO/origin.git" "$DEMO/contributor"
mkdir -p "$DEMO"

export GIT_AUTHOR_NAME="Demo" GIT_AUTHOR_EMAIL="demo@example.com"
export GIT_COMMITTER_NAME="Demo" GIT_COMMITTER_EMAIL="demo@example.com"

commit() { # $1=文件 $2=内容 $3=提交信息
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$2" >> "$1"
  git add -A
  git commit -q -m "$3"
}

# ---------- 1. 另一位开发者构建完整历史 ----------
echo "构建 contributor 历史…"
git init -q --bare -b main "$DEMO/origin.git"
git clone -q "$DEMO/origin.git" "$DEMO/contributor"
cd "$DEMO/contributor"
git config user.name "Demo Contributor"
git config user.email "contributor@example.com"

commit README.md "# Warehouse" "chore: initialize warehouse"
commit src/metrics.js "export const metrics = [];" "feat: add metrics api"
commit src/dashboard.js "export const dashboard = {};" "feat: add dashboard shell"
git branch -M main

git checkout -q -b dev
commit src/pipeline.js "export const pipeline = [];" "feat: add pipeline runner"
commit src/scheduler.js "export const schedule = () => {};" "feat: add job scheduler"

git checkout -q -b feature/auth dev
commit src/auth/login.js "export const login = () => {};" "feat: add login form"
commit src/auth/token.js "export const refresh = () => {};" "feat: add token refresh"
commit src/auth/guard.js "export const guard = () => {};" "fix: guard expired session"
git checkout -q dev
git merge -q --no-ff feature/auth -m "merge: auth into dev"

git checkout -q -b feature/ui dev
commit src/ui/sidebar.js "export const sidebar = [];" "feat: add sidebar"
commit src/ui/spacing.css "body { gap: 8px; }" "style: tune spacing"
git checkout -q dev
git merge -q --no-ff feature/ui -m "merge: ui into dev"

commit src/deps.json '{"version": 2}' "chore: bump dependencies"

git checkout -q main
commit docs/README.md "## Usage" "docs: update readme"
commit src/queue.js "export const queue = [];" "fix: handle empty queues"
git merge -q --no-ff dev -m "merge: dev into main"

git checkout -q -b release/1.0 main
commit CHANGELOG.md "# 1.0" "chore: prepare 1.0"
commit CHANGELOG.md "- first release" "docs: changelog 1.0"

git checkout -q main
commit src/audit.js "export const audit = [];" "feat: add audit log"

git checkout -q dev
commit src/retry.js "export const retry = 3;" "fix: correct retry policy"

git checkout -q main
commit src/cache.js "export const cache = new Map();" "perf: cache aggregates"
git merge -q --no-ff dev -m "merge: dev into main"

git tag v0.9 HEAD~3
git push -q origin main dev feature/auth feature/ui release/1.0
git push -q origin v0.9

# ---------- 2. 本地仓库：拉取后做本地工作 ----------
echo "构建 showcase 本地历史…"
cd "$DEMO"
git clone -q origin.git showcase
cd "$DEMO/showcase"
git config user.name "You"
git config user.email "you@example.com"

git checkout -q main
commit src/webhook.js "export const webhook = () => {};" "feat: add webhook retries"
commit tests/retry.js "export const cases = 4;" "test: cover retry limits"

git checkout -q dev
commit src/dlq.js "export const deadLetter = [];" "feat: add dead-letter queue"

# 本地独有分支（从未推送）
git checkout -q -b experiment/vector dev
commit src/vector.js "export const vector = [];" "experiment: add vector store"
commit src/vector.js "export const query = () => [];" "experiment: query vectors"

# 已合并功能分支保留为本地分支
git checkout -q -b feature/auth origin/feature/auth
git checkout -q -b feature/ui origin/feature/ui
git checkout -q -b release/1.0 origin/release/1.0

# ---------- 3. 另一位开发者继续推送，制造双向分歧 ----------
echo "contributor 推送新的远端提交…"
cd "$DEMO/contributor"
git checkout -q main
commit src/pay.js "export const pay = () => {};" "feat: add payment hooks"
commit src/pay.js "export const retryPay = () => {};" "fix: payment retries"
commit src/pay.js "export const batch = () => {};" "perf: batch payments"
git push -q origin main

git checkout -q dev
commit src/pubsub.js "export const bus = {};" "feat: add pubsub bus"
commit src/pubsub.js "export const ack = () => {};" "fix: ack timeouts"
git push -q origin dev

git checkout -q release/1.0
commit CHANGELOG.md "- regression fix" "fix: 1.0 regression"
git push -q origin release/1.0

# 远端独有分支：从最新 main 分出的 WIP 功能分支，尚未合并（本地还没有同名分支）
git checkout -q -b feature/notifications main
commit src/notify.js "export const notify = () => {};" "feat: add notification center"
commit src/notify.js "export const digest = () => [];" "feat: add daily digest"
git push -q -u origin feature/notifications

# ---------- 4. 本地 fetch，让远端独有分支以 origin/* 出现 ----------
cd "$DEMO/showcase"
git fetch -q --all --prune
git checkout -q main

echo
echo "完成。本地分支:"
git branch -vv
echo
echo "远端分支（origin/*）:"
git branch -r
echo
echo "提示: npm run demo 后打开 http://localhost:4173"
