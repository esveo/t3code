# Private fork

**This checkout is not the T3 Code project itself but Paul's private fork of
`pingdotgg/t3code`.** It exists to add features Paul wants for himself (for
example the agent stage in `apps/web/src/components/agentStage/`) on
top of upstream, which is rebased in regularly. `AGENTS.md` is upstream's
guide for its maintainers; follow it for code and architecture, but these
rules win wherever they differ.

- Remotes: `origin` = `github.com/esveo/t3code` (private), `upstream` =
  `github.com/pingdotgg/t3code` (read-only; pushing is disabled). `gh` defaults
  to the fork. Never open issues, PRs, discussions, or comments on `upstream`,
  and never push there.
- Upstream's maintainer workflows do not apply: no releases, version bumps,
  changelogs, triage, PR evidence uploads, or CI babysitting. Commit on a
  feature branch; open a PR on the fork only when Paul asks.
- The user runs the fork's desktop app from prebuilt slots in
  `~/Documents/private/t3code-app` (see `scripts/fork-app.sh`) and switches
  builds themselves.
- Setting all of this up from a fresh checkout — app, server, service launcher,
  cloud config, client pairing — is written down in
  [docs/fork/setup.md](docs/fork/setup.md). Keep it accurate when the setup
  changes; it is the only place that records the traps.

## The `fork` branch

`fork` is what the user runs. Everything that should go live is merged into it,
and nothing else: feature work happens on its own branch, so several features
can be in flight without disturbing the build the user works in all day.

- Build features on a branch of their own, off `fork`. Never commit to `fork`
  directly, and never to `main`.
- A feature is live when it is merged into `fork` and a build prepared from
  `fork` (see below). Merge, do not rebase `fork` onto anything: its history is
  the record of what the user has been running.
- Only merge a feature the user asked to go live. Ask when in doubt — an
  unfinished branch in `fork` is a broken app for the rest of the day.
- Upstream reaches `fork` by itself: every morning at 06:00 the "Upstream-Sync"
  Copilot automation (repo → Agents → Automations) merges upstream's `main`,
  resolves conflicts, typechecks and opens a PR into `fork`, and
  `fork-copilot-automerge.yml` merges it on its next check (every 15 minutes
  until 09:00) when its title says it is green.
  What Copilot cannot resolve stays open as a PR that mentions Paul. Rebase
  feature branches onto `fork` to pick upstream up.

## Staying mergeable with upstream

Upstream keeps moving and gets rebased in regularly. Every line this fork adds
to a file upstream also edits is a conflict someone resolves by hand later, so
write changes with that merge in mind, not just with the current diff in mind.

- Prefer a new file over editing an existing one. A fork-only component, hook,
  or module costs nothing at merge time; twenty lines spread through an
  upstream file cost a conflict every time upstream touches it.
- A fork feature in the web app gets its own folder under
  `apps/web/src/components/<feature>/` holding its views, logic, tests and
  store (`agentStage/`, `gitGraph/`, `split/`). Only its mount points live in
  upstream folders.
- When an upstream file has to change, make the edit as small and as local as
  possible: one import plus one call site beats an inline block, and a wrapper
  around upstream's code beats a rewrite of it.
- Do not reformat, rename, or tidy upstream code along the way. Unrelated churn
  in an upstream file is pure merge cost.
- Keep the fork's parts recognizable, so a conflict is quick to resolve: group
  the change in one place instead of sprinkling it, and give it a name that
  makes clear it belongs to the fork.
- Mention in the handover when a change had to touch upstream files in a way
  that will likely conflict, so the next rebase is not a surprise.

## The board

Work on the fork is tracked on the project board
[esveo/projects/3](https://github.com/orgs/esveo/projects/3/views/1). Every
item is an issue in `esveo/t3code`, with the status `Ideen`, `In Arbeit` or
`Done`. Keep it current as you work, without being asked:

- **Starting a feature or fix:** find its issue on the board. If there is none,
  create one (German title, a sentence or two of body, like the existing ones)
  and add it to the board. Set it to `In Arbeit`.
- **Feature live:** once it is merged into `fork`, set it to `Done` and close
  the issue. A build prepared from a feature branch alone is not done.
- **Abandoned or paused:** move it back to `Ideen` with a comment on the issue
  saying why and which branch holds the work.
- **Ideas on the side:** when the user mentions something for later, add it as
  an issue in `Ideen` instead of losing it.
- Touch only the items of your own work, and only the primary agent updates
  the board, not its subagents. Name the issue in the handover.

```bash
# Create an issue and put it on the board (prints the item id)
gh issue create -R esveo/t3code --title "…" --body "…"
gh project item-add 3 --owner esveo --url <issue url> --format json --jq .id
# Item id of an existing issue
gh project item-list 3 --owner esveo --format json \
  --jq '.items[] | select(.content.number == <N>) | .id'
# Set the status: Ideen 8bc1201f, In Arbeit 312ea0df, Done 02ced7e8
gh project item-edit --project-id PVT_kwDOAmJGXc4BkTTD --id <item id> \
  --field-id PVTSSF_lADOAmJGXc4BkTTDzhjEWVE --single-select-option-id <option>
```

## Finishing a feature

The user runs the fork's desktop app as a prebuilt build and switches to a new
one with the app's update menu. Your job ends with that build prepared.

1. Commit your work on its feature branch (or leave it uncommitted if the user
   prefers; `prepare` includes uncommitted changes of the checkout it runs in).
2. When the feature should go live, list it in `README.md` first: a separate
   last commit on the feature branch (after any rebase, so the hashes stay)
   that adds one bullet of a single short sentence, followed by the feature's
   commits as links (`[abc1234](https://github.com/esveo/t3code/commit/<full sha>)`).
   Prefix bug fixes with `Fix:`. A fix to a feature already listed adds its
   commit to that feature's bullet instead of a new one.
3. Merge the feature into `fork` and prepare from there. Work the user has not
   asked to ship stays on its branch, and `prepare` from that branch is fine
   for trying it out — just say which branch the prepared build came from.
4. Run `scripts/fork-app.sh prepare` from the checkout or worktree that holds
   what should be built. It builds into
   `~/Documents/private/t3code-app/builds/<branch>`, replacing that branch's
   older build and touching neither the running app nor other branches'
   builds. It takes one to two minutes. If it fails, fix the cause and run it
   again.
5. Update the feature's board item (see [The board](#the-board)).
6. End with a short message: what changed, branch and commit, what you
   verified, and that the build is prepared, so the update menu offers it
   under its branch.

### Staying current with `fork`

While the app runs, it runs `scripts/fork-app.sh watch` every minute: that
fetches `origin/fork` and, when the branch moved, prepares the new commit —
the app into the `fork` slot, and the server with `prepare-server` when
anything the server is built from changed. The app's update menu then offers
the branch in one click: it restarts the service on the new server and the
app side by side, and running threads, subagents and workflows continue after
the service restart. The log is
`~/Documents/private/t3code-app/logs/fork-watch.log`.

It builds from its own detached worktree in
`~/Documents/private/t3code-app/source`, never from a working checkout, so
uncommitted work is neither built nor disturbed. It prepares only — switching
stays the user's click, for the app and for the service alike. Every branch
has a slot of its own, so a build prepared from a feature branch stays on
offer until the user installs it or deletes it from the menu.

- **Never run `scripts/fork-app.sh restart`, `restart-service`, `start`, or
  `stop`**, never run
  `vp run start:desktop`, and never kill the app's Electron processes. The user
  decides when to switch.
- A branch holds one waiting build; a later `prepare` from the same branch
  replaces it. Builds of other branches are never touched.

## Other rules

- Never stop, restart, update, or reconfigure the `t3` background service
  (`t3 service …`, `t3 update`, its LaunchAgent plist). It hosts every running
  agent. Never quit or replace `/Applications/T3 Code (Alpha).app`.
- Do not start `vp run dev`, `dev:desktop`, or a server against `~/.t3`. For
  isolated UI experiments follow the `test-t3-app` skill with its own
  `--home-dir`, and stop what you started before you finish.
- Use Node 26 (`nvm use 26`) for every command, including `git commit`: the
  pre-commit hook fails under the shell's default Node 20.
- Scope checks to what you touched: typecheck the affected app
  (`cd apps/web && npx tsc --noEmit`), run the touched specs with
  `npx vp test run <files>`, and `npx vp lint <files>`. The prepare hook
  rewrites `pnpm-lock.yaml`; restore it with `git checkout pnpm-lock.yaml`
  unless dependencies really changed.
- Commit on a feature branch, never on `fork` or `main`. A worktree needs its
  own `npx pnpm@11.10.0 install` first.
