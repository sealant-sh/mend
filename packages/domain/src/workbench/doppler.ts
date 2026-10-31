import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Schema } from "effect";

import { ProjectId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";

/** Doppler credentials are personal and write-only, irrespective of token kind. */
export const DopplerConnectionInput = Schema.Struct({
  token: Schema.RedactedFromValue(Schema.String),
});
export const DopplerSelection = Schema.Struct({
  dopplerProject: Schema.String,
  config: Schema.String,
});
export type DopplerSelection = typeof DopplerSelection.Type;
export const DopplerMapping = Schema.Struct({ projectId: ProjectId, ...DopplerSelection.fields });
export type DopplerMapping = typeof DopplerMapping.Type;
export const DopplerStatus = Schema.Struct({
  connected: Schema.Boolean,
  name: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Timestamp),
  mappings: Schema.Array(Schema.Struct({ ...DopplerMapping.fields, projectName: Schema.String })),
});
export const DopplerProjects = Schema.Struct({
  projects: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});
export const DopplerConfigs = Schema.Struct({
  configs: Schema.Array(Schema.Struct({ name: Schema.String })),
});
export const DopplerRemoved = Schema.Struct({ removed: Schema.Boolean });
export const DOPPLER_CONFIG_PATH = ".doppler/.doppler.yaml";

/** Basic transport validity only. Personal, CLI and service tokens all work. */
export const dopplerTokenIssue = (token: string): string | null =>
  token.length < 1 || token.length > 8192 || /\s|\p{Cc}/u.test(token)
    ? "enter a Doppler token without whitespace, at most 8192 characters"
    : null;

export const dopplerSelectionIssue = (selection: DopplerSelection): string | null =>
  [selection.dopplerProject, selection.config].some((name) => !/^[a-zA-Z0-9_-]{1,128}$/.test(name))
    ? "Doppler project and config must be names of 1 to 128 letters, numbers, underscores or hyphens"
    : null;

const configDigest = (scoped: unknown) =>
  bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(scoped))));

/** JSON is YAML. These keys match DopplerHQ/cli pkg/models/config.go, including enclave.*. */
export const dopplerConfigContents = (
  token: string,
  worktree: string,
  selection: DopplerSelection | null,
): string => {
  const scoped = {
    "/": { token },
    ...(selection === null
      ? {}
      : {
          [worktree]: {
            "enclave.project": selection.dopplerProject,
            "enclave.config": selection.config,
          },
        }),
  };
  // Doppler ignores unknown YAML keys and drops this stamp when login/configure rewrites the file.
  return `${JSON.stringify({ scoped, "mend-delivery": configDigest(scoped) }, null, 2)}\n`;
};

/** A CLI disconnect removes only an unchanged Mend delivery, preserving a person's later login. */
export const isMendDopplerConfig = (value: unknown): boolean => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("scoped" in value) ||
    !("mend-delivery" in value)
  )
    return false;
  return value["mend-delivery"] === configDigest(value.scoped);
};
