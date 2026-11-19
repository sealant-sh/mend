/**
 * Settings → a project → Only you (Doop "Settings · Project · checkout-api · Only you"): what is
 * the signed-in person's alone in one project (docs/adr/0025): their agent memory there
 * (docs/adr/0009; agent-memory.md `memory-list`, `memory-show`, `memory-remove`) and the Doppler
 * config the project uses for them (docs/adr/0014; doppler.md `doppler-use`). No part of a Doppler
 * token is ever shown here, and Mend never reads the secrets. Pure, so each sentence is tested
 * without a server.
 */

import { dopplerSelectionIssue } from "@mend/domain/workbench";

import { sizeWords } from "./byte-size.ts";

/** One memory file as the API lists it. */
export interface MemoryNote {
  readonly path: string;
  readonly harness: string;
  readonly name: string;
  readonly bytes: number;
  readonly updatedAt: Date;
  readonly updatedBySession: string | null;
}

const time = (at: Date) =>
  at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });

const startOfDay = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();

/** "today at 16:20", "yesterday at 16:20", "on 2 March", "on 2 March 2025". */
export const whenWords = (at: Date, now: Date): string => {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days === 0) return `today at ${time(at)}`;
  if (days === 1) return `yesterday at ${time(at)}`;
  const day = at.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `on ${day}`;
};

/** "1 note", "14 notes". */
export const notesWords = (count: number): string => `${count} ${count === 1 ? "note" : "notes"}`;

/** The newest note: the one the line under Notes talks about. */
const newest = (notes: ReadonlyArray<MemoryNote>): MemoryNote | undefined =>
  notes.reduce<MemoryNote | undefined>(
    (latest, note) =>
      latest === undefined || note.updatedAt.getTime() > latest.updatedAt.getTime() ? note : latest,
    undefined,
  );

/**
 * The Notes row's line: how many the person's memory holds here and when it last changed, by the
 * agent in a session or by an import. "14 notes. The agent last changed one yesterday at 16:20."
 */
export const notesLine = (
  notes: ReadonlyArray<MemoryNote>,
  projectName: string,
  now: Date,
): string => {
  const latest = newest(notes);
  if (latest === undefined) {
    return `No notes yet. The agent saves what it learns when a session of yours in ${projectName} ends, and mend memory import brings in what your own machine's agent knows.`;
  }
  const how =
    latest.updatedBySession === null
      ? `You last imported one ${whenWords(latest.updatedAt, now)}.`
      : `The agent last changed one ${whenWords(latest.updatedAt, now)}.`;
  return `${notesWords(notes.length)}. ${how}`;
};

/** Which agent keeps a note, as a person names it. */
export const harnessName = (harness: string): string =>
  harness === "claude" ? "Claude Code" : harness === "codex" ? "Codex" : harness;

/** A note's facts in the list: "Claude Code · 1.2 KB · changed by a session yesterday at 16:20". */
export const noteFacts = (note: MemoryNote, now: Date): string =>
  [
    harnessName(note.harness),
    sizeWords(note.bytes),
    note.updatedBySession === null
      ? `imported ${whenWords(note.updatedAt, now)}`
      : `changed by session ${note.updatedBySession.slice(0, 8)} ${whenWords(note.updatedAt, now)}`,
  ].join(" · ");

/** The confirmation's sentence for Clear memory. */
export const clearLine = (count: number, projectName: string): string =>
  `Mend removes ${count === 1 ? "the 1 note" : `all ${count} notes`} from your memory in ${projectName}. Your next sessions there start without them. Mend keeps the last version of each on the server.`;

/** What Clear memory did: every file removed, or which weren't and why. */
export const clearedWords = (result: {
  readonly removed: ReadonlyArray<{ readonly name: string }>;
  readonly failed: ReadonlyArray<{ readonly name: string; readonly message: string }>;
}): { readonly done: boolean; readonly words: string } => {
  if (result.failed.length === 0) {
    return {
      done: true,
      words:
        result.removed.length === 0
          ? "Your memory here was already empty."
          : `Cleared ${notesWords(result.removed.length)}.`,
    };
  }
  const failed = result.failed
    .map((file) => `${file.name} (${file.message.trim().replace(/\.$/, "")})`)
    .join(", ");
  return {
    done: false,
    words: `Mend removed ${notesWords(result.removed.length)} but not ${notesWords(result.failed.length)}: ${failed}. Try again.`,
  };
};

/** A note's contents as text: a base64 file (not text Mend can show) says so. */
export const noteText = (file: {
  readonly encoding: "utf8" | "base64";
  readonly contents: string;
}) => (file.encoding === "utf8" ? file.contents : null);

// --- Doppler ------------------------------------------------------------------------------------

/** The person's Doppler connection, as `doppler.status` answers it. */
export interface DopplerState {
  readonly connected: boolean;
  readonly mappings: ReadonlyArray<{
    readonly projectId: string;
    readonly dopplerProject: string;
    readonly config: string;
  }>;
}

/** The Doppler config this project uses for the person, or null. */
export const dopplerPick = (
  status: DopplerState,
  projectId: string,
): { readonly dopplerProject: string; readonly config: string } | null => {
  const mapping = status.mappings.find((entry) => entry.projectId === projectId);
  return mapping === undefined
    ? null
    : { dopplerProject: mapping.dopplerProject, config: mapping.config };
};

/** What the Doppler config row shows: not connected, no config yet, or the config. */
export type DopplerRow =
  | { readonly kind: "not-connected" }
  | { readonly kind: "none" }
  | { readonly kind: "picked"; readonly dopplerProject: string; readonly config: string };

export const dopplerRow = (status: DopplerState, projectId: string): DopplerRow => {
  if (!status.connected) return { kind: "not-connected" };
  const pick = dopplerPick(status, projectId);
  return pick === null ? { kind: "none" } : { kind: "picked", ...pick };
};

/**
 * How the config dialog asks for the names. It picks from Doppler's lists while Doppler lists
 * them; a token that may not list projects (a service token often can't) types both names, and one
 * that lists projects but not a project's configs types the config.
 */
export type DopplerChooser =
  | { readonly kind: "loading" }
  | { readonly kind: "pick" }
  | { readonly kind: "type-config" }
  | { readonly kind: "type-both" };

export const dopplerChooser = (
  projects: "pending" | "success" | "error",
  configs: "idle" | "pending" | "success" | "error",
): DopplerChooser => {
  if (projects === "error") return { kind: "type-both" };
  if (projects === "pending") return { kind: "loading" };
  return configs === "error" ? { kind: "type-config" } : { kind: "pick" };
};

/**
 * Why Mend won't save the typed or picked names, in the dialog; null when it will. The server's own
 * rule (`dopplerSelectionIssue`): names of 1 to 128 letters, digits, underscores or hyphens.
 */
export const dopplerSaveProblem = (dopplerProject: string, config: string): string | null => {
  if (dopplerProject.trim() === "" || config.trim() === "") {
    return "Pick a Doppler project and a config.";
  }
  return dopplerSelectionIssue({ dopplerProject: dopplerProject.trim(), config: config.trim() }) ===
    null
    ? null
    : "Doppler names are letters, digits, underscores and hyphens, up to 128 of them.";
};

/** The toast once a config is saved: the frame's "Saved. Sessions you start in … use …". */
export const dopplerSavedWords = (projectName: string, dopplerProject: string, config: string) =>
  `Saved. Sessions you start in ${projectName} from now on use ${dopplerProject} / ${config}.`;
