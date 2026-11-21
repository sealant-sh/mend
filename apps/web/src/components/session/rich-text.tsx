import { cn } from "@mend/ui/lib/utils";
import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { markdownBlocks } from "#/lib/markdown-blocks";
import { useRevealedText } from "#/lib/text-reveal";

const plugins = [remarkGfm];

const components: Components = {
  a: ({ children, href, title }) => (
    <a
      href={href}
      title={title}
      target="_blank"
      rel="noreferrer noopener"
      className="text-info underline underline-offset-2"
    >
      {children}
    </a>
  ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-lg bg-muted px-3.5 py-2.5 font-mono text-2xs leading-relaxed text-foreground [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-2xs">
      {children}
    </pre>
  ),
  code: ({ children, className }) => (
    <code
      className={cn(
        "rounded-sm bg-muted px-1.25 py-px font-mono text-meta text-foreground",
        className,
      )}
    >
      {children}
    </code>
  ),
  table: ({ children }) => (
    <div className="min-w-0 overflow-x-auto rounded-lg border">
      <table className="w-full border-collapse text-left text-row [&_td]:px-3 [&_td]:py-2 [&_th]:bg-muted [&_th]:px-3 [&_th]:py-2 [&_th]:font-medium [&_thead]:border-b [&_tr+tr]:border-t">
        {children}
      </table>
    </div>
  ),
};

/** One block of the text, read once: a reply that grows re-reads only its last block. */
const Block = memo(function Block({ source }: { readonly source: string }) {
  return (
    <Markdown remarkPlugins={plugins} components={components} skipHtml>
      {source}
    </Markdown>
  );
});

/**
 * What the agent wrote, as Markdown: a streamed block that isn't finished yet renders as far as it
 * goes. Raw HTML is dropped, and links open in a new tab.
 *
 * While `live` (the agent is still writing it), new text shows at a steady pace rather than in the
 * lumps it arrives in, a word at a time, and each new paragraph, list or code block fades in.
 * Text already there when it mounts shows at once and never fades.
 */
export function RichText({
  text,
  live = false,
  className,
}: {
  readonly text: string;
  readonly live?: boolean;
  readonly className?: string;
}) {
  const { shown, growing } = useRevealedText(text, live);
  let start = 0;
  return (
    <div
      data-streaming={growing ? "" : undefined}
      className={cn(
        "min-w-0 space-y-2.5 text-prose leading-relaxed wrap-anywhere text-foreground",
        "[&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold [&_h1]:mt-4 [&_h1]:text-title [&_h2]:mt-4 [&_h2]:text-lead [&_h3]:mt-3 [&>:first-child]:mt-0",
        "[&_:is(ul,ol)]:space-y-1 [&_:is(ul,ol)]:pl-6 [&_ol]:list-decimal [&_ul]:list-disc [&_li>p]:my-1",
        "[&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_hr]:my-4 [&_img]:max-w-full [&_img]:rounded-lg [&_strong]:font-semibold",
        // A block added while the reply streams fades in once, by opacity alone, so nothing moves.
        "motion-safe:data-streaming:*:transition-opacity motion-safe:data-streaming:*:duration-500 motion-safe:data-streaming:*:ease-out motion-safe:data-streaming:*:starting:opacity-0",
        className,
      )}
    >
      {markdownBlocks(shown).map((block) => {
        // A finished block keeps its text as the reply grows after it, so where it starts names it.
        const key = start;
        start += block.length;
        return <Block key={key} source={block} />;
      })}
    </div>
  );
}
