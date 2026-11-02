import { cn } from "@mend/ui/lib/utils";
import { Fragment } from "react";

type Block =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly text: string };

/** Paragraphs and fenced code blocks, in order. Never HTML: the agent's words stay text. */
export const textBlocks = (source: string): ReadonlyArray<Block> => {
  const blocks: Array<Block> = [];
  const parts = source.split(/^```[^\n]*\n?/m);
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      blocks.push({ kind: "code", text: part.replace(/\n$/, "") });
      return;
    }
    for (const paragraph of part.split(/\n{2,}/)) {
      const text = paragraph.trim();
      if (text !== "") blocks.push({ kind: "text", text });
    }
  });
  return blocks;
};

/** One paragraph with its `inline code` set apart. */
function Inline({ text }: { readonly text: string }) {
  const pieces = text.split(/(`[^`\n]+`)/);
  return (
    <>
      {pieces.map((piece, index) =>
        piece.startsWith("`") && piece.endsWith("`") && piece.length > 2 ? (
          <code
            key={index}
            className="rounded-md border border-rule bg-panel px-1.5 py-px font-mono text-[0.86em] text-foreground"
          >
            {piece.slice(1, -1)}
          </code>
        ) : (
          <Fragment key={index}>{piece}</Fragment>
        ),
      )}
    </>
  );
}

/**
 * What an agent wrote, as paragraphs, inline code and code blocks (the `.agent p` of the
 * mockups). A light reading of Markdown's two commonest marks, not a renderer.
 */
export function RichText({
  text,
  className,
}: {
  readonly text: string;
  readonly className?: string;
}) {
  return (
    <div className={cn("grid gap-2.5 text-[14.5px] leading-[1.62] text-ink-2", className)}>
      {textBlocks(text).map((block, index) =>
        block.kind === "code" ? (
          <pre
            key={index}
            className="overflow-x-auto rounded-xl bg-secondary px-3.5 py-2.5 font-mono text-[12px] leading-relaxed text-foreground"
          >
            {block.text}
          </pre>
        ) : (
          <p key={index} className="break-words whitespace-pre-wrap">
            <Inline text={block.text} />
          </p>
        ),
      )}
    </div>
  );
}
