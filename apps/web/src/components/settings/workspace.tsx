import type { DotfilesRepository } from "@mend/domain";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { Field, FieldPair, TextInput } from "#/components/kit/field";
import { focusFirstControl, SaveBar } from "#/components/kit/save-bar";
import { Panel, SettingsSection } from "#/components/kit/section";
import { Segment } from "#/components/kit/segment";
import { errorText, StatusWord } from "#/components/kit/status";
import { SwitchRow } from "#/components/kit/switch";
import {
  DOTFILES_MANAGER_OPTIONS,
  repositoryDraft,
  repositoryDraftDirty,
  repositoryFromDraft,
  type DotfilesRepositoryDraft,
} from "#/lib/dotfiles-repository";
import { useTRPC } from "#/lib/trpc";

import { DopplerSection } from "./workspace-doppler.tsx";
import { HomeFilesSection, SecretFilesSection } from "./workspace-files.tsx";
import { WorkspaceSshSection } from "./workspace-ssh.tsx";

/**
 * Settings · You · Workspace: what every new session of this person starts with. The dotfiles
 * repository is a draft saved from the bar under the panel; files, Doppler and SSH keys save as
 * they are changed.
 */
export function WorkspaceSettings() {
  const dotfiles = useDotfilesDraft();
  return (
    <>
      <Panel>
        <div ref={dotfiles.fields}>
          <DotfilesSection draft={dotfiles} />
        </div>
        <HomeFilesSection />
        <SecretFilesSection />
        <DopplerSection />
        <WorkspaceSshSection />
      </Panel>
      <SaveBar
        dirty={dotfiles.changes > 0}
        summary={`${dotfiles.changes} unsaved ${dotfiles.changes === 1 ? "change" : "changes"}`}
        saveLabel="Save workspace"
        pendingLabel={dotfiles.clearing ? "Saving…" : "Cloning the repository…"}
        pending={dotfiles.save.isPending}
        error={dotfiles.save.error === null ? null : errorText(dotfiles.save.error)}
        said={dotfiles.said}
        returnFocus={() => focusFirstControl(dotfiles.fields.current)}
        onDiscard={dotfiles.discard}
        onSave={dotfiles.submit}
      />
    </>
  );
}

/** How many of the repository form's fields differ from what is saved, as a save would send them. */
export const repositoryChanges = (
  saved: DotfilesRepository | null,
  draft: DotfilesRepositoryDraft,
): number => {
  if (!repositoryDraftDirty(saved, draft)) return 0;
  const before = repositoryDraft(saved);
  const fields: ReadonlyArray<keyof DotfilesRepositoryDraft> = [
    "url",
    "ref",
    "subdirectory",
    "manager",
    "bootstrap",
  ];
  const differing = fields.filter((field) => {
    const a = before[field];
    const b = draft[field];
    return typeof a === "string" && typeof b === "string" ? a.trim() !== b.trim() : a !== b;
  }).length;
  return Math.max(differing, 1);
};

type DotfilesDraft = ReturnType<typeof useDotfilesDraft>;

/**
 * The repository form: a draft started from the saved repository and started again from what the
 * server answers after a save. The server clones the repository once on save and refuses one it
 * cannot clone, so the draft stays put and the bar says why.
 */
function useDotfilesDraft() {
  const trpc = useTRPC();
  const saved = useSuspenseQuery(trpc.settings.dotfiles.queryOptions()).data.repository;
  const [draft, setDraft] = useState(() => repositoryDraft(saved));
  // What the last save or discard did, said once the save bar has gone.
  const [said, setSaid] = useState<string | null>(null);
  const fields = useRef<HTMLDivElement>(null);
  const save = useMutation(
    trpc.settings.putDotfilesRepository.mutationOptions({
      onSuccess: (next, _variables, _result, { client }) => {
        client.setQueryData(trpc.settings.dotfiles.queryKey(), next);
        setDraft(repositoryDraft(next.repository));
        setSaid("Saved · applies from the next launch");
      },
    }),
  );
  const repository = repositoryFromDraft(draft);
  return {
    draft,
    said,
    fields,
    changes: repositoryChanges(saved, draft),
    clearing: repository === null,
    save,
    edit: (change: Partial<DotfilesRepositoryDraft>) => {
      save.reset();
      setSaid(null);
      setDraft((current) => ({ ...current, ...change }));
    },
    discard: () => {
      save.reset();
      setSaid("Discarded");
      setDraft(repositoryDraft(saved));
    },
    submit: () => save.mutate({ repository }),
  };
}

function DotfilesSection({ draft: form }: { readonly draft: DotfilesDraft }) {
  const { draft, edit, save } = form;
  const pending = save.isPending;
  const manager = DOTFILES_MANAGER_OPTIONS.find((option) => option.value === draft.manager);
  return (
    <SettingsSection
      title="Dotfiles"
      why="Mend clones this repository into each workspace before the agent starts. Yours alone; this server's own home is never read."
    >
      <Field label="Repository">
        {(id) => (
          <TextInput
            id={id}
            value={draft.url}
            disabled={pending}
            placeholder="https://github.com/you/dotfiles.git"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => edit({ url: event.target.value })}
          />
        )}
      </Field>
      <FieldPair>
        <Field label="Branch">
          {(id) => (
            <TextInput
              id={id}
              value={draft.ref}
              disabled={pending}
              placeholder="default"
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => edit({ ref: event.target.value })}
            />
          )}
        </Field>
        <Field label="Subdirectory">
          {(id) => (
            <TextInput
              id={id}
              value={draft.subdirectory}
              disabled={pending}
              placeholder="repo root"
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => edit({ subdirectory: event.target.value })}
            />
          )}
        </Field>
      </FieldPair>
      <SwitchRow
        label={
          <>
            Run{" "}
            <code className="rounded-[5px] bg-secondary px-1 py-0.5 font-mono text-[12px]">
              ./install.sh
            </code>{" "}
            when present
          </>
        }
        checked={draft.bootstrap}
        disabled={pending}
        onCheckedChange={(bootstrap) => edit({ bootstrap })}
      />
      <div className="mt-2 grid gap-1.5">
        <span aria-hidden="true" className="font-sans text-[12.5px] font-medium text-ink-2">
          Manager
        </span>
        <Segment
          label="Manager"
          value={draft.manager}
          disabled={pending}
          onChange={(value) => edit({ manager: value })}
          options={DOTFILES_MANAGER_OPTIONS.map((option) => ({
            value: option.value,
            label: option.label,
          }))}
        />
        <p className="text-[12.5px] text-muted-foreground">
          {manager?.detail} Home files below are always copied.
        </p>
      </div>
      {save.isSuccess && form.changes === 0 ? (
        <p role="status" className="mt-3">
          <StatusWord tone="ok">saved · applies from the next launch</StatusWord>
        </p>
      ) : null}
    </SettingsSection>
  );
}
