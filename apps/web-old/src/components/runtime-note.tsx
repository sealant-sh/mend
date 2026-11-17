import { ErrorNote } from "#/components/kit/status";
import type { RuntimeNote } from "#/lib/runtime-support";

/** A line under a picker about where new sessions run: a muted reason, or a refused saved choice. */
export function RuntimeNoteLine({ note }: { readonly note: RuntimeNote | null }) {
  if (note === null) return null;
  return note.tone === "refused" ? (
    <ErrorNote className="max-w-[72ch]">{note.text}</ErrorNote>
  ) : (
    <p className="max-w-[72ch] text-[12.5px] text-muted-foreground">{note.text}</p>
  );
}
