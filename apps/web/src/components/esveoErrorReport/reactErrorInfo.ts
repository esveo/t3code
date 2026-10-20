import type { RootOptions } from "react-dom/client";

const componentStacks = new WeakMap<object, string>();

function remember(error: unknown, info: { readonly componentStack?: string | undefined }) {
  if (typeof error === "object" && error !== null && info.componentStack) {
    componentStacks.set(error, info.componentStack);
  }
}

/** The React component stack recorded when `error` reached an error boundary or the root. */
export function componentStackOf(error: unknown): string | null {
  return typeof error === "object" && error !== null ? (componentStacks.get(error) ?? null) : null;
}

/**
 * Root options that keep React's default logging and record each error's
 * component stack for the error report.
 */
export const esveoReactRootErrorOptions: RootOptions = {
  onCaughtError: (error, info) => {
    remember(error, info);
    console.error(error);
  },
  onUncaughtError: (error, info) => {
    remember(error, info);
    reportError(error);
  },
};
