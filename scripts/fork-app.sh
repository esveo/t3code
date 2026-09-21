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
#
# Staying current with the fork branch, without touching the working checkout:
#
#   scripts/fork-app.sh watch-install     check every minute and build what
#                                         lands on origin/fork
#   scripts/fork-app.sh watch-uninstall   stop it
#   scripts/fork-app.sh watch             one such check, by hand
#
# `watch` fetches into this repo and builds from its own detached worktree in
# source/, so an agent's uncommitted work is never built or disturbed. It only
# prepares; switching stays the update button's job.
#
# Features with a server side need the fork's server too, because the app only
# ever talks to the machine's t3 service:
#
#   scripts/fork-app.sh prepare-server   build this checkout into a t3 runtime,
#                                        install it beside the release one and
#                                        point the service at it
#
# `prepare-server` never stops the running service: the child that serves the
# agents keeps running the version it started with, and the new one takes over
# at the next restart that happens anyway. Undo by putting the previous version
# back into ~/.t3/runtime/service-state.json; the release runtime stays
# installed.
set -euo pipefail

# The watcher loop runs from a copy of this script (see watch_install), so the
# repo it works on is handed over rather than derived from the copy's path.
SCRIPT_REPO="${T3CODE_FORK_REPO:-${0:A:h:h}}"
ROOT="${T3CODE_FORK_APP_ROOT:-$HOME/Documents/private/t3code-app}"
HOME_DIR="$ROOT/home"
LOG_DIR="$ROOT/logs"
NODE_MAJOR=26
PNPM="pnpm@11.10.0"

mkdir -p "$ROOT" "$HOME_DIR/userdata" "$LOG_DIR"

# A restart without a terminal comes from the app's update button or the
# Finder launcher; nobody sees its output, so keep a log.
if [[ ! -t 1 && "${1:-}" == restart ]]; then
  exec >>"$LOG_DIR/fork-app.log" 2>&1
  echo "--- $(date '+%F %T') fork-app.sh ${1:-} (pid $$, parent $PPID)"
fi

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
  # -a: when the app's update button runs this script, the app is our
  # ancestor, which pgrep would otherwise leave out.
  pgrep -af "apps/desktop/.electron-runtime/.*/MacOS/Electron dist-electron/main.cjs" || true
  pgrep -af "vp run start:desktop" || true
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
  resume_watch
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

# The name a build carries. `watch` builds from a detached worktree, where
# HEAD has no branch of its own; the ref it was checked out from names it.
branch_of() {
  local repo="$1" branch
  branch="$(git -C "$repo" rev-parse --abbrev-ref HEAD)"
  if [[ "$branch" == HEAD ]]; then
    branch="$(git -C "$repo" for-each-ref --points-at HEAD --count 1 \
      --format='%(refname:short)' refs/remotes/origin refs/heads)"
  fi
  echo "${branch:-detached}"
}

commit_of() {
  sed -n 's/.*"commit": *"\([^"]*\)".*/\1/p' "$1/.fork-build.json" 2>/dev/null
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
  branch="$(branch_of "$source_repo")"
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

# Builds a t3 runtime from this checkout and makes it the service's active
# version. Mirrors the release pipeline (single-executable, web client,
# resource monitor, runtime externals) so the result is layout-identical to an
# installed release.
prepare_server() {
  local source_repo="$SCRIPT_REPO"
  acquire_lock prepare
  trap 'release_lock prepare' EXIT
  use_node

  local runtime_dir="$HOME/.t3/runtime"
  local state="$runtime_dir/service-state.json"
  [[ -f "$state" ]] || { echo "No t3 service state at $state." >&2; return 1; }

  local branch sha commit slug version
  branch="$(branch_of "$source_repo")"
  sha="$(git -C "$source_repo" rev-parse HEAD)"
  commit="${sha[1,7]}"
  # Semver prerelease identifiers allow [0-9A-Za-z-] only.
  slug="$(echo "$branch" | tr -c '[:alnum:]-' '-' | sed 's/-\{2,\}/-/g; s/^-//; s/-$//')"
  # The base is one patch above the checkout's server version, so the fork
  # outranks the release it came from and a later official release outranks
  # the fork. The service refuses to start a child whose own version differs
  # from the directory it was started from, so this string has to be baked
  # into the build.
  local base
  base="$(node -e "const v=require('$source_repo/apps/server/package.json').version.split('.');console.log([v[0],v[1],Number(v[2])+1].join('.'))")"
  version="$base-fork.$slug.$commit"

  local staging="$ROOT/staging"
  mkdir -p "$staging"
  rm -f "$staging/.fork-build.json"
  echo "Syncing $source_repo → $staging …"
  rsync -a --delete --exclude=.git --exclude=.fork-build.json \
    --filter=':- .gitignore' "$source_repo/" "$staging/"

  node -e "const fs=require('fs');const p='$staging/apps/server/package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.version='$version';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"

  echo "Installing dependencies …"
  (cd "$staging" && npx -y "$PNPM" install --frozen-lockfile --prefer-offline)
  # Both the packer and the archive builder spawn a bare `vp`, which lives only
  # in the workspace bin dir.
  export PATH="$staging/node_modules/.bin:$PATH"

  local target_key rust_target
  case "$(uname -m)" in
    arm64|aarch64) target_key=darwin-arm64; rust_target=aarch64-apple-darwin ;;
    *) target_key=darwin-x64; rust_target=x86_64-apple-darwin ;;
  esac

  echo "Building web client …"
  (cd "$staging" && T3CODE_COMMIT_HASH="$sha" npx vp run --filter t3 build)
  echo "Building single-executable ($target_key) …"
  (cd "$staging" && T3CODE_COMMIT_HASH="$sha" \
    node apps/server/scripts/cli.ts build-exe --target "$target_key")

  # The release job hands the archive a directory keyed by platform-arch; the
  # checked-out Rust build is the same binary, so reuse it when it is there.
  local monitor_root="$staging/.fork-resource-monitor"
  rm -rf "$monitor_root"
  mkdir -p "$monitor_root/$target_key"
  # `target/` is gitignored, so it never reaches staging; the checkout's own
  # build is the same source at the same commit. Cargo is only the fallback,
  # and it is not installed on every machine that runs this.
  local monitor="$source_repo/native/resource-monitor/target/$rust_target/release/t3-resource-monitor"
  if [[ ! -x "$monitor" ]]; then
    if ! command -v cargo >/dev/null; then
      echo "No resource monitor at $monitor and no cargo to build one." >&2
      echo "Run 'npx vp run build:resource-monitor' in the checkout, then retry." >&2
      return 1
    fi
    echo "Building resource monitor …"
    (cd "$source_repo" && cargo build --locked --release \
      --manifest-path native/resource-monitor/Cargo.toml)
  fi
  cp "$monitor" "$monitor_root/$target_key/t3-resource-monitor"

  echo "Packaging runtime $version …"
  rm -rf "$staging/release-cli"
  (cd "$staging" && node scripts/build-cli-archive.ts \
    --platform mac --arch "${target_key##*-}" --version "$version" \
    --resource-monitor-dir "$monitor_root" --output-dir release-cli)

  local archive
  archive="$(echo "$staging"/release-cli/*.tar.gz)"
  [[ -f "$archive" ]] || { echo "No archive was produced." >&2; return 1; }

  local target="$runtime_dir/versions/$version"
  echo "Installing into $target …"
  rm -rf "$target"
  mkdir -p "$target"
  tar -xzf "$archive" -C "$target" --strip-components 1
  [[ -x "$target/t3" ]] || { echo "Extracted runtime has no t3 executable." >&2; rm -rf "$target"; return 1; }
  printf '%s\n' "$version" > "$target/.install-complete"

  local previous
  previous="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$state','utf8')).activeVersion)")"
  node -e "const fs=require('fs');const s='$state';const j=JSON.parse(fs.readFileSync(s,'utf8'));j.activeVersion='$version';fs.writeFileSync(s+'.fork-tmp',JSON.stringify(j,null,2)+'\n');fs.renameSync(s+'.fork-tmp',s)"
  printf '%s\n' "$previous" > "$runtime_dir/.fork-previous-version"

  echo
  echo "Installed $version ($branch@$commit) and set it active."
  echo "The running service keeps serving agents on $previous; the fork server"
  echo "takes over at the next service restart, which nothing here triggers."
  echo "To go back: put \"activeVersion\": \"$previous\" into $state."
}

WATCH_BRANCH="${T3CODE_FORK_WATCH_BRANCH:-fork}"
WATCH_INTERVAL="${T3CODE_FORK_WATCH_INTERVAL:-60}"
WATCH_SOURCE="$ROOT/source"
WATCH_PID="$ROOT/.watch.pid"
WATCH_LOG="$LOG_DIR/fork-watch.log"
# Present while watching is wanted, so `start` can bring the loop back after a
# reboot or logout ended it.
WATCH_WANTED="$ROOT/.watch-wanted"

# One pass: pick up what was pushed to the fork branch and build it, unless
# that commit is already built. Never touches the working checkout beyond the
# fetch — it builds from its own detached worktree.
watch_once() {
  git -C "$SCRIPT_REPO" fetch --quiet origin "$WATCH_BRANCH" || {
    echo "$(date '+%F %T') fetch failed; trying again next pass" >&2
    return 0
  }
  local remote
  remote="$(git -C "$SCRIPT_REPO" rev-parse "origin/$WATCH_BRANCH")"
  if [[ "$remote" == "$(commit_of "$ROOT/next")" || "$remote" == "$(commit_of "$ROOT/current")" ]]
  then
    return 0
  fi
  if [[ ! -e "$WATCH_SOURCE/.git" ]]; then
    rm -rf "$WATCH_SOURCE"
    git -C "$SCRIPT_REPO" worktree add --detach "$WATCH_SOURCE" "$remote" >/dev/null
  fi
  # --force: the worktree is ours alone, so whatever a failed build left in it
  # gives way to the commit being built.
  git -C "$WATCH_SOURCE" checkout --detach --force "$remote" >/dev/null 2>&1
  echo "$(date '+%F %T') origin/$WATCH_BRANCH moved to ${remote[1,7]}; building …"
  # Without -u the loop's own repo override would reach the build and make it
  # use the working checkout — the one thing this worktree exists to avoid.
  env -u T3CODE_FORK_REPO "$WATCH_SOURCE/scripts/fork-app.sh" prepare
}

# Prints the running watcher's pid, or nothing. Always succeeds: `set -e`
# would end the script on a plain "not running".
watch_pid() {
  local pid
  pid="$(cat "$WATCH_PID" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "$pid"
  fi
  return 0
}

watch_loop() {
  echo $$ > "$WATCH_PID"
  trap 'rm -f "$WATCH_PID"' EXIT
  echo "$(date '+%F %T') watching origin/$WATCH_BRANCH every ${WATCH_INTERVAL}s (pid $$)"
  while true; do
    watch_once || true
    sleep "$WATCH_INTERVAL"
  done
}

# A launchd agent would be the obvious home for this, but launchd jobs are
# denied the Documents folder this fork lives in, so the loop runs as a plain
# detached process started from the user's session instead. It survives closing
# the terminal, not logging out; `start` resumes it (see resume_watch).
watch_install() {
  local pid
  touch "$WATCH_WANTED"
  pid="$(watch_pid)"
  if [[ -n "$pid" ]]; then
    echo "Already watching origin/$WATCH_BRANCH (pid $pid, log: $WATCH_LOG)."
    return
  fi
  rm -f "$WATCH_PID"
  # From a copy: the loop lives for days, and zsh reads a script as it runs, so
  # editing the checkout's copy underneath it would corrupt the running loop.
  cp "$SCRIPT_REPO/scripts/fork-app.sh" "$ROOT/.watch-loop.zsh"
  T3CODE_FORK_REPO="$SCRIPT_REPO" nohup /bin/zsh "$ROOT/.watch-loop.zsh" watch-loop \
    >>"$WATCH_LOG" 2>&1 &!
  for _ in {1..20}; do
    pid="$(watch_pid)"
    [[ -n "$pid" ]] && break
    sleep 0.2
  done
  if [[ -z "$pid" ]]; then
    echo "The watcher did not start; see $WATCH_LOG" >&2
    return 1
  fi
  echo "Watching origin/$WATCH_BRANCH every ${WATCH_INTERVAL}s (pid $pid, log: $WATCH_LOG)."
  echo "New commits are built into next/; the app's update button offers them."
}

# Restarts a wanted watcher that a reboot or logout ended. Called by `start`,
# which every way of opening the app goes through.
resume_watch() {
  [[ -f "$WATCH_WANTED" && -z "$(watch_pid)" ]] || return 0
  watch_install || echo "Could not resume watching origin/$WATCH_BRANCH; see $WATCH_LOG" >&2
}

watch_uninstall() {
  local pid
  pid="$(watch_pid)"
  [[ -n "$pid" ]] && kill "$pid" 2>/dev/null
  rm -f "$WATCH_PID" "$WATCH_WANTED"
  echo "Stopped watching origin/$WATCH_BRANCH."
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
  prepare-server) prepare_server ;;
  watch) watch_once ;;
  watch-loop) watch_loop ;;
  watch-install) watch_install ;;
  watch-uninstall) watch_uninstall ;;
  restart) restart ;;
  start) stop && start ;;
  stop) stop ;;
  status)
    echo "app:     $([[ -n "$(app_pids)" ]] && echo running || echo stopped)"
    echo "current: $([[ -d "$ROOT/current" ]] && label_of "$ROOT/current" || echo none)"
    echo "next:    $([[ -d "$ROOT/next" ]] && label_of "$ROOT/next" || echo none)"
    if [[ -n "$(watch_pid)" ]]; then
      echo "watch:   origin/$WATCH_BRANCH every ${WATCH_INTERVAL}s"
    elif [[ -f "$WATCH_WANTED" ]]; then
      echo "watch:   stopped (ended by a reboot or logout); resumes with the next start, or run watch-install"
    else
      echo "watch:   off"
    fi
    ;;
  *)
    echo "usage: $0 prepare|prepare-server|restart|start|stop|status" >&2
    echo "       $0 watch|watch-install|watch-uninstall" >&2
    exit 2
    ;;
esac
