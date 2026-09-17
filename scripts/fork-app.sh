#!/bin/zsh
# Runs this fork's desktop app as a prebuilt production build, with no
# installation and no dev server. Builds live outside the checkout in
# $T3CODE_FORK_APP_ROOT (default ~/Documents/private/t3code-app):
#
#   current/  the build the running app uses
#   next/     a prepared build, waiting for a restart
#   staging/  where `prepare` builds; recycled from the previous `current`
#   home/     app state (T3CODE_HOME): settings and the saved service connection
#
# The app keeps its local environment off and talks to the machine's t3
# background service, so restarting it never stops agents.
#
#   scripts/fork-app.sh prepare   build this checkout (including uncommitted
#                                 changes) into next/ — agents run this
#   scripts/fork-app.sh restart   switch to next/ if one is prepared, then
#                                 relaunch — the user runs this, or clicks the
#                                 app's update button
#   scripts/fork-app.sh start | stop | status
set -euo pipefail

SCRIPT_REPO="${0:A:h:h}"
ROOT="${T3CODE_FORK_APP_ROOT:-$HOME/Documents/private/t3code-app}"
HOME_DIR="$ROOT/home"
LOG_DIR="$ROOT/logs"
NODE_MAJOR=26
PNPM="pnpm@11.10.0"

mkdir -p "$ROOT" "$HOME_DIR/userdata" "$LOG_DIR"

use_node() {
  if [[ "$(node -v 2>/dev/null)" != v$NODE_MAJOR.* ]]; then
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    source "$NVM_DIR/nvm.sh" >/dev/null
    nvm use "$NODE_MAJOR" >/dev/null
  fi
}

# mkdir-based lock; waits while another holder is alive, steals a dead one.
acquire_lock() {
  local lock="$ROOT/.$1.lock"
  while ! mkdir "$lock" 2>/dev/null; do
    local holder
    holder="$(cat "$lock/pid" 2>/dev/null || true)"
    if [[ -n "$holder" ]] && ! kill -0 "$holder" 2>/dev/null; then
      rm -rf "$lock"
      continue
    fi
    echo "Waiting for another $1 (pid ${holder:-?}) …"
    sleep 3
  done
  echo $$ > "$lock/pid"
}

release_lock() {
  rm -rf "$ROOT/.$1.lock"
}

app_pids() {
  pgrep -f "apps/desktop/.electron-runtime/.*/MacOS/Electron dist-electron/main.cjs" || true
  pgrep -f "vp run start:desktop" || true
}

stop() {
  local pids
  pids="$(app_pids)"
  [[ -z "$pids" ]] && return
  echo "Stopping app …"
  kill ${(f)pids} 2>/dev/null || true
  for _ in {1..20}; do
    [[ -z "$(app_pids)" ]] && return
    sleep 0.5
  done
  kill -9 ${(f)"$(app_pids)"} 2>/dev/null || true
}

label_of() {
  sed -n 's/.*"label": *"\([^"]*\)".*/\1/p' "$1/.fork-build.json" 2>/dev/null
}

start() {
  if [[ ! -f "$ROOT/current/.fork-build.json" ]]; then
    echo "No build in $ROOT/current yet; run 'scripts/fork-app.sh prepare' first." >&2
    return 1
  fi
  use_node
  local settings="$HOME_DIR/userdata/desktop-settings.json"
  [[ -f "$settings" ]] || echo '{"localEnvironmentEnabled":false}' > "$settings"
  local log="$LOG_DIR/app.log"
  echo "Starting $(label_of "$ROOT/current") (log: $log) …"
  (
    cd "$ROOT/current"
    # Agents running inside T3 Code inherit the service launcher's context;
    # a child server that sees it refuses to start.
    unset VITE_DEV_SERVER_URL T3_SERVICE_LAUNCHER_CONTEXT T3_BOOT_SERVICE_UNIT
    export T3CODE_HOME="$HOME_DIR"
    export T3CODE_DESKTOP_USER_DATA_DIR_NAME=t3code-fork
    export T3CODE_DISABLE_AUTO_UPDATE=1
    export T3CODE_FORK_APP_ROOT="$ROOT"
    export T3CODE_FORK_APP_SCRIPT="$SCRIPT_REPO/scripts/fork-app.sh"
    # &! detaches the job from this shell so it outlives the script.
    nohup npx vp run start:desktop > "$log" 2>&1 &!
  )
  for _ in {1..60}; do
    if grep -q "main window created" "$log" 2>/dev/null; then
      echo "App window is open."
      return
    fi
    if [[ -z "$(app_pids)" ]]; then
      echo "App exited during startup; last log lines:" >&2
      tail -20 "$log" >&2
      return 1
    fi
    sleep 1
  done
  echo "App did not report a window within 60 s; check $log" >&2
  return 1
}

prepare() {
  local source_repo="$SCRIPT_REPO"
  acquire_lock prepare
  trap 'release_lock prepare' EXIT
  use_node

  local staging="$ROOT/staging"
  mkdir -p "$staging"
  rm -f "$staging/.fork-build.json"
  echo "Syncing $source_repo → $staging …"
  # Tracked and untracked source, minus everything gitignored. Excluded paths
  # (node_modules, dist) survive in the slot, so repeat builds stay fast.
  rsync -a --delete --exclude=.git --exclude=.fork-build.json \
    --filter=':- .gitignore' "$source_repo/" "$staging/"

  local branch commit sha dirty=""
  branch="$(git -C "$source_repo" rev-parse --abbrev-ref HEAD)"
  sha="$(git -C "$source_repo" rev-parse HEAD)"
  commit="${sha[1,7]}"
  [[ -n "$(git -C "$source_repo" status --porcelain)" ]] && dirty="+changes"
  local label="$branch@$commit$dirty $(date +%H:%M)"

  echo "Installing dependencies …"
  (cd "$staging" && npx -y "$PNPM" install --frozen-lockfile --prefer-offline)
  echo "Building $label …"
  (cd "$staging" && T3CODE_COMMIT_HASH="$sha" npx vp run build:desktop)

  printf '{"label": "%s", "commit": "%s", "source": "%s", "builtAt": "%s"}\n' \
    "$label" "$sha" "$source_repo" "$(date -u +%FT%TZ)" > "$staging/.fork-build.json"

  acquire_lock swap
  if [[ -d "$ROOT/next" ]]; then
    mv "$ROOT/next" "$ROOT/staging.recycle"
    mv "$staging" "$ROOT/next"
    mv "$ROOT/staging.recycle" "$staging"
  else
    mv "$staging" "$ROOT/next"
  fi
  release_lock swap
  echo "Prepared $label. The app's update button now offers it."
}

restart() {
  acquire_lock swap
  trap 'release_lock swap' EXIT
  stop
  if [[ -f "$ROOT/next/.fork-build.json" ]]; then
    if [[ -d "$ROOT/current" ]]; then
      if [[ -d "$ROOT/staging" ]]; then
        local trash="$ROOT/.trash-$$"
        mv "$ROOT/current" "$trash"
        (rm -rf "$trash" &!)
      else
        # The old build becomes the next staging area and keeps node_modules.
        mv "$ROOT/current" "$ROOT/staging"
      fi
    fi
    mv "$ROOT/next" "$ROOT/current"
  fi
  start
}

case "${1:-}" in
  prepare) prepare ;;
  restart) restart ;;
  start) stop && start ;;
  stop) stop ;;
  status)
    echo "app:     $([[ -n "$(app_pids)" ]] && echo running || echo stopped)"
    echo "current: $([[ -d "$ROOT/current" ]] && label_of "$ROOT/current" || echo none)"
    echo "next:    $([[ -d "$ROOT/next" ]] && label_of "$ROOT/next" || echo none)"
    ;;
  *) echo "usage: $0 prepare|restart|start|stop|status" >&2; exit 2 ;;
esac
