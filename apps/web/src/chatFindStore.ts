import { create } from "zustand";

interface ChatFindStoreState {
  open: boolean;
  /** Fork: the chat pane whose timeline shows the bar, so split panes do not all open it. */
  paneId: string | null;
  /** Bumps on every show request so an already-open bar refocuses its input. */
  focusRequestId: number;
  show: (paneId: string) => void;
  hide: () => void;
}

/** Find-in-thread visibility, shared by the keybinding, the command palette, and the bar. */
export const useChatFindStore = create<ChatFindStoreState>()((set) => ({
  open: false,
  paneId: null,
  focusRequestId: 0,
  show: (paneId) =>
    set((state) => ({ open: true, paneId, focusRequestId: state.focusRequestId + 1 })),
  hide: () => set({ open: false }),
}));
