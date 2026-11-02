import type { ReactNode } from "react";

import { SettingRow } from "./field";
import { Segment, type SegmentOption } from "./segment";

export type InheritValue = "inherit" | "on" | "off";

/** Where an inherited value comes from: who set it, what it means, and where to change it. */
export interface InheritSource {
  readonly title: string;
  readonly detail: string;
  /** A link to the place that sets it, rendered in the tip's light link colour. */
  readonly link?: ReactNode;
}

/**
 * `tri`: Inherit · On · Off for one setting. The Inherit option shows the value it resolves to
 * ("Inherit · on"), and hovering or focusing it says where that value comes from.
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
      tip: (
        <>
          <b>{source.title}</b>
          <span>{source.detail}</span>
          {source.link === undefined ? null : <span className="tip-link">{source.link}</span>}
        </>
      ),
    },
    { value: "on", label: "On" },
    { value: "off", label: "Off" },
  ];
  return (
    <SettingRow label={label}>
      <Segment
        label={label}
        options={options}
        value={value}
        onChange={onChange}
        disabled={disabled ?? false}
      />
    </SettingRow>
  );
}
