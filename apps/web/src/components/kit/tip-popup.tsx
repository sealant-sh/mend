import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cn } from "@mend/ui/lib/utils";
import { type FocusEvent, type ReactElement, type ReactNode, useRef, useState } from "react";

import { tipPanel } from "./tip";

type Side = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

// The tip and the popover themselves, which `./tip` loads on first use.

export function Tip({
  content,
  children,
  side = "bottom",
  align = "end",
  delay = 200,
  id,
  triggerRef,
}: {
  readonly content: ReactNode;
  readonly children: ReactElement;
  readonly side?: Side;
  readonly align?: Align;
  readonly delay?: number;
  /** The hidden description the trigger names, which `./tip` renders. */
  readonly id: string;
  readonly triggerRef: ((element: HTMLElement | null) => void) | undefined;
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger
        ref={triggerRef}
        delay={delay}
        render={children}
        aria-describedby={id}
      />
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
  defaultOpen,
  triggerRef,
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
  readonly defaultOpen: boolean;
  readonly triggerRef: ((element: HTMLElement | null) => void) | undefined;
}) {
  const [shown, setShown] = useState(defaultOpen);
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
        ref={triggerRef}
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
        <PopoverPrimitive.Positioner
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={8}
          collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "end" }}
          className="z-50"
        >
          <PopoverPrimitive.Popup
            ref={popup}
            aria-label={label}
            initialFocus={!byFocus}
            finalFocus={!byFocus}
            className={cn(
              "max-h-[var(--available-height)] w-[min(340px,var(--available-width))] overflow-y-auto rounded-2xl border border-rule bg-panel px-4 py-3.5 font-sans text-[13px] text-foreground shadow-md outline-none transition-[opacity,scale] motion-reduce:transition-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
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
