import { Input } from "@mend/ui/components/ui/input";
import { Label } from "@mend/ui/components/ui/label";
import { Eye, EyeOff } from "lucide-react";

/** The account form fields shared by sign-in, registration and joining by invitation. */

export function Field({
  id,
  label,
  type,
  value,
  onChange,
  autoComplete,
  required,
}: {
  readonly id: string;
  readonly label: string;
  readonly type: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly autoComplete: string;
  readonly required?: boolean;
}) {
  return (
    <div>
      <Label htmlFor={id} className="mb-1.5 block">
        {label}
      </Label>
      <Input
        id={id}
        className="h-10 bg-background"
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        {...(required === true ? { required: true } : {})}
      />
    </div>
  );
}

/**
 * A password input with its own reveal. Both password fields of the
 * registration share one `shown`, so revealing shows the pair being compared.
 */
export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  shown,
  onToggle,
  hint = null,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly autoComplete: string;
  readonly shown: boolean;
  readonly onToggle: () => void;
  /** A live, quiet statement under the field (the pair differs); null for none. */
  readonly hint?: string | null;
}) {
  return (
    <div>
      <Label htmlFor={id} className="mb-1.5 block">
        {label}
      </Label>
      <div className="relative">
        <Input
          id={id}
          className="h-10 bg-background pr-10"
          type={shown ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          required
        />
        <button
          type="button"
          onClick={onToggle}
          aria-label={shown ? "Hide password" : "Show password"}
          aria-pressed={shown}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
        >
          {shown ? (
            <EyeOff className="size-4" aria-hidden="true" />
          ) : (
            <Eye className="size-4" aria-hidden="true" />
          )}
        </button>
      </div>
      {hint === null ? null : (
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
