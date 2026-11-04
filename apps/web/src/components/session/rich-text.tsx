import { cn } from "@mend/ui/lib/utils";
import type { Components } from "react-markdown";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { CopyButton } from "#/components/kit/copy-button";

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
  pre: ({ children, node }) => {
    const code = node?.children[0];
    const language =
      code?.type === "element" && Array.isArray(code.properties.className)
        ? code.properties.className.find(
            (name) => typeof name === "string" && name.startsWith("language-"),
          )
        : null;
    const label = typeof language === "string" ? language.slice(9) : "Code";
    const text =
      code?.type === "element"
        ? code.children.flatMap((child) => (child.type === "text" ? [child.value] : [])).join("")
        : "";
    return (
      <div className="min-w-0 overflow-hidden rounded-[10px] bg-secondary">
        <div className="flex items-center justify-between gap-3 px-3.5 pt-1 font-mono text-[12px] text-muted-foreground">
          <span>{label}</span>
          <CopyButton text={text.replace(/\n$/, "")} label="code" />
        </div>
        <pre className="overflow-x-auto px-3.5 pt-1 pb-2.5 font-mono text-[12px] leading-relaxed text-foreground [&>code]:border-0 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-[12px]">
          {children}
        </pre>
      </div>
    );
  },
  code: ({ children, className }) => (
    <code
      className={cn(
        "rounded-md border border-rule bg-panel px-1.5 py-px font-mono text-[0.86em] text-foreground",
        className,
      )}
    >
      {children}
    </code>
  ),
  table: ({ children }) => (
    <div className="min-w-0 overflow-x-auto rounded-[10px] border border-rule">
      <table className="w-full border-collapse text-left text-[13px] [&_th]:bg-secondary [&_th]:font-medium [&_th]:text-foreground [&_th]:px-3 [&_th]:py-2 [&_td]:px-3 [&_td]:py-2 [&_tr+tr]:border-t [&_tr]:border-rule [&_thead]:border-b [&_thead]:border-rule">
        {children}
      </table>
    </div>
  ),
};

/** Agent Markdown, including partial streamed blocks, with HTML disabled and safe URLs. */
export function RichText({
  text,
  className,
}: {
  readonly text: string;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        "min-w-0 space-y-2.5 text-[14.5px] leading-[1.55] break-words text-ink-2 [overflow-wrap:anywhere]",
        "[&_h1]:mt-4 [&_h1]:text-[18px] [&_h2]:mt-4 [&_h2]:text-[16px] [&_h3]:mt-3 [&_h3]:text-[14.5px] [&_h4]:text-[14.5px] [&_h5]:text-[13px] [&_h6]:text-[13px] [&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold [&_:is(h1,h2,h3,h4,h5,h6)]:text-foreground [&>:first-child]:mt-0",
        "[&_ul]:list-disc [&_ol]:list-decimal [&_:is(ul,ol)]:space-y-1 [&_:is(ul,ol)]:pl-6 [&_li>p]:my-1 [&_.contains-task-list]:list-none [&_.contains-task-list]:pl-1 [&_input]:mr-2 [&_input]:accent-primary",
        "[&_blockquote]:border-l-2 [&_blockquote]:border-rule [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_hr]:my-4 [&_hr]:border-rule [&_strong]:font-semibold [&_img]:max-w-full [&_img]:rounded-lg",
        className,
      )}
    >
      <Markdown remarkPlugins={plugins} components={components} skipHtml>
        {text}
      </Markdown>
    </div>
  );
}
