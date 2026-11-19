import { Button } from "@mend/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import { Label } from "@mend/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@mend/ui/components/ui/native-select";
import { cn } from "@mend/ui/lib/utils";
import { CheckIcon, ChevronDownIcon, GitCompareArrowsIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Overlay } from "#/components/projects/overlay";
import type { ReviewRangeRequest } from "#/lib/api";
import { usePhone } from "#/lib/phone";
import type { CheckpointRow, RangeLabel } from "#/lib/review-range";

/** Which of the picker's rows the open review is: the whole change, since your last review, or up to a checkpoint. */
export type PickedRange =
  | { readonly kind: "whole" }
  | { readonly kind: "since-last-review" }
  | { readonly kind: "up-to"; readonly checkpointId: string }
  | { readonly kind: "custom" };

const timeOf = (at: Date): string =>
  at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** A row's badge: "New" after your last review, "Your last review" on it. */
function RowMark({ mark }: { readonly mark: CheckpointRow["mark"] }) {
  if (mark === null) return null;
  return (
    <span className="shrink-0 rounded-chip border px-1.5 text-2xs leading-[18px] text-muted-foreground">
      {mark === "new" ? "New" : "Your last review"}
    </span>
  );
}

/** The tick beside the range the review is open over. */
const chosen = (on: boolean) =>
  on ? <CheckIcon aria-hidden className="size-4 shrink-0 text-foreground" /> : null;

/** One row of the phone's "Show changes" sheet: a whole-width button, 44px or taller. */
const sheetRow = (key: string, onClick: () => void, children: ReactNode, on: boolean) => (
  <li key={key}>
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className="flex min-h-11 w-full items-center gap-3 px-5 py-2 text-left text-lead outline-none focus-visible:bg-muted"
    >
      {children}
    </button>
  </li>
);

/** Picking two checkpoints to compare: the first and the last of the range, then Show changes. */
function CompareDialog({
  open,
  onOpenChange,
  rows,
  onPick,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly rows: ReadonlyArray<CheckpointRow>;
  readonly onPick: (range: ReviewRangeRequest) => void;
}) {
  const newest = rows[0]?.id ?? "";
  const [from, setFrom] = useState("base");
  const [to, setTo] = useState(newest);
  const ordinalOf = (id: string) =>
    id === "base" ? 0 : (rows.find((row) => row.id === id)?.ordinal ?? 0);
  const backwards = ordinalOf(from) > ordinalOf(to);
  const option = (row: CheckpointRow) => (
    <NativeSelectOption key={row.id} value={row.id}>
      {row.ordinal} · {row.words} · {timeOf(row.createdAt)}
    </NativeSelectOption>
  );
  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title="Compare two checkpoints"
      description="The review shows what changed from the first checkpoint to the second."
      footer={
        <>
          <Button variant="ghost" className="max-lg:h-11" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className="max-lg:h-11"
            disabled={backwards || to === ""}
            onClick={() => {
              onPick({ from, to });
              onOpenChange(false);
            }}
          >
            Show changes
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Label className="grid gap-1.5 text-meta font-normal text-muted-foreground">
          From
          <NativeSelect
            size="field"
            className="w-full"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          >
            <NativeSelectOption value="base">0 · Where the change starts</NativeSelectOption>
            {rows.map(option)}
          </NativeSelect>
        </Label>
        <Label className="grid gap-1.5 text-meta font-normal text-muted-foreground">
          To
          <NativeSelect
            size="field"
            className="w-full"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          >
            {rows.map(option)}
          </NativeSelect>
        </Label>
        {backwards ? (
          <p role="alert" className="text-meta text-destructive">
            The first checkpoint has to come before the second.
          </p>
        ) : null}
      </div>
    </Overlay>
  );
}

/**
 * The Change toolbar's range (Doop "Change · checkpoint range picker"): a menu on a wide screen,
 * a sheet titled "Show changes" on a phone. The whole change; since your last review, when you
 * have sent comments on this change; up to any checkpoint; or two checkpoints compared.
 */
export function RangePicker({
  label,
  picked,
  base,
  latest,
  lastReview,
  rows,
  onPick,
  onOpen,
}: {
  readonly label: RangeLabel;
  readonly picked: PickedRange;
  /** "main". */
  readonly base: string;
  readonly latest: number;
  readonly lastReview: { readonly ordinal: number } | null;
  readonly rows: ReadonlyArray<CheckpointRow>;
  readonly onPick: (range: ReviewRangeRequest | null) => void;
  /** The list is about to show: a chance to read the checkpoints again. */
  readonly onOpen?: () => void;
}) {
  const phone = usePhone();
  const [sheet, setSheet] = useState(false);
  const [comparing, setComparing] = useState(false);
  const pick = (range: ReviewRangeRequest | null) => {
    setSheet(false);
    onPick(range);
  };

  const trigger = (
    <>
      <GitCompareArrowsIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span>{label.range}</span>
      <span className="truncate font-normal text-muted-foreground">· {label.detail}</span>
      <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </>
  );
  const triggerClass =
    "inline-flex h-8 min-w-0 items-center gap-[7px] rounded-lg border border-input bg-background px-2.5 text-control font-medium whitespace-nowrap outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:border-ring @max-3xl/change:h-11 @max-3xl/change:flex-1 @max-3xl/change:border-0 @max-3xl/change:px-0 @max-3xl/change:text-lead";

  const rangeRows: ReadonlyArray<{
    readonly key: string;
    readonly name: string;
    readonly detail: string;
    readonly on: boolean;
    readonly range: ReviewRangeRequest | null;
  }> = [
    {
      key: "whole",
      name: "Whole change",
      detail: `${base} to checkpoint ${latest}`,
      on: picked.kind === "whole",
      range: null,
    },
    ...(lastReview === null
      ? []
      : [
          {
            key: "since",
            name: "Since your last review",
            detail: `${lastReview.ordinal} to ${latest}`,
            on: picked.kind === "since-last-review",
            range: { from: "last-review" },
          },
        ]),
  ];
  const isUpTo = (row: CheckpointRow) => picked.kind === "up-to" && picked.checkpointId === row.id;
  const upTo = (row: CheckpointRow): ReviewRangeRequest | null =>
    row.ordinal === latest ? null : { from: "base", to: row.id };

  const compare = (
    <CompareDialog
      key={comparing ? "open" : "closed"}
      open={comparing}
      onOpenChange={setComparing}
      rows={rows}
      onPick={pick}
    />
  );

  if (phone) {
    return (
      <>
        <button
          type="button"
          aria-haspopup="dialog"
          aria-label={`Show changes: ${label.range}, ${label.detail}`}
          className={triggerClass}
          onClick={() => {
            onOpen?.();
            setSheet(true);
          }}
        >
          {trigger}
        </button>
        <Overlay open={sheet} onOpenChange={setSheet} size="md" title="Show changes" footer={null}>
          <div className="-mx-5 grid">
            <p className="px-5 pt-1 pb-1 text-meta text-muted-foreground">Range</p>
            <ul>
              {rangeRows.map((row) =>
                sheetRow(
                  row.key,
                  () => pick(row.range),
                  <>
                    <span className="flex-1">{row.name}</span>
                    <span className="text-muted-foreground">{row.detail}</span>
                    {chosen(row.on)}
                  </>,
                  row.on,
                ),
              )}
            </ul>
            <p className="border-t px-5 pt-3 pb-1 text-meta text-muted-foreground">
              Up to a checkpoint
            </p>
            <ul>
              {rows.map((row) =>
                sheetRow(
                  row.id,
                  () => pick(upTo(row)),
                  <>
                    <span className="grid size-6 shrink-0 place-items-center rounded-md border text-meta text-muted-foreground">
                      {row.ordinal}
                    </span>
                    <span className="min-w-0 truncate">{row.words}</span>
                    <RowMark mark={row.mark} />
                    <span className="ml-auto text-muted-foreground">{timeOf(row.createdAt)}</span>
                    {chosen(isUpTo(row))}
                  </>,
                  isUpTo(row),
                ),
              )}
            </ul>
            <div className="border-t">
              {sheetRow(
                "compare",
                () => {
                  setSheet(false);
                  setComparing(true);
                },
                <>
                  <GitCompareArrowsIcon aria-hidden className="size-4 text-muted-foreground" />
                  Compare two checkpoints…
                </>,
                picked.kind === "custom",
              )}
            </div>
          </div>
        </Overlay>
        {compare}
      </>
    );
  }

  return (
    <>
      <DropdownMenu
        onOpenChange={(open: boolean) => {
          if (open) onOpen?.();
        }}
      >
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={`Show changes: ${label.range}, ${label.detail}`}
              className={triggerClass}
            />
          }
        >
          {trigger}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[380px]">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Range</DropdownMenuLabel>
            {rangeRows.map((row) => (
              <DropdownMenuItem
                key={row.key}
                onClick={() => pick(row.range)}
                className={cn("gap-3", row.on && "bg-muted/60")}
              >
                <span className="flex-1">{row.name}</span>
                <span className="text-muted-foreground">{row.detail}</span>
                {chosen(row.on)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Up to a checkpoint</DropdownMenuLabel>
            {rows.map((row) => (
              <DropdownMenuItem
                key={row.id}
                onClick={() => pick(upTo(row))}
                className={cn("gap-2", isUpTo(row) && "bg-muted/60")}
              >
                <span className="min-w-0 truncate">
                  {row.ordinal} · {row.words}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-2 text-muted-foreground">
                  {row.mark === null ? null : (
                    <span>{row.mark === "new" ? "New" : "Your last review"} ·</span>
                  )}
                  {timeOf(row.createdAt)}
                </span>
                {chosen(isUpTo(row))}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setComparing(true)} className="gap-2">
            <GitCompareArrowsIcon aria-hidden className="size-4 text-muted-foreground" />
            Compare two checkpoints…
            {chosen(picked.kind === "custom")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {compare}
    </>
  );
}
