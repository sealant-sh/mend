import { cn } from "@mend/ui/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

const alertVariants = cva(
  "group/alert relative grid w-full gap-0.5 rounded-lg border px-3 py-2.5 text-left text-row has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2.5 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        destructive:
          "bg-card text-destructive *:data-[slot=alert-description]:text-destructive/90 *:[svg]:text-current",
        // Sheet's Banner: a flat band across the sheet under its header, with a hairline under it.
        // Its actions take a column of their own on the right, so a long title never runs under them.
        // The band is muted at 70% over the sheet, as the canvas mixes it; the tone never tints it.
        band: "rounded-none border-x-0 border-t-0 bg-muted/70 py-2.5 pr-3 pl-4 has-data-[slot=alert-action]:pr-3",
      },
      // Sheet keeps the box neutral: the tone colours only the icon.
      tone: {
        none: "",
        info: "*:[svg]:text-info",
        warning: "*:[svg]:text-warning",
        error: "*:[svg]:text-destructive",
        success: "*:[svg]:text-success",
      },
      // stacked (phones) puts the actions under the text instead of on the right.
      layout: {
        inline: "",
        stacked: "has-data-[slot=alert-action]:pr-2.5",
      },
    },
    compoundVariants: [
      {
        variant: "band",
        layout: "inline",
        class: "has-[>svg]:has-data-[slot=alert-action]:grid-cols-[auto_1fr_auto]",
      },
      { variant: "band", layout: "stacked", class: "px-4 py-3 has-data-[slot=alert-action]:pr-4" },
    ],
    defaultVariants: {
      variant: "default",
      tone: "none",
      layout: "inline",
    },
  },
);

function Alert({
  className,
  variant,
  tone,
  layout = "inline",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      data-layout={layout}
      data-variant={variant ?? "default"}
      role="alert"
      className={cn(alertVariants({ variant, tone, layout }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "font-semibold group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-row text-balance text-muted-foreground md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
        className,
      )}
      {...props}
    />
  );
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn(
        "absolute top-2 right-2 group-data-[variant=band]/alert:group-data-[layout=inline]/alert:static group-data-[variant=band]/alert:group-data-[layout=inline]/alert:col-start-3 group-data-[variant=band]/alert:group-data-[layout=inline]/alert:row-span-2 group-data-[variant=band]/alert:group-data-[layout=inline]/alert:row-start-1 group-data-[variant=band]/alert:group-data-[layout=inline]/alert:self-center group-data-[layout=stacked]/alert:static group-data-[layout=stacked]/alert:col-start-2 group-data-[layout=stacked]/alert:mt-2.5 group-data-[layout=stacked]/alert:flex group-data-[layout=stacked]/alert:gap-2 group-data-[layout=stacked]/alert:*:flex-1",
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription, AlertAction };
