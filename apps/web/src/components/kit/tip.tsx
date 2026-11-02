import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cn } from "@mend/ui/lib/utils";
import { type FocusEvent, type ReactElement, type ReactNode, useId, useRef, useState } from "react";

type Side = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

/**
 * `.tip`: the dark hover note, opened by hovering or focusing its one trigger. Screen readers get
 * the same words as the trigger's description (`aria-describedby`), which is in the page whether
 * the tip shows or not; the visible tip is `role="tooltip"`. A tip holds words only: anything to
 * click goes in an `InfoPopover`, which focus can reach.
 *
 * ```tsx
 * <Tip content={<><b>From Mend's organization defaults</b><span>On for everyone…</span></>}>
 *   <button type="button">Inherit</button>
 * </Tip>
 * ```
 */
export function Tip({
  content,
  children,
  side = "bottom",
  align = "end",
  delay = 200,
}: {
  readonly content: ReactNode;
  readonly children: ReactElement;
  readonly side?: Side;
  readonly align?: Align;
  readonly delay?: number;
}) {
  const id = useId();
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger delay={delay} render={children} aria-describedby={id} />
      <span id={id} hidden>
        {content}
      </span>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} align={align} sideOffset={8} className="z-50">
          <TooltipPrimitive.Popup id={`${id}-shown`} role="tooltip" className={tipPanel}>
            {content}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/**
 * The tip's panel: the ink and sheet colours swapped, so it reads in both themes. `b` is its
 * title.
 */
export const tipPanel =
  "grid w-max max-w-[250px] gap-[3px] rounded-xl bg-foreground px-3 py-2.5 text-left font-sans text-[12px] leading-[1.45] text-background shadow-md transition-opacity motion-reduce:transition-none data-ending-style:opacity-0 data-starting-style:opacity-0 [&_b]:font-semibold";

/**
 * `.pop`: a panel of facts a click opens, such as the session details or the person menu. Focus
 * moves into it and Escape returns it to the trigger.
 *
 * ```tsx
 * <InfoPopover trigger={<button type="button">Details</button>} label="Session details">
 *   <Facts rows={[{ term: "Branch", value: "t3/settings-tabs" }]} />
 * </InfoPopover>
 * ```
 */
export function InfoPopover({
  trigger,
  label,
  children,
  side = "bottom",
  align = "start",
  className,
  open,
  onOpenChange,
  openOnHover = false,
}: {
  readonly trigger: ReactElement;
  readonly label: string;
  readonly children: ReactNode;
  readonly side?: Side;
  readonly align?: Align;
  readonly className?: string;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /**
   * Also open while the pointer rests on the trigger or keyboard focus is on it, without taking
   * focus from it; a click or Enter still opens it with focus inside.
   */
  readonly openOnHover?: boolean;
}) {
  const [shown, setShown] = useState(false);
  // Opened by focus: focus stays on the trigger, so Tab goes on through the page.
  const [byFocus, setByFocus] = useState(false);
  const popup = useRef<HTMLDivElement | null>(null);
  // Focus a pointer press gave is the click's: only keyboard focus opens the details on its own.
  const pressed = useRef(false);
  const isOpen = open ?? shown;
  const change = (next: boolean) => {
    setShown(next);
    if (!next) setByFocus(false);
    onOpenChange?.(next);
  };
  return (
    <PopoverPrimitive.Root open={isOpen} onOpenChange={(next) => change(next)}>
      <PopoverPrimitive.Trigger
        render={trigger}
        {...(openOnHover
          ? {
              openOnHover: true,
              delay: 300,
              onPointerDown: () => {
                pressed.current = true;
              },
              onFocus: () => {
                const byPointer = pressed.current;
                pressed.current = false;
                if (byPointer || isOpen) return;
                setByFocus(true);
                change(true);
              },
              onBlur: (event: FocusEvent<HTMLElement>) => {
                const next = event.relatedTarget;
                if (byFocus && !(next instanceof Node && popup.current?.contains(next)))
                  change(false);
              },
            }
          : {})}
      />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner side={side} align={align} sideOffset={8} className="z-50">
          <PopoverPrimitive.Popup
            ref={popup}
            aria-label={label}
            initialFocus={!byFocus}
            finalFocus={!byFocus}
            className={cn(
              "w-[340px] rounded-2xl border border-rule bg-panel px-4 py-3.5 font-sans text-[13px] text-foreground shadow-md outline-none transition-[opacity,scale] motion-reduce:transition-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
              className,
            )}
          >
            {children}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/** A definition list of facts: sans term, mono value. */
export function Facts({
  rows,
}: {
  readonly rows: ReadonlyArray<{ readonly term: string; readonly value: ReactNode }>;
}) {
  return (
    <dl className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 gap-y-[7px] font-sans text-[13px]">
      {rows.map((row) => (
        <div key={row.term} className="contents">
          <dt className="text-muted-foreground">{row.term}</dt>
          <dd className="font-mono text-[12px] leading-normal break-words text-ink-2">
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
