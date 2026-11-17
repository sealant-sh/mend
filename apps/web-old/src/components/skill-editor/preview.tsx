import { Facts } from "#/components/kit/tip";

import { previewBlocks } from "./model";

/**
 * A skill file as an agent reads it: front matter as facts, then its headings, lists, code and
 * paragraphs. Read-only, and plain text throughout: nothing in a file becomes HTML.
 */
export function SkillPreview({ source }: { readonly source: string }) {
  const blocks = previewBlocks(source);
  if (blocks.length === 0)
    return <p className="px-5 py-4 font-mono text-[12px] text-faint">This file is empty.</p>;
  return (
    <div className="grid max-w-[76ch] gap-3 px-5 py-4 font-sans text-[13.5px] leading-relaxed text-ink-2">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "facts":
            return (
              <div key={index} className="rounded-xl bg-secondary px-3.5 py-3">
                <Facts rows={block.rows.map(([term, value]) => ({ term, value }))} />
              </div>
            );
          case "heading":
            return block.level === 1 ? (
              <h2 key={index} className="font-display text-[20px] font-semibold text-foreground">
                {block.text}
              </h2>
            ) : (
              <h3 key={index} className="font-sans text-[15px] font-semibold text-foreground">
                {block.text}
              </h3>
            );
          case "list": {
            const items = block.items.map((item, at) => <li key={at}>{item}</li>);
            return block.ordered ? (
              <ol key={index} className="list-decimal pl-5">
                {items}
              </ol>
            ) : (
              <ul key={index} className="list-disc pl-5">
                {items}
              </ul>
            );
          }
          case "code":
            return (
              <pre
                key={index}
                className="overflow-x-auto rounded-[10px] bg-secondary px-3 py-2 font-mono text-[12px]"
              >
                {block.text}
              </pre>
            );
          case "paragraph":
            return <p key={index}>{block.text}</p>;
        }
      })}
    </div>
  );
}
