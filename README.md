<p align="center">
  <img src="assets/fork/esveo-code-macos-icon.svg" width="112" alt="esveo code icon">
</p>

<h1 align="center">esveo code</h1>

<p align="center">
  esveo's fork of <a href="https://github.com/pingdotgg/t3code">T3 Code</a>, the harness harness for Claude Code, Codex and more.
</p>

<p align="center">
  <a href="#getting-started">Getting started</a> ·
  <a href="#features">Features</a> ·
  <a href="docs/fork/changelog.md">Changelog</a> ·
  <a href="https://github.com/pingdotgg/t3code">Upstream</a>
</p>

## Getting started

Setting up the app, the server and your clients is described in [docs/fork/setup.md](docs/fork/setup.md).

## Features

### Split view

Drag a thread next to the one you have open.

<p align="center">
  <img src="docs/fork/media/split-view.gif" alt="Dragging a second thread from the sidebar onto the right half of the chat" width="100%">
</p>

### Git graph

The repository's commit graph in the side panel. Click a commit to see its diff, or <kbd>⌘</kbd>-click a second one to diff the range.

<p align="center">
  <img src="docs/fork/media/git-graph.webp" alt="The git graph with a range diff between two commits" width="100%">
</p>

### Context, cost and cache

The composer shows context usage, the thread's cost and how long the prompt cache stays warm.

<table>
  <tr>
    <td width="33%"><img src="docs/fork/media/usage-context.webp" alt="Context tab of the usage popover"></td>
    <td width="33%"><img src="docs/fork/media/usage-cost.webp" alt="Cost tab of the usage popover"></td>
    <td width="33%"><img src="docs/fork/media/prompt-cache.webp" alt="Prompt cache timer tooltip"></td>
  </tr>
</table>

### Subagent chats

The Agents panel lists every subagent. Click one to open its chat, live while it runs.

<p align="center">
  <img src="docs/fork/media/subagent-chat.gif" alt="Opening the Agents panel and a subagent's chat" width="100%">
</p>

### Thread orchestration

A coordinator thread starts child threads in any project, waits for them and collects their results.

<p align="center">
  <img src="docs/fork/media/orchestration.gif" alt="A coordinator starts three child threads across three projects" width="100%">
</p>

### Agent stage

Watch every agent move between thinking, reading, editing, terminal and subagents.

<p align="center">
  <img src="docs/fork/media/agent-stage.gif" alt="The agent stage with several threads at work" width="100%">
</p>

### Thought trail

Read back the thinking behind any answer.

<p align="center">
  <img src="docs/fork/media/thinking-trail.webp" alt="The thought trail under an answer" width="80%">
</p>

### esveo themes

_esveo_ and _esveo Midnight_, each in light and dark.

<p align="center">
  <img src="docs/fork/media/themes.webp" alt="esveo Midnight in dark and light" width="100%">
</p>

### And more

- Threads, subagents and workflows survive a server restart.
- Two-line thread cards, grouped by project.
- Prompts lost to an early interrupt carry over to the next turn.
