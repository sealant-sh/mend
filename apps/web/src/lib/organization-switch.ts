/**
 * Switching organization (docs/adr/0003, "Organization switching"). The switch moves only this
 * browser's sign-in, and the server ends the event stream it held in the organization it left. So
 * once the server has switched, the page loads `/` afresh: every cached read, the open session
 * and the composer's project belong to the organization that was left, and a full load drops them
 * all. The old app did the same.
 *
 * A full load forgets the page, so the switch leaves a note in this tab's session storage, and the
 * page it lands on reads it once to say "Switched to Acme Labs." with a way back.
 */

/** What the page that loads after a switch says, and where "Back to …" goes. */
export interface SwitchedNote {
  readonly to: string;
  readonly from: { readonly id: string; readonly name: string };
}

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
  if (!isRecord(value) || !isRecord(value["from"])) return null;
  const { to } = value;
  const { id, name } = value["from"];
  if (typeof to !== "string" || typeof id !== "string" || typeof name !== "string") return null;
  return { to, from: { id, name } };
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

/** Leaves the note for the page the switch loads. Without storage, the switch says nothing. */
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
