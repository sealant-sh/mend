import { cn } from "@mend/ui/lib/utils";

import { type PreviewBlock, previewBlocks } from "#/lib/skills";

/**
 * A skill file in the editor (Doop "Skills · editing a skill"): line numbers in a gutter, the text
 * beside them, and each line that differs from the saved file tinted with a cobalt bar. Lines never
 * wrap, so each number stays beside its line; a long line scrolls sideways. The field grows with
 * its contents, and the sheet scrolls.
 */
export function CodeLines({
  label,
  value,
  marked,
  onChange,
  disabled,
  invalid,
  describedBy,
}: {
  readonly label: string;
  readonly value: string;
  readonly marked: ReadonlySet<number>;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
  readonly invalid: boolean;
  readonly describedBy?: string;
}) {
  // Line numbers from 1, one per line: each is its line's key.
  const numbers = value.split("\n").map((_, at) => at + 1);
  const row = "h-6 leading-6";
  return (
    <div className="relative overflow-x-auto font-mono text-meta max-lg:text-row">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 min-w-full py-3">
        {numbers.map((number) => (
          <div
            key={number}
            className={cn(
              row,
              marked.has(number - 1) && "bg-primary/8 shadow-[inset_3px_0_0_var(--color-primary)]",
            )}
          />
        ))}
      </div>
      <div className="relative grid min-w-max grid-cols-[3.25rem_minmax(0,1fr)]">
        <div
          aria-hidden
          className="py-3 pr-4 text-right text-muted-foreground tabular-nums select-none"
        >
          {numbers.map((number) => (
            <div key={number} className={cn(row, marked.has(number - 1) && "text-foreground")}>
              {number}
            </div>
          ))}
        </div>
        <textarea
          aria-label={label}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          value={value}
          disabled={disabled}
          wrap="off"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => onChange(event.target.value)}
          className="field-sizing-content min-h-60 w-full resize-none overflow-hidden bg-transparent py-3 pr-5 leading-6 whitespace-pre text-foreground outline-none"
        />
      </div>
    </div>
  );
}

/**
 * A skill file as an agent reads it, for the editor's Preview: front matter as facts, then its
 * headings, lists, code and paragraphs. Plain text throughout: nothing in a file becomes HTML.
 */
export function SkillPreview({ source }: { readonly source: string }) {
  const blocks = previewBlocks(source);
  if (blocks.length === 0)
    return <p className="px-5 py-4 text-row text-muted-foreground">This file is empty.</p>;
  return (
    <div className="grid max-w-[76ch] gap-3 px-5 py-4 text-prose text-foreground">
      {blocks.map((block) => (
        <Block key={block.start} block={block} />
      ))}
    </div>
  );
}

function Block({ block }: { readonly block: PreviewBlock }) {
  switch (block.kind) {
    case "facts":
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg bg-muted px-3.5 py-3 text-row">
          {block.rows.map(([term, value]) => (
            <div key={term} className="contents">
              <dt className="text-muted-foreground">{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      );
    case "heading":
      return block.level === 1 ? (
        <h3 className="text-title font-semibold">{block.text}</h3>
      ) : (
        <h4 className="text-lead font-semibold">{block.text}</h4>
      );
    case "list": {
      const items = block.items.map((item) => <li key={item.start}>{item.text}</li>);
      return block.ordered ? (
        <ol className="list-decimal pl-5">{items}</ol>
      ) : (
        <ul className="list-disc pl-5">{items}</ul>
      );
    }
    case "code":
      return (
        <pre className="overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-meta">
          {block.text}
        </pre>
      );
    case "paragraph":
      return <p>{block.text}</p>;
  }
}
