#!/bin/zsh
# Runs this fork's desktop app as a prebuilt production build, with no
# installation and no dev server. Builds live outside the checkout in
# $T3CODE_FORK_APP_ROOT (default ~/Documents/private/t3code-app):
#
#   current/          the build the running app uses
#   builds/<branch>/  the newest build of each branch, waiting to be switched to
#   staging/          where `prepare` builds; recycled from a replaced build
#   home/             app state (T3CODE_HOME): settings and the saved service connection
#   servers/<branch>.json  the newest fork server built from each branch
#
# The app keeps its local environment off and talks to the machine's t3
# background service, so restarting it never stops agents.
#
#   scripts/fork-app.sh prepare           build this checkout (including uncommitted
#                                         changes) into builds/<branch>/, replacing
#                                         that branch's older build — agents run this
#   scripts/fork-app.sh restart <branch>  switch to that branch's build and relaunch;
#                                         the app's update menu runs this, beside
#                                         restart-service when the branch's server
#                                         differs from the one the service runs
#   scripts/fork-app.sh delete <branch>   remove a branch's build and server
#   scripts/fork-app.sh start | stop | status
#
# Features with a server side need the fork's server too, because the app only
# ever talks to the machine's t3 service:
#
#   scripts/fork-app.sh prepare-server    when the server changed since the branch's
#                                         last one built, build this checkout into a
#                                         t3 runtime and install it beside the
#                                         others; the service keeps running
#   scripts/fork-app.sh restart-service <version>
#                                         switch the service to that runtime
#                                         and restart it; running threads,
#                                         subagents and workflows continue after
#                                         it (Continue threads after restarts)
#
# Undo a server switch by putting the previous version back into
# ~/.t3/runtime/service-state.json; the release runtime stays installed.
#
# Staying current with the fork branch, without touching the working checkout:
#
#   scripts/fork-app.sh watch   fetch origin/fork and prepare the app and, when
#                               needed, the server for a new commit
#
# The running app runs `watch` every minute. It builds from its own detached
# worktree in source/, so an agent's uncommitted work is never built or
# disturbed, and it only prepares; switching stays the user's click.
set -euo pipefail

# `watch` builds the fork worktree in source/ with this script, so the slots
# it fills are the ones this script reads; the override names that worktree.
SCRIPT_REPO="${T3CODE_FORK_REPO:-${0:A:h:h}}"
ROOT="${T3CODE_FORK_APP_ROOT:-$HOME/Documents/private/t3code-app}"
HOME_DIR="$ROOT/home"
LOG_DIR="$ROOT/logs"
BUILDS_DIR="$ROOT/builds"
SERVERS_DIR="$ROOT/servers"
NODE_MAJOR=26
PNPM="pnpm@11.10.0"

mkdir -p "$ROOT" "$HOME_DIR/userdata" "$LOG_DIR" "$BUILDS_DIR" "$SERVERS_DIR"

# A restart without a terminal comes from the app's update button or the
# Finder launcher; nobody sees its output, so keep a log.
if [[ ! -t 1 && "${1:-}" == restart ]]; then
  exec >>"$LOG_DIR/fork-app.log" 2>&1
  echo "--- $(date '+%F %T') fork-app.sh ${*:-} (pid $$, parent $PPID)"
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

# A flat string field of a JSON file, or nothing.
json_field() {
  sed -n "s/.*\"$2\": *\"\\([^\"]*\\)\".*/\\1/p" "$1" 2>/dev/null | head -1 || true
}

label_of() {
  json_field "$1/.fork-build.json" label
}

commit_of() {
  json_field "$1/.fork-build.json" commit
}

# The directory name a branch's build and server go by. Doubles as the semver
# prerelease identifier of the server, which allows [0-9A-Za-z-] only.
slug_of() {
  echo "$1" | tr -c '[:alnum:]-' '-' | sed 's/-\{2,\}/-/g; s/^-//; s/-$//'
}

# The branch a build in a slot belongs to. Builds before slots were per branch
# carry only a label, which starts with the branch.
build_slug() {
  local branch
  branch="$(json_field "$1/.fork-build.json" branch)"
  [[ -n "$branch" ]] || branch="${$(label_of "$1")%%@*}"
  slug_of "${${branch:-unknown}#origin/}"
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

# The name a build carries. `watch` builds from a detached worktree, where
# HEAD has no branch of its own; the ref it was checked out from names it.
branch_of() {
  local repo="$1" branch
  branch="$(git -C "$repo" rev-parse --abbrev-ref HEAD)"
  if [[ "$branch" == HEAD ]]; then
    branch="$(git -C "$repo" for-each-ref --points-at HEAD --count 1 \
      --format='%(refname:short)' refs/remotes/origin refs/heads)"
    branch="${branch#origin/}"
  fi
  echo "${branch:-detached}"
}

# Whether the build in a slot is at, or past, the given commit.
build_contains() {
  local built
  built="$(commit_of "$1")"
  [[ -n "$built" ]] && git -C "$SCRIPT_REPO" merge-base --is-ancestor "$2" "$built" 2>/dev/null
}

# What a slot takes on disk, in bytes. Its node_modules is most of it, and
# pnpm clones that from its store, so deleting the slot frees somewhat less.
size_of() {
  echo $(( $(du -sk "$1" | cut -f1) * 1024 ))
}

# Builds from before sizes were recorded get theirs on the next watch pass.
measure_builds() {
  local slot
  for slot in "$BUILDS_DIR"/*(N/); do
    [[ -f "$slot/.fork-build.json" ]] || continue
    grep -q '"sizeBytes"' "$slot/.fork-build.json" && continue
    sed -i '' "s/}\$/, \"sizeBytes\": $(size_of "$slot")}/" "$slot/.fork-build.json"
  done
}

# Moves a finished directory out of the way without waiting for its removal.
discard() {
  local trash="$ROOT/.trash-$$-$RANDOM"
  mv "$1" "$trash"
  (rm -rf "$trash" &!)
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

  local branch slug commit sha dirty=""
  branch="$(branch_of "$source_repo")"
  slug="$(slug_of "$branch")"
  sha="$(git -C "$source_repo" rev-parse HEAD)"
  commit="${sha[1,7]}"
  [[ -n "$(git -C "$source_repo" status --porcelain)" ]] && dirty="+changes"
  local label="$branch@$commit$dirty $(date +%H:%M)"

  echo "Installing dependencies …"
  (cd "$staging" && npx -y "$PNPM" install --frozen-lockfile --prefer-offline)
  echo "Building $label …"
  (cd "$staging" && T3CODE_COMMIT_HASH="$sha" npx vp run build:desktop)

  printf '{"label": "%s", "branch": "%s", "commit": "%s", "dirty": %s, "source": "%s", "builtAt": "%s", "sizeBytes": %s}\n' \
    "$label" "$branch" "$sha" "$([[ -n "$dirty" ]] && echo true || echo false)" \
    "$source_repo" "$(date -u +%FT%TZ)" "$(size_of "$staging")" > "$staging/.fork-build.json"

  # The branch's older build becomes the next staging area and keeps its
  # node_modules; the swap is what the update menu sees, so it is atomic-ish.
  acquire_lock swap
  local slot="$BUILDS_DIR/$slug"
  if [[ -d "$slot" ]]; then
    mv "$slot" "$ROOT/staging.recycle"
    mv "$staging" "$slot"
    mv "$ROOT/staging.recycle" "$staging"
  else
    mv "$staging" "$slot"
  fi
  release_lock swap
  echo "Prepared $label into builds/$slug. The app's update menu now offers it."
}

# Builds a t3 runtime from this checkout and makes it the service's active
# version. Mirrors the release pipeline (single-executable, web client,
# resource monitor, runtime externals) so the result is layout-identical to an
# installed release.
RUNTIME_DIR="$HOME/.t3/runtime"
SERVICE_STATE="$RUNTIME_DIR/service-state.json"
# Written by the t3 CLI too; the launcher removes it when it starts, so it
# marks a switched version that the service has not picked up yet.
RESTART_PENDING="$RUNTIME_DIR/.restart-pending"
SERVER_STAGING="$ROOT/server-staging"

active_server_version() {
  json_field "$SERVICE_STATE" activeVersion
}

# Everything the t3 runtime is built from. The service also serves a web
# client, but the fork app carries its own, so client-only changes do not ask
# for a service restart.
SERVER_PATHS=(
  .
  ':(exclude)apps/web' ':(exclude)apps/desktop' ':(exclude)apps/mobile'
  ':(exclude)apps/marketing' ':(exclude)packages/client-runtime'
  ':(exclude)docs' ':(exclude)*.md' ':(exclude)scripts/fork-app.sh'
  ':(exclude).github' ':(exclude).repos'
)

# Builds this checkout into a t3 runtime when its server differs from the
# branch's last one built (or, before the first, from the one the service
# runs), and records the result in servers/<branch>.json. Never switches the
# service: that is restart-service, which the user triggers through the app's
# update menu.
prepare_server() {
  local source_repo="$SCRIPT_REPO"
  acquire_lock prepare-server
  trap 'release_lock prepare-server' EXIT
  use_node
  [[ -f "$SERVICE_STATE" ]] || { echo "No t3 service state at $SERVICE_STATE." >&2; return 1; }

  local branch slug sha commit
  branch="$(branch_of "$source_repo")"
  slug="$(slug_of "$branch")"
  sha="$(git -C "$source_repo" rev-parse HEAD)"
  commit="${sha[1,7]}"
  local server_info="$SERVERS_DIR/$slug.json"

  # The baseline is the server a switch to this branch would run: the
  # branch's newest server built, or the service's own version. Fork versions
  # end in their commit.
  local base_version base_commit
  base_version="$(json_field "$server_info" version)"
  [[ -n "$base_version" && -x "$RUNTIME_DIR/versions/$base_version/t3" ]] ||
    base_version="$(active_server_version)"
  base_commit=""
  [[ "$base_version" == *-fork.* ]] && base_commit="${base_version##*.}"
  if [[ -n "$base_commit" ]] &&
    git -C "$source_repo" rev-parse --verify --quiet "$base_commit^{commit}" >/dev/null &&
    git -C "$source_repo" diff --quiet "$base_commit" -- "${SERVER_PATHS[@]}"
  then
    write_server_info "$server_info" "$branch" "$base_version" "$sha" ""
    echo "The server is unchanged since $base_version; nothing to build."
    return
  fi

  # A launcher speaks one protocol with the child it starts. A bump needs the
  # launcher moved by hand (docs/fork/setup.md, step 4), so offering the new
  # server as a plain restart would crash-loop the service.
  local protocol running_protocol
  protocol="$(sed -n 's/.*SERVICE_LAUNCHER_PROTOCOL = \([0-9]*\).*/\1/p' \
    "$source_repo/apps/server/src/cloud/serviceProtocol.ts")"
  running_protocol="$(sed -n 's/.*"protocol": *\([0-9]*\).*/\1/p' "$SERVICE_STATE")"
  if [[ "$protocol" != "$running_protocol" ]]; then
    write_server_info "$server_info" "$branch" "$base_version" "$sha" \
      "The service launcher protocol changed ($running_protocol → $protocol). Move the launcher by hand as in docs/fork/setup.md, step 4."
    echo "Launcher protocol changed ($running_protocol → $protocol); not building the server." >&2
    return
  fi

  # The base is one patch above the checkout's server version, so the fork
  # outranks the release it came from and a later official release outranks
  # the fork. The service refuses to start a child whose own version differs
  # from the directory it was started from, so this string has to be baked
  # into the build.
  local base version
  base="$(node -e "const v=require('$source_repo/apps/server/package.json').version.split('.');console.log([v[0],v[1],Number(v[2])+1].join('.'))")"
  version="$base-fork.$slug.$commit"

  # Its own staging directory: the version is written into its package.json,
  # which must not reach an app build.
  local staging="$SERVER_STAGING"
  mkdir -p "$staging"
  echo "Syncing $source_repo → $staging …"
  rsync -a --delete --exclude=.git --filter=':- .gitignore' "$source_repo/" "$staging/"

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

  # The release job hands the archive a directory keyed by platform-arch. The
  # monitor rarely changes, so a checkout's own Rust build or the one the
  # service already ships serves; cargo is only the fallback, and it is not
  # installed on every machine that runs this.
  local monitor_root="$staging/.fork-resource-monitor"
  rm -rf "$monitor_root"
  mkdir -p "$monitor_root/$target_key"
  local checkout monitor=""
  checkout="$(git -C "$source_repo" rev-parse --path-format=absolute --git-common-dir)"
  checkout="${checkout:h}"
  local candidate
  for candidate in \
    "$source_repo/native/resource-monitor/target/$rust_target/release/t3-resource-monitor" \
    "$checkout/native/resource-monitor/target/$rust_target/release/t3-resource-monitor" \
    "$RUNTIME_DIR/versions/$(active_server_version)/resource-monitor/$target_key/t3-resource-monitor"
  do
    if [[ -x "$candidate" ]]; then monitor="$candidate"; break; fi
  done
  if [[ -z "$monitor" ]]; then
    if ! command -v cargo >/dev/null; then
      echo "No resource monitor found and no cargo to build one." >&2
      echo "Run 'npx vp run build:resource-monitor' in the checkout, then retry." >&2
      return 1
    fi
    echo "Building resource monitor …"
    (cd "$source_repo" && cargo build --locked --release \
      --manifest-path native/resource-monitor/Cargo.toml)
    monitor="$source_repo/native/resource-monitor/target/$rust_target/release/t3-resource-monitor"
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

  local target="$RUNTIME_DIR/versions/$version"
  echo "Installing into $target …"
  rm -rf "$target"
  mkdir -p "$target"
  tar -xzf "$archive" -C "$target" --strip-components 1
  [[ -x "$target/t3" ]] || { echo "Extracted runtime has no t3 executable." >&2; rm -rf "$target"; return 1; }
  printf '%s\n' "$version" > "$target/.install-complete"

  write_server_info "$server_info" "$branch" "$version" "$sha" ""
  prune_server_versions
  echo "Installed $version ($branch@$commit). The service keeps running"
  echo "$(active_server_version) until restart-service switches it."
}

write_server_info() {
  local file="$1" branch="$2" version="$3" sha="$4" blocked="$5"
  printf '{"version": "%s", "branch": "%s", "commit": "%s", "blocked": "%s", "builtAt": "%s"}\n' \
    "$version" "$branch" "$sha" "$blocked" "$(date -u +%FT%TZ)" > "$file.tmp"
  mv "$file.tmp" "$file"
}

# Each runtime is ~200 MB. Keeps release versions, the one the service runs,
# the one it ran before, every branch's newest, and the launcher's own.
prune_server_versions() {
  local keep=(
    "$(active_server_version)"
    "$(cat "$RUNTIME_DIR/.fork-previous-version" 2>/dev/null || true)"
  )
  local info
  for info in "$SERVERS_DIR"/*.json(N); do
    keep+=("$(json_field "$info" version)")
  done
  local plist="$HOME/Library/LaunchAgents/com.t3tools.t3code.service.plist"
  keep+=(${(f)"$(sed -n 's|.*/runtime/versions/\([^/<]*\)/.*|\1|p' "$plist" 2>/dev/null)"})
  local dir
  for dir in "$RUNTIME_DIR"/versions/*-fork.*(N/); do
    (( ${keep[(Ie)${dir:t}]} )) && continue
    echo "Removing unused server ${dir:t} …"
    rm -rf "$dir"
  done
}

# Switches the service to an installed fork server and restarts it. Running
# threads continue; only the user starts this, from the app's update menu.
restart_service() {
  local version="${1:-}"
  [[ -n "$version" ]] || { echo "usage: restart-service <version>" >&2; return 2; }
  [[ -x "$RUNTIME_DIR/versions/$version/t3" ]] ||
    { echo "Server $version is not installed; run prepare-server." >&2; return 1; }
  local previous
  previous="$(active_server_version)"
  if [[ "$previous" != "$version" ]]; then
    node -e "const fs=require('fs');const s='$SERVICE_STATE';const j=JSON.parse(fs.readFileSync(s,'utf8'));j.activeVersion='$version';fs.writeFileSync(s+'.fork-tmp',JSON.stringify(j,null,2)+'\n');fs.renameSync(s+'.fork-tmp',s)"
    printf '%s\n' "$previous" > "$RUNTIME_DIR/.fork-previous-version"
  fi
  # Stays behind if the restart fails, so the app keeps offering it.
  printf '%s\n' "$version" > "$RESTART_PENDING"
  echo "Restarting the t3 service on $version (was $previous) …"
  # The service lives in ~/.t3, not in the app's own home, and the CLI refuses
  # a unit that belongs to another base directory.
  env -u T3_SERVICE_LAUNCHER_CONTEXT -u T3_BOOT_SERVICE_UNIT T3CODE_HOME="$HOME/.t3" \
    "$RUNTIME_DIR/versions/$version/t3" service restart
}

WATCH_BRANCH="${T3CODE_FORK_WATCH_BRANCH:-fork}"
WATCH_SOURCE="$ROOT/source"

# One pass: prepare the app and the server for what was pushed to the fork
# branch, skipping whichever is already built for that commit. Never touches
# the working checkout beyond the fetch — it builds from its own detached
# worktree. The running app starts one every minute.
watch_once() {
  git -C "$SCRIPT_REPO" fetch --quiet origin "$WATCH_BRANCH" || {
    echo "$(date '+%F %T') fetch failed; trying again next pass" >&2
    return 0
  }
  measure_builds
  local remote slug app_built=0 server_built=0
  remote="$(git -C "$SCRIPT_REPO" rev-parse "origin/$WATCH_BRANCH")"
  slug="$(slug_of "$WATCH_BRANCH")"
  # The running build may already contain the branch's commit (a feature
  # branch merged from it, say); then the branch's own slot stays as it is.
  { build_contains "$BUILDS_DIR/$slug" "$remote" || build_contains "$ROOT/current" "$remote"; } &&
    app_built=1
  git -C "$SCRIPT_REPO" merge-base --is-ancestor "$remote" \
    "$(json_field "$SERVERS_DIR/$slug.json" commit)" 2>/dev/null && server_built=1
  (( app_built && server_built )) && return 0
  if [[ ! -e "$WATCH_SOURCE/.git" ]]; then
    rm -rf "$WATCH_SOURCE"
    git -C "$SCRIPT_REPO" worktree add --detach "$WATCH_SOURCE" "$remote" >/dev/null
  fi
  # --force: the worktree is ours alone, so whatever a failed build left in it
  # gives way to the commit being built.
  git -C "$WATCH_SOURCE" checkout --detach --force "$remote" >/dev/null 2>&1
  echo "$(date '+%F %T') origin/$WATCH_BRANCH is at ${remote[1,7]}; preparing …"
  (( app_built )) || T3CODE_FORK_REPO="$WATCH_SOURCE" "${0:A}" prepare
  (( server_built )) || T3CODE_FORK_REPO="$WATCH_SOURCE" "${0:A}" prepare-server
}

# Moves the running build back into its branch's slot, so the update menu can
# return to it, unless that branch has a newer build waiting; then the old one
# becomes the next staging area (keeping node_modules) or is thrown away.
retire_current() {
  [[ -d "$ROOT/current" ]] || return 0
  local slot="$BUILDS_DIR/$(build_slug "$ROOT/current")"
  if [[ -f "$ROOT/current/.fork-build.json" && ! -d "$slot" ]]; then
    mv "$ROOT/current" "$slot"
  elif [[ -d "$ROOT/staging" ]]; then
    discard "$ROOT/current"
  else
    mv "$ROOT/current" "$ROOT/staging"
  fi
}

restart() {
  local slug="${1:-}"
  acquire_lock swap
  trap 'release_lock swap' EXIT
  local build=""
  if [[ -n "$slug" ]]; then
    build="$BUILDS_DIR/$slug"
    [[ -f "$build/.fork-build.json" ]] || { echo "No build for $slug in $BUILDS_DIR." >&2; return 1; }
  elif [[ -f "$ROOT/next/.fork-build.json" ]]; then
    # An app from before builds were per branch still installs next/.
    build="$ROOT/next"
  fi
  stop
  if [[ -n "$build" ]]; then
    retire_current
    mv "$build" "$ROOT/current"
  fi
  start
}

delete_build() {
  local slug="${1:-}"
  [[ -n "$slug" ]] || { echo "usage: delete <branch>" >&2; return 2; }
  acquire_lock swap
  trap 'release_lock swap' EXIT
  local removed=0
  if [[ -d "$BUILDS_DIR/$slug" ]]; then
    discard "$BUILDS_DIR/$slug"
    removed=1
  fi
  if [[ -f "$SERVERS_DIR/$slug.json" ]]; then
    rm -f "$SERVERS_DIR/$slug.json"
    prune_server_versions
    removed=1
  fi
  (( removed )) && echo "Removed the build of $slug." || echo "No build of $slug to remove."
}

status() {
  echo "app:     $([[ -n "$(app_pids)" ]] && echo running || echo stopped)"
  echo "current: $([[ -d "$ROOT/current" ]] && label_of "$ROOT/current" || echo none)"
  local slot
  for slot in "$BUILDS_DIR"/*(N/); do
    echo "build:   ${slot:t}: $(label_of "$slot")"
  done
  echo "service: $(active_server_version)$([[ -f "$RESTART_PENDING" ]] && echo ", restart pending")"
  local info
  for info in "$SERVERS_DIR"/*.json(N); do
    echo "server:  ${${info:t}%.json}: $(json_field "$info" version)$([[ -n "$(json_field "$info" blocked)" ]] && echo " (blocked)")"
  done
}

case "${1:-}" in
  prepare) prepare ;;
  prepare-server) prepare_server ;;
  restart-service) restart_service "${2:-}" ;;
  watch) watch_once ;;
  restart) restart "${2:-}" ;;
  delete) delete_build "${2:-}" ;;
  start) stop && start ;;
  stop) stop ;;
  status) status ;;
  *)
    echo "usage: $0 prepare|restart [branch]|delete <branch>|start|stop|status|watch" >&2
    echo "       $0 prepare-server|restart-service <version>" >&2
    exit 2
    ;;
esac
