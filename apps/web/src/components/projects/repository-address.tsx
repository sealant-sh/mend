import { Field, FieldDescription, FieldError, FieldLabel } from "@mend/ui/components/ui/field";
import { Input } from "@mend/ui/components/ui/input";
import { cn } from "@mend/ui/lib/utils";
import { useId } from "react";

/**
 * The address of a repository to clone, as Add project and setup's First project step ask for it.
 * `issue` is why Mend can't clone it (`sourceIssue`); it shows once `showIssue` says the address
 * looks finished (after a blur, or a try to add), and until then the field says what it takes.
 */
export function RepositoryAddressField({
  value,
  onChange,
  onBlur,
  issue,
  showIssue,
  touch,
  autoFocus = false,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onBlur: () => void;
  readonly issue: string | null;
  readonly showIssue: boolean;
  /** On a phone the field is a 44px touch target. */
  readonly touch: boolean;
  readonly autoFocus?: boolean;
}) {
  const id = useId();
  const invalid = showIssue && issue !== null;
  return (
    <Field data-invalid={invalid ? true : undefined}>
      <FieldLabel htmlFor={id}>Repository address</FieldLabel>
      <Input
        id={id}
        value={value}
        autoComplete="off"
        spellCheck={false}
        // Only when the person asked for the field: it opens in place of the list.
        autoFocus={autoFocus}
        placeholder="https://github.com/owner/repository"
        aria-invalid={invalid ? true : undefined}
        className={cn("font-mono", touch && "h-11")}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
      {invalid ? (
        <FieldError>{issue}</FieldError>
      ) : (
        <FieldDescription>
          An HTTPS or SSH address. Mend clones it with your Git access.
        </FieldDescription>
      )}
    </Field>
  );
}
