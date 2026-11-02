import { cn } from "@mend/ui/lib/utils";
import { forwardRef, type TextareaHTMLAttributes } from "react";

/**
 * `.inp` over several lines: pasted file contents, a credentials file. Mono, like `TextInput`,
 * since what goes in is a machine value. Name it with a `Field` or an `aria-label`.
 *
 * ```tsx
 * <Field label="Paste its contents">{(id) => <TextArea id={id} rows={4} value={text} onChange={…} />}</Field>
 * ```
 */
export const TextArea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function TextArea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      spellCheck={false}
      className={cn(
        "w-full min-w-0 resize-y rounded-[10px] border border-input bg-panel px-3 py-[9px] font-mono text-[12.5px] leading-normal text-foreground outline-none placeholder:text-faint focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
});
