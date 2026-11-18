import { Field, FieldDescription, FieldError, FieldLabel } from "@mend/ui/components/ui/field";
import { Input } from "@mend/ui/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@mend/ui/components/ui/input-group";
import { Eye, EyeOff } from "lucide-react";
import type { ReactNode, Ref } from "react";

/**
 * The fields of the account forms (sign-in, the first account, a reset link, and joining from an
 * invitation): a label, the input, a quiet hint under it, and in its place the field's problem in
 * red once the form was sent with one.
 */

/** The frames' field height: 36px on a desktop, a 44px touch target on a phone. */
const HEIGHT = "h-9 max-lg:h-11 max-lg:text-base";

interface FieldProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly autoComplete: string;
  /** A quiet line under the field; the problem replaces it while there is one. */
  readonly hint?: string | undefined;
  /** What is wrong with the value, shown under the field once the form was sent. */
  readonly problem?: string | undefined;
  /** A way out of the problem (a Button), beside it on a desktop and under it on a phone. */
  readonly action?: ReactNode;
  readonly inputRef?: Ref<HTMLInputElement>;
}

/** What a screen reader reads after the label: the problem, or the hint. */
const describedBy = (id: string, hint: string | undefined, problem: string | undefined) =>
  problem !== undefined ? `${id}-problem` : hint !== undefined ? `${id}-hint` : undefined;

function Below({
  id,
  hint,
  problem,
  action,
}: Pick<FieldProps, "id" | "hint" | "problem" | "action">) {
  if (problem !== undefined) {
    const error = (
      <FieldError id={`${id}-problem`} className="text-row max-lg:text-sm">
        {problem}
      </FieldError>
    );
    return action === undefined ? (
      error
    ) : (
      <div className="flex items-center justify-between gap-3 max-lg:flex-col max-lg:items-stretch">
        {error}
        {action}
      </div>
    );
  }
  return hint === undefined ? null : (
    <FieldDescription id={`${id}-hint`} className="text-row max-lg:text-sm">
      {hint}
    </FieldDescription>
  );
}

export function TextField({
  id,
  label,
  type,
  value,
  onChange,
  autoComplete,
  hint,
  problem,
  action,
  inputRef,
}: FieldProps & { readonly type: "text" | "email" }) {
  return (
    <Field>
      <FieldLabel htmlFor={id} className="max-lg:text-base">
        {label}
      </FieldLabel>
      <Input
        id={id}
        ref={inputRef}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        spellCheck={false}
        aria-invalid={problem === undefined ? undefined : true}
        aria-describedby={describedBy(id, hint, problem)}
        className={HEIGHT}
      />
      <Below id={id} hint={hint} problem={problem} action={action} />
    </Field>
  );
}

/**
 * A password input with its own Show button. The two fields of a new password share one `shown`,
 * so showing one shows the pair being compared.
 */
export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  hint,
  problem,
  inputRef,
  shown,
  onToggle,
}: FieldProps & { readonly shown: boolean; readonly onToggle: () => void }) {
  return (
    <Field>
      <FieldLabel htmlFor={id} className="max-lg:text-base">
        {label}
      </FieldLabel>
      <InputGroup className={HEIGHT}>
        <InputGroupInput
          id={id}
          ref={inputRef}
          type={shown ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          spellCheck={false}
          aria-invalid={problem === undefined ? undefined : true}
          aria-describedby={describedBy(id, hint, problem)}
          className="max-lg:text-base"
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-sm"
            onClick={onToggle}
            aria-label={shown ? "Hide password" : "Show password"}
            aria-pressed={shown}
            className="max-lg:size-11"
          >
            {shown ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <Below id={id} hint={hint} problem={problem} />
    </Field>
  );
}
