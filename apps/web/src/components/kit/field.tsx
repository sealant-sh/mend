import { cn } from "@mend/ui/lib/utils";
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";

/**
 * `.field`: a label over its control, with an optional source note on the right ("from your
 * organization", or `tone="set"` for "set for mend · reset"). The label names the control: render
 * the control with the id `children` receives.
 *
 * ```tsx
 * <Field label="Branch" source={<FieldSource>from your organization</FieldSource>}>
 *   {(id) => <TextInput id={id} value={branch} onChange={…} />}
 * </Field>
 * ```
 */
export function Field({
  label,
  source,
  children,
  className,
}: {
  readonly label: ReactNode;
  readonly source?: ReactNode;
  readonly children: (id: string) => ReactNode;
  readonly className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("mb-4 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 last:mb-0", className)}>
      <div className="flex items-baseline gap-2.5 font-sans text-[12.5px] font-medium text-ink-2">
        <label htmlFor={id}>{label}</label>
        {source === undefined ? null : <span className="ml-auto">{source}</span>}
      </div>
      {children(id)}
    </div>
  );
}

/**
 * `.field` for a control that is not one input, such as a `Segment` or a list of choices: the
 * label names a group instead of pointing at an input.
 *
 * ```tsx
 * <GroupField label="Visible to"><Segment label="Visible to" … /></GroupField>
 * ```
 */
export function GroupField({
  label,
  source,
  children,
  className,
}: {
  readonly label: ReactNode;
  readonly source?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const id = useId();
  return (
    <div
      role="group"
      aria-labelledby={id}
      className={cn("mb-4 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 last:mb-0", className)}
    >
      <div className="flex items-baseline gap-2.5 font-sans text-[12.5px] font-medium text-ink-2">
        <span id={id}>{label}</span>
        {source === undefined ? null : <span className="ml-auto">{source}</span>}
      </div>
      {children}
    </div>
  );
}

/** `.src`: where a field's value comes from. `set` marks a value set here, in cobalt. */
export function FieldSource({
  tone = "inherited",
  children,
}: {
  readonly tone?: "inherited" | "set";
  readonly children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "flex items-center gap-2 font-mono text-[11px] font-normal [&_a]:text-muted-foreground [&_a]:underline [&_a]:underline-offset-2 [&_button]:text-muted-foreground [&_button]:underline [&_button]:underline-offset-2",
        tone === "set" ? "text-info" : "text-faint",
      )}
    >
      {children}
    </span>
  );
}

/**
 * `pair`: two (or more) fields side by side on one grid, so their labels and inputs line up.
 *
 * ```tsx
 * <FieldPair><Field label="Name">…</Field><Field label="Email">…</Field></FieldPair>
 * <FieldPair columns="2fr 1fr">…</FieldPair>
 * ```
 */
export function FieldPair({
  columns = "1fr 1fr",
  children,
}: {
  readonly columns?: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      className="mb-4 grid items-start gap-3 last:mb-0 [&>*]:mb-0"
      style={{ gridTemplateColumns: columns }}
    >
      {children}
    </div>
  );
}

/** `.inp`: a text input, mono by default since most settings values are machine facts. */
export const TextInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { readonly sans?: boolean }
>(function TextInput({ sans = false, className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        "w-full min-w-0 rounded-[10px] border border-input bg-panel px-3 py-[9px] text-[13px] text-foreground outline-none placeholder:text-faint focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/30",
        sans ? "font-sans" : "font-mono",
        className,
      )}
      {...props}
    />
  );
});

/** `.tg`: a setting's label on the left and its control on the right; rows divide with a hairline. */
export function SettingRow({
  label,
  children,
}: {
  readonly label: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 font-sans text-[13.5px] [&+&]:border-t [&+&]:border-rule-faint">
      <span>{label}</span>
      {children}
    </div>
  );
}
