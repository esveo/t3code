#!/usr/bin/env bash
# Fork-only: the fixed steps of .github/workflows/fork-upstream-sync.yml, kept
# out of the agent's reach. The workflow runs this file from the fork commit it
# started on (`bash <(git show $FORK_SHA:<this file>) <command>`), so nothing
# the merge or the agent writes into the checkout changes what it checks.
#
# Env: FORK_SHA (fork before the merge), TARGET (upstream commit to merge),
# SYNC_DIR (reports and outputs). Run from the repository root.
#
#   merge     merge TARGET into the checked-out FORK_SHA, rerere on; lists the
#             files left unmerged in $SYNC_DIR/conflicts.txt, exits 1 if any
#   checks    install, typecheck, and the tests related to the files both
#             sides changed or the agent touched; report in checks.md
#   guards    hard rules the result must meet; report in guards.md
#   audit     lines the fork added that the result lost; audit.md. Fails above
#             AUDIT_MAX_LOST (default 50): a careful merge loses a few to
#             upstream rewrites, taking upstream's side of a conflict hundreds
#   verify    checks, guards and audit in one go
#   workflows every .github file the sync changed equals upstream's version
set -uo pipefail

: "${FORK_SHA:?}" "${TARGET:?}" "${SYNC_DIR:?}"
mkdir -p "$SYNC_DIR"
BASE=$(git merge-base "$FORK_SHA" "$TARGET")

# The sync's merge commit: first commit on HEAD's first-parent chain after FORK_SHA.
merge_commit() { git rev-list --first-parent --reverse "$FORK_SHA..HEAD" | head -1; }

changed() { git diff --name-only --no-renames "$@"; }

cmd_merge() {
  git config rerere.enabled true
  git config rerere.autoUpdate true
  git merge --no-ff --no-edit -m "chore: merge upstream/main ($(git rev-parse --short "$TARGET"))" "$TARGET" >/dev/null 2>&1
  # rerere may have resolved every conflict; `ls-files -u` is the truth, not the exit code.
  git ls-files -u | cut -f2 | sort -u > "$SYNC_DIR/conflicts.txt"
  if [ -s "$SYNC_DIR/conflicts.txt" ]; then
    echo "Unmerged files: $(wc -l < "$SYNC_DIR/conflicts.txt")"
    return 1
  fi
  git rev-parse -q --verify MERGE_HEAD >/dev/null && git commit --no-edit >/dev/null
  echo "Merged without conflicts."
}

# Files where both sides meet, plus whatever came after the merge commit.
touched_files() {
  local m
  m=$(merge_commit)
  {
    comm -12 <(changed "$BASE" "$FORK_SHA" | sort) <(changed "$BASE" "$TARGET" | sort)
    [ -n "$m" ] && changed "$m" HEAD
  } | sort -u | while read -r f; do
    [ -n "$(git ls-tree HEAD -- "$f")" ] && printf '%s\n' "$f"
  done
}

cmd_checks() {
  local report="$SYNC_DIR/checks.md" failed=0 log="$SYNC_DIR/checks.log"
  : > "$log"
  echo "## Checks" > "$report"
  step() {
    local name=$1; shift
    echo "::group::$name"
    if "$@" 2>&1 | tee -a "$log"; then
      echo "- ✅ $name" >> "$report"
    else
      echo "- ❌ $name" >> "$report"
      failed=1
    fi
    echo "::endgroup::"
  }
  step "vp install" vp install --no-frozen-lockfile
  step "pnpm-lock.yaml committed" git diff --quiet HEAD -- pnpm-lock.yaml
  step "electron runtime" vp run --filter @t3tools/desktop ensure:electron
  step "typecheck" vpr typecheck

  # vitest runs per package with the package's own `test` script flags.
  local files pkg rel extra
  files=$(touched_files | grep -E '\.(ts|tsx|mts|cts)$' || true)
  for pkg in $(printf '%s\n' "$files" | grep -oE '^(apps|packages)/[^/]+' | sort -u); do
    extra=$(node -p "(require('./$pkg/package.json').scripts?.test || '')" 2>/dev/null)
    case "$extra" in "vp test run"*) extra=${extra#vp test run} ;; *) continue ;; esac
    extra=${extra//--passWithNoTests/}
    rel=$(printf '%s\n' "$files" | grep "^$pkg/" | sed "s|^$pkg/||")
    # shellcheck disable=SC2086
    step "tests related to $(echo "$rel" | wc -l | tr -d ' ') changed files in $pkg" \
      bash -c 'cd "$1" && shift && vp test related --run --passWithNoTests "$@"' _ "$pkg" $extra $rel
  done
  return $failed
}

cmd_guards() {
  local report="$SYNC_DIR/guards.md" failed=0 m
  echo "## Guards" > "$report"
  fail() { echo "- ❌ $*" >> "$report"; failed=1; }
  ok() { echo "- ✅ $*" >> "$report"; }

  m=$(merge_commit)
  if [ -n "$m" ] && [ "$(git rev-parse "$m^1" 2>/dev/null)" = "$FORK_SHA" ] &&
    [ "$(git rev-parse "$m^2" 2>/dev/null)" = "$(git rev-parse "$TARGET")" ]; then
    ok "merge commit of fork and upstream, no rebase"
  else
    fail "HEAD is not fork + a merge commit of upstream (+ fixes)"
  fi
  [ -n "$m" ] && [ -n "$(git rev-list --merges "$m..HEAD")" ] && fail "extra merge commits after the sync merge"

  if [ -n "$(git ls-files -u)" ] || git rev-parse -q --verify MERGE_HEAD >/dev/null; then
    fail "the merge is not committed or has unmerged files"
  fi

  local markers
  markers=$(changed "$FORK_SHA" HEAD | while read -r f; do
    git grep -a -l -E '^(<<<<<<<|>>>>>>>)( |$)' HEAD -- "$f" 2>/dev/null
  done | sed 's/^HEAD://')
  if [ -n "$markers" ]; then fail "conflict markers in: $(echo $markers)"; else ok "no conflict markers"; fi

  # A file the fork has may only disappear when upstream removed it.
  local dropped
  dropped=$(comm -23 <(git ls-tree -r --name-only "$FORK_SHA" | sort) <(git ls-tree -r --name-only HEAD | sort) |
    while read -r f; do
      if [ -n "$(git ls-tree "$TARGET" -- "$f")" ] || [ -z "$(git ls-tree "$BASE" -- "$f")" ]; then echo "$f"; fi
    done)
  if [ -n "$dropped" ]; then fail "fork files deleted: $(echo $dropped)"; else ok "no fork files deleted"; fi

  skips() {
    git grep -a -c -E '(^|[^A-Za-z0-9_])(it|test|describe)\.(skip|only|todo)\(' "$1" 2>/dev/null |
      awk -F: '{ s += $NF } END { print s + 0 }'
  }
  local allowed=$(($(skips "$FORK_SHA") + $(skips "$TARGET") - $(skips "$BASE"))) now
  now=$(skips HEAD)
  if [ "$now" -gt "$allowed" ]; then fail "skipped/only tests: $now, both sides have $allowed"; else ok "no new skipped tests"; fi

  return $failed
}

cmd_audit() {
  local report="$SYNC_DIR/audit.md" f lost total=0 rows=""
  for f in $(changed --diff-filter=AM "$BASE" "$FORK_SHA" -- . ':!pnpm-lock.yaml'); do
    [ -z "$(git ls-tree HEAD -- "$f")" ] && continue
    lost=$(git diff -U0 "$BASE" "$FORK_SHA" -- "$f" | grep -a '^+[^+]' | cut -c2- |
      awk 'length($0) - gsub(/[[:space:]]/, "&") >= 4' | sort -u |
      grep -a -vxFf <(git show "HEAD:$f") | wc -l | tr -d ' ')
    if [ "$lost" -gt 0 ]; then
      total=$((total + lost))
      rows+="| \`$f\` | $lost |"$'\n'
    fi
  done
  {
    echo "## Fork lines not in the result"
    echo
    if [ "$total" -eq 0 ]; then
      echo "Every line the fork added is still there."
    else
      echo "$total lines the fork added are missing verbatim. Upstream rewrites and reformatting cause some; check that the features still exist."
      echo
      echo "| File | Lines |"
      echo "| --- | --- |"
      printf '%s' "$rows" | sort -t'|' -k3 -nr | head -40
    fi
  } > "$report"
  [ "$total" -le "${AUDIT_MAX_LOST:-50}" ]
}

cmd_verify() {
  local failed=0
  cmd_checks || failed=1
  cmd_guards || failed=1
  cmd_audit || failed=1
  return $failed
}

# The push token may write workflows, so the sync may change a .github file only
# to exactly upstream's version of it.
cmd_workflows() {
  local f bad=""
  for f in $(changed "$FORK_SHA" HEAD -- .github); do
    [ "$(git rev-parse -q --verify "HEAD:$f")" = "$(git rev-parse -q --verify "$TARGET:$f")" ] || bad+=" $f"
  done
  if [ -n "$bad" ]; then
    echo "The sync changed .github files away from upstream's version:$bad"
    return 1
  fi
}

"cmd_${1:?command}"
