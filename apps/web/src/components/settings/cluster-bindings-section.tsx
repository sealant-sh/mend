import { ProjectClusterBindingId } from "@mend/domain";
import { InlineAlert } from "@mend/ui/components/banner";
import { Segmented } from "@mend/ui/components/segmented";
import { Button } from "@mend/ui/components/ui/button";
import { Input } from "@mend/ui/components/ui/input";
import { toast } from "@mend/ui/components/ui/toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import {
  bindingRefusal,
  bindingWords,
  type ClusterBindingsRead,
  clusterSection,
} from "#/lib/cluster-bindings";
import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";

import { Overlay } from "../projects/overlay.tsx";
import { QueryView } from "../query-view.tsx";
import { SettingRow, SettingSection } from "./setting-row.tsx";

/** A control's height: the frames' 36px on the desk, a 44px touch target on a phone. */
const CONTROL = "h-9 max-lg:h-11 max-lg:text-base";

/**
 * Cluster bindings (cluster-bindings.md), under a project's variables and secrets, only where the
 * server runs workspaces on Kubernetes: Secrets and ConfigMaps in the workspaces namespace, bound
 * by name, whose keys each new workspace gets, and the service account workspaces run as. Mend
 * keeps the names only. On a server without Kubernetes the section shows only when something is
 * still bound, says that it blocks launches, and offers Remove.
 */
export function ClusterBindingsSection({
  projectId,
  projectName,
  manage,
}: {
  readonly projectId: string;
  readonly projectName: string;
  readonly manage: boolean;
}) {
  const trpc = useTRPC();
  const read = useQuery(trpc.environment.clusterBindings.queryOptions({ projectId }));
  return (
    <QueryView query={read}>
      {(snapshot: ClusterBindingsRead) => (
        <Bindings projectId={projectId} projectName={projectName} manage={manage} read={snapshot} />
      )}
    </QueryView>
  );
}

function Bindings({
  projectId,
  projectName,
  manage,
  read,
}: {
  readonly projectId: string;
  readonly projectName: string;
  readonly manage: boolean;
  readonly read: ClusterBindingsRead;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const section = clusterSection(read);
  const [kind, setKind] = useState<"secret" | "configmap">("secret");
  const [objectName, setObjectName] = useState("");
  const [bindRefusal, setBindRefusal] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [accountRefusal, setAccountRefusal] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ClusterBindingsRead["bindings"][number] | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries(trpc.environment.clusterBindings.queryFilter({ projectId }));
  const bind = useMutation(trpc.environment.addClusterBinding.mutationOptions());
  const setServiceAccount = useMutation(
    trpc.environment.setClusterServiceAccount.mutationOptions(),
  );
  const remove = useMutation(trpc.environment.removeClusterBinding.mutationOptions());
  if (section === "hidden") return null;
  const size = phone ? "touch" : "default";
  const draftAccount = (account ?? read.serviceAccount ?? "").trim();
  const submitBind = async () => {
    const name = objectName.trim();
    if (name === "") return;
    setBindRefusal(null);
    const outcome = await bind.mutateAsync({ projectId, request: { kind, objectName: name } });
    if (!outcome.ok) {
      setBindRefusal(bindingRefusal(outcome));
      return;
    }
    toast.add({ description: `Bound ${bindingWords({ kind, objectName: name })}.` });
    setObjectName("");
    await refresh();
  };
  const saveAccount = async (next: string | null) => {
    setAccountRefusal(null);
    const outcome = await setServiceAccount.mutateAsync({
      projectId,
      request: { serviceAccount: next },
    });
    if (!outcome.ok) {
      setAccountRefusal(
        outcome.kind === "rejected" ? outcome.message : "The service account wasn't saved.",
      );
      return;
    }
    toast.add({
      description:
        next === null
          ? "Workspaces run as the default service account again."
          : `Workspaces run as ${next}.`,
    });
    setAccount(null);
    await refresh();
  };
  return (
    <SettingSection
      title="Cluster bindings"
      description="Kubernetes Secrets and ConfigMaps in the workspaces namespace. Each new workspace gets their keys as environment variables. Mend keeps their names, never what's inside."
    >
      {section === "stranded" ? (
        <div className="py-3 max-lg:px-4">
          <InlineAlert size={size} title="These bindings can't resolve here.">
            {`This server doesn't run workspaces on Kubernetes, so no session in ${projectName} can start while anything is bound. Remove them to start sessions again.`}
          </InlineAlert>
        </div>
      ) : null}
      {read.bindings.length === 0 ? (
        <p className="border-b border-border py-3.5 text-row text-muted-foreground max-lg:px-4">
          Nothing is bound.
        </p>
      ) : (
        <ul aria-label="Cluster bindings">
          {read.bindings.map((binding) => (
            <li
              key={binding.id}
              className="flex items-center gap-4 border-b border-border py-3 max-lg:px-4"
            >
              <span className="w-28 flex-none text-row text-muted-foreground">
                {binding.kind === "secret" ? "Secret" : "ConfigMap"}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-sm">
                {binding.objectName}
              </span>
              {manage ? (
                <Button
                  variant="ghost"
                  size={phone ? "touch" : "sm"}
                  aria-label={`Remove ${bindingWords(binding)}`}
                  onClick={(event) => {
                    trigger.current = event.currentTarget;
                    remove.reset();
                    setRemoving(binding);
                  }}
                >
                  Remove…
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {manage && section === "kubernetes" ? (
        <SettingRow
          layout="stack"
          label="Bind an object"
          labelFor="cluster-object-name"
          description="Name a Secret or ConfigMap that is already in the workspaces namespace."
          note={
            bindRefusal === null && !bind.isError ? null : (
              <span role="alert" className="text-destructive">
                {bindRefusal ?? failureWords(bind.error, "Mend didn't answer. Try again.")}
              </span>
            )
          }
          control={
            <form
              className="flex flex-wrap items-center gap-2 max-lg:w-full"
              onSubmit={(event) => {
                event.preventDefault();
                void submitBind().catch(() => undefined);
              }}
            >
              <Segmented
                aria-label="Kind"
                size={size}
                value={kind}
                disabled={bind.isPending}
                onValueChange={setKind}
                options={[
                  { value: "secret", label: "Secret" },
                  { value: "configmap", label: "ConfigMap" },
                ]}
              />
              <Input
                id="cluster-object-name"
                value={objectName}
                placeholder="app-env"
                autoComplete="off"
                spellCheck={false}
                disabled={bind.isPending}
                className={`${CONTROL} w-44 font-mono max-lg:w-full`}
                onChange={(event) => {
                  setObjectName(event.target.value);
                  setBindRefusal(null);
                }}
              />
              <Button
                type="submit"
                variant="outline"
                className={CONTROL}
                disabled={bind.isPending || objectName.trim() === ""}
              >
                {bind.isPending ? "Binding…" : "Bind"}
              </Button>
            </form>
          }
        />
      ) : null}
      <SettingRow
        layout="stack"
        label="Workspace service account"
        labelFor="cluster-service-account"
        description={
          read.serviceAccount === null
            ? "Workspaces run as the namespace's default account. Name a least-privilege one the operator allows, since the agent holds its permissions for the whole session."
            : "The agent holds this account's permissions for the whole session. The operator allows it in the cluster; a name outside that list fails the launch."
        }
        note={
          accountRefusal === null && !setServiceAccount.isError ? null : (
            <span role="alert" className="text-destructive">
              {accountRefusal ??
                failureWords(setServiceAccount.error, "Mend didn't answer. Try again.")}
            </span>
          )
        }
        control={
          manage && section === "kubernetes" ? (
            <form
              className="flex items-center gap-2 max-lg:w-full"
              onSubmit={(event) => {
                event.preventDefault();
                if (draftAccount !== "" && draftAccount !== read.serviceAccount)
                  void saveAccount(draftAccount).catch(() => undefined);
              }}
            >
              <Input
                id="cluster-service-account"
                value={account ?? read.serviceAccount ?? ""}
                placeholder="default"
                autoComplete="off"
                spellCheck={false}
                disabled={setServiceAccount.isPending}
                className={`${CONTROL} w-44 font-mono max-lg:w-full`}
                onChange={(event) => {
                  setAccount(event.target.value);
                  setAccountRefusal(null);
                }}
              />
              <Button
                type="submit"
                variant="outline"
                className={CONTROL}
                disabled={
                  setServiceAccount.isPending ||
                  draftAccount === "" ||
                  draftAccount === read.serviceAccount
                }
              >
                Save
              </Button>
              {read.serviceAccount === null ? null : (
                <Button
                  variant="ghost"
                  className={CONTROL}
                  disabled={setServiceAccount.isPending}
                  onClick={() => void saveAccount(null).catch(() => undefined)}
                >
                  Clear
                </Button>
              )}
            </form>
          ) : read.serviceAccount === null ? (
            <span className="text-muted-foreground">Default</span>
          ) : (
            <span className="flex items-center gap-2">
              <span className="font-mono text-sm">{read.serviceAccount}</span>
              {manage ? (
                <Button
                  variant="ghost"
                  className={CONTROL}
                  disabled={setServiceAccount.isPending}
                  onClick={() => void saveAccount(null).catch(() => undefined)}
                >
                  Clear
                </Button>
              ) : null}
            </span>
          )
        }
      />
      <Overlay
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next && !remove.isPending) setRemoving(null);
        }}
        title={removing === null ? "Remove binding?" : `Remove ${bindingWords(removing)}?`}
        description="Workspaces that start after this don't get its keys. Running workspaces keep them until they stop. The object stays in the cluster."
        size="sm"
        finalFocus={trigger}
        footer={
          <>
            <Button
              variant="outline"
              size={size}
              disabled={remove.isPending}
              onClick={() => setRemoving(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size={size}
              disabled={remove.isPending || removing === null}
              onClick={() => {
                if (removing === null) return;
                const gone = removing;
                remove.mutate(
                  { projectId, bindingId: ProjectClusterBindingId.make(gone.id) },
                  {
                    onSuccess: () => {
                      toast.add({ description: `Removed ${bindingWords(gone)}.` });
                      setRemoving(null);
                      void refresh();
                    },
                  },
                );
              }}
            >
              {remove.isPending ? "Removing…" : "Remove binding"}
            </Button>
          </>
        }
      >
        {remove.isError ? (
          <InlineAlert size={size} title="It wasn't removed.">
            {failureWords(remove.error, "Mend didn't answer. Try again.")}
          </InlineAlert>
        ) : null}
      </Overlay>
    </SettingSection>
  );
}
