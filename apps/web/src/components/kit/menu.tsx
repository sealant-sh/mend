import { cn } from "@mend/ui/lib/utils";
import type { ComponentProps, ReactElement, ReactNode } from "react";

import { Deferred, firstUse } from "./first-use";
import { Icon } from "./icons";
import type * as Popup from "./menu-popup";

/** Base UI's menu, loaded on first use (`./first-use`). */
const menus = firstUse(() => import("./menu-popup"));

/**
 * `.menu`: a list of actions a button opens (row actions, Filter, Open a shell). Base UI gives it
 * the menu role, named by its trigger, with arrow-key movement, typeahead, Escape, and focus back
 * on the trigger. Name the trigger for what the menu holds. Until its code arrives the trigger is
 * itself, and a press opens the menu once it has.
 *
 * ```tsx
 * <Menu trigger={<IconButton icon="clock" label="Snooze" size="sm" bordered />}>
 *   <MenuItem onClick={() => snooze(inAnHour)}>In an hour<MenuMeta>16:00</MenuMeta></MenuItem>
 *   <MenuSeparator />
 *   <MenuGroup label="More filters">…</MenuGroup>
 * </Menu>
 * ```
 */
export function Menu(props: {
  readonly trigger: ReactElement;
  readonly children: ReactNode;
  readonly side?: "top" | "bottom" | "left" | "right";
  readonly align?: "start" | "center" | "end";
  readonly width?: number;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  const { open, onOpenChange } = props;
  return (
    <Deferred
      code={menus}
      trigger={props.trigger}
      popup="menu"
      {...(open === undefined ? {} : { onPress: () => onOpenChange?.(true) })}
    >
      {(code, woken) => (
        <code.Menu {...props} defaultOpen={woken.pressed} triggerRef={woken.triggerRef} />
      )}
    </Deferred>
  );
}

// The rows render inside the open menu, so its code is there by then.

export function MenuItem(props: ComponentProps<typeof Popup.MenuItem>) {
  const code = menus.useLoaded();
  return code === null ? null : <code.MenuItem {...props} />;
}

/** A row that can be checked; it keeps the menu open so several can be picked. */
export function MenuCheckboxItem(props: ComponentProps<typeof Popup.MenuCheckboxItem>) {
  const code = menus.useLoaded();
  return code === null ? null : <code.MenuCheckboxItem {...props} />;
}

/** A set of rows of which one is picked, such as "Started by: anyone · me". */
export function MenuRadioGroup<T extends string>(props: {
  readonly label: string;
  readonly value: T;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: ReactNode }>;
  readonly onChange: (value: T) => void;
}) {
  const code = menus.useLoaded();
  return code === null ? null : <code.MenuRadioGroup {...props} />;
}

/** A labelled group of rows; the label is an eyebrow. */
export function MenuGroup(props: ComponentProps<typeof Popup.MenuGroup>) {
  const code = menus.useLoaded();
  return code === null ? null : <code.MenuGroup {...props} />;
}

/** A submenu: a row that opens more rows beside it (Filter → Agent → codex). */
export function MenuSubmenu(props: ComponentProps<typeof Popup.MenuSubmenu>) {
  const code = menus.useLoaded();
  return code === null ? null : <code.MenuSubmenu {...props} />;
}

export function MenuSeparator() {
  const code = menus.useLoaded();
  return code === null ? null : <code.MenuSeparator />;
}

/** The `.menu` panel, shared with the finder so both read as one family. */
export const menuPanel =
  "grid min-w-[180px] gap-px rounded-[14px] border border-rule bg-panel p-1.5 text-foreground shadow-md outline-none transition-[opacity,scale] motion-reduce:transition-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0";

/** The `.mi` row, shared with the finder. */
export const menuRow =
  "flex cursor-default items-center gap-2 rounded-[9px] px-2.5 py-1.5 font-sans text-[13px] text-ink-2 outline-none select-none data-highlighted:bg-secondary data-highlighted:text-foreground data-disabled:opacity-50";

/** The quiet mono value at the end of a row (`.mi .n`). */
export function MenuMeta({ children }: { readonly children: ReactNode }) {
  return <span className="ml-auto pl-3 font-mono text-[11px] text-faint">{children}</span>;
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
