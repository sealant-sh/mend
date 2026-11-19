import { InlineAlert } from "@mend/ui/components/banner";
import { CopyField } from "@mend/ui/components/copy-field";
import { Input } from "@mend/ui/components/ui/input";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ClipboardEvent, type ReactNode, useId, useState } from "react";

import { AGENT_FACTS, type Agent, keyProblem, rejectedAdvice } from "#/lib/agent-login";
import { requestFailure, waitedFor } from "#/lib/git-access";
import { useTRPC } from "#/lib/trpc";

import { CommandLineBlock } from "./command-line-block.tsx";

/**
 * The parts of connecting an agent login that the Agent login setup step and Settings → Agent
 * logins and Git share: the commands to run on the person's own computer, and the API key field.
 * Mend's app takes no part in a provider's sign-in (Yiannis, 17 Nov 2026).
 */

/**
 * The command that connects a login (`mend connect claude`, `mend connect github`), after Mend's
 * command line block: how to install it and sign it in, or the computer it is signed in on.
 */
export function ConnectCommands({
  command,
  phone,
}: {
  readonly command: string;
  readonly phone: boolean;
}) {
  return (
    <div className="grid gap-4">
      <CommandLineBlock phone={phone} />
      <CopyField value={command} label="Copy command" size={phone ? "touch" : "default"} />
    </div>
  );
}

/** What is wrong with a key, in a title and the sentence after it. */
type KeyWords = { readonly title: string; readonly advice: string };

/**
 * Saving an API key for an agent. The key is sent as it is pasted, on Enter or on the form's own
 * button, and the field is emptied the moment it is sent, so no part of it stays on the page or in
 * the mutation cache. `onSaved` runs once the platform has accepted it.
 */
export function useApiKeySave(agent: Agent, onSaved?: () => void) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [key, setKey] = useState("");
  const [problem, setProblem] = useState<KeyWords | null>(null);
  const connect = useMutation(
    trpc.platform.connectAccount.mutationOptions({
      // Its variables carry the key: gone from the mutation cache once nothing shows its result.
      gcTime: 0,
      onSuccess: async () => {
        await queryClient.invalidateQueries(trpc.platform.sealantIdentity.queryFilter());
        onSaved?.();
      },
    }),
  );
  const send = (typed: string) => {
    if (connect.isPending) return;
    const secret = typed.trim();
    setKey("");
    connect.reset();
    const found = keyProblem(agent, secret);
    setProblem(found);
    // The key becomes the login the agent's sessions use, in place of one that was refused or
    // is being replaced.
    if (found === null) {
      connect.mutate({ provider: agent, secret, login: "api-key", makeDefault: true });
    }
  };
  const rejected: KeyWords | null =
    problem ??
    (connect.isError
      ? {
          title: "Mend couldn't save this key.",
          advice: `${requestFailure(connect.error)} ${rejectedAdvice(agent)}`,
        }
      : null);
  return {
    key,
    setKey,
    send,
    rejected,
    pending: connect.isPending,
    submittedAt: connect.isPending ? new Date(connect.submittedAt) : null,
  };
}

export type ApiKeySave = ReturnType<typeof useApiKeySave>;

/**
 * The API key field: its label, the field (a password field, so the key is never drawn), what
 * was wrong with the last key sent, a line of help, and the wait while the platform checks it.
 * `formId` lets a dialog's own button submit it.
 */
export function ApiKeyField({
  agent,
  save,
  phone,
  now,
  focus,
  help,
  formId,
  className,
}: {
  readonly agent: Agent;
  readonly save: ApiKeySave;
  readonly phone: boolean;
  readonly now: Date;
  readonly focus: boolean;
  readonly help: ReactNode;
  readonly formId?: string;
  readonly className?: string;
}) {
  const id = useId();
  const facts = AGENT_FACTS[agent];
  return (
    <form
      id={formId}
      noValidate
      className={className}
      onSubmit={(event) => {
        event.preventDefault();
        save.send(save.key);
      }}
    >
      <label
        htmlFor={id}
        className="mb-2 block text-lead font-medium text-foreground max-lg:text-base"
      >
        {facts.issuer} API key
      </label>
      <Input
        id={id}
        type="password"
        value={save.key}
        placeholder={facts.keyPlaceholder}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="done"
        // Kept focusable while the key is sent, so focus stays here for another try.
        readOnly={save.pending}
        autoFocus={focus}
        aria-invalid={save.rejected !== null}
        aria-describedby={`${id}-help`}
        className="h-10 font-mono text-meta max-lg:h-11"
        onChange={(event) => save.setKey(event.target.value)}
        onPaste={(event: ClipboardEvent<HTMLInputElement>) => {
          event.preventDefault();
          save.send(event.clipboardData.getData("text"));
        }}
      />
      {save.rejected === null ? null : (
        <InlineAlert
          title={save.rejected.title}
          size={phone ? "touch" : "default"}
          className="mt-3"
        >
          {save.rejected.advice}
        </InlineAlert>
      )}
      <p
        id={`${id}-help`}
        className="mt-2 text-row text-pretty text-muted-foreground max-lg:text-sm"
      >
        {help}
      </p>
      {save.submittedAt === null ? null : (
        <p role="status" className="mt-3 text-row text-muted-foreground max-lg:text-sm">
          Saving the key · {waitedFor(save.submittedAt, now)}
        </p>
      )}
    </form>
  );
}

/** Where to create a key, as a link inside a sentence. */
export function KeyConsoleLink({ agent }: { readonly agent: Agent }) {
  const { console } = AGENT_FACTS[agent];
  return (
    <>
      {console.words}{" "}
      <a
        href={console.url}
        target="_blank"
        rel="noreferrer"
        className="text-info underline-offset-4 hover:underline"
      >
        {console.link}
      </a>
    </>
  );
}
