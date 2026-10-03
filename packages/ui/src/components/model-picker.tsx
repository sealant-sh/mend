import { Check } from "lucide-react";

/**
 * The model picker's rows, drawn once for the web and the desktop composers. What the rows say
 * comes from the domain's headless picker (`modelPicker` in `@mend/domain/workbench`): the catalog
 * the server listed, the person's sticky choice, the default preselected. This file only draws.
 *
 * Both composers open these inside their own anchored popover; the rows are a radio group with a
 * quiet mono note beside each label (a model's id, an effort's name).
 */

export interface MenuRadioItem {
  readonly key: string;
  readonly label: string;
  /** Quiet mono note beside the label (a model id, "default"). */
  readonly detail?: string | undefined;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

export function MenuRadioGroup({
  label,
  mono = false,
  items,
}: {
  readonly label?: string | undefined;
  readonly mono?: boolean;
  readonly items: ReadonlyArray<MenuRadioItem>;
}) {
  return (
    <div className="not-first:mt-1 not-first:border-t not-first:border-rule-faint not-first:pt-1">
      {label !== undefined && (
        <p className="px-3.5 pb-1 pt-1.5 text-xs font-medium text-label">{label}</p>
      )}
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitemradio"
          aria-checked={item.selected}
          onClick={item.onSelect}
          className="flex w-full items-center gap-2 px-3.5 py-1.5 text-left transition-colors hover:bg-secondary"
        >
          <Check className={`size-3.5 shrink-0 ${item.selected ? "text-primary" : "invisible"}`} />
          <span
            className={`min-w-0 flex-1 truncate ${mono ? "font-mono text-[12px]" : "font-sans text-[13px]"} text-foreground`}
          >
            {item.label}
          </span>
          {item.detail !== undefined && (
            <span className="shrink-0 font-mono text-[11px] text-faint">{item.detail}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** One model row as the headless picker states it. */
export interface ModelPickerModel {
  readonly id: string;
  readonly label: string;
  readonly isDefault: boolean;
  readonly selected: boolean;
}

/** One effort row as the headless picker states it; `effort` null is the harness's own default. */
export interface ModelPickerEffort<Effort extends string> {
  readonly effort: Effort | null;
  readonly label: string;
  readonly selected: boolean;
}

/**
 * The model rows: the label, the id beside it, `default` beside the server's default. Choosing
 * hands the id back; the host saves it as the sticky choice.
 */
export function ModelMenu({
  label,
  models,
  onPick,
}: {
  readonly label?: string | undefined;
  readonly models: ReadonlyArray<ModelPickerModel>;
  readonly onPick: (modelId: string) => void;
}) {
  return (
    <MenuRadioGroup
      label={label}
      items={models.map((model) => ({
        key: model.id,
        label: model.label,
        detail: model.isDefault ? `${model.id} · default` : model.id,
        selected: model.selected,
        onSelect: () => onPick(model.id),
      }))}
    />
  );
}

/** The thinking rows: `default` first, then the efforts the selected model takes. */
export function EffortMenu<Effort extends string>({
  label = "Thinking",
  efforts,
  onPick,
}: {
  readonly label?: string | undefined;
  readonly efforts: ReadonlyArray<ModelPickerEffort<Effort>>;
  readonly onPick: (effort: Effort | null) => void;
}) {
  return (
    <MenuRadioGroup
      label={label}
      mono
      items={efforts.map((row) => ({
        key: row.effort ?? "default",
        label: row.label,
        selected: row.selected,
        onSelect: () => onPick(row.effort),
      }))}
    />
  );
}
