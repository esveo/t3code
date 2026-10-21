import { type KeyboardEvent, Suspense } from "react";

import { useTheme } from "~/hooks/useTheme";
import { HighlightedTokens } from "../chat/HighlightedTokens";

// The textarea and the highlighted copy share one grid cell and must lay text
// out identically, or the caret drifts away from the coloured text behind it.
const LAYER = "col-start-1 row-start-1 m-0 p-2 font-mono text-xs whitespace-pre-wrap break-words";

/**
 * Fork: a markdown editor for the Instructions tab. A transparent textarea sits
 * over the same text highlighted with the app's shared Shiki highlighter; the
 * highlighted layer sets the height and the outer box scrolls both together.
 */
export function ForkInstructionsEditor(props: {
  label: string;
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const { resolvedTheme } = useTheme();
  // A trailing newline has no height in a <pre>; the extra space keeps the
  // textarea's last empty line inside the cell.
  const shown = `${props.value} `;

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-input bg-background focus-within:border-ring dark:bg-input/32">
      <div className="grid min-h-full">
        <pre aria-hidden className={`${LAYER} pointer-events-none`}>
          <Suspense fallback={shown}>
            <HighlightedTokens code={shown} language="markdown" theme={resolvedTheme} />
          </Suspense>
        </pre>
        <textarea
          aria-label={props.label}
          className={`${LAYER} h-full resize-none overflow-hidden bg-transparent text-transparent caret-foreground outline-none`}
          spellCheck={false}
          readOnly={props.readOnly}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          onKeyDown={props.onKeyDown}
        />
      </div>
    </div>
  );
}
