/**
 * What the Workspace image page knows about where the organization's new sessions run, read from
 * `organization.runtime`, so it refuses an image that runtime can't run before it is saved. Copied
 * from the old app's `lib/runtime-support.ts`, cut to what the starting image needs.
 */

import {
  customImageRefusal,
  environmentRefusal,
  osRefusal,
  runtimeName,
  type RuntimeSupport,
  type WorkspaceImage,
  type WorkspaceImageOs,
} from "@mend/domain";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";

import type { OrganizationRuntimeDto } from "./api.ts";
import { clockTime } from "./session-view.ts";
import { signedInOptions } from "./sign-in.ts";
import { useTRPC } from "./trpc.ts";
import { OS_LABELS, OS_ORDER } from "./workspace-image.ts";

/**
 * - `pending`: still reading; the page shows nothing extra.
 * - `observed`: Sealant said what the runtime supports; what it can't run is refused.
 * - `unchecked`: nothing is known for sure. Every choice stays open and `note` says why.
 */
export type RuntimeFacts =
  | { readonly state: "pending" }
  | { readonly state: "observed"; readonly organization: string; readonly support: RuntimeSupport }
  | { readonly state: "unchecked"; readonly note: string };

/** The facts from `organization.runtime`'s answer. */
export const runtimeFacts = (view: OrganizationRuntimeDto, organization: string): RuntimeFacts => {
  const { support, sessionRuntime } = view;
  switch (support.state) {
    case "observed":
      return { state: "observed", organization, support: support.support };
    case "not-launched": {
      const name = runtimeName(support.runtime);
      return {
        state: "unchecked",
        note: `New sessions in ${organization} are set to run on ${name}, but Sealant on this server doesn't launch ${name} workspaces (checked at ${clockTime(support.observedAt)}). These choices aren't checked against it.`,
      };
    }
    case "unread": {
      const runtime = sessionRuntime.effective ?? sessionRuntime.serverDefault;
      const against =
        runtime === null
          ? "Not checked: Mend couldn't read from Sealant what this server's runtime supports"
          : `Not checked against ${runtimeName(runtime)}: Mend couldn't read what it supports from Sealant`;
      return {
        state: "unchecked",
        note: `${against} (${support.reason}). A session that can't start says why.`,
      };
    }
  }
};

export const useRuntimeFacts = (): RuntimeFacts => {
  const trpc = useTRPC();
  const organization = useSuspenseQuery(signedInOptions(trpc)).data.organization.name;
  const view = useQuery(trpc.organization.runtime.queryOptions(undefined, { retry: false }));
  if (view.isPending) return { state: "pending" };
  if (view.isError)
    return {
      state: "unchecked",
      note: `Not checked: Mend couldn't read where new sessions in ${organization} run (${view.error.message}). A session that can't start says why.`,
    };
  return runtimeFacts(view.data, organization);
};

/** The OS families the runtime can't run. */
export const refusedFamilies = (facts: RuntimeFacts): ReadonlySet<WorkspaceImageOs> =>
  facts.state === "observed"
    ? new Set(OS_ORDER.filter((os) => osRefusal(facts.support, os) !== null))
    : new Set();

/**
 * The lines under Image and Operating system, and why Save stays off. An image the runtime can't
 * run says what is wrong under the control that holds it and blocks Save; a runtime Mend couldn't
 * check says so under Image.
 */
export const pickerNotes = (
  facts: RuntimeFacts,
  image: WorkspaceImage,
): { readonly base: string | null; readonly os: string | null; readonly blocks: string | null } => {
  if (facts.state === "pending") return { base: null, os: null, blocks: null };
  if (facts.state === "unchecked") return { base: facts.note, os: null, blocks: null };
  const { organization, support } = facts;
  const name = runtimeName(support.runtime);
  const refusal = environmentRefusal(support, image);
  const where = `New sessions in ${organization} run on ${name}.`;
  const blocks = refusal === null ? null : `Not saved yet: ${name} can't run this image.`;
  const custom = customImageRefusal(support);
  if (image.mode === "custom")
    return { base: refusal === null ? null : `${refusal} ${where}`, os: null, blocks };
  const refused = OS_ORDER.filter((os) => osRefusal(support, os) !== null).map(
    (os) => OS_LABELS[os],
  );
  return {
    base: custom === null ? null : `${custom} ${where}`,
    os:
      refusal !== null
        ? `${refusal} ${where}`
        : refused.length === 0
          ? null
          : `${where} It doesn't run ${refused.join(", ")}.`,
    blocks,
  };
};
