import { cn } from "@mend/ui/lib/utils";
import { Questionnaire as QuestionnairePrimitive } from "@shadcn/react/questionnaire";
import { CheckIcon, ChevronLeftIcon } from "lucide-react";
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
 *
 * `step` ("1 of 2") sits at the right of the title when the agent asked several questions at once.
 * `multiple` lets several choices be picked: `values` holds them, and `onValueChange` reports the
 * one that was toggled.
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
  step,
  multiple = false,
  values,
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
  /** Where this question is among the ones asked together, such as "1 of 2". */
  step?: string;
  multiple?: boolean;
  /** The picked choices when `multiple`. */
  values?: readonly string[];
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
  const valueList = rows.map((row) => row.value).join("\n");
  const items = React.useMemo(
    () => [{ name, choices: valueList.split("\n").map((choice) => ({ value: choice })) }],
    [name, valueList],
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
        const first = multiple ? (values?.[0] ?? null) : picked;
        if (first !== null) onSubmit?.(first);
      }}
      className={cn("group/question grid gap-0.5 pt-4 pr-4 pb-3 pl-4.5 text-row", className)}
    >
      <QuestionnairePrimitive.Item
        name={name}
        multiple={multiple}
        className="m-0 grid min-w-0 gap-0.5 border-0 p-0"
      >
        <QuestionnairePrimitive.Title className="flex w-full items-baseline gap-3 p-0 text-lead font-semibold">
          <span className="min-w-0 flex-1">{title}</span>
          {step === undefined ? null : (
            <span className="shrink-0 text-meta font-normal text-muted-foreground tabular-nums">
              {step}
            </span>
          )}
        </QuestionnairePrimitive.Title>
        {description === undefined ? null : (
          <QuestionnairePrimitive.Description className="mb-2 text-muted-foreground">
            {description}
          </QuestionnairePrimitive.Description>
        )}
        <QuestionnairePrimitive.Choices className="grid min-w-0 gap-0.5">
          {rows.map((row) => {
            const isOther = "other" in row;
            const checked = multiple ? (values ?? []).includes(row.value) : picked === row.value;
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
                    <span className="truncate text-muted-foreground group-data-[size=touch]/question:whitespace-normal">
                      {row.description}
                    </span>
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

/**
 * An earlier question of several asked together, answered and folded, above the one being
 * answered: "Question 1: Back off and retry", and Change, which goes back to it. The whole row is
 * the button.
 */
function QuestionEarlier({
  size = "default",
  label,
  answer,
  onChange,
  className,
}: {
  size?: "default" | "touch";
  /** Which question it was, such as "Question 1". */
  label: string;
  answer: string;
  onChange: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-slot="question-earlier"
      data-size={size}
      onClick={onChange}
      aria-label={`Change your answer to ${label}: ${answer}`}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 bg-card py-2.5 pr-4 pl-3.5 text-left text-row outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset data-[size=touch]:min-h-11",
        className,
      )}
    >
      <ChevronLeftIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-muted-foreground">{label}: </span>
        {answer}
      </span>
      <span className="shrink-0 text-muted-foreground">Change</span>
    </button>
  );
}

export { Question, QuestionEarlier, type QuestionChoice };
