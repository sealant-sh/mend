import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cn } from "@mend/ui/lib/utils";
import type { ReactElement, ReactNode } from "react";

type Side = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

/**
 * `.tip`: the dark hover note. It opens on hover and on keyboard focus of its trigger, which
 * Base UI wires to the trigger's description. `children` is the one focusable trigger element.
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
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger delay={delay} render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} align={align} sideOffset={8} className="z-50">
          <TooltipPrimitive.Popup className={tipPanel}>{content}</TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/** The tip's dark panel; `b` is its title and `.tip-link` its light link. */
export const tipPanel =
  "grid w-[250px] gap-[3px] rounded-xl bg-foreground px-3 py-2.5 text-left font-sans text-[12px] leading-[1.45] text-[#f4f4f2] shadow-md transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0 [&_b]:font-semibold [&_.tip-link]:text-[#9db8ff]";

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
  /** Also open while the pointer rests on the trigger; a click or Enter still opens it. */
  readonly openOnHover?: boolean;
}) {
  return (
    <PopoverPrimitive.Root
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange === undefined ? {} : { onOpenChange: (next) => onOpenChange(next) })}
    >
      <PopoverPrimitive.Trigger
        render={trigger}
        {...(openOnHover ? { openOnHover: true, delay: 300 } : {})}
      />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner side={side} align={align} sideOffset={8} className="z-50">
          <PopoverPrimitive.Popup
            aria-label={label}
            className={cn(
              "w-[340px] rounded-2xl border border-rule bg-panel px-4 py-3.5 font-sans text-[13px] text-foreground shadow-md outline-none transition-[opacity,scale] data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
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
    <dl className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 gap-y-[7px]">
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
