/**
 * Switching organization (docs/adr/0003, "Organization switching"). The switch moves only this
 * browser's sign-in, and the server ends the event stream it held in the organization it left. So
 * once the server has switched, the page loads `/` afresh: every cached read, the open session
 * and the composer's project belong to the organization that was left, and a full load drops them
 * all. The old app did the same. Creating an organization and leaving one move the sign-in too,
 * and load `/` the same way.
 *
 * A full load forgets the page, so the move leaves a note in this tab's session storage, and the
 * page it lands on reads it once: "Switched to Acme Labs." with a way back, "Created Difference
 * Engine. You're its owner.", or "You left Northwind. You're now in Acme Labs."
 */

/** What the page that loads after the sign-in moved says, and where "Back to …" goes. */
export type SwitchedNote =
  | {
      readonly kind: "switched";
      readonly to: string;
      readonly from: { readonly id: string; readonly name: string };
    }
  | { readonly kind: "created"; readonly name: string }
  /** `now` is null when the organizations didn't read after leaving. */
  | { readonly kind: "left"; readonly left: string; readonly now: string | null };

const NOTE_KEY = "mend-switched-organization";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The note as it was stored; anything else (nothing, or something unreadable) is null. */
export const parseSwitchedNote = (stored: string | null): SwitchedNote | null => {
  if (stored === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  switch (value["kind"]) {
    case "switched": {
      const { to, from } = value;
      if (typeof to !== "string" || !isRecord(from)) return null;
      const { id, name } = from;
      if (typeof id !== "string" || typeof name !== "string") return null;
      return { kind: "switched", to, from: { id, name } };
    }
    case "created": {
      const { name } = value;
      return typeof name === "string" ? { kind: "created", name } : null;
    }
    case "left": {
      const { left, now } = value;
      if (typeof left !== "string" || (now !== null && typeof now !== "string")) return null;
      return { kind: "left", left, now };
    }
    default:
      return null;
  }
};

/** Where the note lives: this tab's session storage, which a private window may refuse. */
export interface NoteStore {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}

const browserStore = (): NoteStore | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

/** Leaves the note for the page the move loads. Without storage, the move says nothing. */
export const leaveSwitchedNote = (
  note: SwitchedNote,
  store: NoteStore | null = browserStore(),
): void => {
  try {
    store?.setItem(NOTE_KEY, JSON.stringify(note));
  } catch {
    // Storage full or refused: the switch still happens, without its toast.
  }
};

/** Reads the note once: a reload after it was shown says nothing. */
export const takeSwitchedNote = (store: NoteStore | null = browserStore()): SwitchedNote | null => {
  try {
    const note = parseSwitchedNote(store?.getItem(NOTE_KEY) ?? null);
    store?.removeItem(NOTE_KEY);
    return note;
  } catch {
    return null;
  }
};

/** Opens home in the organization the sign-in now acts in, dropping everything on the page. */
export const openHomeAfterSwitch = (): void => window.location.assign("/");
