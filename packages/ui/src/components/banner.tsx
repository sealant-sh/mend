import { Alert, AlertAction, AlertDescription } from "@mend/ui/components/ui/alert";
import { cn } from "@mend/ui/lib/utils";
import { CircleCheckIcon, CircleXIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import * as React from "react";

type NoticeTone = "info" | "warning" | "error" | "success";

/** Each tone's icon. The tone colours only the icon; the box or band stays neutral. */
const toneIcons: Record<NoticeTone, React.ReactNode> = {
  info: <InfoIcon />,
  warning: <TriangleAlertIcon />,
  error: <CircleXIcon />,
  success: <CircleCheckIcon />,
};

/** The bold lead and the sentences after it, run together as one paragraph. */
function NoticeCopy({
  title,
  children,
}: {
  title: string | undefined;
  children?: React.ReactNode;
}) {
  return (
    <>
      {title === undefined || title === "" ? null : (
        <b data-slot="notice-title" className="font-semibold text-foreground">
          {title}{" "}
        </b>
      )}
      {children}
    </>
  );
}

/**
 * A state that lasts and affects the whole screen (you're offline, the session couldn't start),
 * as a flat band under the header it belongs to, with a hairline under it. Never a floating card.
 *
 * `title` is a short bold lead that names the state; the children say what it means and what to
 * do. `actions` holds one or two small Buttons. `layout="stacked"` is the phone layout: the
 * actions go under the text and share its width.
 */
function Banner({
  tone = "info",
  layout = "inline",
  icon,
  title,
  actions,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  tone?: NoticeTone;
  layout?: "inline" | "stacked";
  icon?: React.ReactNode;
  title?: string;
  actions?: React.ReactNode;
}) {
  return (
    <Alert
      data-slot="banner"
      variant="band"
      tone={tone}
      layout={layout}
      // A banner reports a state; only an error interrupts a screen reader.
      role={tone === "error" ? "alert" : "status"}
      className={cn("*:[svg]:row-span-1", className)}
      {...props}
    >
      {icon ?? toneIcons[tone]}
      <AlertDescription className="col-start-2 text-pretty">
        <NoticeCopy title={title}>{children}</NoticeCopy>
      </AlertDescription>
      {actions === undefined ? null : (
        // Inline, the buttons overlap the band's padding so it keeps the height of its text.
        <AlertAction className={layout === "inline" ? "-my-1.5 flex gap-2" : undefined}>
          {actions}
        </AlertAction>
      )}
    </Alert>
  );
}

/**
 * An error or notice inside a form, a setup card, a dialog or a settings row, directly under the
 * thing it is about: a neutral box with a hairline border. For a state that affects the whole
 * screen, use Banner.
 *
 * `title` is a short bold lead ending in a full stop; the children are whole sentences (put
 * commands and paths in `<code>`). `actions` holds one or two Buttons under the text.
 * `size="touch"` is the phone size: more padding, and the actions share the width.
 */
function InlineAlert({
  tone = "error",
  size = "default",
  icon,
  title,
  actions,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  tone?: NoticeTone;
  size?: "default" | "touch";
  icon?: React.ReactNode;
  title?: string;
  actions?: React.ReactNode;
}) {
  return (
    <Alert
      data-slot="inline-alert"
      data-size={size}
      tone={tone}
      className={cn(
        "border-input bg-background *:[svg]:row-span-1 data-[size=touch]:gap-x-3 data-[size=touch]:px-3.5 data-[size=touch]:py-3 data-[size=touch]:text-sm data-[size=touch]:*:[svg]:size-4.5 data-[size=touch]:*:[svg]:translate-y-px",
        className,
      )}
      {...props}
    >
      {icon ?? toneIcons[tone]}
      <div data-slot="inline-alert-main" className="col-start-2 flex min-w-0 flex-col gap-2.5">
        <AlertDescription className="text-pretty in-data-[size=touch]:text-sm [&_code]:font-mono [&_code]:text-meta [&_code]:wrap-anywhere [&_code]:text-foreground">
          <NoticeCopy title={title}>{children}</NoticeCopy>
        </AlertDescription>
        {actions === undefined ? null : (
          <div
            data-slot="inline-alert-actions"
            className="flex flex-wrap items-center gap-2 in-data-[size=touch]:*:flex-1"
          >
            {actions}
          </div>
        )}
      </div>
    </Alert>
  );
}

export { Banner, InlineAlert, type NoticeTone };
