import { type ComponentProps, type ReactNode, useId } from "react";

import { Deferred, firstUse } from "./first-use";
import type * as Popup from "./tip-popup";

/** Base UI's tooltip and popover, loaded on first use (`./first-use`). */
const tips = firstUse(() => import("./tip-popup"));

/**
 * `.tip`: the dark hover note, opened by hovering or focusing its one trigger. Screen readers get
 * the same words as the trigger's description (`aria-describedby`), which is in the page whether
 * the tip shows or not, and before its code has arrived; the visible tip is `role="tooltip"`. A
 * tip holds words only: anything to click goes in an `InfoPopover`, which focus can reach.
 *
 * ```tsx
 * <Tip content={<><b>From Mend's organization defaults</b><span>On for everyone…</span></>}>
 *   <button type="button">Inherit</button>
 * </Tip>
 * ```
 */
export function Tip(props: Omit<ComponentProps<typeof Popup.Tip>, "id" | "triggerRef">) {
  const id = useId();
  return (
    <>
      <Deferred code={tips} trigger={props.children} popup={null} describedBy={id}>
        {(code, woken) => <code.Tip {...props} id={id} triggerRef={woken.triggerRef} />}
      </Deferred>
      <span id={id} hidden>
        {props.content}
      </span>
    </>
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
export function InfoPopover(
  props: Omit<ComponentProps<typeof Popup.InfoPopover>, "defaultOpen" | "triggerRef">,
) {
  const { open, onOpenChange } = props;
  return (
    <Deferred
      code={tips}
      trigger={props.trigger}
      popup="dialog"
      {...(open === undefined ? {} : { onPress: () => onOpenChange?.(true) })}
    >
      {(code, woken) => (
        <code.InfoPopover {...props} defaultOpen={woken.pressed} triggerRef={woken.triggerRef} />
      )}
    </Deferred>
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
