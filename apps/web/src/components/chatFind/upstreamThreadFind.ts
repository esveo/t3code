/**
 * Fork: esveo code keeps its own find on Mod+F, scoped to one split pane and
 * listing its matches. Upstream's server-backed thread find listens on a global
 * bus and would open in every split pane at once, so it stays off until it is
 * ported to panes. Every upstream entry point checks this flag.
 */
export const UPSTREAM_THREAD_FIND_ENABLED = false;
