import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";

import { Panel, SettingsSection } from "#/components/kit/section";
import { ErrorNote, errorText } from "#/components/kit/status";
import { SwitchRow } from "#/components/kit/switch";
import type { SettingsDto } from "#/lib/api";
import { fieldWriter } from "#/lib/optimistic";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

/** The instance switches an operator sets: the root of the instance → organization → project cascade. */
type InstanceSwitch = "backgroundSessions" | "autoTour" | "autoSuggest" | "autoName" | "autoLand";

const SECTIONS: ReadonlyArray<{
  readonly title: string;
  readonly why: string;
  readonly rows: ReadonlyArray<{ readonly key: InstanceSwitch; readonly label: string }>;
}> = [
  {
    title: "Background",
    why: "A session keeps running when every terminal and browser disconnects; stops are explicit. Off gives CLI launches foreground semantics: the session stops when the launching mend exits. A closing browser tab cannot promise a stop, so this governs CLI launches.",
    rows: [{ key: "backgroundSessions", label: "Run sessions in the background" }],
  },
  {
    title: "Review automation",
    why: "What Mend does around each session; Mend uses inference for these. The description, tour and suggested fixes run when a session settles, and suggestions come only for concrete defects. The name comes after the first prompt; a typed label always wins.",
    rows: [
      { key: "autoTour", label: "Compose the description and tour" },
      { key: "autoSuggest", label: "Suggest fixes" },
      { key: "autoName", label: "Name the session" },
    ],
  },
  {
    title: "Landing",
    why: "After each completed turn whose request asked for a change, Mend pushes it and opens or updates its pull request; a question never lands. Sessions started from Slack follow the Slack app's setting, and terminal sessions land only from the change page.",
    rows: [{ key: "autoLand", label: "Land when a turn completes" }],
  },
];

/**
 * Settings · Instance · Defaults: what every organization on this machine inherits unless it sets
 * its own, and what a project on inherit follows through it. The operator's only (docs/adr/0003).
 * Each switch moves at once and moves back if the server refuses.
 */
export function InstanceDefaults() {
  return (
    <Panel>
      {SECTIONS.map((section) => (
        <SettingsSection key={section.title} title={section.title} why={section.why}>
          {section.rows.map((row) => (
            <InstanceSwitchRow key={row.key} name={row.key} label={row.label} />
          ))}
        </SettingsSection>
      ))}
    </Panel>
  );
}

/** Every instance switch writes the one instance document, so they share one writer. */
const instanceSettings = fieldWriter<SettingsDto>((_server, saved) => saved);

/**
 * One switch. It shows at once, goes back alone if the server refuses, and sends the server's
 * latest document with only its own field changed, after any other switch's write.
 */
function InstanceSwitchRow({
  name,
  label,
}: {
  readonly name: InstanceSwitch;
  readonly label: string;
}) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const settings = instanceSettings.useVisible(
    useSuspenseQuery(trpc.settings.get.queryOptions()).data,
  );
  const save = useMutation(
    instanceSettings.options({
      queryClient,
      documentKey: trpc.settings.get.queryKey(),
      mutationKey: trpc.settings.put.mutationKey(),
      send: (patch, server) => client.settings.put.mutate({ ...server, ...patch }),
      // Organizations that set nothing of their own resolve through these, so their reads move too.
      related: [trpc.organization.settings.queryKey()],
    }),
  );
  if (settings === undefined) return null;
  return (
    <>
      <SwitchRow
        label={label}
        checked={settings[name]}
        onCheckedChange={(value) => save.mutate({ [name]: value })}
      />
      {save.error === null ? null : (
        <ErrorNote className="mb-2">Not saved: {errorText(save.error)}</ErrorNote>
      )}
    </>
  );
}
