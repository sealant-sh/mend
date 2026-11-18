import { cn } from "@mend/ui/lib/utils";
import { Questionnaire as QuestionnairePrimitive } from "@shadcn/react/questionnaire";
import { CheckIcon } from "lucide-react";
import * as React from "react";

type QuestionChoice = { value: string; label: string; description?: string };

/**
 * The agent's question, as the top half of the composer card: a title, a description, numbered
 * choices as flat rows (the picked one gets the choice tint, a filled key and a tick), an optional
 * `other` row ("Something else…") and a hint.
 *
 * There is one send control, the composer's: it sends the picked choice and any note. The number
 * keys pick a choice and Enter on a picked choice submits (`onSubmit`), both from shadcn's
 * Questionnaire. `size="touch"` makes every choice 44px tall and stacks its description.
 */
function Question({
  size = "default",
  title,
  description,
  choices,
  other,
  value,
  defaultValue = null,
  onValueChange,
  onSubmit,
  hint,
  actions,
  name = "answer",
  className,
}: {
  size?: "default" | "touch";
  title: string;
  description?: string;
  choices: readonly QuestionChoice[];
  /** A last, muted row for an answer of the person's own. Picking it reports its value. */
  other?: { value: string; label: string };
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  hint?: string;
  actions?: React.ReactNode;
  name?: string;
  className?: string;
}) {
  const [own, setOwn] = React.useState<string | null>(defaultValue);
  const picked = value === undefined ? own : value;
  const pick = (next: string) => {
    if (value === undefined) setOwn(next);
    onValueChange?.(next);
  };
  const rows = other === undefined ? choices : [...choices, { ...other, other: true }];
  // The values are what the primitive numbers; rebuild its list only when they change.
  const values = rows.map((row) => row.value).join("\n");
  const items = React.useMemo(
    () => [{ name, choices: values.split("\n").map((choice) => ({ value: choice })) }],
    [name, values],
  );

  return (
    <QuestionnairePrimitive.Root
      data-slot="question"
      data-size={size}
      shortcuts="numbers"
      items={items}
      defaultItem={name}
      onSubmit={(event) => {
        event.preventDefault();
        if (picked !== null) onSubmit?.(picked);
      }}
      className={cn("group/question grid gap-0.5 pt-4 pr-4 pb-3 pl-4.5 text-row", className)}
    >
      <QuestionnairePrimitive.Item name={name} className="m-0 grid min-w-0 gap-0.5 border-0 p-0">
        <QuestionnairePrimitive.Title className="p-0 text-lead font-semibold">
          {title}
        </QuestionnairePrimitive.Title>
        {description === undefined ? null : (
          <QuestionnairePrimitive.Description className="mb-2 text-muted-foreground">
            {description}
          </QuestionnairePrimitive.Description>
        )}
        <QuestionnairePrimitive.Choices className="grid min-w-0 gap-0.5">
          {rows.map((row) => {
            const isOther = "other" in row;
            const checked = picked === row.value;
            return (
              <QuestionnairePrimitive.Choice
                key={row.value}
                value={row.value}
                checked={checked}
                onChange={() => pick(row.value)}
                className="group/choice relative -mx-2 flex min-h-9 cursor-pointer items-center gap-3 rounded-lg py-1.5 pr-2.5 pl-2 hover:bg-accent has-[>input:focus-visible]:ring-3 has-[>input:focus-visible]:ring-ring/50 data-checked:bg-choice data-checked:hover:bg-choice group-data-[size=touch]/question:min-h-11"
              >
                <QuestionnairePrimitive.ChoiceInput className="absolute inset-0 z-10 size-full cursor-pointer opacity-0" />
                <QuestionnairePrimitive.ChoiceShortcut className="grid size-5.5 shrink-0 place-items-center rounded-md border border-input text-2xs font-medium text-muted-foreground group-data-checked/choice:border-primary group-data-checked/choice:bg-primary group-data-checked/choice:text-primary-foreground" />
                <QuestionnairePrimitive.ChoiceLabel
                  className={cn(
                    "flex min-w-0 items-baseline gap-3 group-data-[size=touch]/question:grid group-data-[size=touch]/question:gap-px",
                    isOther && "text-muted-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "shrink-0",
                      !isOther && "w-37.5 font-semibold group-data-[size=touch]/question:w-auto",
                    )}
                  >
                    {row.label}
                  </span>
                  {isOther || row.description === undefined ? null : (
                    <span className="truncate text-muted-foreground">{row.description}</span>
                  )}
                </QuestionnairePrimitive.ChoiceLabel>
                {checked ? (
                  <CheckIcon aria-hidden="true" className="ms-auto size-4 shrink-0 text-ring" />
                ) : null}
              </QuestionnairePrimitive.Choice>
            );
          })}
        </QuestionnairePrimitive.Choices>
      </QuestionnairePrimitive.Item>
      {hint === undefined && actions === undefined ? null : (
        <div
          className={cn(
            "mt-2 flex items-center gap-2 group-data-[size=touch]/question:justify-end",
            // The hint hides on phones; with no actions there is nothing left to show.
            actions === undefined && "group-data-[size=touch]/question:hidden",
          )}
        >
          {hint === undefined ? null : (
            <span className="flex-1 text-meta text-muted-foreground group-data-[size=touch]/question:hidden">
              {hint}
            </span>
          )}
          {actions}
        </div>
      )}
    </QuestionnairePrimitive.Root>
  );
}

export { Question, type QuestionChoice };
