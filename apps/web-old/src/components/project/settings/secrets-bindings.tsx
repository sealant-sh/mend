import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "#/components/kit/button";
import { Field, GroupField, TextInput } from "#/components/kit/field";
import { FoldSection } from "#/components/kit/section";
import { Segment } from "#/components/kit/segment";
import { DataTable } from "#/components/kit/table";
import {
  addProjectClusterBinding,
  removeProjectClusterBinding,
  setProjectClusterServiceAccount,
} from "#/lib/project-environment";
import { useTRPC } from "#/lib/trpc";

import { ConfirmRemove } from "./secrets-remove";
import { countWords } from "./secrets-variables";

type Kind = "secret" | "configmap";

/**
 * Cluster bindings: names of Kubernetes Secrets and ConfigMaps in the platform's workspaces
 * namespace, resolved by the platform at each fresh workspace launch, and the workspace service
 * account. Mend keeps the names only; what is inside is unknown to Mend and never shown. On an
 * install without a cluster, a declared binding blocks launches, so removal always stays open.
 */
export function ClusterBindingsSection({ projectId }: { readonly projectId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const snapshot = useSuspenseQuery(
    trpc.environment.clusterBindings.queryOptions({ projectId }),
  ).data;
  const [kind, setKind] = useState<Kind>("secret");
  const [objectName, setObjectName] = useState("");
  const [account, setAccount] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const refresh = () =>
    queryClient.invalidateQueries(trpc.environment.clusterBindings.queryFilter({ projectId }));

  const bind = useMutation({
    mutationFn: async (binding: { readonly kind: Kind; readonly objectName: string }) => {
      const outcome = await addProjectClusterBinding(projectId, binding);
      if (!outcome.ok)
        throw new Error(
          outcome.kind === "duplicate"
            ? `${outcome.binding} is already bound on this project.`
            : outcome.message,
        );
      return binding;
    },
    onSuccess: async (binding) => {
      setNotice(`Bound ${binding.kind}/${binding.objectName}.`);
      setObjectName("");
      await refresh();
    },
  });
  const serviceAccount = useMutation({
    mutationFn: async (next: string | null) => {
      const outcome = await setProjectClusterServiceAccount(projectId, next);
      if (!outcome.ok)
        throw new Error(
          outcome.kind === "rejected" ? outcome.message : "The service account was not saved.",
        );
      return next;
    },
    onSuccess: async (next) => {
      setNotice(
        next === null ? "Cleared the workspace service account." : `Set service account ${next}.`,
      );
      setAccount(null);
      await refresh();
    },
  });

  const capable = snapshot.clusterCapable;
  const summary = [
    ...snapshot.bindings.map((binding) => `${binding.kind} ${binding.objectName}`),
    ...(snapshot.serviceAccount === null ? [] : [`service account ${snapshot.serviceAccount}`]),
  ];
  const draftAccount = (account ?? snapshot.serviceAccount ?? "").trim();
  const busy = bind.isPending || serviceAccount.isPending;

  return (
    <FoldSection
      title="Cluster bindings"
      count={countWords(snapshot.bindings.length, "binding")}
      why="Kubernetes objects mounted into workspaces. Mend keeps their names only; their contents stay in the cluster."
      summary={summary.length === 0 ? "none" : summary.join(" · ")}
      defaultOpen={false}
    >
      {capable ? null : (
        <p className="mb-3 text-[12.5px] text-warning">
          This install runs workspaces on the local runner, where cluster bindings do not resolve. A
          declared binding blocks launches here; remove it to launch.
        </p>
      )}
      <p role="status" className="mb-1 font-mono text-[11.5px] text-success empty:hidden">
        {notice}
      </p>
      <DataTable
        label="Cluster bindings"
        columns={[
          { head: "Kind", width: "0.5fr" },
          { head: "Name", width: "1.5fr" },
          { head: "", width: "minmax(112px,auto)", align: "end" },
        ]}
        empty="No cluster bindings."
        rows={snapshot.bindings.map((binding) => ({
          key: binding.id,
          cells: [
            <span key="kind" className="font-mono text-[12px] text-ink-2">
              {binding.kind}
            </span>,
            <span key="name" className="grid gap-0.5">
              <span className="font-mono text-[12px] break-all text-ink-2">
                {binding.objectName}
              </span>
              <span className="font-mono text-[11px] text-faint">
                resolved by the platform at launch
              </span>
            </span>,
            <ConfirmRemove
              key="remove"
              label={`${binding.kind}/${binding.objectName}`}
              disabled={busy}
              onRemove={async () => {
                await removeProjectClusterBinding(projectId, binding.id);
                setNotice(`Removed ${binding.kind}/${binding.objectName}.`);
                await refresh();
              }}
            />,
          ],
        }))}
      />
      <form
        className="mt-3 grid grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (capable && !busy && objectName.trim() !== "")
            bind.mutate({ kind, objectName: objectName.trim() });
        }}
      >
        <GroupField label="Kind" className="mb-0">
          <Segment
            label="Kind"
            value={kind}
            disabled={!capable || busy}
            onChange={setKind}
            options={[
              { value: "secret", label: "Secret" },
              { value: "configmap", label: "ConfigMap" },
            ]}
          />
        </GroupField>
        <Field label="Object name" className="mb-0">
          {(id) => (
            <TextInput
              id={id}
              value={objectName}
              disabled={!capable || busy}
              placeholder="app-env"
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setObjectName(event.target.value)}
            />
          )}
        </Field>
        <Button type="submit" disabled={!capable || busy || objectName.trim() === ""}>
          {bind.isPending ? "Binding…" : "Bind"}
        </Button>
      </form>
      <p role="alert" className="mt-1.5 font-mono text-[11.5px] text-danger empty:hidden">
        {bind.isError ? `Not bound: ${bind.error.message}` : ""}
      </p>
      <form
        className="mt-5 border-t border-rule-faint pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (capable && !busy && draftAccount !== "" && draftAccount !== snapshot.serviceAccount)
            serviceAccount.mutate(draftAccount);
        }}
      >
        <Field label="Workspace service account">
          {(id) => (
            <>
              <p id={`${id}-why`} className="text-[12.5px] text-muted-foreground">
                The agent holds this role&apos;s permissions for the whole session. Bind a
                least-privilege role meant for untrusted code; the operator binds and allows it in
                the cluster, and a name outside that list fails the launch.
              </p>
              <div className="flex items-center gap-2">
                <TextInput
                  id={id}
                  value={account ?? snapshot.serviceAccount ?? ""}
                  disabled={!capable || busy}
                  placeholder="none"
                  spellCheck={false}
                  autoComplete="off"
                  aria-describedby={`${id}-why`}
                  className="max-w-[280px]"
                  onChange={(event) => setAccount(event.target.value)}
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={
                    !capable ||
                    busy ||
                    draftAccount === "" ||
                    draftAccount === snapshot.serviceAccount
                  }
                >
                  {serviceAccount.isPending ? "Saving…" : "Set"}
                </Button>
                {snapshot.serviceAccount === null ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => serviceAccount.mutate(null)}
                  >
                    Clear
                  </Button>
                )}
              </div>
            </>
          )}
        </Field>
        <p role="alert" className="font-mono text-[11.5px] text-danger empty:hidden">
          {serviceAccount.isError ? `Not saved: ${serviceAccount.error.message}` : ""}
        </p>
      </form>
    </FoldSection>
  );
}
