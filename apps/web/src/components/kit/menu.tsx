import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "@mend/ui/lib/utils";
import type { ReactElement, ReactNode } from "react";

import { Icon } from "./icons";

/**
 * `.menu`: a list of actions a button opens (row actions, Filter, Open a shell). Base UI gives it
 * the menu role, named by its trigger, with arrow-key movement, typeahead, Escape, and focus back
 * on the trigger. Name the trigger for what the menu holds.
 *
 * ```tsx
 * <Menu trigger={<IconButton icon="clock" label="Snooze" size="sm" bordered />}>
 *   <MenuItem onClick={() => snooze(inAnHour)}>In an hour<MenuMeta>16:00</MenuMeta></MenuItem>
 *   <MenuSeparator />
 *   <MenuGroup label="More filters">…</MenuGroup>
 * </Menu>
 * ```
 */
export function Menu({
  trigger,
  children,
  side = "bottom",
  align = "start",
  width,
  open,
  onOpenChange,
}: {
  readonly trigger: ReactElement;
  readonly children: ReactNode;
  readonly side?: "top" | "bottom" | "left" | "right";
  readonly align?: "start" | "center" | "end";
  readonly width?: number;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  return (
    <MenuPrimitive.Root
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange === undefined ? {} : { onOpenChange: (next) => onOpenChange(next) })}
    >
      <MenuPrimitive.Trigger render={trigger} />
      <MenuPrimitive.Portal>
        {/* Flips to whichever side has room and slides along the trigger to stay on screen; a
            menu taller than that room scrolls inside it (`menuPanel`'s cap). */}
        <MenuPrimitive.Positioner
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "end" }}
          className="z-50"
        >
          <MenuPrimitive.Popup
            style={width === undefined ? undefined : { width }}
            className={menuPanel}
          >
            {children}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

/** The `.menu` panel, shared with the finder so both read as one family. */
export const menuPanel =
  "grid max-h-[var(--available-height)] min-w-[180px] gap-px overflow-y-auto overscroll-contain rounded-[14px] border border-rule bg-panel p-1.5 text-foreground shadow-md outline-none transition-[opacity,scale] motion-reduce:transition-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0";

/** The `.mi` row, shared with the finder. */
export const menuRow =
  "flex cursor-default items-center gap-2 rounded-[9px] px-2.5 py-1.5 font-sans text-[13px] text-ink-2 outline-none select-none data-highlighted:bg-secondary data-highlighted:text-foreground data-disabled:opacity-50";

export function MenuItem({
  children,
  onClick,
  disabled,
  className,
}: {
  readonly children: ReactNode;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly className?: string;
}) {
  return (
    <MenuPrimitive.Item
      {...(onClick === undefined ? {} : { onClick })}
      disabled={disabled ?? false}
      className={cn(menuRow, className)}
    >
      {children}
    </MenuPrimitive.Item>
  );
}

/** A row that can be checked; it keeps the menu open so several can be picked. */
export function MenuCheckboxItem({
  checked,
  onCheckedChange,
  children,
}: {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly children: ReactNode;
}) {
  return (
    <MenuPrimitive.CheckboxItem
      checked={checked}
      onCheckedChange={(next) => onCheckedChange(next)}
      closeOnClick={false}
      className={cn(menuRow, "data-checked:text-foreground")}
    >
      <CheckBox checked={checked} />
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

/** A set of rows of which one is picked, such as "Started by: anyone · me". */
export function MenuRadioGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: ReactNode }>;
  readonly onChange: (value: T) => void;
}) {
  return (
    <MenuPrimitive.RadioGroup
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        const picked = options.find((option) => option.value === next);
        if (picked !== undefined) onChange(picked.value);
      }}
      className="grid gap-px"
    >
      {options.map((option) => (
        <MenuPrimitive.RadioItem
          key={option.value}
          value={option.value}
          closeOnClick={false}
          className={cn(menuRow, "data-checked:bg-wash data-checked:text-foreground")}
        >
          <span className="grid w-3.5 place-items-center text-info">
            <MenuPrimitive.RadioItemIndicator>
              <Icon name="check" size={13} />
            </MenuPrimitive.RadioItemIndicator>
          </span>
          {option.label}
        </MenuPrimitive.RadioItem>
      ))}
    </MenuPrimitive.RadioGroup>
  );
}

/** A labelled group of rows; the label is an eyebrow. */
export function MenuGroup({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <MenuPrimitive.Group className="grid gap-px">
      <MenuPrimitive.GroupLabel className="px-2.5 pt-1 pb-1 font-mono text-[10.5px] font-medium tracking-[0.06em] text-label uppercase">
        {label}
      </MenuPrimitive.GroupLabel>
      {children}
    </MenuPrimitive.Group>
  );
}

/** A submenu: a row that opens more rows beside it (Filter → Agent → codex). */
export function MenuSubmenu({
  label,
  meta,
  children,
}: {
  readonly label: ReactNode;
  readonly meta?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <MenuPrimitive.SubmenuRoot>
      <MenuPrimitive.SubmenuTrigger className={cn(menuRow, "data-popup-open:bg-secondary")}>
        {label}
        {meta === undefined ? null : <MenuMeta>{meta}</MenuMeta>}
        <Icon name="chevronRight" size={12} className="ml-1 text-faint" />
      </MenuPrimitive.SubmenuTrigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner
          side="right"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "end" }}
          className="z-50"
        >
          <MenuPrimitive.Popup
            className={cn(menuPanel, "max-h-[min(320px,var(--available-height))]")}
          >
            {children}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.SubmenuRoot>
  );
}

/** The quiet mono value at the end of a row (`.mi .n`). */
export function MenuMeta({ children }: { readonly children: ReactNode }) {
  return <span className="ml-auto pl-3 font-mono text-[11px] text-faint">{children}</span>;
}

export function MenuSeparator() {
  return <MenuPrimitive.Separator className="my-1.5 border-t border-rule" />;
}

/** `.chk`: the square check the menu and finder rows draw. */
export function CheckBox({ checked }: { readonly checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-grid size-[15px] shrink-0 place-items-center rounded-[4px] border-[1.5px]",
        checked ? "border-primary bg-primary text-primary-foreground" : "border-input",
      )}
    >
      {checked ? <Icon name="check" size={11} strokeWidth={2.6} /> : null}
    </span>
  );
}
