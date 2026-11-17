import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "@mend/ui-old/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";

/*
 * DESIGN.md §6 — no pills or chips as containers, no flooded accent fills.
 * A badge is a quiet mono fact: soft corners, a recessed or hairlined ground,
 * color only on the word and only when earned (destructive).
 */
const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border border-transparent px-1.5 py-0.5 font-mono text-[11px] font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-[var(--sw-sunken)] text-ink-2",
        secondary: "bg-transparent text-label",
        destructive: "bg-transparent text-danger",
        outline: "border-rule bg-panel text-ink-2",
        ghost: "text-muted-foreground hover:bg-[var(--sw-sunken)]",
        link: "text-info underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props,
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  });
}

export { Badge, badgeVariants };
