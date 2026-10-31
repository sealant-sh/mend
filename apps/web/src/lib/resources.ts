import type { WorktreeId } from "@mend/domain";
import {
  defaultChoiceFor,
  isDatabasePreset,
  ResourceAddInput,
  type ResourceDefinitionInput,
  type ResourceRefusal,
  type WorktreeChoice,
} from "@mend/domain/workbench";
import type { inferRouterOutputs } from "@trpc/server";
import { Schema } from "effect";

import type { AppRouter } from "../server/routers/index.ts";
import { orLogin, trpcClient } from "./trpc.ts";

/**
 * The project's resources as the setup card reads and changes them (ADR 0019). The server decides
 * every act, sends every status line and says which `mend.toml` tables the reader may add; this
 * module builds the definition the card adds and sorts the server's refusals onto the fields they
 * name.
 */

type Outputs = inferRouterOutputs<AppRouter>["resources"];
export type ResourcesPageView = Outputs["list"];
export type ResourceSettingView = ResourcesPageView["settings"][number];
export type ResourceFileView = ResourcesPageView["file"];
export type ResourceFileTableView = Extract<ResourceFileView, { kind: "read" }>["tables"][number];

/** The reader's zone, which every clock time in a status line reads in. */
export const readerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const at = (projectId: string) => ({ projectId, timeZone: readerZone() });

export const addResource = (projectId: string, addition: ResourceAddInput) =>
  orLogin(trpcClient.resources.add.mutate({ ...at(projectId), addition }));
export const removeResourceDefinition = (projectId: string, entry: ResourceSettingView) =>
  orLogin(
    trpcClient.resources.remove.mutate({
      projectId,
      definitionId: entry.id,
      expectedDigest: entry.digest,
    }),
  );
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

// ── Adding ───────────────────────────────────────────────────────────────────

export interface EnvRow {
  readonly key: string;
  readonly from: "literal" | "secret";
  readonly value: string;
}

/** The add form as typed. Ports and volumes are one per line: `smtp=1025`, `data=/data`. */
export interface ResourceDraft {
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

export const EMPTY_DRAFT: ResourceDraft = {
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
export type DraftField = "name" | "scope" | "version" | "image" | "ports" | "volumes" | "env";

const FIELDS: ReadonlySet<string> = new Set([
  "name",
  "scope",
  "version",
  "image",
  "ports",
  "volumes",
  "env",
]);

const isField = (value: string): value is DraftField => FIELDS.has(value);

export const fieldOf = (key: string): DraftField | null => {
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

const additionCheck = Schema.toStandardSchemaV1(ResourceAddInput);

/** A path's field: `["spec", "ports", 0, "port"]` is `ports`. */
const keyOf = (path: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>): string =>
  path
    .map((segment) => (typeof segment === "object" ? segment.key : segment))
    .filter((segment) => segment !== "spec")
    .map(String)
    .join(".");

/**
 * What the form adds, or the refusals its shape draws before anything is sent, keyed as the
 * server keys its own. The rules across fields are the server's, which answer by key too.
 */
export const additionOf = (
  draft: ResourceDraft,
):
  | { readonly ok: true; readonly addition: ResourceAddInput }
  | { readonly ok: false; readonly refusals: ReadonlyArray<ResourceRefusal> } => {
  const name = draft.name.trim();
  const typed = draft.env.map((row) => ({ ...row, key: row.key.trim() }));
  // A row left wholly blank is an unused placeholder; a value with no name would be dropped.
  const env = typed.filter((row) => row.key !== "");
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
          spec: ((ports, rows) => ({
            name,
            scope: draft.scope,
            preset: null,
            image: draft.image.trim(),
            command: null,
            ports,
            env: Object.fromEntries(
              rows.map((row) => [
                row.key,
                row.from === "secret" ? { secret: row.value.trim() } : row.value,
              ]),
            ),
            volumes: lines(draft.volumes).map(volumeOf),
            ready: { kind: ports.some((port) => port.protocol === "tcp") ? "tcp" : "none" },
            exports: {},
          }))(lines(draft.ports).map(portOf), env),
        };
  if (draft.kind === "image") {
    if (typed.some((row) => row.key === "" && row.value.trim() !== "")) {
      return { ok: false, refusals: [{ key: "env", message: "has a value with no name" }] };
    }
    // A record keeps one value per name: a second row would silently replace the first.
    const named = env.map((row) => row.key);
    const twice = [...new Set(named.filter((key, index) => named.indexOf(key) !== index))];
    if (twice.length > 0) {
      return {
        ok: false,
        refusals: twice.map((key) => ({ key: `env.${key}`, message: "is named by two rows" })),
      };
    }
  }
  const checked = additionCheck["~standard"].validate(body);
  if (checked instanceof Promise) {
    throw new Error(
      "the definition's schema checks asynchronously, which this form cannot wait for",
    );
  }
  if (checked.issues === undefined) return { ok: true, addition: checked.value };
  return {
    ok: false,
    refusals: checked.issues.map((issue) => ({
      key: keyOf(issue.path ?? []) || "resource",
      message: issue.message,
    })),
  };
};
