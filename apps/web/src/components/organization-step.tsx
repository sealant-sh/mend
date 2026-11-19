import type { RuntimeSwitchMoves } from "@mend/domain";
import { InlineAlert } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@mend/ui/components/ui/field";
import { Input } from "@mend/ui/components/ui/input";
import { Spinner } from "@mend/ui/components/ui/spinner";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";

import { savedAgentLine } from "#/lib/agent-login";
import { accountNameOptions } from "#/lib/auth-client";
import { savedModeLine } from "#/lib/git-access";
import { nameDraft, renameRefusal } from "#/lib/organization-general";
import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import {
  RUNTIME_LABELS,
  runtimeChoices,
  type SessionRuntime,
  type SwitchAsk,
  switchStep,
} from "#/lib/runtime-switch";
import { hasAgentLogin, SETUP_PATHS } from "#/lib/setup";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";

import { RuntimeList, SwitchDialog } from "./settings/runtime-page.tsx";
import {
  SectionTitle,
  SetupActions,
  SetupFrame,
  skippedSteps,
  useSetupProgress,
} from "./setup-frame.tsx";

/** A failed save, as the Inline alert under the form says it. */
interface SaveFailure {
  readonly title: string;
  readonly detail: string;
}

/**
 * Step 5 of the first account's six: its organization, after Agent login and before First project. The name the server gave it, to keep or
 * change (the same rule and refusals as Settings → General's rename), and where its sessions run
 * when the server offers more than one runtime (the Runtime page's choices and words). Nothing is
 * saved until Continue: it renames, then switches the runtime the way the Runtime page does,
 * asking first when the server says the switch would change something. A failed save stays here.
 */
export function OrganizationStep() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const phone = usePhone();
  const ids = useId();
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  const settings = useSuspenseQuery(trpc.organization.settings.queryOptions()).data;
  const accountName = useSuspenseQuery(accountNameOptions()).data;
  const progress = useSetupProgress();
  const access = useSuspenseQuery(trpc.git.access.queryOptions()).data;
  // Read beside the page: until it answers, the steps name no agent.
  const identity = useQuery(trpc.platform.sealantIdentity.queryOptions());
  const logins = identity.isPending || identity.isError ? null : identity.data;
  const skippedAgent = logins !== null && !hasAgentLogin(logins);
  const agentLine = logins === null || skippedAgent ? "" : savedAgentLine(logins.accounts);
  const savedName = viewer.organization.name;
  const choices = runtimeChoices(settings.sessionRuntime);
  const offered = choices.kind === "offered" && choices.runtimes.length > 1 ? choices : null;

  // Null while untouched: the field and the radio follow what the server holds.
  const [typedName, setTypedName] = useState<string | null>(null);
  const [pickedRuntime, setPickedRuntime] = useState<SessionRuntime | null>(null);
  const [nameProblem, setNameProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [checking, setChecking] = useState(false);
  const [asked, setAsked] = useState<SwitchAsk | null>(null);
  const name = typedName ?? savedName;
  const runtime = pickedRuntime ?? offered?.selected ?? null;

  const rename = useMutation(trpc.organization.rename.mutationOptions());
  const switchRuntime = useMutation(trpc.organization.setSessionRuntime.mutationOptions());
  const pending = rename.isPending || switchRuntime.isPending || checking;
  const onward = () => void navigate({ to: SETUP_PATHS.firstProject });

  /** Saves the runtime the way the Runtime page does; false, with the alert shown, when refused. */
  const saveRuntime = async (
    chosen: SessionRuntime,
    moves: RuntimeSwitchMoves | null,
  ): Promise<boolean> => {
    try {
      const saved = await switchRuntime.mutateAsync(
        moves === null ? { sessionRuntime: chosen } : { sessionRuntime: chosen, moves },
      );
      queryClient.setQueryData(trpc.organization.settings.queryKey(), saved);
      return true;
    } catch (cause) {
      setFailure({
        title: `Mend didn't switch to ${RUNTIME_LABELS[chosen]}.`,
        detail: failureWords(cause, "Mend couldn't save it. Try again."),
      });
      return false;
    }
  };

  const switchFromDialog = async (chosen: SessionRuntime, moves: RuntimeSwitchMoves | null) => {
    const saved = await saveRuntime(chosen, moves);
    setAsked(null);
    if (saved) onward();
  };

  const submit = async () => {
    if (pending) return;
    setFailure(null);
    const draft = nameDraft(savedName, name);
    setNameProblem(draft.problem);
    if (draft.problem !== null) return;
    const organization = draft.changed ? name.trim() : savedName;
    if (draft.changed) {
      try {
        await rename.mutateAsync({ name: organization });
      } catch (cause) {
        setFailure({
          title: "Mend didn't save the name.",
          detail: renameRefusal(cause, savedName),
        });
        return;
      }
      setTypedName(null);
      await queryClient.invalidateQueries(trpc.organization.pathFilter());
    }
    if (offered !== null && runtime !== null && runtime !== offered.selected) {
      setChecking(true);
      try {
        const view = await queryClient.fetchQuery({
          ...trpc.organization.runtimeSwitch.queryOptions({ sessionRuntime: runtime }),
          staleTime: 0,
        });
        const step = switchStep(view, runtime, organization);
        if (step.kind === "ask") {
          setAsked(step.ask);
          return;
        }
      } catch (cause) {
        setFailure({
          title: `Mend didn't switch to ${RUNTIME_LABELS[runtime]}.`,
          detail: `Mend couldn't read what ${RUNTIME_LABELS[runtime]} would change. ${failureWords(cause, "Try again.")}`,
        });
        return;
      } finally {
        setChecking(false);
      }
      if (!(await saveRuntime(runtime, null))) return;
    }
    onward();
  };

  return (
    <SetupFrame
      title="Your organization"
      step="organization"
      steps={progress.steps}
      saved={{
        account: accountName,
        ...progress.saved,
        git: savedModeLine(access.mode),
        agent: agentLine,
      }}
      skipped={skippedSteps(progress.skippedCli, skippedAgent)}
      back={{ to: "/welcome/agent-login", label: "Back to Agent login" }}
    >
      <p className="text-prose text-pretty text-foreground max-lg:text-sm">
        An organization is the people who share this Mend server's projects. You are its owner, and
        you can invite people once setup is done.
      </p>
      <form
        aria-label="Your organization"
        noValidate
        className="mt-6 flex min-w-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field data-invalid={nameProblem === null ? undefined : true}>
          <FieldLabel htmlFor={`${ids}-name`}>Name</FieldLabel>
          <Input
            id={`${ids}-name`}
            value={name}
            autoComplete="organization"
            spellCheck={false}
            readOnly={pending}
            aria-invalid={nameProblem === null ? undefined : true}
            className={phone ? "h-11" : "h-10"}
            onChange={(event) => {
              setTypedName(event.target.value);
              setNameProblem(null);
            }}
          />
          {nameProblem === null ? (
            <FieldDescription>
              People see it in the sidebar and when they open an invitation.
            </FieldDescription>
          ) : (
            <FieldError>{nameProblem}</FieldError>
          )}
        </Field>
        {offered === null || runtime === null ? null : (
          <>
            <SectionTitle>Where sessions run</SectionTitle>
            <div className="border-t max-lg:-mx-4">
              <RuntimeList
                runtimes={offered.runtimes}
                selected={runtime}
                organization={name.trim() === "" ? savedName : name.trim()}
                disabled={pending}
                onChoose={setPickedRuntime}
              />
            </div>
          </>
        )}
        {failure === null ? null : (
          <InlineAlert title={failure.title} size={phone ? "touch" : "default"} className="mt-6">
            {failure.detail}
          </InlineAlert>
        )}
        <SetupActions
          status={
            checking && runtime !== null
              ? `Reading what ${RUNTIME_LABELS[runtime]} would change…`
              : rename.isPending
                ? "Saving the name…"
                : switchRuntime.isPending && runtime !== null
                  ? `Switching to ${RUNTIME_LABELS[runtime]}…`
                  : null
          }
        >
          <Button type="submit" size={phone ? "touch" : "default"} disabled={pending}>
            {pending ? <Spinner aria-hidden /> : null}
            Continue
          </Button>
        </SetupActions>
      </form>
      <SwitchDialog
        ask={asked}
        pending={switchRuntime.isPending}
        error={null}
        onCancel={() => setAsked(null)}
        onSwitch={(chosen, moves) => void switchFromDialog(chosen, moves)}
      />
    </SetupFrame>
  );
}
