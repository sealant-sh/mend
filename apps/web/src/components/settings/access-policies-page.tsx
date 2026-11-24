import type { AccessRevocationKind, GitTransport } from "@mend/domain/workbench";
import { InlineAlert } from "@mend/ui/components/banner";
import { Segmented } from "@mend/ui/components/segmented";
import { Button } from "@mend/ui/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@mend/ui/components/ui/field";
import { Input } from "@mend/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@mend/ui/components/ui/native-select";
import { Switch } from "@mend/ui/components/ui/switch";
import { Textarea } from "@mend/ui/components/ui/textarea";
import { toast } from "@mend/ui/components/ui/toast";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

import {
  automaticHosts,
  ceilingLine,
  draftElevated,
  draftOf,
  draftProblems,
  ELEVATED_LINE,
  enforcementLead,
  GIT_TRANSPORT_LINES,
  GIT_TRANSPORT_NAMES,
  GIT_TRANSPORT_ORDER,
  MODE_LINES,
  MODE_NAMES,
  type PolicyDraft,
  policiesIntro,
  policyMarks,
  REVOKE_WARNING,
  revisionLine,
  revocationScope,
  revocationWhat,
  revokedByLine,
  rulesOf,
} from "#/lib/access-policies";
import type { AccessPoliciesDto, AccessPolicyDto, AccessRevokedDto } from "#/lib/api";
import { mcpServerHosts } from "#/lib/mcp-servers";
import { ownersOf } from "#/lib/organization-general";
import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";

import { EnforcementList, RuleList } from "../access-policy-parts.tsx";
import { Overlay } from "../projects/overlay.tsx";
import { QueryView } from "../query-view.tsx";
import { SettingRow, SettingSection } from "./setting-row.tsx";
import { SettingsPage } from "./settings-page.tsx";

/** A control's height: the frames' 36px on the desk, a 44px touch target on a phone. */
const CONTROL = "h-9 max-lg:h-11 max-lg:text-base";

/** Which dialog is open. A counter keys each opening, so a dialog starts from what is saved. */
type Open =
  | { readonly kind: "policy"; readonly policy: AccessPolicyDto | null; readonly n: number }
  | { readonly kind: "remove"; readonly policy: AccessPolicyDto; readonly n: number }
  | { readonly kind: "revoke"; readonly n: number }
  | null;

/**
 * Settings → the organization → Access policies: the organization's policy templates (Standard,
 * built in, and any an owner made), what Restricted egress allows without listing it, the private
 * destinations this server lets a policy open, and the durable revocations. Everyone reads it;
 * owners create, edit and remove policies and revoke access. A project takes a copy of one on its
 * Workspace page; nothing here changes a project or a worktree by itself, except a revocation.
 */
export function AccessPoliciesPage() {
  const trpc = useTRPC();
  const phone = usePhone();
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  const view = useSuspenseQuery(trpc.accessPolicies.list.queryOptions()).data;
  const roster = useSuspenseQuery(trpc.organization.members.queryOptions()).data;
  const organization = viewer.organization.name;
  const owner = viewer.role === "owner";
  const [open, setOpen] = useState<Open>(null);
  const [opened, setOpened] = useState(0);
  const openDialog = (next: NonNullable<Open>) => {
    setOpened(opened + 1);
    setOpen({ ...next, n: opened + 1 });
  };
  const close = () => setOpen(null);
  const people = new Map(roster.map((member) => [member.userId, member.name]));
  const policyNames = new Map(view.policies.map((policy) => [policy.id, policy.name]));
  const size = phone ? "touch" : "default";
  return (
    <SettingsPage
      page="o-access"
      intro={policiesIntro(
        organization,
        owner,
        ownersOf(roster, viewer.userId).map((person) => person.name),
      )}
    >
      <SettingSection
        title="Policies"
        count={view.policies.length}
        description="A project's owner or creator picks one on the project's Workspace page, and the project keeps a copy of its rules."
        action={
          owner ? (
            <Button
              variant="outline"
              className={CONTROL}
              onClick={() => openDialog({ kind: "policy", policy: null, n: 0 })}
            >
              New policy…
            </Button>
          ) : undefined
        }
      >
        {view.policies.map((policy) => (
          <PolicyBlock
            key={policy.id}
            policy={policy}
            owner={owner}
            onEdit={() => openDialog({ kind: "policy", policy, n: 0 })}
            onRemove={() => openDialog({ kind: "remove", policy, n: 0 })}
          />
        ))}
        {owner ? (
          <div className="px-4 pt-3 lg:hidden">
            <Button
              variant="outline"
              size="touch"
              className="w-full"
              onClick={() => openDialog({ kind: "policy", policy: null, n: 0 })}
            >
              New policy…
            </Button>
          </div>
        ) : null}
      </SettingSection>
      <AutomaticHostsSection />
      <SettingSection
        title="Private destinations"
        description={ceilingLine(view.privateEgressCeiling)}
      >
        {view.privateEgressCeiling.length === 0 ? null : (
          <ul
            aria-label="Private destinations this server allows"
            className="grid gap-1 border-b border-border py-3 font-mono text-meta max-lg:px-4"
          >
            {view.privateEgressCeiling.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        )}
      </SettingSection>
      <SettingSection
        title="Revocations"
        count={view.revocations.length}
        description="A revocation takes access back from running workspaces at once and stays in force. It wins over every worktree's pinned policy."
        action={
          owner ? (
            <Button
              variant="outline"
              className={CONTROL}
              onClick={() => openDialog({ kind: "revoke", n: 0 })}
            >
              Revoke access…
            </Button>
          ) : undefined
        }
      >
        {view.revocations.length === 0 ? (
          <p className="border-b border-border py-3.5 text-row text-muted-foreground max-lg:px-4">
            Nothing revoked.
          </p>
        ) : (
          <ul aria-label="Revocations">
            {view.revocations.map((revocation) => (
              <li
                key={revocation.id}
                className="grid gap-0.5 border-b border-border py-3 max-lg:px-4"
              >
                <span className="font-medium">
                  {revocation.kind === "all" ? (
                    revocationWhat(revocation)
                  ) : (
                    <>
                      {revocation.kind === "host" ? "Host " : "Project secret "}
                      <span className="font-mono text-meta">{revocation.target}</span>
                    </>
                  )}
                </span>
                <span className="text-row text-muted-foreground">
                  {revocationScope(revocation.policyId, policyNames)} ·{" "}
                  {revokedByLine(revocation, people)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {owner ? (
          <div className="px-4 pt-3 lg:hidden">
            <Button
              variant="outline"
              size="touch"
              className="w-full"
              onClick={() => openDialog({ kind: "revoke", n: 0 })}
            >
              Revoke access…
            </Button>
          </div>
        ) : null}
      </SettingSection>
      {open?.kind === "policy" ? (
        <PolicyDialog key={open.n} view={view} policy={open.policy} size={size} onClose={close} />
      ) : null}
      {open?.kind === "remove" ? (
        <RemovePolicyDialog key={open.n} policy={open.policy} size={size} onClose={close} />
      ) : null}
      {open?.kind === "revoke" ? (
        <RevokeDialog key={open.n} view={view} size={size} onClose={close} />
      ) : null}
    </SettingsPage>
  );
}

/** One policy: its name and marks, its revision, its rules, and an owner's Edit… and Remove…. */
function PolicyBlock({
  policy,
  owner,
  onEdit,
  onRemove,
}: {
  readonly policy: AccessPolicyDto;
  readonly owner: boolean;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  const phone = usePhone();
  const marks = policyMarks(policy);
  return (
    <section aria-label={policy.name} className="border-b border-border py-4 max-lg:px-4">
      <div className="flex items-start gap-4 max-lg:flex-col max-lg:gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">
            {policy.name}
            {marks.length === 0 ? null : (
              <span className="ml-2 text-row font-normal text-muted-foreground">
                {marks.join(" · ")}
              </span>
            )}
          </h3>
          <p className="mt-0.5 text-row text-muted-foreground">{revisionLine(policy)}</p>
        </div>
        {owner && !policy.builtIn ? (
          <div className="flex flex-none gap-1 max-lg:w-full max-lg:gap-2 max-lg:*:flex-1">
            <Button
              variant={phone ? "outline" : "ghost"}
              size={phone ? "touch" : "sm"}
              aria-label={`Edit ${policy.name}`}
              onClick={onEdit}
            >
              Edit…
            </Button>
            <Button
              variant={phone ? "outline" : "ghost"}
              size={phone ? "touch" : "sm"}
              aria-label={`Remove ${policy.name}`}
              onClick={onRemove}
            >
              Remove…
            </Button>
          </div>
        ) : null}
      </div>
      <div className="mt-3">
        <RuleList rules={policy.rules} />
      </div>
      {policy.elevated ? (
        <p className="mt-3 text-row text-pretty text-muted-foreground">{ELEVATED_LINE}</p>
      ) : null}
    </section>
  );
}

/**
 * What Restricted egress allows without the policy listing it (§7.1): each agent's model
 * provider, Doppler, and the MCP servers of the person starting the session, the viewer's own
 * named when the page could read them.
 */
function AutomaticHostsSection() {
  const trpc = useTRPC();
  const mcp = useQuery(trpc.mcpServers.list.queryOptions());
  const mcpHosts = mcp.isPending || mcp.isError ? null : mcpServerHosts(mcp.data.servers);
  return (
    <SettingSection
      title="Allowed under Restricted egress"
      description="A Restricted worktree also reaches what its session needs to run, without the policy listing it. A revocation of everything takes these away too."
    >
      {automaticHosts(mcpHosts).map((group) => (
        <SettingRow
          key={group.label}
          label={group.label}
          description={group.when}
          note={
            group.hosts.length === 0 ? null : (
              <span className="font-mono text-meta wrap-anywhere text-foreground-2">
                {group.hosts.join(", ")}
              </span>
            )
          }
        />
      ))}
    </SettingSection>
  );
}

/** A switch with its name and what it does, in the editor. */
function SwitchField({
  label,
  description,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </Field>
  );
}

/** A refusal's or a check's problems, listed under the form. */
function Problems({
  title,
  problems,
  size,
}: {
  readonly title: string;
  readonly problems: ReadonlyArray<string>;
  readonly size: "touch" | "default";
}) {
  return (
    <InlineAlert tone="error" size={size} title={title}>
      <ul className="mt-1 grid list-disc gap-0.5 pl-4">
        {problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    </InlineAlert>
  );
}

/**
 * New policy… and Edit <name>: the policy's name and rules. Checked with the server's own rules
 * before it is sent; a refusal keeps the draft and names what to fix. An edit sends the revision
 * it read, so a change someone made meanwhile is never overwritten. Projects keep the copy they
 * took: an edit reaches none of them by itself.
 */
function PolicyDialog({
  view,
  policy,
  size,
  onClose,
}: {
  readonly view: AccessPoliciesDto;
  readonly policy: AccessPolicyDto | null;
  readonly size: "touch" | "default";
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const ids = useId();
  const [draft, setDraft] = useState<PolicyDraft>(() => draftOf(policy));
  const [problems, setProblems] = useState<ReadonlyArray<string>>([]);
  const [refusal, setRefusal] = useState<string | null>(null);
  const create = useMutation(trpc.accessPolicies.create.mutationOptions());
  const update = useMutation(trpc.accessPolicies.update.mutationOptions());
  const pending = create.isPending || update.isPending;
  const failure = create.error ?? update.error;
  const previous = policy?.rules.allowHosts ?? [];
  const ceiling = view.privateEgressCeiling;
  const set = <K extends keyof PolicyDraft>(key: K, value: PolicyDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setProblems([]);
    setRefusal(null);
  };
  const save = async () => {
    const found = draftProblems(draft, previous, ceiling);
    setProblems(found);
    setRefusal(null);
    if (found.length > 0) return;
    const rules = rulesOf(draft, previous);
    const name = draft.name.trim();
    const outcome =
      policy === null
        ? await create.mutateAsync({ name, rules })
        : await update.mutateAsync({
            id: policy.id,
            request: { name, rules, expectedRevision: policy.revision },
          });
    if (outcome.ok) {
      toast.add({ description: policy === null ? `Added ${name}.` : `Saved ${name}.` });
      onClose();
      await queryClient.invalidateQueries(trpc.accessPolicies.pathFilter());
      return;
    }
    if (outcome.kind === "rejected") {
      setRefusal(outcome.message);
      setProblems(outcome.problems);
      return;
    }
    setRefusal(outcome.message);
    // Someone else changed it: the page reads it again, and the next opening starts from that.
    if (outcome.kind === "stale")
      await queryClient.invalidateQueries(trpc.accessPolicies.list.queryFilter());
  };
  const elevated = draftElevated(draft);
  return (
    <Overlay
      open
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
      title={policy === null ? "New policy" : `Edit ${policy.name}`}
      description={
        policy === null
          ? "Start from Standard's rules and change what this policy should allow. No project uses it until someone assigns it."
          : "Saving makes a new revision. Projects keep the copy they took until someone updates it from this policy."
      }
      size="lg"
      footer={
        <>
          <Button variant="outline" size={size} disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            size={size}
            disabled={pending || draft.name.trim() === ""}
            onClick={() => void save().catch(() => undefined)}
          >
            {pending ? "Saving…" : policy === null ? "Add policy" : "Save policy"}
          </Button>
        </>
      }
    >
      <form
        className="grid gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save().catch(() => undefined);
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${ids}-name`}>Name</FieldLabel>
          <Input
            id={`${ids}-name`}
            value={draft.name}
            autoComplete="off"
            placeholder="Production deploys"
            className={cn(size === "touch" && "h-11")}
            onChange={(event) => set("name", event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel id={`${ids}-mode`}>Network</FieldLabel>
          <Segmented
            aria-label="Network"
            value={draft.mode}
            size={size}
            options={[
              { value: "standard", label: MODE_NAMES.standard },
              { value: "restricted", label: MODE_NAMES.restricted },
            ]}
            onValueChange={(mode) => set("mode", mode)}
          />
          <FieldDescription>{MODE_LINES[draft.mode]}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${ids}-hosts`}>Allowed hosts</FieldLabel>
          <Textarea
            id={`${ids}-hosts`}
            value={draft.hosts}
            rows={4}
            spellCheck={false}
            placeholder={"api.example.com\nregistry.example.com:443,5000"}
            className="font-mono"
            onChange={(event) => set("hosts", event.target.value)}
          />
          <FieldDescription>
            One host per line, such as api.example.com, or api.example.com:443,8443 for other ports.
            No wildcards.
            {draft.mode === "restricted"
              ? " Each session also reaches its agent's model provider, Doppler and its starter's MCP servers without these."
              : " Under Standard every public host is reachable already; a host listed here gets its ports allowed."}
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${ids}-private`}>Private destinations</FieldLabel>
          <Textarea
            id={`${ids}-private`}
            value={draft.privateEgress}
            rows={2}
            spellCheck={false}
            disabled={ceiling.length === 0 && draft.privateEgress === ""}
            placeholder="10.0.4.0/24"
            className="font-mono"
            onChange={(event) => set("privateEgress", event.target.value)}
          />
          <FieldDescription>{ceilingLine(ceiling)}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel id={`${ids}-git`}>Git</FieldLabel>
          <Segmented
            aria-label="Git"
            value={draft.gitTransport}
            size={size}
            options={GIT_TRANSPORT_ORDER.map((value: GitTransport) => ({
              value,
              label: GIT_TRANSPORT_NAMES[value],
            }))}
            onValueChange={(value) => set("gitTransport", value)}
          />
          <FieldDescription>{GIT_TRANSPORT_LINES[draft.gitTransport]}</FieldDescription>
        </Field>
        <SwitchField
          label="Executor tools"
          description="Agents may call the organization's Executor tools."
          checked={draft.allowExecutorTools}
          onChange={(value) => set("allowExecutorTools", value)}
        />
        <SwitchField
          label="Brokered secrets"
          description="A project's Brokered secrets reach its workspaces through their egress proxy. The workspace holds only a placeholder."
          checked={draft.allowBrokeredSecrets}
          onChange={(value) => set("allowBrokeredSecrets", value)}
        />
        <SwitchField
          label="VM of its own"
          description="Every workspace must run in a virtual machine of its own. A launch on Docker, whose containers share the server's kernel, is refused."
          checked={draft.requireVmIsolation}
          onChange={(value) => set("requireVmIsolation", value)}
        />
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
      {elevated ? (
        <InlineAlert tone="info" size={size} title="Elevated.">
          It lets Brokered secrets reach workspaces or opens private destinations. Only an owner can
          assign it to a project, and the Audit log records each assignment.
        </InlineAlert>
      ) : null}
      {problems.length > 0 ? (
        <Problems title={refusal ?? "It wasn't saved."} problems={problems} size={size} />
      ) : refusal !== null ? (
        <InlineAlert tone="error" size={size} title="It wasn't saved.">
          {refusal}
        </InlineAlert>
      ) : failure !== null ? (
        <InlineAlert tone="error" size={size} title="It wasn't saved.">
          {failureWords(failure, "Mend didn't answer. Try again.")}
        </InlineAlert>
      ) : null}
    </Overlay>
  );
}

/** Remove <name>?: projects keep their copies, which say the template was removed. */
function RemovePolicyDialog({
  policy,
  size,
  onClose,
}: {
  readonly policy: AccessPolicyDto;
  readonly size: "touch" | "default";
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const remove = useMutation(trpc.accessPolicies.remove.mutationOptions());
  const [refusal, setRefusal] = useState<string | null>(null);
  const run = async () => {
    setRefusal(null);
    const outcome = await remove.mutateAsync({ id: policy.id });
    if (!outcome.ok) {
      setRefusal(outcome.message);
      return;
    }
    toast.add({ description: `Removed ${policy.name}.` });
    onClose();
    await queryClient.invalidateQueries(trpc.accessPolicies.pathFilter());
  };
  return (
    <Overlay
      open
      onOpenChange={(next) => {
        if (!next && !remove.isPending) onClose();
      }}
      title={`Remove ${policy.name}?`}
      description={`Projects that took a copy of ${policy.name} keep it, and their worktrees keep the rules they started with. Nobody can assign ${policy.name} again. Revocations that name it stay in force.`}
      size="sm"
      footer={
        <>
          <Button variant="outline" size={size} disabled={remove.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size={size}
            disabled={remove.isPending}
            onClick={() => void run().catch(() => undefined)}
          >
            {remove.isPending ? "Removing…" : "Remove policy"}
          </Button>
        </>
      }
    >
      {refusal !== null ? (
        <InlineAlert tone="error" size={size} title="It wasn't removed.">
          {refusal}
        </InlineAlert>
      ) : remove.error !== null ? (
        <InlineAlert tone="error" size={size} title="It wasn't removed.">
          {failureWords(remove.error, "Mend didn't answer. Try again.")}
        </InlineAlert>
      ) : null}
    </Overlay>
  );
}

const EVERY_WORKTREE = "";

/**
 * Revoke access…: which worktrees it reaches (every one, or those on one policy), what it takes
 * (a host, a project secret, or everything) and, before anything is stored, that it lasts. After
 * it, what each running workspace answered.
 */
function RevokeDialog({
  view,
  size,
  onClose,
}: {
  readonly view: AccessPoliciesDto;
  readonly size: "touch" | "default";
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const ids = useId();
  const [policyId, setPolicyId] = useState(EVERY_WORKTREE);
  const [kind, setKind] = useState<AccessRevocationKind>("host");
  const [host, setHost] = useState("");
  const [projectId, setProjectId] = useState("");
  const [secretId, setSecretId] = useState("");
  const [problems, setProblems] = useState<ReadonlyArray<string>>([]);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState<AccessRevokedDto | null>(null);
  const revoke = useMutation(trpc.accessPolicies.revoke.mutationOptions());
  const target = kind === "host" ? host.trim() : kind === "secret" ? secretId : null;
  const ready = kind === "all" || (target !== null && target !== "");
  const run = async () => {
    setProblems([]);
    setRefusal(null);
    const outcome = await revoke.mutateAsync({
      policyId:
        policyId === EVERY_WORKTREE
          ? null
          : (view.policies.find((policy) => policy.id === policyId)?.id ?? null),
      kind,
      target: kind === "all" ? null : target,
    });
    if (!outcome.ok) {
      setRefusal(outcome.message);
      if (outcome.kind === "rejected") setProblems(outcome.problems);
      return;
    }
    setDone(outcome.result);
    await queryClient.invalidateQueries(trpc.accessPolicies.pathFilter());
  };
  if (done !== null)
    return (
      <Overlay
        open
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
        title="Revoked"
        description={`${revocationWhat(done.revocation)}. ${enforcementLead(done.workspaces.length)}`}
        size="md"
        footer={
          <Button size={size} onClick={onClose}>
            Done
          </Button>
        }
      >
        {done.workspaces.length === 0 ? null : <EnforcementList workspaces={done.workspaces} />}
      </Overlay>
    );
  return (
    <Overlay
      open
      onOpenChange={(next) => {
        if (!next && !revoke.isPending) onClose();
      }}
      title="Revoke access"
      description="Take back a host, a project secret or everything a policy granted, from running workspaces and every later launch."
      size="md"
      footer={
        <>
          <Button variant="outline" size={size} disabled={revoke.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size={size}
            disabled={revoke.isPending || !ready}
            onClick={() => void run().catch(() => undefined)}
          >
            {revoke.isPending ? "Revoking…" : "Revoke access"}
          </Button>
        </>
      }
    >
      <div className="grid gap-5">
        <Field>
          <FieldLabel htmlFor={`${ids}-scope`}>Worktrees</FieldLabel>
          <NativeSelect
            id={`${ids}-scope`}
            size="field"
            value={policyId}
            onChange={(event) => setPolicyId(event.target.value)}
          >
            <NativeSelectOption value={EVERY_WORKTREE}>Every worktree</NativeSelectOption>
            {view.policies.map((policy) => (
              <NativeSelectOption key={policy.id} value={policy.id}>
                Worktrees on {policy.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel id={`${ids}-kind`}>What to revoke</FieldLabel>
          <Segmented
            aria-label="What to revoke"
            value={kind}
            size={size}
            options={[
              { value: "host", label: "A host" },
              { value: "secret", label: "A secret" },
              { value: "all", label: "Everything" },
            ]}
            onValueChange={(value) => {
              setKind(value);
              setProblems([]);
              setRefusal(null);
            }}
          />
          <FieldDescription>
            {kind === "host"
              ? "The host leaves every allowed list and every Brokered secret's bind hosts."
              : kind === "secret"
                ? "The project secret reaches no workspace, Brokered or Direct."
                : "Every listed host, private destination and Brokered secret, and the hosts sessions reach under Restricted egress without listing them."}
          </FieldDescription>
        </Field>
        {kind === "host" ? (
          <Field>
            <FieldLabel htmlFor={`${ids}-host`}>Host</FieldLabel>
            <Input
              id={`${ids}-host`}
              value={host}
              autoComplete="off"
              spellCheck={false}
              placeholder="api.example.com"
              className={cn("font-mono", size === "touch" && "h-11")}
              onChange={(event) => {
                setHost(event.target.value);
                setProblems([]);
              }}
            />
          </Field>
        ) : kind === "secret" ? (
          <SecretPicker
            projectId={projectId}
            secretId={secretId}
            onProject={(next) => {
              setProjectId(next);
              setSecretId("");
            }}
            onSecret={setSecretId}
          />
        ) : null}
        <InlineAlert tone="warning" size={size} title="There's no undo.">
          {REVOKE_WARNING}
        </InlineAlert>
        {problems.length > 0 ? (
          <Problems title={refusal ?? "Nothing was revoked."} problems={problems} size={size} />
        ) : refusal !== null ? (
          <InlineAlert tone="error" size={size} title="Nothing was revoked.">
            {refusal}
          </InlineAlert>
        ) : revoke.error !== null ? (
          <InlineAlert tone="error" size={size} title="Nothing was revoked.">
            {failureWords(revoke.error, "Mend didn't answer. Try again.")}
          </InlineAlert>
        ) : null}
      </div>
    </Overlay>
  );
}

/** A project, then one of its secrets, for a secret's revocation. */
function SecretPicker({
  projectId,
  secretId,
  onProject,
  onSecret,
}: {
  readonly projectId: string;
  readonly secretId: string;
  readonly onProject: (projectId: string) => void;
  readonly onSecret: (secretId: string) => void;
}) {
  const trpc = useTRPC();
  const ids = useId();
  const projects = useQuery(trpc.projects.list.queryOptions());
  const secrets = useQuery({
    ...trpc.environment.secrets.queryOptions({ projectId }),
    enabled: projectId !== "",
  });
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${ids}-project`}>Project</FieldLabel>
        <QueryView query={projects}>
          {(list) => (
            <NativeSelect
              id={`${ids}-project`}
              size="field"
              value={projectId}
              onChange={(event) => onProject(event.target.value)}
            >
              <NativeSelectOption value="">Choose a project</NativeSelectOption>
              {list.map((project) => (
                <NativeSelectOption key={project.id} value={project.id}>
                  {project.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
        </QueryView>
      </Field>
      {projectId === "" ? null : (
        <Field>
          <FieldLabel htmlFor={`${ids}-secret`}>Secret</FieldLabel>
          <QueryView query={secrets}>
            {(snapshot) =>
              snapshot.secrets.length === 0 ? (
                <p className="text-row text-muted-foreground">This project has no secrets.</p>
              ) : (
                <NativeSelect
                  id={`${ids}-secret`}
                  size="field"
                  value={secretId}
                  onChange={(event) => onSecret(event.target.value)}
                >
                  <NativeSelectOption value="">Choose a secret</NativeSelectOption>
                  {snapshot.secrets.map((secret) => (
                    <NativeSelectOption key={secret.id} value={secret.id}>
                      {secret.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )
            }
          </QueryView>
        </Field>
      )}
    </>
  );
}
