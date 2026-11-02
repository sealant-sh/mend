import { modelPickerFor, type EffortLevel } from "@mend/domain/workbench";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Pick } from "#/components/kit/button";
import { Field, FieldPair } from "#/components/kit/field";
import { FuzzyFinder } from "#/components/kit/finder";
import { Panel, SettingsSection } from "#/components/kit/section";
import { Segment } from "#/components/kit/segment";
import { ErrorNote, errorText } from "#/components/kit/status";
import { SwitchRow } from "#/components/kit/switch";
import type { MessageSettingsDto } from "#/lib/api";
import { useHarnessCatalogs } from "#/lib/harness-models";
import { fieldWriter } from "#/lib/optimistic";
import {
  sessionDefaultsWriter,
  useSessionDefaultsQuery,
  withDefaultsChange as withChange,
  type DefaultsChange,
} from "#/lib/session-defaults";
import type { Harness } from "#/lib/session-launch";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

import { PersonChoices } from "./sessions-defaults";

/** The harnesses the composer offers, in the order the picker lists them. */
const AGENTS: ReadonlyArray<{ readonly value: Harness; readonly label: string }> = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude" },
  { value: "opencode", label: "opencode" },
  { value: "pi", label: "pi" },
];

/** Settings · Sessions: whether sessions outlive their clients, what Send does, and what a new one starts with. */
export function SessionsSettings() {
  return (
    <Panel>
      <SettingsSection title="Background" why="Keep sessions running when you close every client.">
        <PersonChoices
          rows={[{ key: "backgroundSessions", label: "Run sessions in the background" }]}
        />
      </SettingsSection>
      <SettingsSection
        title="Messages"
        why="What Send does while your own turn runs. Off, Send always starts your next turn. Another person's turn is never steered."
      >
        <MessageSetting />
      </SettingsSection>
      <SettingsSection
        title="New sessions"
        why="What the composer picks first, on every device you sign in from. You can change each one per session."
      >
        <NewSessionDefaults />
      </SettingsSection>
    </Panel>
  );
}

/** The person's message settings, flipped again before the last flip answered. */
const messageSettingsWriter = fieldWriter<MessageSettingsDto>((_server, saved) => saved);

function MessageSetting() {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const settings = useQuery(trpc.platform.messageSettings.queryOptions());
  const shown = messageSettingsWriter.useVisible(settings.data);
  const save = useMutation(
    messageSettingsWriter.options({
      queryClient,
      documentKey: trpc.platform.messageSettings.queryKey(),
      mutationKey: trpc.platform.setMessageSettings.mutationKey(),
      send: (patch, server) => client.platform.setMessageSettings.mutate({ ...server, ...patch }),
    }),
  );
  if (shown === undefined) {
    return settings.isError ? (
      <ErrorNote>{errorText(settings.error)}</ErrorNote>
    ) : (
      <p className="py-2.5 font-mono text-[12px] text-faint">reading…</p>
    );
  }
  return (
    <>
      <SwitchRow
        label="Send steers the running turn"
        checked={shown.sendSteersRunningTurn}
        onCheckedChange={(sendSteersRunningTurn) => save.mutate({ sendSteersRunningTurn })}
      />
      {save.isError ? <ErrorNote>Not saved: {errorText(save.error)}</ErrorNote> : null}
    </>
  );
}

function NewSessionDefaults() {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const defaults = useSessionDefaultsQuery();
  const shown = sessionDefaultsWriter.useVisible(defaults.data);
  const save = useMutation(
    sessionDefaultsWriter.options({
      queryClient,
      documentKey: trpc.platform.sessionDefaults.queryKey(),
      mutationKey: trpc.platform.setSessionDefaults.mutationKey(),
      send: (change, server) =>
        client.platform.setSessionDefaults.mutate(withChange(server, change)),
    }),
  );
  const catalogs = useHarnessCatalogs();
  if (shown === undefined) {
    return defaults.isError ? (
      <ErrorNote>{errorText(defaults.error)}</ErrorNote>
    ) : (
      <p className="py-2.5 font-mono text-[12px] text-faint">reading your defaults…</p>
    );
  }
  const change = (next: DefaultsChange) => save.mutate(next);
  // What the composer starts a project with no sticky choice on: these, else claude and the
  // catalog's defaults.
  const harness = shown.harness ?? "claude";
  const picker = modelPickerFor(catalogs, harness, {
    model: shown.byHarness[harness]?.model ?? null,
    effort: shown.byHarness[harness]?.effort ?? null,
  });
  const listed = catalogs?.map((catalog) => catalog.harness);
  const agents = AGENTS.filter(
    (agent) => listed === undefined || listed.includes(agent.value) || agent.value === harness,
  );
  return (
    <>
      <Field label="Agent">
        {() => (
          <Segment
            label="Agent"
            value={harness}
            options={agents}
            onChange={(next) => change({ field: "harness", harness: next })}
          />
        )}
      </Field>
      <FieldPair>
        <Field label="Model">
          {(id) =>
            picker.hasModels ? (
              <FuzzyFinder
                label="Model"
                items={picker.models}
                itemKey={(model) => model.id}
                itemText={(model) => model.label}
                meta={(model) => (model.isDefault ? "default" : model.id)}
                onPick={(model) => change({ field: "start", harness, start: { model: model.id } })}
                placeholder="Find a model"
                trigger={
                  <Pick id={id} className="w-fit">
                    {picker.modelLabel}
                  </Pick>
                }
              />
            ) : (
              <p id={id} className="py-1 font-mono text-[12px] text-muted-foreground">
                {catalogs === undefined ? "reading the model list…" : "the agent picks its own"}
              </p>
            )
          }
        </Field>
        <Field label="Effort">
          {() => (
            <Segment<EffortLevel | "default">
              label="Effort"
              value={picker.effort ?? "default"}
              options={picker.efforts.map((row) => ({
                value: row.effort ?? "default",
                label: row.label,
              }))}
              onChange={(next) => {
                const row = picker.efforts.find((entry) => (entry.effort ?? "default") === next);
                if (row !== undefined)
                  change({ field: "start", harness, start: { effort: row.effort } });
              }}
            />
          )}
        </Field>
      </FieldPair>
      {save.isError ? <ErrorNote>Not saved: {errorText(save.error)}</ErrorNote> : null}
    </>
  );
}
