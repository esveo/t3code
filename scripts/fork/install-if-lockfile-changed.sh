#!/usr/bin/env bash
# Fork: run from the post-merge and post-rewrite git hooks (.vite-hooks/). When a
# pull, merge or rebase changed pnpm-lock.yaml, reinstalls so typecheck, tests and
# lint see the new packages instead of the stale ones. Never fails the git command.
# Skipped in CI and in checkouts that were never installed. VP_GIT_HOOKS=0 turns it off.
set -uo pipefail

[[ -n "${CI:-}" ]] && exit 0
[[ "${1:-}" == "amend" ]] && exit 0

root="$(git rev-parse --show-toplevel)" || exit 0
cd "$root" || exit 0
[[ -d node_modules ]] || exit 0
git rev-parse -q --verify ORIG_HEAD >/dev/null || exit 0
git diff --quiet ORIG_HEAD HEAD -- pnpm-lock.yaml && exit 0

pnpm="$(node -p 'require("./package.json").packageManager' 2>/dev/null)"
major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ -z "$pnpm" || "$major" -lt 26 ]]; then
  echo "fork: pnpm-lock.yaml changed; run 'npx $pnpm install --frozen-lockfile' under Node 26." >&2
  exit 0
fi

echo "fork: pnpm-lock.yaml changed, reinstalling dependencies …" >&2
if ! npx -y "$pnpm" install --frozen-lockfile --prefer-offline >&2; then
  echo "fork: reinstall failed; run 'npx $pnpm install --frozen-lockfile' by hand." >&2
fi
exit 0
