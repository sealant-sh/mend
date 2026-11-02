import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "@mend/ui/lib/utils";
import type { ReactElement, ReactNode } from "react";

import { Icon } from "./icons";
import { CheckBox, menuPanel, menuRow, MenuMeta } from "./menu";

/** The menu itself, which `./menu` loads on first use. */
export function Menu({
  trigger,
  children,
  side = "bottom",
  align = "start",
  width,
  open,
  onOpenChange,
  defaultOpen,
  triggerRef,
}: {
  readonly trigger: ReactElement;
  readonly children: ReactNode;
  readonly side?: "top" | "bottom" | "left" | "right";
  readonly align?: "start" | "center" | "end";
  readonly width?: number;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly defaultOpen: boolean;
  readonly triggerRef: ((element: HTMLElement | null) => void) | undefined;
}) {
  return (
    <MenuPrimitive.Root
      defaultOpen={defaultOpen}
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange === undefined ? {} : { onOpenChange: (next) => onOpenChange(next) })}
    >
      <MenuPrimitive.Trigger ref={triggerRef} render={trigger} />
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner side={side} align={align} sideOffset={6} className="z-50">
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
        <MenuPrimitive.Positioner side="right" align="start" sideOffset={4} className="z-50">
          <MenuPrimitive.Popup className={cn(menuPanel, "max-h-[320px] overflow-y-auto")}>
            {children}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.SubmenuRoot>
  );
}

export function MenuSeparator() {
  return <MenuPrimitive.Separator className="my-1.5 border-t border-rule" />;
}
