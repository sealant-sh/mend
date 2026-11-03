import type { ReactNode } from "react";

import { focusRing, IconButton } from "./button";
import { SettingRow } from "./field";
import { Segment, type SegmentOption } from "./segment";
import { InfoPopover, Tip } from "./tip";

export type InheritValue = "inherit" | "on" | "off";

/** Where an inherited value comes from: who set it, what it means, and where to change it. */
export interface InheritSource {
  readonly title: string;
  readonly detail: string;
  /**
   * A link to the place that sets it. A tip holds no controls, so the link sits in a popover
   * behind the "Where this comes from" button beside the choice.
   */
  readonly link?: ReactNode;
}

/** Where a value comes from, as a tip says it: words only, since a tip holds no controls. */
const sourceTip = (source: InheritSource) => (
  <>
    <b>{source.title}</b>
    <span>{source.detail}</span>
  </>
);

/**
 * `tri`: Inherit · On · Off for one setting. The Inherit option shows the value it resolves to
 * ("Inherit · on"); hovering or focusing it says where that value comes from, which screen readers
 * hear as its description. With `source.link`, a button beside the choice opens the same words
 * with the link.
 *
 * ```tsx
 * <InheritChoice label="Run sessions in the background" value={choice} onChange={save}
 *   resolved="on" source={{ title: "From Mend's organization defaults", detail: "On for everyone in Mend unless a project changes it." }} />
 * ```
 */
export function InheritChoice({
  label,
  value,
  resolved,
  source,
  onChange,
  disabled,
}: {
  readonly label: string;
  readonly value: InheritValue;
  /** The value Inherit resolves to, in the setting's own words ("on", "off", "high"). */
  readonly resolved: string;
  readonly source: InheritSource;
  readonly onChange: (value: InheritValue) => void;
  readonly disabled?: boolean;
}) {
  const options: ReadonlyArray<SegmentOption<InheritValue>> = [
    {
      value: "inherit",
      className: "min-w-[104px] justify-center",
      label: (
        <span className="border-b border-dashed border-faint pb-px">
          Inherit{" "}
          <span className="font-mono text-[11px] font-normal text-muted-foreground">
            · {resolved}
          </span>
        </span>
      ),
      tip: sourceTip(source),
    },
    { value: "on", label: "On" },
    { value: "off", label: "Off" },
  ];
  return (
    <SettingRow label={label}>
      <span className="flex items-center gap-1">
        <Segment
          label={label}
          options={options}
          value={value}
          onChange={onChange}
          disabled={disabled ?? false}
        />
        {source.link === undefined ? null : (
          <InfoPopover
            label={`Where “${label}” comes from`}
            side="bottom"
            align="end"
            className="w-[280px]"
            trigger={<IconButton icon="info" label="Where this comes from" size="sm" />}
          >
            <div className="grid gap-1">
              <p className="font-semibold">{source.title}</p>
              <p className="text-ink-2">{source.detail}</p>
              <div className="text-info [&_a]:underline [&_a]:underline-offset-2">
                {source.link}
              </div>
            </div>
          </InfoPopover>
        )}
      </span>
    </SettingRow>
  );
}

/**
 * A setting this person reads but does not set here: the value it resolves to and, on hover or
 * focus, where it comes from. The same dashed mark as Inherit, so it reads as one family.
 *
 * ```tsx
 * <InheritedValue label="Suggest fixes" resolved="on"
 *   source={{ title: "From Mend's organization defaults", detail: "Owners of Mend set it." }} />
 * ```
 */
export function InheritedValue({
  label,
  resolved,
  source,
}: {
  readonly label: string;
  readonly resolved: string;
  readonly source: InheritSource;
}) {
  return (
    <SettingRow label={label}>
      <Tip content={sourceTip(source)}>
        <span
          tabIndex={0}
          aria-label={`${label}: ${resolved}`}
          className={`rounded-md border-b border-dashed border-faint pb-px font-mono text-[12px] text-ink-2 ${focusRing}`}
        >
          {resolved} <span className="text-faint">· {source.title.toLowerCase()}</span>
        </span>
      </Tip>
    </SettingRow>
  );
}
