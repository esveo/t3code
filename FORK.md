# Private fork

**This checkout is not the T3 Code project itself but Paul's private fork of
`pingdotgg/t3code`.** It exists to add features Paul wants for himself (for
example the split view in `apps/web/src/components/SplitThreadLayout.tsx`) on
top of upstream, which is rebased in regularly. `AGENTS.md` is upstream's
guide for its maintainers; follow it for code and architecture, but these
rules win wherever they differ.

- Remotes: `origin` = `github.com/Pawl-Patrol/t3code` (private), `upstream` =
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

## Finishing a feature

The user runs the fork's desktop app as a prebuilt build and switches to a new
one with the app's update button. Your job ends with that build prepared.

1. Commit your work (or leave it uncommitted if the user prefers; `prepare`
   includes uncommitted changes of the checkout it runs in).
2. Run `scripts/fork-app.sh prepare` from the checkout or worktree that holds
   the feature. It builds into `~/Documents/private/t3code-app/next` without
   touching the running app and takes one to two minutes. If it fails, fix the
   cause and run it again.
3. End with a short message: what changed, branch and commit, what you
   verified, and that the build is prepared, so the update button offers it.

- **Never run `scripts/fork-app.sh restart`, `start`, or `stop`**, never run
  `vp run start:desktop`, and never kill the app's Electron processes. The user
  decides when to switch.
- Only one prepared build waits at a time; a later `prepare` from another agent
  replaces it. Mention in your message if you know another agent is preparing.

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
- Keep fork-only changes in new files where possible, so rebasing onto
  `upstream/main` stays conflict-free. Commit on a branch, never on `main`.
  A worktree needs its own `npx pnpm@11.10.0 install` first.
