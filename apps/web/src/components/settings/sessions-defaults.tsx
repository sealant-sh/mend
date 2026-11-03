import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { InheritChoice, type InheritSource } from "#/components/kit/inherit-choice";
import { ErrorNote, errorText } from "#/components/kit/status";
import { onOff } from "#/lib/organization-defaults";
import {
  choiceOf,
  personAutomationWriter,
  valueOf,
  type PersonSwitch,
} from "#/lib/person-settings";
import { useTRPC, useTRPCClient, type TrpcProxy } from "#/lib/trpc";
import { useSignedInQuery } from "#/lib/viewer";
import type { RouterAppContext } from "#/router";

/** The person's own switches, what each inherits and what their sessions get. */
export const personAutomationOptions = (trpc: TrpcProxy) => trpc.platform.automation.queryOptions();

/** Warm what the person's switches read. */
export const warmPersonAutomation = ({ queryClient, trpc }: RouterAppContext) =>
  queryClient.ensureQueryData(personAutomationOptions(trpc));

/** Where Inherit's value comes from, in words, with a way there for an owner. */
const sourceOf = (
  from: "organization" | "instance",
  value: boolean,
  organizationName: string | null,
  owner: boolean,
): InheritSource =>
  from === "organization" && organizationName !== null
    ? {
        title: `From ${organizationName}'s organization defaults`,
        detail: `${value ? "On" : "Off"} for everyone in ${organizationName} unless they pick for themselves. Pick On or Off to set it for you.`,
        ...(owner
          ? { link: <Link to="/settings/organization/defaults">Open organization defaults</Link> }
          : {}),
      }
    : {
        title: "From the instance default",
        detail:
          organizationName === null
            ? "Set by the operator of this machine. Pick On or Off to set it for you."
            : `Set by the operator of this machine, and ${organizationName} follows it. Pick On or Off to set it for you.`,
        ...(owner
          ? {
              link: <Link to="/settings/organization/defaults">Set it for {organizationName}</Link>,
            }
          : {}),
      };

/**
 * The person's own Inherit · On · Off for each row: Inherit follows their organization's default
 * (else the instance's) and says which; On or Off is theirs, for their own sessions, unless a
 * project sets its own. A change shows at once and only that row goes back if the server refuses.
 */
export function PersonChoices({
  rows,
}: {
  readonly rows: ReadonlyArray<{ readonly key: PersonSwitch; readonly label: string }>;
}) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const viewer = useSignedInQuery().data;
  const view = useQuery(personAutomationOptions(trpc));
  const shown = personAutomationWriter.useVisible(view.data);
  const save = useMutation(
    personAutomationWriter.options({
      queryClient,
      documentKey: trpc.platform.automation.queryKey(),
      mutationKey: trpc.platform.setAutomation.mutationKey(),
      send: (patch, server) => client.platform.setAutomation.mutate({ ...server.own, ...patch }),
    }),
  );
  if (shown === undefined) {
    return view.isError ? (
      <ErrorNote>{errorText(view.error)}</ErrorNote>
    ) : (
      <p className="py-2.5 font-mono text-[12px] text-faint">reading your settings…</p>
    );
  }
  const organizationName = viewer?.organization.name ?? null;
  const owner = viewer?.role === "owner";
  return (
    <>
      {rows.map((row) => (
        <InheritChoice
          key={row.key}
          label={row.label}
          value={choiceOf(shown.own[row.key])}
          resolved={onOff(shown.inherited[row.key])}
          source={sourceOf(
            shown.inheritedFrom[row.key],
            shown.inherited[row.key],
            organizationName,
            owner,
          )}
          onChange={(choice) => save.mutate({ [row.key]: valueOf(choice) })}
        />
      ))}
      {save.isError ? <ErrorNote>Not saved: {errorText(save.error)}</ErrorNote> : null}
    </>
  );
}
