import {
  useMutation,
  useQueries,
  useQuery,
  useSuspenseQuery,
  type MutationFunctionContext,
} from "@tanstack/react-query";
import { useId, useState } from "react";

import { Button } from "#/components/kit/button";
import { Field, TextInput } from "#/components/kit/field";
import { SettingsSection } from "#/components/kit/section";
import { ErrorNote, StatusWord } from "#/components/kit/status";
import { DataTable } from "#/components/kit/table";
import type { DopplerDto } from "#/lib/api";
import { failureWords } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";

type Mapping = DopplerDto["mappings"][number];

/** A project's mapping as typed, before it is saved. */
interface MappingDraft {
  readonly dopplerProject: string;
  readonly config: string;
}

const draftOf = (mapping: Mapping | undefined): MappingDraft => ({
  dopplerProject: mapping?.dopplerProject ?? "",
  config: mapping?.config ?? "",
});

const dayOf = (at: Date) => at.toLocaleDateString(undefined, { month: "short", day: "numeric" });

/**
 * The person's Doppler connection and which Doppler config each Mend project gets. The token is
 * sent once and never read back; Mend writes the configuration into the person's home in the
 * workspace, for `doppler run -- …`. Sessions start even when Doppler cannot be reached.
 */
export function DopplerSection() {
  const trpc = useTRPC();
  const view = useSuspenseQuery(trpc.doppler.status.queryOptions()).data;
  return (
    <SettingsSection
      title="Doppler"
      why={
        <>
          Pulls secrets from Doppler into the projects you map, for{" "}
          <code className="font-mono text-[12px]">doppler run -- …</code> in the workspace. Sessions
          start even when Doppler cannot be reached.
        </>
      }
    >
      <p role="status">
        <StatusWord tone={view.connected ? "ok" : "off"}>
          {view.connected
            ? ["connected", view.name, view.updatedAt === null ? null : dayOf(view.updatedAt)]
                .filter((part) => part !== null)
                .join(" · ")
            : "not connected"}
        </StatusWord>
      </p>
      <DopplerToken connected={view.connected} />
      {view.connected ? <Mappings view={view} /> : null}
    </SettingsSection>
  );
}

function DopplerToken({ connected }: { readonly connected: boolean }) {
  const trpc = useTRPC();
  const [token, setToken] = useState("");
  const settle = {
    onSuccess: (
      _result: unknown,
      _variables: unknown,
      _context: unknown,
      { client }: MutationFunctionContext,
    ) => {
      setToken("");
      return client.invalidateQueries(trpc.doppler.pathFilter());
    },
  };
  const connect = useMutation(trpc.doppler.connect.mutationOptions(settle));
  const disconnect = useMutation(trpc.doppler.disconnect.mutationOptions(settle));
  const pending = connect.isPending || disconnect.isPending;
  const error = connect.error ?? disconnect.error;
  return (
    <form
      className="mt-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (token.trim() === "" || pending) return;
        disconnect.reset();
        connect.mutate({ token: token.trim() });
      }}
    >
      <div className="flex items-end gap-2">
        <Field label={connected ? "Replace the token" : "Doppler token"} className="mb-0 flex-1">
          {(id) => (
            <TextInput
              id={id}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              disabled={pending}
              placeholder="dp.ct.… or dp.st.…"
              onChange={(event) => setToken(event.target.value)}
            />
          )}
        </Field>
        <Button type="submit" disabled={pending || token.trim() === ""}>
          {connect.isPending ? "Connecting…" : connected ? "Replace" : "Connect"}
        </Button>
        {connected ? (
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => {
              connect.reset();
              disconnect.mutate();
            }}
          >
            {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
          </Button>
        ) : null}
      </div>
      <p className="mt-1.5 text-[12.5px] text-muted-foreground">
        A token from the Doppler CLI login or a service token. Encrypted at rest and never shown
        again. Changes apply when your files are next delivered to a session.
      </p>
      {error === null ? null : (
        <ErrorNote className="mt-2">
          {failureWords(
            error,
            connect.error === null
              ? "Doppler could not be disconnected."
              : "Doppler could not be connected.",
          )}
        </ErrorNote>
      )}
    </form>
  );
}

/** One row per Mend project: which Doppler project and config it gets, edited in place. */
function Mappings({ view }: { readonly view: DopplerDto }) {
  const trpc = useTRPC();
  const listId = useId();
  const projects = useQuery(trpc.projects.list.queryOptions());
  const choices = useQuery(trpc.doppler.projects.queryOptions(undefined, { retry: false }));
  const [drafts, setDrafts] = useState<Readonly<Record<string, MappingDraft>>>({});
  const known = choices.data?.projects ?? [];
  const rows = (projects.data ?? []).map((project) => {
    const mapping = view.mappings.find((row) => row.projectId === project.id);
    return { project, mapping, draft: drafts[project.id] ?? draftOf(mapping) };
  });
  const configs = useQueries({
    queries: rows.map(({ draft }) =>
      trpc.doppler.configs.queryOptions(
        { project: draft.dopplerProject.trim() },
        {
          enabled: known.some((choice) => choice.id === draft.dopplerProject.trim()),
          retry: false,
        },
      ),
    ),
  });
  const forget = (projectId: string) => setDrafts(({ [projectId]: _dropped, ...rest }) => rest);
  const settled = {
    onSuccess: (
      _result: unknown,
      variables: { readonly projectId: string },
      _context: unknown,
      { client }: MutationFunctionContext,
    ) => {
      forget(variables.projectId);
      return client.invalidateQueries(trpc.doppler.status.queryFilter());
    },
  };
  const use = useMutation(trpc.doppler.use.mutationOptions(settled));
  const remove = useMutation(trpc.doppler.removeMapping.mutationOptions(settled));
  const pending = use.isPending || remove.isPending;
  const failed = use.error === null ? remove : use;
  const failedProject = rows.find(
    ({ project }) => project.id === failed.variables?.projectId,
  )?.project;
  const edit = (projectId: string, draft: MappingDraft) =>
    setDrafts((current) => ({ ...current, [projectId]: draft }));

  return (
    <div className="mt-4">
      {choices.isError ? (
        <p className="mb-2 text-[12.5px] text-muted-foreground">
          Doppler&apos;s project list could not be read. Type the project and config names.
        </p>
      ) : null}
      {projects.isError ? <ErrorNote>Mend&apos;s projects could not be read.</ErrorNote> : null}
      <datalist id={`${listId}-projects`}>
        {known.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.name}
          </option>
        ))}
      </datalist>
      <DataTable
        label="Doppler project mappings"
        columns={[
          { head: "Project", width: "0.8fr" },
          { head: "Doppler project", width: "1fr" },
          { head: "Config", width: "1fr" },
          { head: "", width: "auto" },
        ]}
        rows={rows.map(({ project, mapping, draft }, index) => {
          const changed =
            draft.dopplerProject !== (mapping?.dopplerProject ?? "") ||
            draft.config !== (mapping?.config ?? "");
          const busy =
            (use.isPending && use.variables.projectId === project.id) ||
            (remove.isPending && remove.variables.projectId === project.id);
          const configList = `${listId}-configs-${index}`;
          return {
            key: project.id,
            cells: [
              <span key="project" className="font-mono text-[12px] text-ink-2">
                {project.name}
              </span>,
              <TextInput
                key="doppler"
                list={`${listId}-projects`}
                value={draft.dopplerProject}
                disabled={pending}
                autoComplete="off"
                spellCheck={false}
                placeholder="none"
                aria-label={`Doppler project for ${project.name}`}
                className="py-1.5 text-[12px]"
                onChange={(event) =>
                  edit(project.id, { dopplerProject: event.target.value, config: "" })
                }
              />,
              <span key="config">
                <TextInput
                  list={configList}
                  value={draft.config}
                  disabled={pending}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={`Doppler config for ${project.name}`}
                  className="py-1.5 text-[12px]"
                  onChange={(event) => edit(project.id, { ...draft, config: event.target.value })}
                />
                <datalist id={configList}>
                  {configs[index]?.data?.configs.map((choice) => (
                    <option key={choice.name} value={choice.name} />
                  ))}
                </datalist>
              </span>,
              changed ? (
                <span key="actions" className="flex gap-0.5">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={
                      pending || draft.dopplerProject.trim() === "" || draft.config.trim() === ""
                    }
                    aria-label={`Save the Doppler mapping for ${project.name}`}
                    onClick={() =>
                      use.mutate({
                        projectId: project.id,
                        dopplerProject: draft.dopplerProject.trim(),
                        config: draft.config.trim(),
                      })
                    }
                  >
                    {busy ? "Saving…" : "Save"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    aria-label={`Undo the edit for ${project.name}`}
                    onClick={() => forget(project.id)}
                  >
                    Undo
                  </Button>
                </span>
              ) : mapping === undefined ? null : (
                <Button
                  key="actions"
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  aria-label={`Remove the Doppler mapping for ${project.name}`}
                  onClick={() => remove.mutate({ projectId: project.id })}
                >
                  {busy ? "Removing…" : "Remove"}
                </Button>
              ),
            ],
          };
        })}
        empty={projects.isPending ? "reading projects…" : "adopt a project to map a Doppler config"}
      />
      {failed.error === null ? null : (
        <ErrorNote className="mt-2">
          {failureWords(
            failed.error,
            `The Doppler mapping${failedProject === undefined ? "" : ` for ${failedProject.name}`} could not be saved.`,
          )}
        </ErrorNote>
      )}
    </div>
  );
}
