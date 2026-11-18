import { cn } from "@mend/ui/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";

function Empty({
  className,
  kind = "page",
  ...props
}: React.ComponentProps<"div"> & {
  // page: centred in an empty screen (icon, title, text, one button). inline: an empty list
  // group, just the muted text, lined up with the rows.
  kind?: "page" | "inline";
}) {
  return (
    <div
      data-slot="empty"
      data-kind={kind}
      className={cn(
        "group/empty flex w-full min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-xl border-dashed px-6 py-10 text-center text-balance data-[kind=inline]:flex-none data-[kind=inline]:items-start data-[kind=inline]:gap-0 data-[kind=inline]:rounded-none data-[kind=inline]:px-4 data-[kind=inline]:pt-2.5 data-[kind=inline]:pb-3 data-[kind=inline]:text-left data-[kind=inline]:text-row data-[kind=inline]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function EmptyHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-header"
      className={cn("flex max-w-sm flex-col items-center gap-1", className)}
      {...props}
    />
  );
}

const emptyMediaVariants = cva(
  "mb-2 flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        icon: "flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground [&_svg:not([class*='size-'])]:size-4",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function EmptyMedia({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof emptyMediaVariants>) {
  return (
    <div
      data-slot="empty-icon"
      data-variant={variant}
      className={cn(emptyMediaVariants({ variant, className }))}
      {...props}
    />
  );
}

function EmptyTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-title"
      className={cn("text-lead font-semibold tracking-tight", className)}
      {...props}
    />
  );
}

function EmptyDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <div
      data-slot="empty-description"
      className={cn(
        "text-sm/relaxed text-muted-foreground [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary",
        className,
      )}
      {...props}
    />
  );
}

function EmptyContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-content"
      className={cn(
        "flex w-full max-w-sm min-w-0 flex-col items-center gap-2.5 text-sm text-balance",
        className,
      )}
      {...props}
    />
  );
}

export { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent, EmptyMedia };
