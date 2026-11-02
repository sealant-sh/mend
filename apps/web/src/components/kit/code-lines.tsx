import { cn } from "@mend/ui/lib/utils";
import type { TextareaHTMLAttributes } from "react";

/**
 * A file shown or edited with line numbers (`.fh` + the numbered `pre` of a skill's file).
 * `marked` lines take the added-line wash. Long lines wrap; each number stays beside its line.
 */
export function CodeLines({
  text,
  marked,
  className,
}: {
  readonly text: string;
  readonly marked?: ReadonlySet<number> | undefined;
  readonly className?: string;
}) {
  return (
    <div className={cn(codeFrame, className)}>
      <Gutter />
      <Lines text={text} marked={marked} visible />
    </div>
  );
}

/**
 * The same file as a textarea over its numbered lines. The textarea holds the text and the
 * caret; the lines underneath give it its height, its numbers and the wash on changed lines, so
 * the field grows with the file and never scrolls on its own.
 */
export function CodeEditor({
  value,
  onValueChange,
  marked,
  label,
  className,
  ...props
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "className"> & {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly marked?: ReadonlySet<number> | undefined;
  /** The textarea's accessible name ("Contents of SKILL.md"). */
  readonly label: string;
  readonly className?: string;
}) {
  return (
    <div className={cn(codeFrame, "relative", className)}>
      <Gutter />
      <Lines text={value} marked={marked} visible={false} />
      <textarea
        {...props}
        aria-label={label}
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => onValueChange(event.target.value)}
        className={cn(
          lineText,
          "absolute inset-y-0 right-0 left-[34px] resize-none overflow-hidden bg-transparent py-3.5 text-ink-2 caret-primary outline-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-inset",
        )}
      />
    </div>
  );
}

const codeFrame = "relative font-mono text-[12.5px] leading-[1.7]";

/** Wrapping that the textarea and the lines under it share, so their rows line up. */
const lineText = "px-3.5 whitespace-pre-wrap [overflow-wrap:anywhere] [tab-size:2]";

function Gutter() {
  return <div aria-hidden="true" className="absolute inset-y-0 left-0 w-[34px] bg-secondary" />;
}

function Lines({
  text,
  marked,
  visible,
}: {
  readonly text: string;
  readonly marked: ReadonlySet<number> | undefined;
  readonly visible: boolean;
}) {
  const lines = text.split("\n");
  return (
    <div
      aria-hidden={visible ? undefined : "true"}
      className="relative grid grid-cols-[34px_minmax(0,1fr)] py-3.5"
    >
      {lines.map((line, index) => (
        <div key={index} className="contents">
          <span aria-hidden="true" className="pr-2.5 text-right text-faint select-none">
            {index + 1}
          </span>
          <span
            className={cn(
              lineText,
              visible ? "text-ink-2" : "text-transparent",
              marked?.has(index) === true ? "bg-[var(--sw-add-bg)]" : "",
            )}
          >
            {line === "" ? " " : line}
          </span>
        </div>
      ))}
    </div>
  );
}
