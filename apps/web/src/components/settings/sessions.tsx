import { modelPickerFor, type EffortLevel } from "@mend/domain/workbench";
import { useMutation, useQuery } from "@tanstack/react-query";

import { Pick } from "#/components/kit/button";
import { Field, FieldPair } from "#/components/kit/field";
import { FuzzyFinder } from "#/components/kit/finder";
import { Panel, SettingsSection } from "#/components/kit/section";
import { Segment } from "#/components/kit/segment";
import { ErrorNote, errorText } from "#/components/kit/status";
import { SwitchRow } from "#/components/kit/switch";
import {
  setComposerDefaultHarness,
  setComposerDefaultPrefs,
  useComposerPrefs,
} from "#/lib/composer-prefs";
import { useHarnessCatalogs } from "#/lib/harness-models";
import { optimisticOver } from "#/lib/optimistic";
import type { Harness } from "#/lib/session-launch";
import { useTRPC } from "#/lib/trpc";

import { InheritedDefaults } from "./sessions-defaults";

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
        <InheritedDefaults
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
        why="What the composer picks first, in this browser. You can change each one per session."
      >
        <NewSessionDefaults />
      </SettingsSection>
    </Panel>
  );
}

function MessageSetting() {
  const trpc = useTRPC();
  const settings = useQuery(trpc.platform.messageSettings.queryOptions());
  const save = useMutation(
    trpc.platform.setMessageSettings.mutationOptions(
      optimisticOver(trpc.platform.messageSettings.queryKey(), (current, next) => ({
        ...current,
        ...next,
      })),
    ),
  );
  if (settings.data === undefined) {
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
        checked={settings.data.sendSteersRunningTurn}
        onCheckedChange={(sendSteersRunningTurn) => save.mutate({ sendSteersRunningTurn })}
      />
      {save.isError ? <ErrorNote>Not saved: {errorText(save.error)}</ErrorNote> : null}
    </>
  );
}

function NewSessionDefaults() {
  const prefs = useComposerPrefs();
  const catalogs = useHarnessCatalogs();
  // What the composer starts a project with no sticky choice on: these, else claude and the
  // catalog's defaults.
  const harness = prefs.defaults.harness ?? "claude";
  const picker = modelPickerFor(catalogs, harness, {
    model: prefs.defaults.byHarness[harness]?.model ?? null,
    effort: prefs.defaults.byHarness[harness]?.effort ?? null,
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
            onChange={(next) => setComposerDefaultHarness(next)}
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
                onPick={(model) => setComposerDefaultPrefs(harness, { model: model.id })}
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
                if (row !== undefined) setComposerDefaultPrefs(harness, { effort: row.effort });
              }}
            />
          )}
        </Field>
      </FieldPair>
    </>
  );
}
