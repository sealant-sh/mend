import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "#/components/kit/button";

/**
 * Remove, then "Remove? Running workspaces keep it" to confirm: a removal asks twice, and says
 * what it does not touch. Leaving the button disarms it. A refusal is announced beside it.
 */
export function ConfirmRemove({
  label,
  disabled = false,
  onRemove,
}: {
  /** What is removed, for the button's accessible name. */
  readonly label: string;
  readonly disabled?: boolean;
  /** Resolves when removed; rejects with the words to show. */
  readonly onRemove: () => Promise<void>;
}) {
  const [armed, setArmed] = useState(false);
  const remove = useMutation({ mutationFn: onRemove, onSettled: () => setArmed(false) });
  return (
    <span className="inline-flex flex-col items-end">
      <Button
        size="sm"
        variant="ghost"
        aria-label={armed ? `Confirm removing ${label}` : `Remove ${label}`}
        disabled={disabled || remove.isPending}
        onBlur={() => setArmed(false)}
        onClick={() => {
          if (!armed) {
            setArmed(true);
            return;
          }
          remove.mutate();
        }}
        className={armed ? "text-danger" : undefined}
      >
        {remove.isPending ? "Removing…" : armed ? "Remove? Running workspaces keep it" : "Remove"}
      </Button>
      <span role="alert" className="mt-1 font-mono text-[11px] text-danger empty:hidden">
        {remove.isError ? remove.error.message : ""}
      </span>
    </span>
  );
}
