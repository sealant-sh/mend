import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ErrorNote, errorText } from "#/components/kit/status";
import { SwitchRow } from "#/components/kit/switch";
import { personAutomationWriter, type PersonSwitch } from "#/lib/person-settings";
import { useTRPC, useTRPCClient, type TrpcProxy } from "#/lib/trpc";
import type { RouterAppContext } from "#/router";

/** The person's own switches, which are what their sessions get. */
export const personAutomationOptions = (trpc: TrpcProxy) => trpc.platform.automation.queryOptions();

/** Warm what the person's switches read. */
export const warmPersonAutomation = ({ queryClient, trpc }: RouterAppContext) =>
  queryClient.ensureQueryData(personAutomationOptions(trpc));

/**
 * The person's own On or Off for each row, for their own sessions, unless a project sets its own.
 * There is no Inherit (docs/adr/0025-one-home-per-setting.md). A change shows at once and only that
 * row goes back if the server refuses.
 */
export function PersonChoices({
  rows,
}: {
  readonly rows: ReadonlyArray<{ readonly key: PersonSwitch; readonly label: string }>;
}) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
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
  return (
    <>
      {rows.map((row) => (
        <SwitchRow
          key={row.key}
          label={row.label}
          checked={shown.own[row.key]}
          onCheckedChange={(value) => save.mutate({ [row.key]: value })}
        />
      ))}
      {save.isError ? <ErrorNote>Not saved: {errorText(save.error)}</ErrorNote> : null}
    </>
  );
}
