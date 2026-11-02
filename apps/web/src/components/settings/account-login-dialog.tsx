import { useMutation } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { Button } from "#/components/kit/button";
import { CodeBox } from "#/components/kit/code-box";
import { Field, TextInput } from "#/components/kit/field";
import { ModalClose, ModalDialog } from "#/components/kit/modal";
import { Segment } from "#/components/kit/segment";
import { ErrorNote, errorText, StatusWord } from "#/components/kit/status";
import { TextArea } from "#/components/kit/text-area";
import type { ConnectedAccountDto, ConnectedAccountProviderDto } from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

/**
 * How a person hands Mend one of their agent logins (docs/SEALANT-IDENTITY.md). Sealant accepts the
 * login as the provider's own file or token, pasted once: a Claude setup token or credentials file,
 * Codex's auth.json, a GitHub token. Each method says where to get it and what to paste.
 */
interface LoginMethod {
  readonly value: string;
  readonly label: string;
  readonly fetch: ReactNode;
  /** A command to copy for step 1, when there is one. */
  readonly command: string | null;
  readonly paste: string;
  readonly placeholder: string;
  readonly multiline: boolean;
}

interface ProviderLogin {
  readonly label: string;
  readonly detail: string;
  readonly methods: ReadonlyArray<LoginMethod>;
}

export const PROVIDER_LOGINS: Readonly<Record<ConnectedAccountProviderDto, ProviderLogin>> = {
  claude: {
    label: "Claude",
    detail: "What mend claude and Mend's own reads of a change run on.",
    methods: [
      {
        value: "token",
        label: "Setup token",
        fetch:
          "On a computer signed in to Claude, run this and allow it in the browser tab it opens.",
        command: "claude setup-token",
        paste: "Paste the token it prints.",
        placeholder: "sk-ant-oat01-…",
        multiline: false,
      },
      {
        value: "credentials",
        label: "Credentials file",
        fetch: "On a computer where Claude Code is signed in, open its credentials file.",
        command: "cat ~/.claude/.credentials.json",
        paste: "Paste the file's contents.",
        placeholder: '{ "claudeAiOauth": { … } }',
        multiline: true,
      },
    ],
  },
  codex: {
    label: "Codex",
    detail: "What mend codex runs on.",
    methods: [
      {
        value: "auth",
        label: "auth.json",
        fetch: "On a computer where codex login has run, open its auth file.",
        command: "cat ~/.codex/auth.json",
        paste: "Paste the file's contents.",
        placeholder: '{ "OPENAI_API_KEY": null, "tokens": { … } }',
        multiline: true,
      },
    ],
  },
  github: {
    label: "GitHub",
    // docs/adr/0016, decisions 4 and 5: written per person, never into the environment.
    detail:
      "In a per-person workspace your processes use your own GitHub login, written into your own home and never anyone else's. A shared workspace gives it to gh as GH_TOKEN.",
    methods: [
      {
        value: "token",
        label: "gh token",
        fetch: "On a computer where gh is signed in, print its token.",
        command: "gh auth token",
        paste: "Paste the token it prints.",
        placeholder: "gho_…",
        multiline: false,
      },
    ],
  },
};

export interface LoginTarget {
  readonly provider: ConnectedAccountProviderDto;
  /** The login being replaced; null to connect a first one. */
  readonly replacing: ConnectedAccountDto | null;
}

/**
 * Replace or Connect for one agent login. What was pasted lives inside the dialog only: it is gone
 * from the page the moment the dialog closes, saved or not.
 */
export function LoginDialog({
  target,
  onClose,
}: {
  readonly target: LoginTarget | null;
  readonly onClose: () => void;
}) {
  const login = target === null ? null : PROVIDER_LOGINS[target.provider];
  return (
    <ModalDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      width={520}
      title={
        login === null || target === null
          ? ""
          : `${target.replacing === null ? "Connect" : "Replace"} your ${login.label} login`
      }
      description={login?.detail}
    >
      {target === null || login === null ? null : (
        <LoginForm target={target} login={login} onSaved={onClose} />
      )}
    </ModalDialog>
  );
}

function LoginForm({
  target,
  login,
  onSaved,
}: {
  readonly target: LoginTarget;
  readonly login: ProviderLogin;
  readonly onSaved: () => void;
}) {
  const trpc = useTRPC();
  const [methodValue, setMethodValue] = useState(login.methods[0]?.value ?? "");
  const [secret, setSecret] = useState("");
  const method = login.methods.find((candidate) => candidate.value === methodValue);
  const connect = useMutation(
    trpc.platform.connectAccount.mutationOptions({
      onSuccess: async (_saved, _variables, _result, { client }) => {
        setSecret("");
        await client.invalidateQueries(trpc.platform.sealantIdentity.queryFilter());
        onSaved();
      },
    }),
  );
  const ready = secret.trim() !== "" && !connect.isPending;

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        connect.mutate({
          provider: target.provider,
          secret: secret.trim(),
          ...(target.replacing === null ? {} : { accountId: target.replacing.id }),
        });
      }}
    >
      {login.methods.length > 1 ? (
        <Segment
          label="How you sign in"
          value={methodValue}
          onChange={(next) => {
            setMethodValue(next);
            setSecret("");
          }}
          options={login.methods.map((candidate) => ({
            value: candidate.value,
            label: candidate.label,
          }))}
        />
      ) : null}
      {method === undefined ? null : (
        <ol className="grid gap-3.5">
          <Step number={1}>
            <p className="text-[13.5px]">{method.fetch}</p>
            {method.command === null ? null : (
              <CodeBox className="mt-2" copy={method.command} label="the command">
                {method.command}
              </CodeBox>
            )}
          </Step>
          <Step number={2}>
            <Field label={method.paste}>
              {(id) =>
                method.multiline ? (
                  <TextArea
                    id={id}
                    rows={4}
                    value={secret}
                    disabled={connect.isPending}
                    placeholder={method.placeholder}
                    autoComplete="off"
                    onChange={(event) => setSecret(event.target.value)}
                  />
                ) : (
                  <TextInput
                    id={id}
                    type="password"
                    value={secret}
                    disabled={connect.isPending}
                    placeholder={method.placeholder}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setSecret(event.target.value)}
                  />
                )
              }
            </Field>
          </Step>
        </ol>
      )}
      <p role="status">
        <StatusWord tone={connect.isPending ? "run" : secret.trim() === "" ? "wait" : "ok"}>
          {connect.isPending
            ? "sending it to Sealant…"
            : secret.trim() === ""
              ? "waiting for the login"
              : "ready to save"}
        </StatusWord>
      </p>
      <p className="text-[12.5px] text-muted-foreground">
        Mend sends it once to Sealant under your own platform user and never shows it again. Each
        turn spends the login of whoever sent it.
      </p>
      {connect.error === null ? null : <ErrorNote>{errorText(connect.error)}</ErrorNote>}
      <div className="flex items-center justify-end gap-2.5">
        <ModalClose render={<Button variant="ghost" disabled={connect.isPending} />}>
          Cancel
        </ModalClose>
        <Button type="submit" variant="primary" disabled={!ready}>
          {connect.isPending ? "Saving…" : "Save login"}
        </Button>
      </div>
    </form>
  );
}

function Step({ number, children }: { readonly number: number; readonly children: ReactNode }) {
  return (
    <li className="grid grid-cols-[26px_minmax(0,1fr)] gap-2.5">
      <span aria-hidden="true" className="pt-0.5 font-mono text-[12px] text-muted-foreground">
        {number}
      </span>
      <div className="min-w-0">{children}</div>
    </li>
  );
}
