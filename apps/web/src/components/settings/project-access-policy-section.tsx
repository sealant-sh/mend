import { InlineAlert } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@mend/ui/components/ui/radio-group";
import { toast } from "@mend/ui/components/ui/toast";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";

import {
  ASSIGN_LINE,
  ELEVATED_LINE,
  MODE_NAMES,
  policyMarks,
  projectPolicyLine,
} from "#/lib/access-policies";
import type { AccessPolicyDto, ProjectAccessPolicyDto } from "#/lib/api";
import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";

import { RuleList } from "../access-policy-parts.tsx";
import { Overlay } from "../projects/overlay.tsx";
import { QueryView } from "../query-view.tsx";
import { SettingRow, SettingSection } from "./setting-row.tsx";
import { settingsLink } from "./settings-links.tsx";

/**
 * The project's Access policy, on Project → Workspace: its own copy of one of the organization's
 * policies, what that copy allows, and whether the policy it came from moved on or was removed.
 * Whoever manages the project picks another policy or updates from the template; an elevated one
 * only an Organization Owner assigns, which the dialog says before anyone presses a button.
 * Assigning copies the rules: worktrees that exist keep theirs until each applies the update.
 */
export function ProjectAccessPolicySection({
  projectId,
  projectName,
  manage,
}: {
  readonly projectId: string;
  readonly projectName: string;
  readonly manage: boolean;
}) {
  const trpc = useTRPC();
  const phone = usePhone();
  const view = useQuery(trpc.accessPolicies.project.queryOptions({ projectId }));
  const [choosing, setChoosing] = useState(false);
  const [opened, setOpened] = useState(0);
  return (
    <SettingSection
      title="Access policy"
      description={`What ${projectName}'s workspaces may reach, and what Mend may do for them. New worktrees start with these rules.`}
    >
      <QueryView query={view}>
        {(current) => (
          <>
            <SettingRow
              layout="stack"
              label={current.policy.source.name}
              description={projectPolicyLine(current)}
              note={
                current.elevated ? (
                  <span className="text-muted-foreground">{ELEVATED_LINE}</span>
                ) : null
              }
              control={
                manage ? (
                  <>
                    {current.latestRevision === null ? null : (
                      <UpdateFromTemplate projectId={projectId} current={current} />
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size={phone ? "touch" : "default"}
                      onClick={() => {
                        setOpened(opened + 1);
                        setChoosing(true);
                      }}
                    >
                      Change policy…
                    </Button>
                  </>
                ) : null
              }
            />
            <div className="border-b border-border py-3.5 max-lg:px-4">
              <RuleList rules={current.policy.rules} />
            </div>
            {choosing ? (
              <ChoosePolicyDialog
                key={opened}
                projectId={projectId}
                projectName={projectName}
                current={current}
                onClose={() => setChoosing(false)}
              />
            ) : null}
          </>
        )}
      </QueryView>
    </SettingSection>
  );
}

/** The template's owner gate, read before an action: whether this person may assign it. */
const useMayAssign = (): ((elevated: boolean) => boolean) => {
  const trpc = useTRPC();
  const owner = useSuspenseQuery(signedInOptions(trpc)).data.role === "owner";
  return (elevated) => owner || !elevated;
};

/**
 * Update from template: the template has a newer revision than the project's copy. Copies it, as
 * assigning it again would; an elevated revision only an owner can take.
 */
function UpdateFromTemplate({
  projectId,
  current,
}: {
  readonly projectId: string;
  readonly current: ProjectAccessPolicyDto;
}) {
  const trpc = useTRPC();
  const phone = usePhone();
  const list = useQuery(trpc.accessPolicies.list.queryOptions());
  const mayAssign = useMayAssign();
  const assign = useAssign(projectId);
  const template =
    list.isPending || list.isError
      ? null
      : (list.data.policies.find((policy) => policy.id === current.policy.source.policyId) ?? null);
  const allowed = template !== null && mayAssign(template.elevated);
  return (
    <span className="grid gap-1 max-lg:w-full">
      <Button
        type="button"
        size={phone ? "touch" : "default"}
        disabled={!allowed || assign.pending}
        title={
          template !== null && !allowed
            ? "The newer revision is elevated: only an Organization Owner can take it."
            : undefined
        }
        onClick={() => {
          if (template !== null) assign.run(template);
        }}
      >
        {assign.pending ? "Updating…" : "Update from template"}
      </Button>
      {assign.refusal === null ? null : (
        <span role="alert" className="text-row text-destructive">
          {assign.refusal}
        </span>
      )}
    </span>
  );
}

/** Assigning a template to the project, with the server's refusal in words. */
const useAssign = (projectId: string) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const mutation = useMutation(trpc.accessPolicies.assign.mutationOptions());
  const [refusal, setRefusal] = useState<string | null>(null);
  const run = (template: AccessPolicyDto, onDone?: () => void) => {
    setRefusal(null);
    mutation.mutate(
      { projectId, request: { policyId: template.id } },
      {
        onSuccess: (outcome) => {
          if (!outcome.ok) {
            setRefusal(outcome.message);
            return;
          }
          toast.add({
            description: `${outcome.result.policy.source.name} is copied into this project. Existing worktrees keep their rules until each applies the update.`,
          });
          onDone?.();
          void queryClient.invalidateQueries(trpc.accessPolicies.pathFilter());
        },
        onError: (error) => setRefusal(failureWords(error, "Mend didn't answer. Try again.")),
      },
    );
  };
  return { run, pending: mutation.isPending, refusal };
};

/**
 * Change policy…: the organization's policies, one radio each, with what marks them. An elevated
 * policy says it takes an Organization Owner, and a member can't pick it; the dialog says what
 * assigning does to worktrees before anyone presses Assign.
 */
function ChoosePolicyDialog({
  projectId,
  projectName,
  current,
  onClose,
}: {
  readonly projectId: string;
  readonly projectName: string;
  readonly current: ProjectAccessPolicyDto;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const phone = usePhone();
  const ids = useId();
  const size = phone ? "touch" : "default";
  const list = useQuery(trpc.accessPolicies.list.queryOptions());
  const mayAssign = useMayAssign();
  const assign = useAssign(projectId);
  const [picked, setPicked] = useState<string>(current.policy.source.policyId);
  const chosen =
    list.isPending || list.isError
      ? null
      : (list.data.policies.find((policy) => policy.id === picked) ?? null);
  const unchanged =
    chosen !== null &&
    chosen.id === current.policy.source.policyId &&
    chosen.revision === current.policy.source.revision;
  return (
    <Overlay
      open
      onOpenChange={(next) => {
        if (!next && !assign.pending) onClose();
      }}
      title={`Access policy for ${projectName}`}
      description={ASSIGN_LINE}
      size="md"
      footer={
        <>
          <Button variant="outline" size={size} disabled={assign.pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            size={size}
            disabled={assign.pending || chosen === null || unchanged || !mayAssign(chosen.elevated)}
            onClick={() => {
              if (chosen !== null) assign.run(chosen, onClose);
            }}
          >
            {assign.pending ? "Assigning…" : "Assign policy"}
          </Button>
        </>
      }
    >
      <QueryView query={list}>
        {(policies) => (
          <RadioGroup
            aria-label={`Access policy for ${projectName}`}
            value={picked}
            onValueChange={(value) => {
              if (typeof value === "string") setPicked(value);
            }}
            className="gap-0"
          >
            {policies.policies.map((policy) => {
              const allowed = mayAssign(policy.elevated);
              const marks = policyMarks(policy);
              return (
                <div
                  key={policy.id}
                  className="flex items-start gap-3 border-b border-border py-3 last:border-b-0"
                >
                  <RadioGroupItem
                    id={`${ids}-${policy.id}`}
                    value={policy.id}
                    disabled={!allowed}
                    aria-describedby={`${ids}-${policy.id}-about`}
                    className="mt-0.5 size-4.5"
                  />
                  <div className="grid min-w-0 gap-0.5">
                    <label htmlFor={`${ids}-${policy.id}`} className="font-semibold">
                      {policy.name}
                      {marks.length === 0 ? null : (
                        <span className="ml-2 text-row font-normal text-muted-foreground">
                          {marks.join(" · ")}
                        </span>
                      )}
                    </label>
                    <p
                      id={`${ids}-${policy.id}-about`}
                      className="text-row text-pretty text-muted-foreground"
                    >
                      {MODE_NAMES[policy.rules.mode]}
                      {policy.rules.allowHosts.length === 0
                        ? ""
                        : `, ${policy.rules.allowHosts.length} allowed ${policy.rules.allowHosts.length === 1 ? "host" : "hosts"}`}
                      {policy.rules.allowBrokeredSecrets ? ", Brokered secrets allowed" : ""}
                      {policy.rules.requireVmIsolation ? ", needs a VM of its own" : ""}.
                      {allowed
                        ? ""
                        : " Elevated: only an Organization Owner can assign it. Ask one to assign it."}
                    </p>
                  </div>
                </div>
              );
            })}
          </RadioGroup>
        )}
      </QueryView>
      <p className="text-row text-muted-foreground">
        Policies are made on{" "}
        <Link
          {...settingsLink("o-access")}
          className="text-primary underline-offset-2 hover:underline"
        >
          Access policies
        </Link>
        .
      </p>
      {assign.refusal === null ? null : (
        <InlineAlert tone="error" size={size} title="It wasn't assigned.">
          {assign.refusal}
        </InlineAlert>
      )}
    </Overlay>
  );
}
