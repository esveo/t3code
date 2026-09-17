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
- The user runs the fork's desktop app from this checkout and restarts it
  themselves.

## Finishing a feature

- **Never start, stop, restart, or rebuild the fork app yourself.** Do not run
  `scripts/fork-app.sh` (any command), `vp run build:desktop`,
  `vp run start:desktop`, or anything that kills its Electron processes.
  Rebuilding replaces the assets the running app loads and would break the
  user's session.
- When the feature is done, end with a short message: what changed, which
  branch and commit, what you verified, and that it is ready to try. The user
  then restarts the app with the "T3 Code Fork" launcher, which rebuilds first.
- If the feature lives in a worktree, say so and whether it still needs
  merging into the branch the main checkout has checked out; the launcher only
  builds the main checkout.

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
