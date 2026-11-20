import { cn } from "@mend/ui/lib/utils";
import type { ReactNode } from "react";

/**
 * One setting on a settings page (Doop "Setting row"). Every setting has one home and nothing
 * inherits (docs/adr/0025), so this is the only settings row: the setting's name and what it does
 * on the left, its control on the right, a hairline under it, no card.
 *
 * - `layout="row"` (the default) keeps the control on the right at every width: a Switch, or a
 *   button short enough to sit beside its label on a phone.
 * - `layout="stack"` is for an input, a select or a wide button: beside the text on the desk, and
 *   under it, filling the width, on a phone (under 1024px), where controls take the touch size.
 * - `note` sits under the description: a save error with Try again, a saved line, a link. Leave it
 *   out otherwise.
 *
 * `labelFor` names the control's id, so a field's label is its row's label.
 */
export function SettingRow({
  label,
  description,
  note,
  control,
  layout = "row",
  labelFor,
  className,
}: {
  readonly label: string;
  readonly description?: ReactNode;
  readonly note?: ReactNode;
  readonly control?: ReactNode;
  readonly layout?: "row" | "stack";
  readonly labelFor?: string;
  readonly className?: string;
}) {
  return (
    <div
      data-slot="setting-row"
      data-layout={layout}
      className={cn(
        "flex items-start gap-8 border-b border-border py-3.5 max-lg:px-4",
        layout === "stack" && "max-lg:flex-col max-lg:gap-3",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        {labelFor === undefined ? (
          <p className="font-semibold">{label}</p>
        ) : (
          <label htmlFor={labelFor} className="font-semibold">
            {label}
          </label>
        )}
        {description === undefined ? null : (
          <p className="mt-0.5 text-row text-pretty text-muted-foreground">{description}</p>
        )}
        {note === undefined || note === null ? null : <div className="mt-1 text-row">{note}</div>}
      </div>
      {control === undefined ? null : (
        <div
          className={cn(
            "flex min-h-6 max-w-1/2 flex-none items-center justify-end gap-2",
            layout === "stack" && "max-lg:w-full max-lg:max-w-none max-lg:*:flex-1",
          )}
        >
          {control}
        </div>
      )}
    </div>
  );
}

/**
 * A heading over a run of rows ("Profile", "Sign out", "Display"), with the hairline under it.
 * `description` is one muted line under the heading, above the hairline. `action` sits on its right
 * on the desk (an "Add server…" button) and is left to the page on a phone, where it goes under the
 * rows.
 */
export function SettingSection({
  title,
  count,
  description,
  action,
  children,
}: {
  readonly title: string;
  /** Beside the title, muted: how many rows ("Members 4", "Invitations 1 open"). */
  readonly count?: number | string | undefined;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={title} className="mt-10 first:mt-0">
      <div className="flex items-start gap-6 border-b border-border pb-2.5 max-lg:px-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-lead font-semibold">
            {title}
            {count === undefined ? null : (
              <span className="ml-1.5 text-row font-normal text-muted-foreground">{count}</span>
            )}
          </h2>
          {description === undefined ? null : (
            <p className="mt-0.5 text-row text-pretty text-muted-foreground">{description}</p>
          )}
        </div>
        {action === undefined ? null : <div className="flex-none max-lg:hidden">{action}</div>}
      </div>
      {children}
    </section>
  );
}
