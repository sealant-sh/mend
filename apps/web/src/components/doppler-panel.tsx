import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

import type { DopplerDto, ProjectDto } from "#/lib/api";
import { failureWords } from "#/lib/refusal";
import { orLogin, useTRPC, useTRPCClient } from "#/lib/trpc";

const INPUT =
  "mt-1.5 w-full rounded-xl border border-input bg-card px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-primary disabled:opacity-60";
const QUIET =
  "text-[13px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-60";
const ACTION =
  "rounded-xl bg-primary px-4 py-2 text-[13px] font-medium text-primary-foreground disabled:opacity-60";

/** The person's Doppler connection and project mappings; the token is sent once and never read back. */
export function DopplerPanel() {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const view = useSuspenseQuery(trpc.doppler.status.queryOptions()).data;
  const projects = useQuery(
    trpc.projects.list.queryOptions(undefined, { enabled: view.connected }),
  );
  const choices = useQuery(
    trpc.doppler.projects.queryOptions(undefined, { enabled: view.connected, retry: false }),
  );
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries(trpc.doppler.pathFilter());
  const connect = () => {
    if (token.trim() === "" || busy !== null) return;
    setBusy("connect");
    setError(null);
    void orLogin(client.doppler.connect.mutate({ token: token.trim() }))
      .then(() => {
        setToken("");
        return refresh();
      })
      .catch((cause: unknown) => setError(failureWords(cause, "Doppler could not be connected.")))
      .finally(() => setBusy(null));
  };
  const disconnect = () => {
    setBusy("disconnect");
    setError(null);
    void orLogin(client.doppler.disconnect.mutate())
      .then(refresh)
      .catch((cause: unknown) =>
        setError(failureWords(cause, "Doppler could not be disconnected.")),
      )
      .finally(() => setBusy(null));
  };

  return (
    <section id="doppler" className="rounded-2xl bg-panel p-6 shadow-[var(--shadow-sm)]">
      <h2 className="font-sans text-sm font-semibold">Doppler</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
        Connect your Doppler account and choose a config for each Mend project. Mend writes the
        configuration into your home in the workspace, where you can use{" "}
        <code className="font-mono text-xs">doppler run -- …</code>. Sessions start even when
        Doppler cannot be reached.
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="font-mono text-xs text-ink-2" role="status">
          {view.connected
            ? `Connected${view.name === null ? "" : ` · ${view.name}`}${view.updatedAt === null ? "" : ` · set ${view.updatedAt.toISOString().slice(0, 10)}`}`
            : "Not connected"}
        </p>
        {view.connected ? (
          <button type="button" className={QUIET} disabled={busy !== null} onClick={disconnect}>
            {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
          </button>
        ) : null}
      </div>
      <form
        className="mt-5 flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          connect();
        }}
      >
        <label className="min-w-48 flex-1 text-[13px] font-medium">
          {view.connected ? "Replace token" : "Doppler token"}
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            disabled={busy !== null}
            onChange={(event) => setToken(event.target.value)}
            className={INPUT}
          />
        </label>
        <button type="submit" disabled={busy !== null || token.trim() === ""} className={ACTION}>
          {busy === "connect" ? "Connecting…" : view.connected ? "Replace token" : "Connect"}
        </button>
      </form>
      <p className="mt-2 text-xs text-muted-foreground">
        A token from Doppler CLI login or a service token. Encrypted at rest and never shown again.
        New settings apply when your files are next delivered to a session.
      </p>
      {error === null ? null : (
        <p className="mt-3 text-[13px] text-danger" role="alert">
          {error}
        </p>
      )}
      {view.connected ? (
        <div className="mt-5 border-t border-[var(--sw-faint-rule)] pt-5">
          <h3 className="text-[13px] font-medium">Your project mappings</h3>
          {choices.error === null ? null : (
            <p className="mt-2 text-xs text-muted-foreground">
              Doppler&apos;s project list could not be loaded. You can enter the project and config
              names.
            </p>
          )}
          {projects.error === null ? null : (
            <p className="mt-2 text-[13px] text-danger" role="alert">
              Mend projects could not be loaded.
            </p>
          )}
          {projects.isPending ? (
            <p className="mt-3 text-xs text-muted-foreground">Loading projects…</p>
          ) : null}
          {projects.data?.length === 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Adopt a project to choose its Doppler config.
            </p>
          ) : null}
          <div className="divide-y divide-[var(--sw-faint-rule)]">
            {projects.data?.map((project) => {
              const mapping = view.mappings.find((row) => row.projectId === project.id);
              return (
                <ProjectMapping
                  key={`${project.id}:${mapping?.dopplerProject ?? ""}:${mapping?.config ?? ""}`}
                  project={project}
                  mapping={mapping}
                  choices={choices.data?.projects ?? []}
                  disabled={busy !== null}
                />
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ProjectMapping({
  project,
  mapping,
  choices,
  disabled,
}: {
  readonly project: ProjectDto;
  readonly mapping: DopplerDto["mappings"][number] | undefined;
  readonly choices: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly disabled: boolean;
}) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const [dopplerProject, setDopplerProject] = useState(mapping?.dopplerProject ?? "");
  const [config, setConfig] = useState(mapping?.config ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const configs = useQuery(
    trpc.doppler.configs.queryOptions(
      { project: dopplerProject.trim() },
      { enabled: choices.some((choice) => choice.id === dopplerProject.trim()), retry: false },
    ),
  );
  const changed =
    dopplerProject !== (mapping?.dopplerProject ?? "") || config !== (mapping?.config ?? "");
  const save = (action: "save" | "remove") => {
    if (busy || disabled) return;
    setBusy(true);
    setError(null);
    const operation =
      action === "remove"
        ? client.doppler.removeMapping.mutate({ projectId: project.id })
        : client.doppler.use.mutate({
            projectId: project.id,
            dopplerProject: dopplerProject.trim(),
            config: config.trim(),
          });
    void orLogin<unknown>(operation)
      .then(() => queryClient.invalidateQueries(trpc.doppler.status.queryFilter()))
      .catch((cause: unknown) =>
        setError(failureWords(cause, "The Doppler mapping could not be saved.")),
      )
      .finally(() => setBusy(false));
  };
  return (
    <form
      className="py-4"
      onSubmit={(event) => {
        event.preventDefault();
        save("save");
      }}
    >
      <p className="text-[13px] font-medium">{project.name}</p>
      <div className="mt-2 grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto_auto]">
        <label className="text-xs text-muted-foreground">
          Doppler project
          <input
            list={`${id}-projects`}
            value={dopplerProject}
            className={INPUT}
            disabled={disabled || busy}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setDopplerProject(event.target.value);
              setConfig("");
            }}
          />
          <datalist id={`${id}-projects`}>
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.name}
              </option>
            ))}
          </datalist>
        </label>
        <label className="text-xs text-muted-foreground">
          Config
          <input
            list={`${id}-configs`}
            value={config}
            className={INPUT}
            disabled={disabled || busy}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setConfig(event.target.value)}
          />
          <datalist id={`${id}-configs`}>
            {configs.data?.configs.map((choice) => (
              <option key={choice.name} value={choice.name} />
            ))}
          </datalist>
        </label>
        <button
          type="submit"
          className={ACTION}
          disabled={
            disabled || busy || !changed || dopplerProject.trim() === "" || config.trim() === ""
          }
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {mapping === undefined ? null : (
          <button
            type="button"
            className={`${QUIET} py-2`}
            disabled={disabled || busy}
            onClick={() => save("remove")}
          >
            Remove
          </button>
        )}
      </div>
      {configs.error === null ? null : (
        <p className="mt-2 text-xs text-muted-foreground">
          Doppler&apos;s config list could not be loaded. Enter a config name to save it.
        </p>
      )}
      {error === null ? null : (
        <p className="mt-2 text-[13px] text-danger" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
