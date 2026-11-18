import { Button } from "@mend/ui/components/ui/button";
import { cn } from "@mend/ui/lib/utils";
import * as React from "react";

/** How long the button says Copied before it goes back to its label. */
const COPIED_MS = 1500;

/**
 * Copies `value` and says so for a moment. When the browser refuses (no clipboard permission, an
 * insecure origin), `onRefused` runs instead, so the caller can select the text for the person.
 */
function useCopy(
  value: string,
  { onCopied, onRefused }: { onCopied?: (() => void) | undefined; onRefused?: () => void } = {},
) {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timeout);
  }, [copied]);

  /** Resolves true once the value is on the clipboard, false when the browser refused. */
  const copy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      onCopied?.();
      return true;
    } catch {
      onRefused?.();
      return false;
    }
  }, [value, onCopied, onRefused]);

  return { copied, copy };
}

/**
 * A machine value someone has to paste somewhere else (an SSH key, an access key, a command), in
 * Geist Mono on a muted fill, with a Copy button on the right. No border and no card.
 *
 * `label` names what the button copies ("Copy key", "Copy command"); it says Copied for a moment
 * after a copy. `size="touch"` is the phone layout, with a 44px ghost button.
 */
function CopyField({
  value,
  label = "Copy",
  size = "default",
  onCopied,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  value: string;
  label?: string;
  size?: "default" | "touch";
  /** Runs once the value is on the clipboard. */
  onCopied?: () => void;
}) {
  const valueRef = React.useRef<HTMLParagraphElement>(null);
  // When the clipboard is refused, select the value so the person can copy it by hand.
  const selectValue = React.useCallback(() => {
    const node = valueRef.current;
    const selection = window.getSelection();
    if (node === null || selection === null) return;
    selection.selectAllChildren(node);
  }, []);
  const { copied, copy } = useCopy(value, { onCopied, onRefused: selectValue });

  return (
    <div
      data-slot="copy-field"
      data-size={size}
      className={cn(
        "flex items-start gap-3 rounded-lg bg-muted py-2.5 pr-2.5 pl-3 text-foreground data-[size=touch]:gap-1 data-[size=touch]:pr-0",
        className,
      )}
      {...props}
    >
      <p
        ref={valueRef}
        data-slot="copy-field-value"
        className="min-w-0 flex-1 pt-0.5 font-mono text-meta leading-relaxed break-all in-data-[size=touch]:text-2xs"
      >
        {value}
      </p>
      <Button
        data-slot="copy-field-button"
        variant={size === "touch" ? "ghost" : "outline"}
        size={size === "touch" ? "touch" : "sm"}
        className={size === "touch" ? undefined : "bg-card"}
        onClick={() => {
          void copy();
        }}
      >
        {copied ? "Copied" : label}
      </Button>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </div>
  );
}

export { CopyField, useCopy };
