import type {
  ExecutorServiceConnection,
  ExecutorServiceDirectory,
  ExecutorServiceRequirement,
  ExecutorServiceTarget,
} from "@mend/domain/workbench";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "#/components/kit/button";
import { Field, TextInput } from "#/components/kit/field";
import { ErrorNote } from "#/components/kit/status";
import { useTRPC } from "#/lib/trpc";

type Service = (typeof ExecutorServiceDirectory.Type.services)[number];

/** Service sign-in opens only the service's page; every Executor request stays on Mend's server. */
export function ExecutorServiceSettings({ target }: { readonly target: ExecutorServiceTarget }) {
  const trpc = useTRPC();
  const result = useQuery(trpc.executor.directory.queryOptions({ target }, { retry: false }));
  return (
    <div className="grid gap-5">
      <p>
        {target === "member"
          ? "Services added here are shared with everyone. Accounts connected here belong to Mend's member and are shared with everyone. Mend adds nothing until you choose Add service."
          : "Add a service only you see, or connect your own account to an available service. Your sessions use these accounts through your Executor link."}
      </p>
      <AddService target={target} />
      {result.isPending ? (
        <p>Reading services from Executor…</p>
      ) : result.isError ? (
        <ErrorNote>{result.error.message}</ErrorNote>
      ) : (
        <>
          <p role="status" className="font-mono text-[12px]">
            Executor answered · observed{" "}
            {result.data.observedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </p>
          {result.data.services.length === 0 ? (
            <p>No services were returned for this link.</p>
          ) : (
            result.data.services.map((service) => (
              <ServiceRow key={service.id} target={target} service={service} />
            ))
          )}
        </>
      )}
    </div>
  );
}
function AddService({ target }: { readonly target: ExecutorServiceTarget }) {
  const trpc = useTRPC();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const add = useMutation(
    trpc.executor.addService.mutationOptions({
      onSuccess: (_a, _b, _c, { client }) => {
        setName("");
        setUrl("");
        return client.invalidateQueries(trpc.executor.pathFilter());
      },
    }),
  );
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        add.mutate({ target, name, url });
      }}
    >
      <Field label="Service name">
        {(id) => (
          <TextInput
            id={id}
            value={name}
            maxLength={120}
            required
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </Field>
      <Field label="MCP address">
        {(id) => (
          <TextInput
            id={id}
            type="url"
            value={url}
            placeholder="https://service.example/mcp"
            required
            onChange={(event) => setUrl(event.target.value)}
          />
        )}
      </Field>
      <p className="text-[13px] text-muted-foreground">
        The service must allow anonymous use or advertise OAuth sign-in. API-key accounts can be
        connected to service definitions already in Executor.
      </p>
      <div>
        <Button type="submit" disabled={add.isPending}>
          {add.isPending
            ? "Adding…"
            : target === "member"
              ? "Add service for everyone"
              : "Add service only for me"}
        </Button>
      </div>
      {add.error === null ? null : <ErrorNote>{add.error.message}</ErrorNote>}
    </form>
  );
}
function ServiceRow({
  service,
  target,
}: {
  readonly service: Service;
  readonly target: ExecutorServiceTarget;
}) {
  const trpc = useTRPC();
  const share = useMutation(
    trpc.executor.shareService.mutationOptions({
      onSuccess: (_a, _b, _c, { client }) => client.invalidateQueries(trpc.executor.pathFilter()),
    }),
  );
  return (
    <div className="grid gap-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{service.name}</h3>
        <span className="font-mono text-[12px] text-muted-foreground">
          {service.shared ? "Shared with everyone" : "Private to this link"}
        </span>
      </div>
      {target === "member" && !service.shared ? (
        <Button disabled={share.isPending} onClick={() => share.mutate({ service: service.id })}>
          Share with everyone
        </Button>
      ) : null}
      {share.error === null ? null : <ErrorNote>{share.error.message}</ErrorNote>}
      {service.requirements.length === 0 ? (
        <p className="text-[13px]">No account required · Executor answered</p>
      ) : (
        service.requirements.map((requirement) => (
          <Requirement
            key={requirement.name}
            target={target}
            service={service}
            requirement={requirement}
          />
        ))
      )}
    </div>
  );
}
function Requirement({
  target,
  service,
  requirement,
}: {
  readonly target: ExecutorServiceTarget;
  readonly service: Service;
  readonly requirement: typeof ExecutorServiceRequirement.Type;
}) {
  const trpc = useTRPC();
  const [form, setForm] = useState<typeof ExecutorServiceConnection.Type | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const connect = useMutation(
    trpc.executor.connectService.mutationOptions({
      gcTime: 0,
      onSuccess: async (result, _b, _c, { client }) => {
        if (result.url !== null) {
          window.location.assign(result.url);
          return;
        }
        if (result.completed) await client.invalidateQueries(trpc.executor.pathFilter());
        else setForm(result);
      },
    }),
  );
  const disconnect = useMutation(
    trpc.executor.disconnectService.mutationOptions({
      onSuccess: (_a, _b, _c, { client }) => {
        setDisconnecting(null);
        return client.invalidateQueries(trpc.executor.pathFilter());
      },
    }),
  );
  const useAccount = useMutation(
    trpc.executor.useServiceAccount.mutationOptions({
      onSuccess: (_a, _b, _c, { client }) => client.invalidateQueries(trpc.executor.pathFilter()),
    }),
  );
  const error = connect.error ?? disconnect.error ?? useAccount.error;
  const pending = connect.isPending || disconnect.isPending || useAccount.isPending;
  const action = (account: string) => ({
    target,
    service: service.id,
    requirement: requirement.name,
    account,
  });
  return (
    <div className="grid gap-3">
      <p className="text-[13px] text-muted-foreground">
        {requirement.name}
        {requirement.scope === "app" ? " · used by every caller" : ""}
      </p>
      {requirement.accounts.map((account) => (
        <div key={account.id} className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span>{account.label || "Connected account"}</span>
            <span className="font-mono text-[12px]">
              {account.linked ? "In use · Executor answered" : "Available · Executor answered"}
            </span>
            {!account.linked ? (
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() => useAccount.mutate(action(account.id))}
              >
                Use account
              </Button>
            ) : null}
            {account.canDisconnect ? (
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() => setDisconnecting(account.id)}
              >
                Disconnect
              </Button>
            ) : null}
          </div>
          {disconnecting === account.id ? (
            <div role="alert" className="grid gap-2 border border-border p-3">
              <p>
                {target === "member"
                  ? "Disconnect this shared account? Sessions using it through Mend's member or another service will lose that service login."
                  : "Disconnect this account? Services using this saved account will lose its login."}
              </p>
              <div className="flex gap-2">
                <Button disabled={pending} onClick={() => disconnect.mutate(action(account.id))}>
                  {disconnect.isPending ? "Disconnecting…" : "Disconnect account"}
                </Button>
                <Button variant="ghost" disabled={pending} onClick={() => setDisconnecting(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ))}
      {form !== null ? (
        <AccountFields key={form.id} connection={form} onClose={() => setForm(null)} />
      ) : (
        <div className="flex flex-wrap gap-2">
          {requirement.methods.map((method) =>
            method.kind === "unsupported" ? (
              <p key={method.name}>This service's account form is not supported in Mend.</p>
            ) : (
              <Button
                key={method.name}
                disabled={pending}
                onClick={() =>
                  connect.mutate({
                    target,
                    service: service.id,
                    requirement: requirement.name,
                    method: method.name,
                  })
                }
              >
                {connect.isPending ? "Starting connection…" : `Connect account · ${method.label}`}
              </Button>
            ),
          )}
        </div>
      )}
      {error === null ? null : <ErrorNote>{error.message}</ErrorNote>}
    </div>
  );
}
function AccountFields({
  connection,
  onClose,
}: {
  readonly connection: typeof ExecutorServiceConnection.Type;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const submit = useMutation(
    trpc.executor.submitService.mutationOptions({
      gcTime: 0,
      onSuccess: async (_a, _b, _c, { client }) => {
        setValues({});
        await client.invalidateQueries(trpc.executor.pathFilter());
        onClose();
      },
    }),
  );
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (connection.id !== null) submit.mutate({ id: connection.id, fields: values });
      }}
    >
      <p>These values are sent to Executor through Mend's server and are never returned by Mend.</p>
      {connection.fields.map((field) => (
        <Field key={field.name} label={field.label}>
          {(id) => (
            <TextInput
              id={id}
              type={field.secret ? "password" : "text"}
              autoComplete="off"
              required={field.required}
              value={values[field.name] ?? ""}
              onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
            />
          )}
        </Field>
      ))}
      <div className="flex gap-2">
        <Button type="submit" disabled={submit.isPending}>
          {submit.isPending ? "Connecting…" : "Connect account"}
        </Button>
        <Button
          variant="ghost"
          disabled={submit.isPending}
          onClick={() => {
            setValues({});
            onClose();
          }}
        >
          Cancel
        </Button>
      </div>
      {submit.error === null ? null : <ErrorNote>{submit.error.message}</ErrorNote>}
    </form>
  );
}
