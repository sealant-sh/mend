import { useState } from "react";

import { copyTextChecked } from "#/lib/clipboard";

import { Button } from "./button";

/**
 * A Copy button that says what happened. It copies through the app's clipboard helper, which
 * falls back where the Clipboard API is missing (Mend opened over plain HTTP on a private
 * network), and announces "Copied" only once the text is on the clipboard, or "Copy failed,
 * select the text" when it is not.
 *
 * ```tsx
 * <CopyButton text={publicKey} label="Mend's public key" />
 * ```
 */
export function CopyButton({ text, label }: { readonly text: string; readonly label?: string }) {
  const [outcome, setOutcome] = useState<"copied" | "failed" | null>(null);
  const copy = async () => {
    const copied = await copyTextChecked(text);
    setOutcome(copied ? "copied" : "failed");
    if (copied) window.setTimeout(() => setOutcome(null), 1500);
  };
  return (
    <span className="inline-flex shrink-0 items-center gap-2">
      <span role="status" className="font-mono text-[11px] text-faint empty:hidden">
        {outcome === "failed" ? "Copy failed, select the text" : ""}
      </span>
      <Button
        size="sm"
        variant="ghost"
        aria-label={label === undefined ? "Copy" : `Copy ${label}`}
        onClick={() => void copy()}
      >
        {outcome === "copied" ? "Copied" : "Copy"}
      </Button>
      <span role="status" className="sr-only">
        {outcome === "copied" ? "Copied" : ""}
      </span>
    </span>
  );
}
