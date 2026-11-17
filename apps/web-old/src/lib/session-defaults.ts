import { useQuery } from "@tanstack/react-query";

import type { SessionDefaultsDto } from "./api.ts";
import {
  forgetLegacyComposerDefaults,
  legacyComposerDefaults,
  NO_DEFAULTS,
  type ComposerDefaults,
  type HarnessPrefs,
} from "./composer-prefs.ts";
import { documentWriter } from "./optimistic.ts";
import type { Harness } from "./session-launch.ts";
import { useTRPC, useTRPCClient } from "./trpc.ts";

type Client = ReturnType<typeof useTRPCClient>;

/**
 * The person's new-session defaults, read from the server. A browser that still keeps defaults
 * of its own from before they moved there hands them over first: the server keeps them only when
 * the person has none saved yet (so the first browser to ask wins, once), and the browser forgets
 * its own once the server answered.
 */
export const readSessionDefaults = async (client: Client): Promise<SessionDefaultsDto> => {
  const local = legacyComposerDefaults();
  if (local === null) return client.platform.sessionDefaults.query();
  const saved = await client.platform.adoptSessionDefaults.mutate({
    harness: local.harness,
    byHarness: local.byHarness,
  });
  forgetLegacyComposerDefaults();
  return saved;
};

/** The read, with the hand-over above as its fetch; every reader shares its cache entry. */
export const useSessionDefaultsQuery = () => {
  const trpc = useTRPC();
  const client = useTRPCClient();
  return useQuery({
    ...trpc.platform.sessionDefaults.queryOptions(),
    queryFn: () => readSessionDefaults(client),
  });
};

/** What the composer starts from: the person's defaults, or none while they are read. */
export const useSessionDefaults = (): ComposerDefaults =>
  useSessionDefaultsQuery().data ?? NO_DEFAULTS;

/** One change to the defaults: the agent picked first, or what one agent starts with. */
export type DefaultsChange =
  | { readonly field: "harness"; readonly harness: Harness }
  | {
      readonly field: "start";
      readonly harness: Harness;
      readonly start: Partial<Pick<HarnessPrefs, "model" | "effort">>;
    };

/** The defaults with one change applied; a harness's first choice leaves its other field unset. */
export const withDefaultsChange = (
  defaults: SessionDefaultsDto,
  change: DefaultsChange,
): SessionDefaultsDto =>
  change.field === "harness"
    ? { ...defaults, harness: change.harness }
    : {
        ...defaults,
        byHarness: {
          ...defaults.byHarness,
          [change.harness]: {
            model: null,
            effort: null,
            ...defaults.byHarness[change.harness],
            ...change.start,
          },
        },
      };

/**
 * Every default writes the one document, so the agent, model and effort share one writer: each
 * change shows at once, leaves after the last one answered, and a refusal puts back that change
 * alone.
 */
export const sessionDefaultsWriter = documentWriter<
  SessionDefaultsDto,
  DefaultsChange,
  SessionDefaultsDto
>({
  overlay: withDefaultsChange,
  saved: (_server, saved) => saved,
});
