#!/bin/zsh
# Runs this fork's desktop app as a production build straight from the
# checkout: no installation, no dev server. The app keeps its local
# environment off (see .t3/userdata/desktop-settings.json) and talks to the
# machine's t3 background service, so restarting it never stops agents.
#
#   scripts/fork-app.sh restart   build, then replace the running app (default)
#   scripts/fork-app.sh start     start without building
#   scripts/fork-app.sh stop
#   scripts/fork-app.sh build
#   scripts/fork-app.sh status
set -euo pipefail

REPO="${0:A:h:h}"
# App state lives in the main checkout even when this runs from a worktree,
# so every build sees the same settings and saved service connection.
MAIN_REPO="$(git -C "$REPO" worktree list --porcelain | awk 'NR == 1 { print $2 }')"
STATE_HOME="$MAIN_REPO/.t3"
LOG_FILE="$STATE_HOME/fork-app.log"
NODE_MAJOR=26

use_node() {
  if [[ "$(node -v 2>/dev/null)" != v$NODE_MAJOR.* ]]; then
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    source "$NVM_DIR/nvm.sh" >/dev/null
    nvm use "$NODE_MAJOR" >/dev/null
  fi
}

app_pids() {
  # Any checkout's app: a restart from a worktree must replace the main one.
  pgrep -f "apps/desktop/.electron-runtime/.*/MacOS/Electron dist-electron/main.cjs" || true
  pgrep -f "vp run start:desktop" || true
}

build() {
  use_node
  echo "Building in $REPO …"
  (cd "$REPO" && npx vp run build:desktop)
  # The workspace prepare hook rewrites the lockfile; keep the tree clean.
  git -C "$REPO" checkout -q -- pnpm-lock.yaml 2>/dev/null || true
}

stop() {
  local pids
  pids="$(app_pids)"
  if [[ -z "$pids" ]]; then
    echo "App is not running."
    return
  fi
  echo "Stopping app …"
  kill ${(f)pids} 2>/dev/null || true
  for _ in {1..20}; do
    [[ -z "$(app_pids)" ]] && return
    sleep 0.5
  done
  kill -9 ${(f)"$(app_pids)"} 2>/dev/null || true
}

start() {
  use_node
  mkdir -p "$STATE_HOME/userdata"
  local settings="$STATE_HOME/userdata/desktop-settings.json"
  [[ -f "$settings" ]] || echo '{"localEnvironmentEnabled":false}' > "$settings"
  echo "Starting app from $REPO (log: $LOG_FILE) …"
  (
    cd "$REPO"
    # Agents running inside T3 Code inherit the service launcher's context;
    # a child server that sees it refuses to start.
    unset VITE_DEV_SERVER_URL T3_SERVICE_LAUNCHER_CONTEXT T3_BOOT_SERVICE_UNIT
    export T3CODE_HOME="$STATE_HOME"
    export T3CODE_DESKTOP_USER_DATA_DIR_NAME=t3code-fork
    export T3CODE_DISABLE_AUTO_UPDATE=1
    # &! detaches the job from this shell so it outlives the script.
    nohup npx vp run start:desktop > "$LOG_FILE" 2>&1 &!
  )
  for _ in {1..60}; do
    if grep -q "main window created" "$LOG_FILE" 2>/dev/null; then
      echo "App window is open."
      return
    fi
    if [[ -z "$(app_pids)" ]]; then
      echo "App exited during startup; last log lines:" >&2
      tail -20 "$LOG_FILE" >&2
      return 1
    fi
    sleep 1
  done
  echo "App did not report a window within 60 s; check $LOG_FILE" >&2
  return 1
}

case "${1:-restart}" in
  restart) build && stop && start ;;
  start) stop && start ;;
  stop) stop ;;
  build) build ;;
  status) [[ -n "$(app_pids)" ]] && echo "running" || echo "stopped" ;;
  *) echo "usage: $0 [restart|start|stop|build|status]" >&2; exit 2 ;;
esac
