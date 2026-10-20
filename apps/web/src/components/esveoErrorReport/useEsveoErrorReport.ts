import { useEffect, useState } from "react";

import { componentStackOf } from "./reactErrorInfo";
import { sameOriginSourceMapLoader, symbolicateStackText } from "./symbolicateStack";

const COMMIT_HASH = import.meta.env.VITE_ESVEO_COMMIT_HASH;

/**
 * Adds the build commit and React's component stack to upstream's error report,
 * then resolves minified bundle frames through the build's source maps, so a
 * report names source files even after that build is gone.
 */
export function esveoErrorReport(report: string, error: unknown): string {
  const [header = "", ...rest] = report.split("\n");
  const lines = [header];
  if (COMMIT_HASH) lines.push(`Commit: ${COMMIT_HASH}`);
  lines.push(...rest);
  const componentStack = componentStackOf(error);
  if (componentStack) lines.push("", "Component stack:", componentStack.replace(/^\n+/, ""));
  return lines.join("\n");
}

export function useEsveoErrorReport(report: string, error: unknown): string {
  const [resolved, setResolved] = useState<{ readonly from: string; readonly text: string } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    // Read here, not during render: React records the component stack after the error view renders.
    const unresolved = esveoErrorReport(report, error);
    void symbolicateStackText(unresolved, sameOriginSourceMapLoader(window.location)).then(
      (text) => {
        if (!cancelled) setResolved({ from: report, text });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [error, report]);

  return resolved?.from === report ? resolved.text : esveoErrorReport(report, error);
}
