/**
 * Settings → the organization → Runtime (route PR 47, Doop "Settings · Northwind · Runtime"):
 * where the organization's new sessions run, and what a switch would change, in words. Pure, so
 * every sentence the page and its dialog show is tested without a server.
 *
 * A switch changes where new sessions run; running sessions, and every worktree that exists, keep
 * the runtime they were made on (the server's `setSessionRuntime`). What the server answers before
 * a switch (`runtimeSwitch`) is what the new runtime would not run as it is: the organization's
 * workspace image, each project the person can see by name, and a count of private projects they
 * can't. That is what the page says before it switches.
 */

import {
  movesAnything,
  offeredMoves,
  runtimeName,
  type RuntimeSwitchMoves,
  switchChangesNothing,
  type WorkspaceImage,
  type WorkspaceImageOs,
} from "@mend/domain";

import type { OrganizationRuntimeSwitchDto, OrganizationSettingsViewDto } from "./api.ts";
import { namesList } from "./organization-general.ts";
import { clockTime } from "./session-view.ts";

export type SessionRuntimeView = OrganizationSettingsViewDto["sessionRuntime"];
export type SessionRuntime = SessionRuntimeView["offered"][number];
type Impact = OrganizationRuntimeSwitchDto["impact"];
type ObservedImpact = Extract<Impact, { state: "observed" }>;

/** A runtime's name as the page's choices and sentences say it ("Docker", not "this server's Docker"). */
export const RUNTIME_LABELS: Readonly<Record<SessionRuntime, string>> = {
  docker: "Docker",
  "host-vm": "this server's KVM",
  boat: "Boat",
};

/** The order the page lists runtimes in: this server's two, then Boat. */
const RUNTIME_ORDER: ReadonlyArray<SessionRuntime> = ["docker", "host-vm", "boat"];

/** What the Session runtime section shows. */
export type RuntimeChoices =
  /** The server leaves it to Sealant (no runtime offered): nothing to choose. */
  | { readonly kind: "sealant-picks" }
  | {
      readonly kind: "offered";
      /** What the server offers, in the page's order. */
      readonly runtimes: ReadonlyArray<SessionRuntime>;
      /** Where new sessions run now. */
      readonly selected: SessionRuntime;
    };

/**
 * The runtimes to list and the one new sessions run on now. An organization that never chose runs
 * on the server's default, which is shown as the selected choice: it is where its sessions go.
 */
export const runtimeChoices = (view: SessionRuntimeView): RuntimeChoices => {
  const selected = view.effective ?? view.serverDefault;
  if (selected === null || view.offered.length === 0) return { kind: "sealant-picks" };
  return {
    kind: "offered",
    runtimes: RUNTIME_ORDER.filter((runtime) => view.offered.includes(runtime)),
    selected,
  };
};

/** The muted line under "Session runtime". */
export const offerLine = (choices: RuntimeChoices): string => {
  if (choices.kind === "sealant-picks")
    return "This server leaves where sessions run to Sealant. An operator can offer runtimes with mend server setup --session-runtimes.";
  const [only] = choices.runtimes;
  return choices.runtimes.length === 1 && only !== undefined
    ? `This server offers only ${RUNTIME_LABELS[only]}. An operator chose which runtimes it offers.`
    : "An operator chose which runtimes this server offers.";
};

/**
 * The intro under the title. Owners read the frame's words; everyone else reads who can change it,
 * by name, as the General page says who can rename the organization.
 */
export const runtimeIntro = (
  organization: string,
  owner: boolean,
  owners: ReadonlyArray<string>,
): string => {
  const lead = `Where ${organization}'s new sessions run. Running sessions stay where they are.`;
  if (owner) return `${lead} Only owners can change this.`;
  return owners.length === 0
    ? `${lead} Only an owner of ${organization} can change this.`
    : `${lead} Only an owner can change this: ${namesList(owners)}.`;
};

const OS_NAMES: Readonly<Record<WorkspaceImageOs, string>> = {
  arch: "Arch",
  fedora: "Fedora",
  nix: "Nix",
  ubuntu: "Ubuntu",
};

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** An image as a row says it: "Arch with 12 packages", "the image node:22". */
export const imageWords = (image: WorkspaceImage): string =>
  image.mode === "custom"
    ? `the image ${image.baseImage}`
    : `${OS_NAMES[image.os]} with ${count(image.packages.length, "package")}`;

/** What Mend would move an image to: an OS family with Mend's default packages. */
const targetWords = (image: WorkspaceImage): string =>
  image.mode === "custom"
    ? imageWords(image)
    : `${OS_NAMES[image.os]} with Mend's default packages`;

/** One thing the new runtime would not run, under a project's name or the image's. */
export interface ImpactFact {
  readonly text: string;
  /** Sealant's reason, after the text. */
  readonly why?: string;
}

export interface ImpactRow {
  readonly key: string;
  readonly name: string;
  readonly facts: ReadonlyArray<ImpactFact>;
}

const moveFact = (
  move: {
    readonly refusal: string;
    readonly from: WorkspaceImage;
    readonly to: WorkspaceImage | null;
  },
  runtime: string,
): ImpactFact => ({
  text:
    move.to === null
      ? `${imageWords(move.from)}, and ${runtime} runs no image Mend can move it to`
      : `${imageWords(move.from)} → ${targetWords(move.to)}`,
  why: move.refusal,
});

/**
 * What the runtime would not run, as rows: the organization's image, each project the person can
 * see, and one row counting private projects they can't, which are never named.
 */
export const impactRows = (
  impact: ObservedImpact,
  organization: string,
): ReadonlyArray<ImpactRow> => {
  const runtime = runtimeName(impact.runtime);
  const rows: Array<ImpactRow> = [];
  if (impact.organizationDefault !== null)
    rows.push({
      key: "organization",
      name: `${organization}'s workspace image`,
      facts: [moveFact(impact.organizationDefault, runtime)],
    });
  for (const project of impact.projects) {
    const environment =
      project.environment === null ? null : moveFact(project.environment, runtime);
    rows.push({
      key: project.id,
      name: project.name,
      facts: [
        ...(environment === null
          ? []
          : [{ ...environment, text: `New sessions wouldn't start on ${environment.text}` }]),
        ...project.services.map((service) => ({
          text: `Service ${service.name} on port ${service.port} couldn't listen: ${runtime} holds that port`,
        })),
        ...(project.serverFolders === null
          ? []
          : [
              {
                text: `${count(project.serverFolders.count, "server folder")}: sessions start without them`,
                why: project.serverFolders.refusal,
              },
            ]),
      ],
    });
  }
  if (impact.unseen > 0)
    rows.push({
      key: "unseen",
      name: count(impact.unseen, "private project"),
      facts: [
        {
          text:
            impact.unseen === 1
              ? `Another member's private project uses something ${runtime} doesn't run. Mend doesn't name or move it; its creator can change it.`
              : `Other members' private projects use something ${runtime} doesn't run. Mend doesn't name or move them; their creators can change them.`,
        },
      ],
    });
  return rows;
};

/**
 * How much the switch reaches, as the list's heading says it: "2 projects and Northwind's
 * workspace image". Projects the person can't see are counted with the rest.
 */
export const impactCount = (impact: ObservedImpact, organization: string): string => {
  const projects = impact.projects.length + impact.unseen;
  const parts = [
    ...(projects === 0 ? [] : [count(projects, "project")]),
    ...(impact.organizationDefault === null ? [] : [`${organization}'s workspace image`]),
  ];
  return namesList(parts);
};

/** What the page does once the server has answered what a switch would change. */
export type SwitchStep =
  /** Nothing changes for new sessions, as far as Sealant's report shows: switch straight away. */
  { readonly kind: "switch" } | { readonly kind: "ask"; readonly ask: SwitchAsk };

/** The dialog before a switch that would change something, or that Mend couldn't check. */
export interface SwitchAsk {
  readonly runtime: SessionRuntime;
  readonly title: string;
  /** What Sealant reported, or what Mend doesn't know. */
  readonly lead: string;
  /** The list's heading, with the count; null when there is no list. */
  readonly heading: string | null;
  readonly rows: ReadonlyArray<ImpactRow>;
  /** The moves Mend offers in the same step; null when there is nothing it can move. */
  readonly moves: RuntimeSwitchMoves | null;
  /** What moving does, shown when there are moves. */
  readonly moveNote: string | null;
  /** The button that switches without moving. */
  readonly confirm: string;
}

const KEPT = "Running sessions stay where they are; this is about new sessions.";

/**
 * Whether to switch straight away or ask first, from the server's answer to "what would choosing
 * `runtime` change". `runtime` is what the person picked; the server's answer names it too.
 */
export const switchStep = (
  view: OrganizationRuntimeSwitchDto,
  runtime: SessionRuntime,
  organization: string,
): SwitchStep => {
  const { impact } = view;
  if (switchChangesNothing(impact)) return { kind: "switch" };
  const name = RUNTIME_LABELS[runtime];
  const title = `Before new sessions run on ${name}`;
  if (impact.state !== "observed")
    return {
      kind: "ask",
      ask: {
        runtime,
        title,
        lead:
          impact.state === "unread"
            ? `Not checked: Mend couldn't read what ${name} runs (${impact.reason}), so it can't tell which projects in ${organization} would stop starting new sessions. ${KEPT}`
            : `Sealant on this server doesn't launch ${name} workspaces (checked at ${clockTime(impact.observedAt)}). No new session in ${organization} would start until it does. ${KEPT}`,
        heading: null,
        rows: [],
        moves: null,
        moveNote: null,
        confirm: `Switch to ${name} anyway`,
      },
    };
  const offered = offeredMoves(impact);
  const movable = movesAnything(offered);
  return {
    kind: "ask",
    ask: {
      runtime,
      title,
      lead: `${name} can't run everything in ${organization} as it is, as Sealant reported at ${clockTime(impact.observedAt)}. ${KEPT}`,
      heading: `What ${name} wouldn't run: ${impactCount(impact, organization)}`,
      rows: impactRows(impact, organization),
      moves: movable ? offered : null,
      moveNote: movable
        ? "Move and switch gives each image above the one after its arrow; packages a project added aren't kept. The next session in each moved project builds it, which takes a few minutes the first time. Services and server folders stay as they are."
        : null,
      confirm: movable ? "Switch without moving" : `Switch to ${name} anyway`,
    },
  };
};

/**
 * What the runtime new sessions run on now wouldn't run, for its owners: after a switch without
 * moving, or when a project changed since. Null when it runs everything, or Sealant wasn't read
 * (the switch already said so).
 */
export interface StandingImpact {
  readonly lead: string;
  readonly heading: string;
  readonly rows: ReadonlyArray<ImpactRow>;
  readonly moves: RuntimeSwitchMoves | null;
  readonly moveLabel: string;
}

export const standingImpact = (
  view: OrganizationRuntimeSwitchDto,
  organization: string,
): StandingImpact | null => {
  const { impact } = view;
  if (impact.state !== "observed" || switchChangesNothing(impact)) return null;
  const name = runtimeName(impact.runtime);
  const offered = offeredMoves(impact);
  return {
    lead: `New sessions in ${organization} run on ${name}, which can't run everything here as it is, as Sealant reported at ${clockTime(impact.observedAt)}.`,
    heading: `What ${name} doesn't run: ${impactCount(impact, organization)}`,
    rows: impactRows(impact, organization),
    moves: movesAnything(offered) ? offered : null,
    moveLabel: `Move to what ${name} runs`,
  };
};

/** The toast after a switch, or a move, or both. */
export const switchedLine = (
  organization: string,
  runtime: SessionRuntime,
  moved: boolean,
): string =>
  moved
    ? `Moved. New sessions in ${organization} run on ${RUNTIME_LABELS[runtime]}.`
    : `New sessions in ${organization} run on ${RUNTIME_LABELS[runtime]}.`;
