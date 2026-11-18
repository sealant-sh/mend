import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
} from "@mend/ui/components/ui/code-block";
import { RadioGroup } from "@mend/ui/components/ui/radio-group";
import { cn } from "@mend/ui/lib/utils";
import * as React from "react";

type ApprovalChoice = { value: string; label: React.ReactNode; description?: React.ReactNode };

const noChoices: readonly ApprovalChoice[] = [];

/**
 * The agent asking for approval, as the top half of the composer card. `title` says what it wants
 * ("Claude Code wants to run a command"). The children show exactly what will happen: an
 * ApprovalCommand for a command and what it touches, a Diff for an edit, a tool and its arguments.
 * Then up to two `choices` as radio rows ("Approve once", "Always allow … in this session"); pass
 * none for an approval with only Deny and Approve. `actions` holds those two Buttons.
 *
 * `size="touch"` is the phone size: 44px choices, and the buttons share the row.
 */
function Approval({
  size = "default",
  title,
  choices = noChoices,
  value,
  defaultValue,
  onValueChange,
  actions,
  children,
  className,
}: {
  size?: "default" | "touch";
  title: React.ReactNode;
  choices?: readonly ApprovalChoice[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  const titleId = React.useId();
  return (
    <div
      data-slot="approval"
      data-size={size}
      role="group"
      aria-labelledby={titleId}
      className={cn(
        "group/approval grid grid-cols-1 gap-2.5 bg-card pt-4 pr-4 pb-3 pl-4.5 text-row text-foreground data-[size=touch]:pt-3.5 data-[size=touch]:pr-3.5 data-[size=touch]:pl-4",
        className,
      )}
    >
      <p id={titleId} className="text-lead font-semibold">
        {title}
      </p>
      {children === undefined ? null : (
        <div
          data-slot="approval-detail"
          className="grid grid-cols-1 gap-2.5 [&_code:not(pre_*)]:rounded-sm [&_code:not(pre_*)]:wrap-anywhere [&_code:not(pre_*)]:bg-muted [&_code:not(pre_*)]:px-1.25 [&_code:not(pre_*)]:py-px [&_code:not(pre_*)]:font-mono [&_code:not(pre_*)]:text-meta group-data-[size=touch]/approval:[&_code:not(pre_*)]:text-2xs"
        >
          {children}
        </div>
      )}
      {choices.length === 0 ? null : (
        <RadioGroup
          aria-labelledby={titleId}
          value={value}
          defaultValue={defaultValue}
          onValueChange={(next) => {
            if (typeof next === "string") onValueChange?.(next);
          }}
          className="-mx-2 gap-0.5"
        >
          {choices.map((choice) => (
            // The whole row is the radio, so a click anywhere on it picks the choice and its
            // text is the radio's name.
            <RadioPrimitive.Root
              key={choice.value}
              value={choice.value}
              className="group/choice flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.75 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 data-checked:bg-choice group-data-[size=touch]/approval:min-h-11 group-data-[size=touch]/approval:items-center group-data-[size=touch]/approval:gap-3 group-data-[size=touch]/approval:py-1.5"
            >
              <span
                aria-hidden="true"
                className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border border-input bg-card group-data-checked/choice:border-primary group-data-[size=touch]/approval:mt-0 group-data-[size=touch]/approval:size-5"
              >
                <RadioPrimitive.Indicator className="size-2 rounded-full bg-primary group-data-[size=touch]/approval:size-2.5" />
              </span>
              <span className="min-w-0">
                <span className="block">{choice.label}</span>
                {choice.description === undefined ? null : (
                  <span className="mt-px block text-meta text-muted-foreground">
                    {choice.description}
                  </span>
                )}
              </span>
            </RadioPrimitive.Root>
          ))}
        </RadioGroup>
      )}
      {actions === undefined ? null : (
        <div
          data-slot="approval-actions"
          className="flex justify-end gap-2 group-data-[size=touch]/approval:grid group-data-[size=touch]/approval:grid-cols-2"
        >
          {actions}
        </div>
      )}
    </div>
  );
}

/**
 * The command an Approval would run: a muted header saying where it runs (the app passes it, such
 * as "Runs in" and the folder in `<code>`), a Copy button, and the command, wrapped.
 */
function ApprovalCommand({
  command,
  where,
  className,
}: {
  command: string;
  where?: React.ReactNode;
  className?: string;
}) {
  return (
    <CodeBlock
      data-slot="approval-command"
      className={cn("border-border bg-card dark:bg-card", className)}
    >
      <CodeBlockHeader className="h-7.5 border-b bg-muted py-0 pr-1 pl-3 text-meta group-data-[size=touch]/approval:h-8 group-data-[size=touch]/approval:pr-0 [&_code]:bg-transparent [&_code]:px-0 [&_code]:text-2xs">
        <span className="min-w-0 truncate">{where}</span>
        <CodeBlockCopyButton
          value={command}
          className="ms-auto group-data-[size=touch]/approval:h-8 group-data-[size=touch]/approval:w-10"
        />
      </CodeBlockHeader>
      <CodeBlockContent wrap className="px-3 py-2 text-meta leading-relaxed">
        {command}
      </CodeBlockContent>
    </CodeBlock>
  );
}

export { Approval, ApprovalCommand, type ApprovalChoice };
