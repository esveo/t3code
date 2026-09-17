---
name: fork-app
description: Build and (re)start this private fork's T3 Code desktop app from the checkout so the user can try a change. Use after implementing a feature in this fork when the user asks to restart, relaunch, rebuild, or "start the app", and whenever they say to implement something "and restart the app".
---

# Fork app

This checkout is a private fork of `pingdotgg/t3code` (`origin` = the fork,
`upstream` = the original; pushing to `upstream` is disabled). The user runs
the fork's desktop app as a production build straight from the checkout. The
app has its local environment turned off and is connected to the machine's
`t3` background service, which runs the agents. Restarting the app therefore
does not interrupt any agent, including you.

## Restart after a change

```sh
scripts/fork-app.sh restart
```

It builds first and only replaces the running app when the build succeeds.
Report the result, and on failure the relevant log lines from the script output
or `.t3/fork-app.log` in the main checkout.

Other commands: `start` (no build), `stop`, `build`, `status`.

## Rules

- Never stop, restart, update, or reconfigure the `t3` background service
  (`t3 service …`, `t3 update`, the LaunchAgent plist). It hosts every running
  agent. Never quit or replace `/Applications/T3 Code (Alpha).app`.
- Do not start `vp run dev`, `dev:desktop`, or a server against `~/.t3`; the
  fork app is the way to try changes. For isolated UI experiments follow the
  `test-t3-app` skill with its own `--home-dir`.
- Work in a worktree for anything larger than a small fix; it needs its own
  `npx pnpm@11.10.0 install` first. The script run from a worktree builds that
  worktree and replaces the running app; app state stays in the main
  checkout's `.t3`.
- Use Node 26 (`nvm use 26`) for every command, including `git commit`: the
  pre-commit hook fails under the shell's default Node 20. The script selects
  Node 26 itself.
- Scope checks to what you touched: typecheck the affected app
  (`cd apps/web && npx tsc --noEmit`), run the touched specs with
  `npx vp test run <files>`, and `npx vp lint <files>`. The prepare hook
  rewrites `pnpm-lock.yaml`; restore it with `git checkout pnpm-lock.yaml`
  unless dependencies really changed.
- Keep fork-only changes in new files where possible, so rebasing onto
  `upstream/main` stays conflict-free. Commit on a branch, never on `main`.
