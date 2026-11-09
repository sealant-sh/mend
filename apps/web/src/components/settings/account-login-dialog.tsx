import type { ConnectLogin } from "@mend/api-contracts";
import { parseEndpointUrl } from "@mend/domain/endpoint-url";
import {
  ENDPOINT_KEY_WORDS,
  keyEndpointWords,
  type KeyProvider,
  keySpendWords,
} from "@mend/domain/workbench";
import { useMutation } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { Button } from "#/components/kit/button";
import { CodeBox } from "#/components/kit/code-box";
import { Field, TextInput } from "#/components/kit/field";
import { ModalClose, ModalDialog } from "#/components/kit/modal";
import { Segment } from "#/components/kit/segment";
import { ErrorNote, errorText, StatusWord } from "#/components/kit/status";
import { SwitchRow } from "#/components/kit/switch";
import { TextArea } from "#/components/kit/text-area";
import type { ConnectedAccountDto, ConnectedAccountProviderDto } from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

/**
 * How a person hands Mend one of their agent logins (docs/SEALANT-IDENTITY.md). Sealant accepts the
 * login as the provider's own file or token, pasted once: a Claude setup token or credentials file,
 * Codex's auth.json, an Anthropic or OpenAI API key, a GitHub token. Each method says where to get
 * it and what to paste.
 */
interface LoginMethod {
  readonly value: string;
  readonly label: string;
  /** Claude and Codex: the login class the platform checks the secret against. */
  readonly login: ConnectLogin | null;
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
        login: "subscription",
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
        login: "subscription",
        fetch: "On a computer where Claude Code is signed in, open its credentials file.",
        command: "cat ~/.claude/.credentials.json",
        paste: "Paste the file's contents.",
        placeholder: '{ "claudeAiOauth": { … } }',
        multiline: true,
      },
      {
        value: "api-key",
        label: "API key",
        login: "api-key",
        fetch: "Create a key in the Anthropic Console, under API keys.",
        command: null,
        paste: "Paste the key.",
        placeholder: "sk-ant-api03-…",
        multiline: false,
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
        login: "subscription",
        fetch: "On a computer where codex login has run, open its auth file.",
        command: "cat ~/.codex/auth.json",
        paste: "Paste the file's contents.",
        placeholder: '{ "OPENAI_API_KEY": null, "tokens": { … } }',
        multiline: true,
      },
      {
        value: "api-key",
        label: "API key",
        login: "api-key",
        fetch: "Create a key in the OpenAI platform, under your project's API keys.",
        command: null,
        paste: "Paste the key.",
        placeholder: "sk-proj-…",
        multiline: false,
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
        login: null,
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
  /** The login being replaced; null to add one. */
  readonly replacing: ConnectedAccountDto | null;
  /** Only the ways to sign in of this class; null offers every way. */
  readonly login: ConnectLogin | null;
  /** The person's default for the provider when it is another login: the form offers to move it. */
  readonly otherDefault: ConnectedAccountDto | null;
}

const isKeyProvider = (provider: ConnectedAccountProviderDto): provider is KeyProvider =>
  provider === "claude" || provider === "codex";

/** A key's endpoint as typed: none, one the platform takes, or why it would refuse it. */
const endpointOf = (
  typed: string,
):
  | { readonly kind: "none" }
  | { readonly kind: "valid"; readonly url: string }
  | { readonly kind: "refused"; readonly reason: string } => {
  const raw = typed.trim();
  if (raw === "") return { kind: "none" };
  const parsed = parseEndpointUrl(raw);
  return parsed.valid
    ? { kind: "valid", url: parsed.url }
    : { kind: "refused", reason: parsed.reason };
};

const titleOf = (target: LoginTarget, label: string): string => {
  if (target.login === "api-key")
    return target.replacing === null ? `Add a ${label} API key` : `Replace your ${label} API key`;
  if (target.login === "subscription" && target.replacing === null)
    return `Connect your ${label} subscription`;
  return `${target.replacing === null ? "Connect" : "Replace"} your ${label} login`;
};

/**
 * Replace or Connect for one agent login. What was pasted lives inside the dialog only: it is gone
 * from the page the moment the dialog closes, saved or not. `apiKeys` is whether the platform runs
 * sessions on a key; without it the key method says so and saves nothing.
 */
export function LoginDialog({
  target,
  apiKeys,
  onClose,
}: {
  readonly target: LoginTarget | null;
  readonly apiKeys: boolean;
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
      title={login === null || target === null ? "" : titleOf(target, login.label)}
      description={login?.detail}
    >
      {target === null || login === null ? null : (
        <LoginForm target={target} login={login} apiKeys={apiKeys} onSaved={onClose} />
      )}
    </ModalDialog>
  );
}

function LoginForm({
  target,
  login,
  apiKeys,
  onSaved,
}: {
  readonly target: LoginTarget;
  readonly login: ProviderLogin;
  readonly apiKeys: boolean;
  readonly onSaved: () => void;
}) {
  const trpc = useTRPC();
  const methods = login.methods.filter(
    (candidate) => target.login === null || candidate.login === target.login,
  );
  const [methodValue, setMethodValue] = useState(methods[0]?.value ?? "");
  const [secret, setSecret] = useState("");
  const [typedEndpoint, setTypedEndpoint] = useState("");
  const [endpointLeft, setEndpointLeft] = useState(false);
  const [makeDefault, setMakeDefault] = useState(false);
  const method = methods.find((candidate) => candidate.value === methodValue);
  const isKey = method?.login === "api-key";
  const keyRefused = isKey && !apiKeys;
  const keyProvider = isKey && isKeyProvider(target.provider) ? target.provider : null;
  const endpoint = keyProvider === null ? { kind: "none" as const } : endpointOf(typedEndpoint);
  const connect = useMutation(
    trpc.platform.connectAccount.mutationOptions({
      // It carries a credential: gone from the mutation cache once nothing shows its result.
      gcTime: 0,
      onSuccess: async (_saved, _variables, _result, { client }) => {
        setSecret("");
        await client.invalidateQueries(trpc.platform.sealantIdentity.queryFilter());
        onSaved();
      },
    }),
  );
  const ready =
    secret.trim() !== "" && !connect.isPending && !keyRefused && endpoint.kind !== "refused";

  return (
    <form
      className="grid gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || method === undefined) return;
        connect.mutate({
          provider: target.provider,
          secret: secret.trim(),
          ...(method.login === null ? {} : { login: method.login }),
          ...(endpoint.kind === "valid" ? { endpoint: endpoint.url } : {}),
          ...(makeDefault ? { makeDefault: true } : {}),
          ...(target.replacing === null ? {} : { accountId: target.replacing.id }),
        });
      }}
    >
      {methods.length > 1 ? (
        <Segment
          label="How you sign in"
          value={methodValue}
          onChange={(next) => {
            setMethodValue(next);
            setSecret("");
            setTypedEndpoint("");
            setEndpointLeft(false);
          }}
          options={methods.map((candidate) => ({
            value: candidate.value,
            label: candidate.label,
          }))}
        />
      ) : null}
      {method === undefined ? null : keyRefused ? (
        <p className="text-[13.5px]">
          This Mend server's Sealant does not run sessions on an API key yet, so a key cannot be
          connected here. The person who runs Mend can upgrade Sealant to add it.
        </p>
      ) : (
        <ol className="grid gap-3.5">
          <Step number={1}>
            <p className="text-[13.5px]">{method.fetch}</p>
            {method.command === null ? null : (
              <CodeBox className="mt-2" copy={method.command} label="the command">
                {method.command}
              </CodeBox>
            )}
            {isKey && isKeyProvider(target.provider) ? (
              <p className="mt-1.5 text-[12.5px] text-muted-foreground">
                {keySpendWords(target.provider)}
              </p>
            ) : null}
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
            {endpoint.kind === "none" ? null : (
              <p className="mt-1.5 text-[12.5px] text-muted-foreground">{ENDPOINT_KEY_WORDS}</p>
            )}
          </Step>
          {keyProvider === null ? null : (
            <Step number={3}>
              <Field label="Endpoint (optional)">
                {(id) => (
                  <>
                    <TextInput
                      id={id}
                      type="url"
                      inputMode="url"
                      value={typedEndpoint}
                      disabled={connect.isPending}
                      placeholder="https://gateway.example.com"
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={endpoint.kind === "refused" && endpointLeft}
                      aria-describedby={`${id}-words`}
                      onChange={(event) => setTypedEndpoint(event.target.value)}
                      onBlur={() => setEndpointLeft(true)}
                    />
                    <EndpointWords
                      id={`${id}-words`}
                      provider={keyProvider}
                      refusal={endpoint.kind === "refused" && endpointLeft ? endpoint.reason : null}
                    />
                  </>
                )}
              </Field>
            </Step>
          )}
        </ol>
      )}
      {target.otherDefault === null || keyRefused ? null : (
        <SwitchRow
          label={`Use it as my default ${login.label} login`}
          detail="Your sessions spend your default login only. Mend never moves them to another login on its own."
          checked={makeDefault}
          disabled={connect.isPending}
          onCheckedChange={setMakeDefault}
        />
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
        {isKey
          ? "Mend sends it once to Sealant under your own platform user and shows only its last four characters after that."
          : "Mend sends it once to Sealant under your own platform user and never shows it again."}{" "}
        Each turn spends the login of whoever sent it.
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

/** What the endpoint is for, or, once the person left the field, why the platform would refuse it. */
function EndpointWords({
  id,
  provider,
  refusal,
}: {
  readonly id: string;
  readonly provider: KeyProvider;
  readonly refusal: string | null;
}) {
  return refusal === null ? (
    <p id={id} className="text-[12.5px] text-muted-foreground">
      {keyEndpointWords(provider)}
    </p>
  ) : (
    <p id={id} className="text-[12.5px] text-danger">
      {refusal}
    </p>
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
