import { previewStatusLine, serviceReach } from "@mend/domain/workbench";

import type {
  ServiceRecipeDto,
  ServiceViewDto,
  SessionProcessDto,
  WorktreePreviewsDto,
} from "./api.ts";
import {
  placePreviews,
  type PreviewsRead,
  rowOpen,
  type ServicePreview,
  whyNoOpen,
} from "./previews.ts";

/**
 * A workspace's Services, as the Preview view lists them (Doop "Preview · this workspace's
 * services"). Sessions share a workspace, and the server keeps each Service on the session that
 * started it: the view lists, together, the Services of every session in the worktree, and the
 * recipes `.mend/mend.toml` declares that none of them runs. Everything here is pure.
 */

/** The attempt the Service points at now: its running process, or the one that last ran. */
export const currentAttempt = (view: ServiceViewDto): SessionProcessDto | null =>
  view.service.currentAttemptId === null
    ? null
    : (view.attempts.find((attempt) => attempt.id === view.service.currentAttemptId) ?? null);

/** The newest attempt that ran a command: what Run again runs. Null for an adopted port. */
export const latestSupervisedAttempt = (view: ServiceViewDto): SessionProcessDto | null =>
  view.attempts.findLast((attempt) => attempt.argv.length > 0) ?? null;

/** What Mend last observed of the Service's current forward; null before it observed anything. */
export const currentObservation = (view: ServiceViewDto) =>
  view.currentForward !== null && view.latestObservation?.forwardId === view.currentForward.id
    ? view.latestObservation
    : null;

/** Its process runs, or its forward is up (an adopted port has no process of Mend's). */
export const serviceIsLive = (view: ServiceViewDto): boolean => {
  const attempt = currentAttempt(view);
  return (
    (attempt !== null && attempt.exitedAt === null) ||
    view.currentForward?.state === "binding" ||
    view.currentForward?.state === "bound"
  );
};

/** "pnpm dev" from `sh -c "pnpm dev"`, the way the form sends a typed command. */
export const commandOf = (argv: ReadonlyArray<string>): string | null => {
  if (argv.length === 0) return null;
  if (argv.length === 3 && (argv[0] === "sh" || argv[0] === "/bin/sh") && argv[1] === "-c")
    return argv[2] ?? null;
  return argv.join(" ");
};

/** The one word a Service's state is, and how loud: Status's tones. */
export interface ServiceState {
  readonly word: string;
  readonly tone: "run" | "ok" | "bad" | "idle";
}

/**
 * What a Service is now, as observed: Starting until its port answers for the first time,
 * Running while it answers, Not answering when Mend's last check of its port failed, and once
 * it ended, Stopped, or Exited with its code when it ended by itself on a failure.
 */
export const serviceState = (view: ServiceViewDto): ServiceState => {
  const attempt = currentAttempt(view) ?? view.attempts.at(-1) ?? null;
  if (serviceIsLive(view)) {
    const observed = currentObservation(view);
    if (observed?.state === "reachable") return { word: "Running", tone: "run" };
    if (observed?.state === "unreachable") return { word: "Not answering", tone: "bad" };
    if (attempt?.status === "starting" || view.currentForward?.state === "binding")
      return { word: "Starting", tone: "run" };
    return { word: "Running", tone: "run" };
  }
  if (view.currentForward?.state === "failed") return { word: "Failed to start", tone: "bad" };
  if (attempt !== null && attempt.status !== "stopped" && (attempt.exitCode ?? 0) !== 0)
    return { word: `Exited with code ${attempt.exitCode ?? 0}`, tone: "bad" };
  return { word: "Stopped", tone: "idle" };
};

/** One Service of the workspace, as its row and the view's pane read it. */
export interface WorkspaceService {
  readonly view: ServiceViewDto;
  readonly id: string;
  readonly sessionId: string;
  readonly name: string;
  readonly port: number;
  readonly udp: boolean;
  /** Declared a web page (`browserScheme`): only these open in a browser. */
  readonly web: boolean;
  readonly live: boolean;
  readonly state: ServiceState;
  /** What runs: "pnpm dev"; null for an adopted port. */
  readonly command: string | null;
  /** The attempt whose output the log shows: the current one, else the last that ran. */
  readonly logProcessId: string | null;
  /** It was started from `.mend/mend.toml`. */
  readonly fromFile: boolean;
}

/** How many ended Services the list keeps beside the live ones. */
const ENDED_SHOWN = 3;

/**
 * The workspace's Services in the order the list shows them: the live ones by when they
 * started, then the latest few that ended, one per name, leaving out a name that runs again.
 */
export const workspaceServices = (
  views: ReadonlyArray<ServiceViewDto>,
  sessionIds: ReadonlySet<string>,
): ReadonlyArray<WorkspaceService> => {
  const mine = views.filter((view) => sessionIds.has(view.service.sessionId));
  const live = mine
    .filter(serviceIsLive)
    .toSorted((a, b) => a.service.createdAt.getTime() - b.service.createdAt.getTime());
  const liveNames = new Set(live.map((view) => view.service.name));
  const endedByName = new Map<string, ServiceViewDto>();
  for (const view of mine.toSorted(
    (a, b) => a.service.updatedAt.getTime() - b.service.updatedAt.getTime(),
  )) {
    if (serviceIsLive(view) || liveNames.has(view.service.name)) continue;
    endedByName.delete(view.service.name);
    endedByName.set(view.service.name, view);
  }
  const ended = [...endedByName.values()].slice(-ENDED_SHOWN).toReversed();
  return [...live, ...ended].map((view): WorkspaceService => {
    const attempt = currentAttempt(view) ?? view.attempts.at(-1) ?? null;
    const supervised = latestSupervisedAttempt(view);
    return {
      view,
      id: view.service.id,
      sessionId: view.service.sessionId,
      name: view.service.name,
      port: view.service.workspacePort,
      udp: view.service.transport === "udp",
      web: view.service.browserScheme !== null,
      live: serviceIsLive(view),
      state: serviceState(view),
      command: commandOf(supervised?.argv ?? []),
      // An adopted port has no process of Mend's, so nothing of its output is recorded.
      logProcessId:
        [attempt, supervised].find((each) => each !== null && each.sealantSessionId !== null)?.id ??
        null,
      fromFile: view.service.declarationSource === "recipe-file",
    };
  });
};

/**
 * The recipes `.mend/mend.toml` declares that no Service in the list already shows (that one is
 * restarted from its own row). Services come only from the file (decision D8): a recipe a
 * project once saved in Mend's database is not offered.
 */
export const fileRecipes = (
  recipes: ReadonlyArray<ServiceRecipeDto>,
  shown: ReadonlyArray<WorkspaceService>,
): ReadonlyArray<ServiceRecipeDto> => {
  const names = new Set(shown.map((service) => service.name));
  return recipes.filter(
    (recipe) => recipe.source === "file" && recipe.shadowedBy === null && !names.has(recipe.name),
  );
};

/** ":3000", or ":53/udp": a port as the list and the tab write it. */
export const portText = (port: number, udp = false): string => `:${port}${udp ? "/udp" : ""}`;

/** The Service the view shows: the one picked while it is listed, else the first live web one. */
export const shownService = (
  services: ReadonlyArray<WorkspaceService>,
  picked: string | null,
): WorkspaceService | null =>
  services.find((service) => service.name === picked) ??
  services.find((service) => service.live && service.web) ??
  services.find((service) => service.live) ??
  services[0] ??
  null;

/** The Preview tab's fact: the shown Service's port while it runs (":3000"). */
export const previewFact = (service: WorkspaceService | null): string | undefined =>
  service === null || !service.live ? undefined : portText(service.port, service.udp);

/** The worktree's previews, read or not, placed against the Services shown. */
export const readPreviews = (
  read: { readonly data: WorktreePreviewsDto | undefined; readonly isError: boolean },
  sessionId: string,
  services: ReadonlyArray<WorkspaceService>,
  recipeNames: ReadonlyArray<string>,
): PreviewsRead => {
  // A failed refresh wins over what an earlier read said: the query keeps that data, but it no
  // longer vouches for where Open goes.
  const answered = read.isError ? undefined : read.data;
  if (answered === undefined)
    return {
      _tag: "Unknown",
      why: read.isError
        ? "Mend couldn't read this worktree's previews"
        : "Reading this worktree's previews",
    };
  return {
    _tag: "Read",
    placed: placePreviews(answered, sessionId, {
      serviceIds: new Set(services.map((service) => service.id)),
      names: new Set([...services.map((service) => service.name), ...recipeNames]),
    }),
  };
};

const previewOf = (previews: PreviewsRead, service: WorkspaceService): ServicePreview | null =>
  previews._tag === "Read"
    ? (previews.placed.byService.get(service.id) ??
      previews.placed.byName.get(service.name) ??
      null)
    : null;

/**
 * Where a Service opens in a browser, and if it doesn't, why: its preview (Mend's own
 * `/preview-auth` link) when one is placed, else its own address once Mend saw it answer from
 * here, else the tunnel command when its address answers only on Mend's machine.
 */
export type ServiceOpen =
  | { readonly _tag: "Open"; readonly href: string }
  | { readonly _tag: "Waiting"; readonly why: string }
  | { readonly _tag: "Tunnel" }
  | { readonly _tag: "None"; readonly why: string | null };

export const serviceOpen = (
  service: WorkspaceService,
  previews: PreviewsRead,
  onMendHost: boolean,
): ServiceOpen => {
  const reach = serviceReach(service.view.endpoints, onMendHost);
  const url = reach.kind === "direct" ? reach.browserUrl : null;
  const observed = currentObservation(service.view)?.state ?? null;
  const open = rowOpen(
    previews,
    previewOf(previews, service),
    service.live && url !== null && observed === "reachable" ? url : null,
  );
  if (open?._tag === "Link") return { _tag: "Open", href: open.href };
  if (open?._tag === "Waiting") return { _tag: "Waiting", why: open.why };
  if (service.live && reach.kind === "tunnel") return { _tag: "Tunnel" };
  return {
    _tag: "None",
    why: whyNoOpen({ live: service.live, open, reach: reach.kind, browserUrl: url, observed }),
  };
};

/** The preview's own lines for a Service ("preview · web · answered HTTP 200 · observed 4 s ago"). */
export const previewLines = (
  previews: PreviewsRead,
  service: WorkspaceService,
  now: Date,
): ReadonlyArray<string> => {
  if (previews._tag !== "Read") return [];
  const preview = previewOf(previews, service);
  return preview === null ? [] : preview.facts.map((fact) => previewStatusLine(fact, { now }));
};

/** How many lines of a log the view keeps; older output stays in the record. */
export const LOG_LINES_KEPT = 2_000;

const decoder = (): TextDecoder => new TextDecoder("utf-8", { fatal: false });

/** The bytes of one base64 chunk. */
const bytesOf = (base64: string): Uint8Array =>
  Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

/**
 * Terminal control sequences a log has no use for: colours, cursor moves, titles. What they
 * colour stays.
 */
const CONTROL =
  // oxlint-disable-next-line no-control-regex -- escape sequences are what this removes
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f]/gu;

/**
 * A Service's recorded output as lines a person reads: the chunks in order, decoded as UTF-8
 * across chunk boundaries, control sequences dropped, and a line redrawn with `\r` (a progress
 * bar) kept as it was last drawn. Only the last `LOG_LINES_KEPT` lines.
 */
export const logLines = (
  chunks: ReadonlyArray<{ readonly dataBase64: string }>,
): ReadonlyArray<string> => {
  const text = decoder();
  const decoded =
    chunks.map((chunk) => text.decode(bytesOf(chunk.dataBase64), { stream: true })).join("") +
    text.decode();
  const lines = decoded
    .replace(CONTROL, "")
    .replace(/\r\n/gu, "\n")
    .split("\n")
    .map((line) => line.split("\r").findLast((part) => part !== "") ?? "");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-LOG_LINES_KEPT);
};

/** The last line that says something: what the collapsed Logs bar shows. */
export const lastLogLine = (lines: ReadonlyArray<string>): string | null =>
  lines.findLast((line) => line.trim() !== "") ?? null;
