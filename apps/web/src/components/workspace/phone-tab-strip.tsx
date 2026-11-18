import { Tabs, TabsList } from "@mend/ui/components/ui/tabs";
import { cn } from "@mend/ui/lib/utils";
import { Fragment, type ReactNode, type UIEvent, useCallback, useState } from "react";

/** Which ends of the strip have tabs past them, for the fades. */
interface Overflow {
  readonly before: boolean;
  readonly after: boolean;
}

const overflowOf = (strip: HTMLElement): Overflow => ({
  before: strip.scrollLeft > 1,
  after: strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1,
});

/**
 * Every tab of the workspace in one strip, under 1024px (Doop "Phone tab strip", T19, T23, T28):
 * 44px tabs whose labels stay whole, the strip scrolling sideways instead, with a fade on each end
 * that has tabs past it, and the "+" (`add`) fixed on the right. The active tab scrolls into view.
 * The body under it is the active tab's tile.
 */
export function PhoneTabStrip({
  tabs,
  active,
  onActiveChange,
  add,
  className,
}: {
  readonly tabs: ReadonlyArray<{ readonly value: string; readonly tab: ReactNode }>;
  readonly active: string;
  readonly onActiveChange: (value: string) => void;
  readonly add: ReactNode;
  readonly className?: string;
}) {
  const [overflow, setOverflow] = useState<Overflow>({ before: false, after: false });
  // Measuring the strip is the browser's: when it mounts, and when the active tab changes.
  const measure = useCallback(
    (strip: HTMLDivElement | null) => {
      if (strip === null) return;
      const shown = strip.querySelector<HTMLElement>(`[data-tab="${CSS.escape(active)}"]`);
      shown?.scrollIntoView({ block: "nearest", inline: "nearest" });
      setOverflow(overflowOf(strip));
    },
    [active],
  );
  return (
    <Tabs
      value={active}
      onValueChange={(value) => {
        if (typeof value === "string") onActiveChange(value);
      }}
      className={cn("flex h-11.25 shrink-0 flex-row gap-0 border-b bg-background", className)}
    >
      <div className="relative flex min-w-0 flex-1">
        <TabsList
          ref={measure}
          variant="line"
          aria-label="Tabs"
          onScroll={(event: UIEvent<HTMLDivElement>) =>
            setOverflow(overflowOf(event.currentTarget))
          }
          className="h-full min-w-0 flex-1 items-stretch justify-start gap-0.5 overflow-x-auto rounded-none p-0 pr-1 pl-1.5 [scrollbar-width:none]"
        >
          {tabs.map((entry) => (
            <Fragment key={entry.value}>{entry.tab}</Fragment>
          ))}
        </TabsList>
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-y-0 left-0 w-8 bg-linear-to-l from-transparent to-background",
            !overflow.before && "hidden",
          )}
        />
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-y-0 right-0 w-8 bg-linear-to-r from-transparent to-background",
            !overflow.after && "hidden",
          )}
        />
      </div>
      {add}
    </Tabs>
  );
}
