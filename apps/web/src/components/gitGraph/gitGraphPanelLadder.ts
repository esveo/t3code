/**
 * One key drives the graph through the right panel: open it beside the thread,
 * give it the window, then put it away. Kept apart from ChatView so the cycle
 * can be read and tested without the panel around it.
 */
export type GitGraphPanelStep = "open" | "maximize" | "close";

export function nextGitGraphPanelStep(state: {
  /** The graph is the panel's active surface and the panel is open. */
  readonly showing: boolean;
  /** False in the sheet layout, which already covers the chat. */
  readonly canMaximize: boolean;
  readonly maximized: boolean;
}): GitGraphPanelStep {
  if (!state.showing) return "open";
  if (state.canMaximize && !state.maximized) return "maximize";
  return "close";
}
