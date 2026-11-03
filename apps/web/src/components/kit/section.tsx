import { Collapsible } from "@base-ui/react/collapsible";
import { cn } from "@mend/ui/lib/utils";
import type { ReactNode } from "react";

import { focusRing } from "./button";
import { Icon } from "./icons";

/** `.panel`: the white card the settings sections and tables rest on. */
export function Panel({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return <div className={cn("rounded-[22px] bg-panel shadow-sm", className)}>{children}</div>;
}

const sectionGrid =
  "grid grid-cols-[240px_minmax(0,1fr)] gap-8 px-[26px] py-6 [&+&]:border-t [&+&]:border-rule max-md:grid-cols-[minmax(0,1fr)] max-md:gap-4 max-md:px-4 max-md:py-5";

/**
 * `fs`: a settings section, title and why on the left, controls on the right; on a phone the
 * controls stack under the title. Sections in one `Panel` divide with a hairline.
 */
export function SettingsSection({
  title,
  why,
  children,
}: {
  readonly title: string;
  readonly why?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className={sectionGrid}>
      <div>
        <h3 className="font-sans text-[15px] leading-[1.3] font-semibold">{title}</h3>
        {why === undefined ? null : (
          <p className="mt-1.5 text-[13px] text-muted-foreground">{why}</p>
        )}
      </div>
      <div>{children}</div>
    </section>
  );
}

/**
 * `fsc`: a settings section that folds. Folded, it keeps its title and count and shows a one-line
 * summary in place of its controls. The title is a disclosure button (`aria-expanded`), so Enter
 * or Space folds it from the keyboard.
 *
 * ```tsx
 * <FoldSection title="Secrets" count="5 secrets" why="Never shown again after you save them."
 *   summary="STRIPE_KEY · OPENAI_API_KEY · and 3 more" defaultOpen={false}>
 *   <DataTable … />
 * </FoldSection>
 * ```
 */
export function FoldSection({
  title,
  count,
  why,
  summary,
  defaultOpen = true,
  open,
  onOpenChange,
  children,
}: {
  readonly title: string;
  readonly count: ReactNode;
  readonly why?: ReactNode;
  /** What the folded section says instead of its controls. */
  readonly summary: ReactNode;
  readonly defaultOpen?: boolean;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly children: ReactNode;
}) {
  return (
    <Collapsible.Root
      defaultOpen={defaultOpen}
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange === undefined ? {} : { onOpenChange: (next) => onOpenChange(next) })}
      render={(props, state) => (
        <section {...props} className={cn(sectionGrid, state.open ? "" : "items-center py-4")}>
          <div>
            <h3 className="font-sans text-[15px] leading-[1.3] font-semibold">
              <Collapsible.Trigger
                className={cn("-ml-0.5 flex items-center gap-1.5 rounded-md text-left", focusRing)}
              >
                <Icon
                  name={state.open ? "chevronDown" : "chevronRight"}
                  size={15}
                  className="text-muted-foreground"
                />
                {title}
                <span className="font-mono text-[11.5px] font-normal text-faint">{count}</span>
              </Collapsible.Trigger>
            </h3>
            {state.open && why !== undefined ? (
              <p className="mt-1.5 text-[13px] text-muted-foreground">{why}</p>
            ) : null}
          </div>
          {state.open ? null : (
            <p className="truncate font-mono text-[12px] text-muted-foreground">{summary}</p>
          )}
          <Collapsible.Panel>{children}</Collapsible.Panel>
        </section>
      )}
    />
  );
}
