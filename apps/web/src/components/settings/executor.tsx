import type {
  ExecutorLinkStatus,
  ExecutorLinkTarget,
  ExecutorManagedStatus,
} from "@mend/domain/workbench";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "#/components/kit/button";
import { Field, TextInput } from "#/components/kit/field";
import { Panel, SettingsSection } from "#/components/kit/section";
import { ErrorNote } from "#/components/kit/status";
import { useTRPC } from "#/lib/trpc";
import { useViewer } from "#/lib/viewer";

export const executorLinkWords = (link: ExecutorLinkStatus) =>
  `${link.state === "active" ? "Executor issued this link" : link.state === "refused" ? "Executor refused this link" : "No Executor link"}${link.observedAt === null ? "" : ` · observed ${link.observedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}`;

function ExecutorLink({
  target,
  status,
  editable = true,
}: {
  readonly target: ExecutorLinkTarget;
  readonly status: ExecutorLinkStatus;
  readonly editable?: boolean;
}) {
  const trpc = useTRPC();
  const begin = useMutation(
    trpc.executor.begin.mutationOptions({
      gcTime: 0,
      onSuccess: (result) => window.location.assign(result.url),
    }),
  );
  const unlink = useMutation(
    trpc.executor.unlink.mutationOptions({
      onSuccess: (_a, _b, _c, { client }) => client.invalidateQueries(trpc.executor.pathFilter()),
    }),
  );
  const error = begin.error ?? unlink.error;
  return (
    <div className="grid gap-3">
      <p role="status" className="font-mono text-[12px]">
        {executorLinkWords(status)}
      </p>
      {editable ? (
        <div className="flex gap-2">
          <Button
            disabled={begin.isPending || unlink.isPending}
            onClick={() => begin.mutate({ target })}
          >
            {begin.isPending
              ? "Opening Executor…"
              : status.state === "refused"
                ? "Link again"
                : status.state === "active"
                  ? "Replace link"
                  : "Link"}
          </Button>
          {status.state !== "unlinked" ? (
            <Button
              variant="ghost"
              disabled={begin.isPending || unlink.isPending}
              onClick={() => unlink.mutate({ target })}
            >
              {unlink.isPending ? "Unlinking…" : "Unlink"}
            </Button>
          ) : null}
        </div>
      ) : null}
      {error === null ? null : <ErrorNote>{error.message}</ErrorNote>}
    </div>
  );
}
export function PersonalExecutorSection() {
  const trpc = useTRPC();
  const status = useQuery(trpc.executor.personal.queryOptions(undefined, { retry: false }));
  return (
    <SettingsSection
      title="Executor"
      why="Your sessions call services as you through this link. Without it they use Mend's member and see what is shared with everyone."
    >
      {status.isPending ? (
        <p>Reading your Executor link…</p>
      ) : status.isError ? (
        <ErrorNote>{status.error.message}</ErrorNote>
      ) : !status.data.configured ? (
        <p>An organization owner sets up Executor in Settings → Organization → Executor.</p>
      ) : (
        <div className="grid gap-3">
          {status.data.url === null ? (
            <p>Your sessions use the organization's shared services through Mend's member.</p>
          ) : (
            <ExecutorLink target="person" status={status.data.link} />
          )}
          {status.data.link.state === "active" ? <ExecutorServices /> : null}
          {status.data.url === null ? null : (
            <a
              className="text-info underline"
              href={status.data.url}
              target="_blank"
              rel="noreferrer"
            >
              Manage your services in Executor
            </a>
          )}
        </div>
      )}
    </SettingsSection>
  );
}
export function OrganizationExecutorSettings() {
  const trpc = useTRPC();
  const viewer = useViewer();
  const saved = useQuery(trpc.executor.configuration.queryOptions());
  if (saved.isPending) return <p>Reading Executor settings…</p>;
  if (saved.isError) return <ErrorNote>{saved.error.message}</ErrorNote>;
  const owner = viewer?.role === "owner";
  return (
    <Panel>
      {saved.data.mode === "mend-run" ? null : (
        <SettingsSection
          title="Organization's own Executor"
          why="People consent at your Executor. Mend keeps their grants on its server and relays tools through each session's mend MCP server."
        >
          <ExecutorAddress key={saved.data.url ?? "unset"} url={saved.data.url} owner={owner} />
        </SettingsSection>
      )}
      <SettingsSection
        title="Mend's member"
        why={
          saved.data.mode === "mend-run"
            ? "Mend created this member for the organization's shared services. Calls use it when their person has no link."
            : "Calls use this member when their person has no link. Use an Executor member made for Mend, not a person's account."
        }
      >
        {saved.data.mode === "mend-run" ? (
          <p role="status" className="font-mono text-[12px]">
            {executorLinkWords(saved.data.member)}
          </p>
        ) : saved.data.url === null ? (
          <p>Set an Executor address first.</p>
        ) : (
          <ExecutorLink target="member" status={saved.data.member} editable={owner} />
        )}
      </SettingsSection>
      <SettingsSection
        title="Mend runs Executor"
        why="Sealant runs one Executor for this organization. It uses about 1.5 GiB of memory. Mend adds no services for anyone."
      >
        {saved.data.managed === undefined ? (
          <p>Reading runtime support…</p>
        ) : (
          <ManagedExecutor
            status={saved.data.managed}
            owner={owner}
            ownConfigured={saved.data.mode === "own"}
          />
        )}
        <a href="https://docs.mend.run/integrations/executor/" className="text-info underline">
          Executor setup instructions
        </a>
      </SettingsSection>
    </Panel>
  );
}
function ExecutorAddress({ url, owner }: { readonly url: string | null; readonly owner: boolean }) {
  const trpc = useTRPC();
  const [value, setValue] = useState(url ?? "");
  const save = useMutation(
    trpc.executor.configure.mutationOptions({
      onSuccess: (_a, _b, _c, { client }) => client.invalidateQueries(trpc.executor.pathFilter()),
    }),
  );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(value.trim() === "" ? null : { mode: "own", url: value });
      }}
    >
      <Field label="Executor address">
        {(id) => (
          <TextInput
            id={id}
            type="url"
            placeholder="https://executor.example.org"
            value={value}
            readOnly={!owner}
            onChange={(event) => setValue(event.target.value)}
          />
        )}
      </Field>
      {owner ? (
        <>
          <p className="mb-3 text-[13px] text-muted-foreground">
            Changing or clearing the address revokes the existing links. People link again at the
            new Executor.
          </p>
          <Button type="submit" disabled={save.isPending || value.trim() === (url ?? "")}>
            {save.isPending ? "Saving…" : "Save Executor"}
          </Button>
        </>
      ) : (
        <p>Only an organization owner changes this address.</p>
      )}
      {save.error === null ? null : <ErrorNote>{save.error.message}</ErrorNote>}
    </form>
  );
}

function ExecutorServices() {
  const trpc = useTRPC();
  const [offset, setOffset] = useState(0);
  const result = useQuery(trpc.executor.services.queryOptions({ offset }, { retry: false }));
  if (result.isPending) return <p>Reading the services your Executor link can use…</p>;
  if (result.isError) return <ErrorNote>{result.error.message}</ErrorNote>;
  return (
    <div className="grid gap-2">
      <p className="font-mono text-[12px]">
        Executor answered · observed{" "}
        {result.data.observedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </p>
      <p>Services in this page of available tools:</p>
      <ul>
        {result.data.services.map((service) => (
          <li key={service.id}>{service.name}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        {offset > 0 ? (
          <Button variant="ghost" onClick={() => setOffset(0)}>
            First page
          </Button>
        ) : null}
        {result.data.nextOffset === null ? null : (
          <Button variant="ghost" onClick={() => setOffset(result.data.nextOffset ?? 0)}>
            More tools
          </Button>
        )}
      </div>
    </div>
  );
}

function ManagedExecutor({
  status,
  owner,
  ownConfigured,
}: {
  readonly status: typeof ExecutorManagedStatus.Type;
  readonly owner: boolean;
  readonly ownConfigured: boolean;
}) {
  const trpc = useTRPC();
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const action = useMutation(
    trpc.executor.manage.mutationOptions({
      onSuccess: (_a, _b, _c, { client }) => {
        setConfirmRemoval(false);
        return client.invalidateQueries(trpc.executor.pathFilter());
      },
    }),
  );
  return (
    <div className="grid gap-3">
      <p role="status" className="font-mono text-[12px]">
        Executor {status.state}
        {status.observedAt === null
          ? ""
          : ` · observed ${status.observedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
      </p>
      {status.reason === null ? null : <p>{status.reason}</p>}
      {status.backupAt === null ? null : (
        <p className="font-mono text-[12px]">
          Volume backup saved · observed {status.backupAt.toLocaleString()}
        </p>
      )}
      {owner && status.available ? (
        ownConfigured ? (
          <p>Clear the organization's own Executor address before choosing Mend-run.</p>
        ) : (
          <div className="grid gap-3">
            <p>
              Stop keeps the organization's service logins and data. Upgrade stops Executor and
              saves its volume before applying the image included with this Mend release.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={action.isPending || status.state === "running"}
                onClick={() => action.mutate({ action: "start" })}
              >
                {action.isPending && action.variables?.action === "start"
                  ? "Starting Executor…"
                  : status.state === "not-started"
                    ? "Mend runs Executor for this organization"
                    : "Start Executor"}
              </Button>
              {status.state === "not-started" ? null : (
                <>
                  <Button
                    variant="ghost"
                    disabled={action.isPending || status.state === "stopped"}
                    onClick={() => action.mutate({ action: "stop" })}
                  >
                    {action.isPending && action.variables?.action === "stop"
                      ? "Stopping…"
                      : "Stop Executor"}
                  </Button>
                  {status.image === null || status.image === status.releaseImage ? null : (
                    <Button
                      variant="default"
                      disabled={action.isPending}
                      onClick={() => action.mutate({ action: "upgrade" })}
                    >
                      {action.isPending && action.variables?.action === "upgrade"
                        ? "Saving backup and upgrading…"
                        : "Back up and upgrade Executor"}
                    </Button>
                  )}
                </>
              )}
            </div>
            {status.retained ? (
              confirmRemoval ? (
                <div className="grid gap-3 rounded-xl border border-danger/30 p-4">
                  <p>
                    Remove this organization's Executor? The organization's service logins are
                    deleted, along with its services, retained data, saved backups, and everyone's
                    Executor links. This cannot be undone.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      className="text-danger"
                      disabled={action.isPending}
                      onClick={() => action.mutate({ action: "remove" })}
                    >
                      {action.isPending
                        ? "Removing Executor…"
                        : "Delete service logins and remove Executor"}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={action.isPending}
                      onClick={() => setConfirmRemoval(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  className="w-fit text-danger"
                  disabled={action.isPending}
                  onClick={() => setConfirmRemoval(true)}
                >
                  Remove Executor
                </Button>
              )
            ) : null}
          </div>
        )
      ) : null}
      {action.error === null ? null : <ErrorNote>{action.error.message}</ErrorNote>}
    </div>
  );
}
