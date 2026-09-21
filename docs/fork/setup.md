# Running this fork

This fork adds features on top of upstream T3 Code. Using them means running
two fork-built pieces:

- the **desktop app**, a prebuilt production build launched from outside the
  checkout, and
- the **server**, installed as an extra runtime next to the release one and
  picked up by the machine's `t3` background service.

Both install beside the official release rather than replacing it, and one
command puts you back on the release.

The app deliberately keeps its own local environment switched off and talks to
the background service instead, so restarting the app never stops running
agents. That also means a feature with a server side needs both halves built,
or the client asks for something the server cannot answer.

## Prerequisites

- **macOS.** `scripts/fork-app.sh` is zsh, and the server half edits a
  LaunchAgent. Linux would need the equivalent systemd work.
- **Node 26**, through nvm. The pre-commit hook fails under older Node, and the
  script switches to 26 on its own via `nvm use`.
- **pnpm 11.10.0**, invoked as `npx pnpm@11.10.0`. Do not use a different one:
  the build installs with `--frozen-lockfile`.
- **A working T3 Code release install, with its background service running.**
  See [install](../user/install.md) and [the background
  service](../user/background-service.md). This is not optional. The fork
  borrows two things from the release install: its `cloudflared` binary and its
  baked-in cloud configuration (see [step 4](#4-give-the-server-its-cloud-config)).
- **Rust/cargo**, or a prebuilt resource monitor. `prepare-server` reuses
  `native/resource-monitor/target/<triple>/release/t3-resource-monitor` from the
  checkout when it exists, then the one the running service ships, and falls
  back to cargo. `npx vp run build:resource-monitor` produces it once.

## 1. Check out and install

```bash
git clone https://github.com/<you>/t3code.git && cd t3code
npx pnpm@11.10.0 install
```

A git worktree needs its own `npx pnpm@11.10.0 install`.

## 2. Build and run the desktop app

```bash
scripts/fork-app.sh prepare
scripts/fork-app.sh restart
```

`prepare` builds the checkout — including uncommitted changes — into a staging
slot and promotes it to `next/`. `restart` swaps `next/` into `current/` and
relaunches. From then on the app's own update button runs `restart` for you, so
the usual loop is: `prepare`, then click update in the app.

Everything lives outside the checkout, under `$T3CODE_FORK_APP_ROOT`
(default `~/Documents/private/t3code-app`):

| Slot          | What it holds                                                          |
| ------------- | ---------------------------------------------------------------------- |
| `current/`    | the build the running app uses                                         |
| `next/`       | a prepared build waiting for a restart                                 |
| `staging/`    | where `prepare` builds; recycled from the previous `current`           |
| `home/`       | the app's own `T3CODE_HOME`: settings and the saved service connection |
| `server.json` | the newest fork server `prepare-server` built for the service          |

`scripts/fork-app.sh status` prints which build is where. Only one prepared
build waits at a time — a second `prepare` replaces it.

While it runs, the app checks `origin/fork` every minute
(`fork-app.sh watch`, logged to `logs/fork-watch.log`) and prepares new commits
from its own worktree: the app always, the server only when something it is
built from changed. The sidebar's update icon (and **Check for updates** when
nothing waits) installs both at once with `fork-app.sh update`: the service
switches to the new server and restarts while the app restarts beside it. With
**Settings → General → Continue threads after restarts** on (the default),
running threads, subagents and workflows continue after the service restart.

Note that `home/` is the app's state, separate from `~/.t3`, which belongs to
the background service. Your threads and projects live in the service's
`~/.t3/userdata`, not here.

## 3. Build and install the fork server

```bash
scripts/fork-app.sh prepare-server
```

This mirrors the release pipeline — single executable, web client, resource
monitor — and installs the result into
`~/.t3/runtime/versions/<version>`, where `<version>` is one patch above the
checkout's server version plus a branch-and-commit prerelease tag, for example
`0.0.43-fork.feat-git-graph.2763366`, and records it in `server.json` beside
the app slots. When the server is unchanged since the last one built, it builds
nothing.

It deliberately does not switch or restart anything: that is
`scripts/fork-app.sh restart-service`, which the app's update button runs once
the service is set up.

**On its own, this is not enough.** Two further steps are needed, and skipping
either one leaves you with a service that crash-loops or a server that cannot
reach T3 Connect.

## 4. Point the launcher at the fork, and give the server its cloud config

### Why the launcher has to move too

The LaunchAgent starts a _launcher_ process, which spawns the actual server as
its child, using `activeVersion` to decide which one. Launcher and child talk
over a versioned protocol, `SERVICE_LAUNCHER_PROTOCOL` in
[`serviceProtocol.ts`](../../apps/server/src/cloud/serviceProtocol.ts). Neither
side can read the other's startup context or state file across a protocol bump.

So if the fork is built from a newer upstream than the installed release, an
old launcher spawning the fork child dies immediately with:

```
ServiceLauncherClientError: The service launcher supplied invalid startup context.
```

and the service crash-loops every five seconds. The plist picks the launcher and
`service-state.json` picks its child; both have to name a build that speaks the
same protocol.

Upstream's own update path never hits this: `t3 update` runs a preflight against
the staged binary and refuses a build that needs a newer launcher. See
[server updates](../internals/server-updates.md). `prepare-server` bypasses that
check, which is why the launcher is yours to move.

### Why the cloud config has to be supplied

Release binaries get the relay URL, the Clerk publishable key and the CLI OAuth
client id baked in at build time, as the `__T3CODE_BUILD_*` defines in
[`publicConfig.ts`](../../apps/server/src/cloud/publicConfig.ts). The fork build
has none of them, because those values are injected by upstream's release
pipeline.

Without them the server still starts and still serves the local web app, but
T3 Connect stays dark: no managed tunnel, no access from the phone or from
app.t3.codes, no GitHub-account sign-in. The failure is quiet — the server logs
no error, it simply never starts a relay client.

Each value is read from the runtime environment first, so passing them to the
service is enough; no rebuild is needed. They are public values that ship in
every release, so take them from your own installed release binary rather than
copying them from anywhere else.

### Doing both

`FORK` is the version `prepare-server` just built, and `PROTOCOL` is read from
the source the fork was built from, so the two always agree:

```bash
FORK=$(python3 -c "import json;print(json.load(open('$HOME/Documents/private/t3code-app/server.json'))['version'])")
PROTOCOL=$(sed -n 's/.*SERVICE_LAUNCHER_PROTOCOL = \([0-9]*\).*/\1/p' apps/server/src/cloud/serviceProtocol.ts)
RELEASE=<your installed release version, e.g. 0.0.42>
PLIST="$HOME/Library/LaunchAgents/com.t3tools.t3code.service.plist"
PB=/usr/libexec/PlistBuddy
```

Keep a way back before touching anything:

```bash
mkdir -p ~/.t3/runtime/.fork-launcher-backup
cp "$PLIST" ~/.t3/runtime/.fork-launcher-backup/plist.$RELEASE
cp ~/.t3/runtime/service-state.json ~/.t3/runtime/.fork-launcher-backup/service-state.json.$RELEASE
```

Read the three cloud values out of the release binary:

```bash
strings -n 6 "$HOME/.t3/runtime/versions/$RELEASE/t3" | grep -E '^const buildTime(RelayUrl|ClerkPublishableKey|ClerkCliOAuthClientId)'
```

Stop the service, move both halves, add the cloud config, start it again:

```bash
launchctl bootout "gui/$(id -u)/com.t3tools.t3code.service"
sed -i '' "s|versions/$RELEASE/t3|versions/$FORK/t3|g; s|versions/$RELEASE<|versions/$FORK<|g" "$PLIST"
printf '{\n  "protocol": %s,\n  "activeVersion": "%s"\n}\n' "$PROTOCOL" "$FORK" > ~/.t3/runtime/service-state.json
"$PB" -c "Add :EnvironmentVariables:T3CODE_RELAY_URL string <relay url>" "$PLIST"
"$PB" -c "Add :EnvironmentVariables:T3CODE_CLERK_PUBLISHABLE_KEY string <publishable key>" "$PLIST"
"$PB" -c "Add :EnvironmentVariables:T3CODE_CLERK_CLI_OAUTH_CLIENT_ID string <client id>" "$PLIST"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
```

A wrong `protocol` makes the launcher reject its own state as "invalid or
unsupported", so run these from the checkout the fork was built from — that is
where the `PROTOCOL` line reads the right number.

Verify:

```bash
curl -s http://127.0.0.1:3773/.well-known/t3/environment | python3 -m json.tool | head -20
pgrep -fl cloudflared
```

The descriptor should report the fork's `serverVersion`, and a `cloudflared
tunnel run` process should appear within a few seconds. If it does not, the
cloud config did not take.

## 5. Connect the client

The service normally listens on `127.0.0.1:3773`. It falls back to an ephemeral
port when 3773 is busy — which happens when a previous child is still shutting
down — and clients remember whatever address they paired with. A client stuck
in "Reconnecting" on an unfamiliar high port has a stale saved address; the
server cannot correct it, because the client sets it at pairing time.

Check the current one:

```bash
cat ~/.t3/userdata/server-runtime.json
```

Mint a pairing token against the running service:

```bash
T3CODE_HOME=~/.t3 ~/.t3/runtime/versions/$FORK/t3 pair --label "Desktop app"
```

In the app, under Settings → Connections, paste the printed pairing URL into the
**Host** field of **Add environment** — it fills in both the host and the code.
A saved environment's address cannot be edited, so a stale one has to be removed
via its `···` menu first. Removing it forgets only this device's cached copy;
threads live on the server and come back on reconnect.

Phones and app.t3.codes need no pairing. They reach the environment through the
managed tunnel and the T3 account, which is why step 4's cloud config matters.

## Going back to the release

Both halves have to move together again:

```bash
launchctl bootout "gui/$(id -u)/com.t3tools.t3code.service"
cp ~/.t3/runtime/.fork-launcher-backup/plist.$RELEASE "$PLIST"
cp ~/.t3/runtime/.fork-launcher-backup/service-state.json.$RELEASE ~/.t3/runtime/service-state.json
launchctl bootstrap "gui/$(id -u)" "$PLIST"
```

The release runtime is never removed, so this always has something to return to.
For the app, `scripts/fork-app.sh stop` is enough; the official
`/Applications/T3 Code*.app` is untouched throughout.

## Rebuilding later

For the app: `scripts/fork-app.sh prepare`, then the update button.

For the server: `scripts/fork-app.sh prepare-server`, then the same update
button. Both happen on their own for commits pushed to `origin/fork`. The plist
and the cloud environment variables stay valid and do not need redoing —
unless a rebase brings a `SERVICE_LAUNCHER_PROTOCOL` bump, in which case step 4
has to be repeated, because the plist would still name a launcher speaking the
old protocol. `prepare-server` notices that bump, builds nothing, and records
why in `server.json`; the update button then offers only the app, and
`logs/fork-watch.log` points here.
