import type { WorktreeId } from "@mend/domain";
import {
  approvalWorktreeOf,
  defaultChoiceFor,
  isDatabasePreset,
  type ResourceApprovalRequest,
  type ResourceDefinitionInput,
  ResourceProposalInput,
  type ResourceRefusal,
  type WorktreeChoice,
} from "@mend/domain/workbench";
import type { inferRouterOutputs } from "@trpc/server";
import { Schema } from "effect";

import type { AppRouter } from "../server/routers/index.ts";
import { orLogin, trpcClient } from "./trpc.ts";

/**
 * The project's resources as the setup card reads and changes them (ADR 0019). The server decides
 * every act and sends every status line; this module builds what the card sends and sorts the
 * server's refusals onto the fields they name.
 */

type Outputs = inferRouterOutputs<AppRouter>["resources"];
export type ResourcesPageView = Outputs["list"];
export type ResourceSettingView = ResourcesPageView["settings"][number];
export type ResourceProposalView = ResourcesPageView["proposals"][number];
export type ResourceFileView = ResourcesPageView["file"];
export type ResourceFileTableView = Extract<
  ResourceFileView,
  { kind: "read" }
>["proposals"][number];

/** The reader's zone, which every clock time in a status line reads in. */
export const readerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const at = (projectId: string) => ({ projectId, timeZone: readerZone() });

export const proposeResource = (projectId: string, proposal: ResourceProposalInput) =>
  orLogin(trpcClient.resources.propose.mutate({ ...at(projectId), proposal }));
export const withdrawResourceProposal = (projectId: string, proposalId: string) =>
  orLogin(trpcClient.resources.withdraw.mutate({ ...at(projectId), proposalId }));
export const removeResourceDefinition = (projectId: string, entry: ResourceSettingView) =>
  orLogin(
    trpcClient.resources.remove.mutate({
      ...at(projectId),
      definitionId: entry.id,
      expectedDigest: entry.digest,
    }),
  );
export const approveResource = (projectId: string, request: ResourceApprovalRequest) =>
  orLogin(trpcClient.resources.approve.mutate({ ...at(projectId), request }));
export const chooseResource = (
  projectId: string,
  worktreeId: WorktreeId,
  definitionId: string,
  mode: WorktreeChoice,
) => orLogin(trpcClient.resources.use.mutate({ ...at(projectId), worktreeId, definitionId, mode }));

/** What a worktree gets on each choice, in the order the card offers them. */
export const choiceWords = (
  spec: ResourceDefinitionInput,
  choice: WorktreeChoice,
): { readonly label: string; readonly meaning: string } => {
  const database = isDatabasePreset(spec);
  switch (choice) {
    case "shared":
      return {
        label: "shared",
        meaning: database
          ? "Reaches the project's instance and its one shared database. Any worktree on shared can change or drop its tables."
          : "Reaches the project's instance. Any worktree on shared can change what it holds.",
      };
    case "own":
      return {
        label: "own",
        meaning: database
          ? "Gets a database of its own on the project instance."
          : "Gets an instance of its own, of the same definition.",
      };
    case "off":
      return {
        label: "off",
        meaning: "Gets nothing from this resource; the worktree runs its own.",
      };
  }
};

/** The choice in use, or the default that applies at the worktree's first launch. */
export const choiceInUse = (
  entry: Pick<ResourceSettingView, "spec" | "choice">,
): { readonly choice: WorktreeChoice; readonly stored: boolean } | null => {
  if (entry.choice !== null) return { choice: entry.choice, stored: true };
  const fallback = defaultChoiceFor(entry.spec);
  return fallback === null ? null : { choice: fallback, stored: false };
};

/**
 * Whether the definition still waits for the approval its reader may give: a worktree
 * resource read for a worktree waits for that worktree's own, anything else for the project's.
 */
export const awaitsApproval = (entry: ResourceSettingView, worktreeId: WorktreeId | null) =>
  entry.canApprove &&
  (approvalWorktreeOf(entry.spec, worktreeId) === null
    ? entry.approval === null
    : entry.approval?.for !== "worktree");

/** A definition settings hold under `name`, as an adoption names what it may replace. */
const heldUnder = (page: ResourcesPageView, name: string) => {
  const held = page.settings.find((entry) => entry.spec.name === name);
  return held === undefined ? null : { id: held.id, digest: held.digest };
};

/** Whether settings hold exactly this spec, so approving it would change nothing. */
export const sameAsSettings = (
  page: ResourcesPageView,
  entry: { readonly spec: ResourceDefinitionInput; readonly digest: string },
) => heldUnder(page, entry.spec.name)?.digest === entry.digest;

/** What approving an item as read sends: its source by the digest read, and its target. */
export const approvalRequest = (
  page: ResourcesPageView,
  item:
    | { readonly kind: "settings"; readonly entry: ResourceSettingView }
    | { readonly kind: "proposal"; readonly entry: ResourceProposalView }
    | {
        readonly kind: "file";
        readonly entry: ResourceFileTableView;
        readonly worktreeId: WorktreeId;
      },
  worktreeId: WorktreeId | null,
): ResourceApprovalRequest => {
  const { spec, digest } = item.entry;
  const target = approvalWorktreeOf(spec, worktreeId);
  switch (item.kind) {
    case "settings":
      return { source: { kind: "settings", id: item.entry.id, digest }, worktreeId: target };
    case "proposal":
      return {
        source: {
          kind: "proposal",
          id: item.entry.id,
          digest,
          settings: heldUnder(page, spec.name),
        },
        worktreeId: target,
      };
    case "file":
      return {
        source: {
          kind: "file",
          worktreeId: item.worktreeId,
          name: spec.name,
          digest,
          settings: heldUnder(page, spec.name),
        },
        worktreeId: target,
      };
  }
};

/** Every field of a definition that runs, as an approver reviews it before approving. */
export const reviewFields = (
  spec: ResourceDefinitionInput,
): ReadonlyArray<readonly [string, string]> => {
  const fields: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    ["image", [spec.image]],
    ["scope", [spec.scope]],
    ["command", spec.command === null ? [] : [spec.command.join(" ")]],
    ["ports", spec.ports.map((port) => `${port.name}=${port.port}/${port.protocol}`)],
    ["volumes", spec.volumes.map((volume) => `${volume.name}=${volume.mountPath}`)],
    [
      "env",
      Object.entries(spec.env).map(([key, value]) =>
        typeof value === "string" ? `${key}=${value}` : `${key} from secret ${value.secret}`,
      ),
    ],
    [
      "limits",
      [
        `${spec.limits.cpu} CPU · ${spec.limits.memoryMiB} MiB memory · ${spec.limits.diskGiB} GiB disk`,
      ],
    ],
    ["ready", [spec.ready.kind === "command" ? spec.ready.argv.join(" ") : spec.ready.kind]],
    ["exports", Object.entries(spec.exports).map(([key, value]) => `${key}=${value}`)],
  ];
  return fields.flatMap(([label, values]) =>
    values.length === 0 ? [] : [[label, values.join(", ")] as const],
  );
};

// ── Proposing ────────────────────────────────────────────────────────────────

export interface EnvRow {
  readonly key: string;
  readonly from: "literal" | "secret";
  readonly value: string;
}

/** The proposal form as typed. Ports and volumes are one per line: `smtp=1025`, `data=/data`. */
export interface ProposalDraft {
  readonly kind: "preset" | "image";
  readonly name: string;
  readonly scope: "project" | "worktree";
  readonly preset: "postgres" | "redis" | "mysql";
  readonly version: string;
  readonly image: string;
  readonly ports: string;
  readonly volumes: string;
  readonly env: ReadonlyArray<EnvRow>;
}

export const EMPTY_DRAFT: ProposalDraft = {
  kind: "preset",
  name: "",
  scope: "project",
  preset: "postgres",
  version: "",
  image: "",
  ports: "",
  volumes: "",
  env: [],
};

/** The form field a refusal's key belongs under; anything else is shown under the whole form. */
export type ProposalField = "name" | "scope" | "version" | "image" | "ports" | "volumes" | "env";

const FIELDS: ReadonlySet<string> = new Set([
  "name",
  "scope",
  "version",
  "image",
  "ports",
  "volumes",
  "env",
]);

const isField = (value: string): value is ProposalField => FIELDS.has(value);

export const fieldOf = (key: string): ProposalField | null => {
  const [head = ""] = key.split(".");
  return isField(head) ? head : null;
};

const lines = (text: string) =>
  text
    .split("\n")
    .map((each) => each.trim())
    .filter((each) => each !== "");

/** `smtp=1025` or `dns=53/udp`; a line that is neither is sent as written, for the rules to refuse. */
const portOf = (raw: string) => {
  const match = /^([^=\s]+)=(\d+)(?:\/(tcp|udp))?$/.exec(raw);
  return match === null
    ? { name: raw, port: Number.NaN, protocol: "tcp" }
    : { name: match[1] ?? raw, port: Number(match[2]), protocol: match[3] ?? "tcp" };
};

const volumeOf = (raw: string) => {
  const equals = raw.indexOf("=");
  return equals === -1
    ? { name: raw, mountPath: "" }
    : { name: raw.slice(0, equals).trim(), mountPath: raw.slice(equals + 1).trim() };
};

const proposalCheck = Schema.toStandardSchemaV1(ResourceProposalInput);

/** A path's field: `["spec", "ports", 0, "port"]` is `ports`. */
const keyOf = (path: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>): string =>
  path
    .map((segment) => (typeof segment === "object" ? segment.key : segment))
    .filter((segment) => segment !== "spec")
    .map(String)
    .join(".");

/**
 * What the form proposes, or the refusals its shape draws before anything is sent, keyed as the
 * server keys its own. The rules across fields are the server's, which answer by key too.
 */
export const proposalOf = (
  draft: ProposalDraft,
):
  | { readonly ok: true; readonly proposal: ResourceProposalInput }
  | { readonly ok: false; readonly refusals: ReadonlyArray<ResourceRefusal> } => {
  const name = draft.name.trim();
  const body =
    draft.kind === "preset"
      ? {
          kind: "preset",
          name,
          preset: draft.preset,
          version: draft.version.trim(),
          scope: draft.scope,
        }
      : {
          kind: "definition",
          spec: ((ports) => ({
            name,
            scope: draft.scope,
            preset: null,
            image: draft.image.trim(),
            command: null,
            ports,
            env: Object.fromEntries(
              draft.env
                .filter((row) => row.key.trim() !== "")
                .map((row) => [
                  row.key.trim(),
                  row.from === "secret" ? { secret: row.value.trim() } : row.value,
                ]),
            ),
            volumes: lines(draft.volumes).map(volumeOf),
            ready: { kind: ports.some((port) => port.protocol === "tcp") ? "tcp" : "none" },
            exports: {},
          }))(lines(draft.ports).map(portOf)),
        };
  const checked = proposalCheck["~standard"].validate(body);
  if (checked instanceof Promise) return { ok: false, refusals: [] };
  if (checked.issues === undefined) return { ok: true, proposal: checked.value };
  return {
    ok: false,
    refusals: checked.issues.map((issue) => ({
      key: keyOf(issue.path ?? []) || "proposal",
      message: issue.message,
    })),
  };
};
