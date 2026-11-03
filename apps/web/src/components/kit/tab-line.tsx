import { cn } from "@mend/ui/lib/utils";
import { createLink } from "@tanstack/react-router";
import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from "react";

import { focusRing } from "./button";
import { Icon, type IconName } from "./icons";

/**
 * The tab line of settings and project pages. Every tab is a link with its own URL, so the line
 * is navigation, not an ARIA tablist: the router marks the current link `aria-current="page"`, and
 * the browser's back button walks the tabs. A group (project Settings, Organization, Instance)
 * either shows its own tabs inline on the same line, or folds to one link that opens it. On a phone
 * (below `md`) every tab line scrolls sideways, its links are 44 px tall, and the current tab is
 * scrolled into view when the line mounts.
 *
 * ```tsx
 * <TabLine label="Project">
 *   <TabLink to="/projects/$projectId" params={{ projectId }} activeOptions={{ exact: true }} count={12}>Sessions</TabLink>
 *   {inSettings ? (
 *     <TabGroup label="Settings" icon="settings" close={<TabGroupClose to="/projects/$projectId" params={{ projectId }} label="Close settings" />}>
 *       <TabGroupLink to="/projects/$projectId/settings/general" params={{ projectId }}>General</TabGroupLink>
 *     </TabGroup>
 *   ) : (
 *     <TabGroupToggle to="/projects/$projectId/settings/general" params={{ projectId }} icon="settings">Settings</TabGroupToggle>
 *   )}
 * </TabLine>
 * ```
 */
export function TabLine({
  label,
  children,
  className,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <nav
      ref={revealCurrent}
      aria-label={label}
      className={cn(
        "flex items-center gap-1 border-b border-rule pb-2 max-md:overflow-x-auto max-md:overscroll-x-contain",
        className,
      )}
    >
      {children}
    </nav>
  );
}

/**
 * Keeps a tab line's current tab in view: on a phone the line is wider than the screen. The tabs
 * widen after they mount (the web fonts, the change's size), so it scrolls again as they do,
 * until the person touches the line. A module function, so React attaches it on mount only.
 */
const revealCurrent = (line: HTMLElement | null) => {
  if (line === null || typeof ResizeObserver === "undefined") return;
  const reveal = () => {
    const current = line.querySelector('[aria-current="page"]');
    if (!(current instanceof HTMLElement)) return;
    const box = line.getBoundingClientRect();
    const tab = current.getBoundingClientRect();
    if (tab.right > box.right) line.scrollLeft += tab.right - box.right + 16;
    else if (tab.left < box.left) line.scrollLeft -= box.left - tab.left + 16;
  };
  const watch = new ResizeObserver(reveal);
  for (const tab of line.children) watch.observe(tab);
  const stop = () => watch.disconnect();
  line.addEventListener("pointerdown", stop, { once: true });
  line.addEventListener("wheel", stop, { once: true });
  return stop;
};

/** Pushes what follows to the end of the line. */
export function TabSpacer() {
  return <span aria-hidden="true" className="flex-1" />;
}

type AnchorProps = AnchorHTMLAttributes<HTMLAnchorElement>;

const TabAnchor = forwardRef<HTMLAnchorElement, AnchorProps & { readonly count?: ReactNode }>(
  function TabAnchor({ count, className, children, ...props }, ref) {
    return (
      <a
        ref={ref}
        className={cn(
          "flex items-center gap-[7px] rounded-[9px] px-2 py-1.5 font-sans text-[13.5px] leading-[1.3] font-medium whitespace-nowrap text-muted-foreground no-underline transition-colors hover:text-foreground aria-[current=page]:bg-secondary aria-[current=page]:text-foreground max-md:min-h-11",
          focusRing,
          className,
        )}
        {...props}
      >
        {children}
        {count === undefined ? null : (
          <span className="font-mono text-[11px] font-normal text-faint">{count}</span>
        )}
      </a>
    );
  },
);

/** One tab: a typed router link, with an optional mono count. */
export const TabLink = createLink(TabAnchor);

const GroupAnchor = forwardRef<HTMLAnchorElement, AnchorProps>(function GroupAnchor(
  { className, ...props },
  ref,
) {
  return (
    <a
      ref={ref}
      className={cn(
        "rounded-[9px] px-2 py-[5px] font-sans text-[12.5px] font-medium whitespace-nowrap text-ink-2 no-underline transition-colors hover:text-foreground aria-[current=page]:bg-panel aria-[current=page]:text-foreground aria-[current=page]:shadow-xs max-md:flex max-md:min-h-11 max-md:items-center",
        focusRing,
        className,
      )}
      {...props}
    />
  );
});

/** A tab inside an expanded group. */
export const TabGroupLink = createLink(GroupAnchor);

/** An expanded group: its label, then its own tabs, on the sunken pill of the same line. */
export function TabGroup({
  label,
  icon = "settings",
  close,
  children,
}: {
  readonly label: string;
  readonly icon?: IconName;
  /** A `TabGroupClose` back to the line without the group, when the group can be closed. */
  readonly close?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="ml-2 inline-flex items-center gap-px rounded-xl bg-secondary p-[3px]"
    >
      <span className="mr-[3px] flex items-center gap-1.5 border-r border-rule py-[5px] pr-2.5 pl-2 font-sans text-[13px] font-semibold text-foreground">
        <Icon name={icon} size={15} />
        {label}
      </span>
      {children}
      {close}
    </div>
  );
}

const ToggleAnchor = forwardRef<HTMLAnchorElement, AnchorProps & { readonly icon?: IconName }>(
  function ToggleAnchor({ icon, className, children, ...props }, ref) {
    return (
      <a
        ref={ref}
        className={cn(
          "ml-2 flex items-center gap-[7px] rounded-[9px] border border-rule bg-panel px-2 py-1.5 font-sans text-[13.5px] leading-[1.3] font-medium whitespace-nowrap text-ink-2 no-underline shadow-xs transition-colors hover:text-foreground max-md:min-h-11",
          focusRing,
          className,
        )}
        {...props}
      >
        {icon === undefined ? null : <Icon name={icon} size={15} />}
        {children}
        <Icon name="chevronRight" size={13} />
      </a>
    );
  },
);

/** A folded group: one link that opens the group on the same line. */
export const TabGroupToggle = createLink(ToggleAnchor);

const CloseAnchor = forwardRef<HTMLAnchorElement, AnchorProps & { readonly label: string }>(
  function CloseAnchor({ label, className, ...props }, ref) {
    return (
      <a
        ref={ref}
        aria-label={label}
        title={label}
        className={cn(
          "ml-0.5 grid size-6 place-items-center rounded-[7px] text-muted-foreground transition-colors hover:text-foreground max-md:size-11",
          focusRing,
          className,
        )}
        {...props}
      >
        <Icon name="chevronLeft" size={13} />
      </a>
    );
  },
);

/** Closes an expanded group: a link back to the line without it. */
export const TabGroupClose = createLink(CloseAnchor);

const UnderlineAnchor = forwardRef<HTMLAnchorElement, AnchorProps>(function UnderlineAnchor(
  { className, ...props },
  ref,
) {
  return (
    <a
      ref={ref}
      className={cn(
        "relative flex items-center gap-[7px] rounded-sm pb-[11px] max-md:min-h-11 font-sans text-[13.5px] leading-[1.3] font-medium whitespace-nowrap text-muted-foreground no-underline transition-colors hover:text-foreground aria-[current=page]:text-foreground aria-[current=page]:after:absolute aria-[current=page]:after:inset-x-0 aria-[current=page]:after:-bottom-px aria-[current=page]:after:h-0.5 aria-[current=page]:after:rounded-sm aria-[current=page]:after:bg-primary",
        focusRing,
        className,
      )}
      {...props}
    />
  );
});

/**
 * `.utabs`: the underlined tab line of a session. Like `TabLink`, every tab is a router link with
 * its own URL; the current one carries `aria-current="page"` and the cobalt underline. Lay them in
 * an `UnderlineTabLine`.
 */
export const UnderlineTabLink = createLink(UnderlineAnchor);

export function UnderlineTabLine({
  label,
  children,
  className,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <nav
      ref={revealCurrent}
      aria-label={label}
      className={cn(
        "flex items-center gap-5 overflow-x-auto overscroll-x-contain border-b border-rule",
        className,
      )}
    >
      {children}
    </nav>
  );
}

const SegmentAnchor = forwardRef<HTMLAnchorElement, AnchorProps>(function SegmentAnchor(
  { className, ...props },
  ref,
) {
  return (
    <a
      ref={ref}
      className={cn(
        "flex items-center gap-[7px] rounded-[9px] px-3 py-1.5 font-sans text-[13px] leading-[1.3] font-medium whitespace-nowrap text-ink-2 no-underline transition-colors hover:text-foreground aria-[current=page]:bg-panel aria-[current=page]:text-foreground aria-[current=page]:shadow-xs max-md:min-h-11",
        focusRing,
        className,
      )}
      {...props}
    />
  );
});

/**
 * A tab line drawn as a `.seg` track (the split view's work panel, the full-screen top bar): the
 * same links with their own URLs as `UnderlineTabLink`, on the sunken pill.
 */
export const SegmentTabLink = createLink(SegmentAnchor);

export function SegmentTabLine({
  label,
  children,
  className,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <nav
      ref={revealCurrent}
      aria-label={label}
      className={cn("inline-flex w-fit gap-0.5 rounded-xl bg-secondary p-[3px]", className)}
    >
      {children}
    </nav>
  );
}
