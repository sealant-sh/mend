import { secretKindOf } from "@mend/domain/workbench";
import { Segmented } from "@mend/ui/components/segmented";
import { Button } from "@mend/ui/components/ui/button";
import { Input } from "@mend/ui/components/ui/input";
import { Label } from "@mend/ui/components/ui/label";
import { Spinner } from "@mend/ui/components/ui/spinner";
import { Textarea } from "@mend/ui/components/ui/textarea";
import { toast } from "@mend/ui/components/ui/toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import type { McpServerDto } from "#/lib/api";
import {
  buildWrite,
  draftOf,
  keepsSealedUrl,
  type McpDraft,
  type McpTransportKind,
  savedApplies,
  secretNoun,
  TRANSPORT_WORDS,
} from "#/lib/mcp-servers";
import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";

import { Overlay } from "../projects/overlay.tsx";

const TRANSPORTS: ReadonlyArray<{ readonly value: McpTransportKind; readonly label: string }> = [
  { value: "stdio", label: TRANSPORT_WORDS.stdio },
  { value: "http", label: TRANSPORT_WORDS.http },
  { value: "sse", label: TRANSPORT_WORDS.sse },
];

/** A field's height: 36px on the desk, a 44px touch target on a phone. */
const FIELD = "h-9 max-lg:h-11 max-lg:text-base";

/**
 * Add an MCP server, or edit one (Doop "MCP servers · add server dialog", "edit server dialog"):
 * its name, its transport, the URL or the command, and its headers or variables. A saved value is
 * never filled in: its field stays empty to keep it, takes a new value to replace it, or is
 * removed with its ×. Nothing typed stays in the page once the dialog closes.
 */
export function McpServerDialog({
  open,
  saved,
  taken,
  onClose,
}: {
  readonly open: boolean;
  readonly saved: McpServerDto | null;
  readonly taken: ReadonlyArray<string>;
  readonly onClose: () => void;
}) {
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => (next ? undefined : onClose())}
      size="md"
      title={saved === null ? "Add MCP server" : `Edit ${saved.name}`}
      description={
        saved === null
          ? "Your new sessions start with this server. Sessions that are already running don't get it."
          : "Sessions that start after you save get the new settings. Running sessions keep the old ones until they stop."
      }
      footer={null}
    >
      {open ? (
        <ServerForm
          key={saved?.id ?? "new"}
          saved={saved}
          taken={taken.filter((name) => name !== saved?.name)}
          onClose={onClose}
        />
      ) : null}
    </Overlay>
  );
}

function ServerForm({
  saved,
  taken,
  onClose,
}: {
  readonly saved: McpServerDto | null;
  readonly taken: ReadonlyArray<string>;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const phone = usePhone();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<McpDraft>(() => draftOf(saved));
  const [nextKey, setNextKey] = useState(1);
  const [tried, setTried] = useState(false);
  // It carries values: gone from the mutation cache once nothing shows its result.
  const save = useMutation(trpc.mcpServers.save.mutationOptions({ gcTime: 0 }));
  const built = buildWrite(draft, saved, taken);
  const kind = secretKindOf({ _tag: draft.kind });
  const noun = secretNoun(kind);
  const set = (change: Partial<McpDraft>) => setDraft((current) => ({ ...current, ...change }));
  const dropped = saved !== null && !savedApplies(draft, saved) ? saved.secretNames : [];
  const name = saved?.name ?? draft.name;

  const submit = async () => {
    setTried(true);
    if (built._tag !== "Write") return;
    try {
      await save.mutateAsync({ name, server: built.write });
      await queryClient.invalidateQueries(trpc.mcpServers.list.queryFilter());
      toast.add({
        description:
          saved === null
            ? `Added ${name}. Your new sessions start with it.`
            : `Saved ${name}. Sessions that start from now on use the new settings.`,
      });
      onClose();
    } catch {
      // Said under the form, from the mutation's error.
    }
  };

  const issue =
    built._tag === "Issue"
      ? built.issue
      : tried && built._tag === "Incomplete"
        ? incomplete(draft)
        : null;

  return (
    <form
      id="mcp-server"
      noValidate
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="mcp-name">Name</Label>
        <Input
          id="mcp-name"
          value={draft.name}
          readOnly={saved !== null}
          placeholder="github"
          spellCheck={false}
          autoComplete="off"
          className={`${FIELD} font-mono read-only:text-muted-foreground`}
          onChange={(event) => set({ name: event.target.value })}
        />
        <p className="text-meta text-muted-foreground">
          {saved === null
            ? "Agents see the server under this name. You can't change it later."
            : "A server's name can't change."}
        </p>
      </div>
      <div className="grid gap-1.5">
        <span id="mcp-transport" className="text-sm font-medium">
          Transport
        </span>
        <Segmented
          aria-label="Transport"
          value={draft.kind}
          options={TRANSPORTS}
          size={phone ? "touch" : "default"}
          className={phone ? "w-full" : ""}
          onValueChange={(next) => set({ kind: next })}
        />
      </div>
      {draft.kind === "stdio" ? (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="mcp-command">Command</Label>
            <Input
              id="mcp-command"
              value={draft.command}
              placeholder="npx"
              spellCheck={false}
              autoComplete="off"
              className={`${FIELD} font-mono`}
              onChange={(event) => set({ command: event.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mcp-args">Arguments, one per line</Label>
            <Textarea
              id="mcp-args"
              rows={3}
              value={draft.args}
              placeholder={"-y\n@modelcontextprotocol/server-filesystem"}
              spellCheck={false}
              className="font-mono max-lg:text-base"
              onChange={(event) => set({ args: event.target.value })}
            />
            <p className="text-meta text-muted-foreground">
              Mend runs the command in each of your sessions.
            </p>
          </div>
        </>
      ) : (
        <div className="grid gap-1.5">
          <Label htmlFor="mcp-url">URL</Label>
          <Input
            id="mcp-url"
            type="url"
            value={draft.url}
            placeholder="https://mcp.example.com/mcp"
            spellCheck={false}
            autoComplete="off"
            className={`${FIELD} font-mono`}
            onChange={(event) => set({ url: event.target.value })}
          />
          {keepsSealedUrl(draft, saved) ? (
            <p className="text-meta text-muted-foreground">
              Mend sealed the parts shown as …. Leave the URL as it is to keep them.
            </p>
          ) : null}
          {saved !== null && saved.signIn !== null ? (
            <p className="text-meta text-muted-foreground">
              Changing the URL signs you out of this server.
            </p>
          ) : null}
        </div>
      )}
      <fieldset className="grid gap-2">
        <legend className="mb-1.5 text-sm font-medium">
          {kind === "env" ? "Environment variables" : "Headers"}
        </legend>
        {savedApplies(draft, saved)
          ? draft.saved.map((secret, index) =>
              secret.removed ? null : (
                <div key={secret.name} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
                  <Input
                    aria-label={`Saved ${noun} name`}
                    value={secret.name}
                    readOnly
                    className={`${FIELD} font-mono text-muted-foreground`}
                  />
                  <Input
                    aria-label={`New value for ${secret.name}`}
                    type="password"
                    value={secret.value}
                    placeholder="Saved. Type to replace."
                    autoComplete="new-password"
                    className={FIELD}
                    onChange={(event) =>
                      set({
                        saved: draft.saved.map((s, at) =>
                          at === index ? { ...s, value: event.target.value } : s,
                        ),
                      })
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size={phone ? "icon-touch" : "icon"}
                    aria-label={`Remove ${secret.name}`}
                    onClick={() =>
                      set({
                        saved: draft.saved.map((s, at) =>
                          at === index ? { ...s, value: "", removed: true } : s,
                        ),
                      })
                    }
                  >
                    <XIcon aria-hidden />
                  </Button>
                </div>
              ),
            )
          : null}
        {dropped.length === 0 ? null : (
          <p className="text-meta text-muted-foreground">
            Saving as {TRANSPORT_WORDS[draft.kind]} deletes the saved{" "}
            {kind === "env" ? "headers" : "variables"} {dropped.join(", ")}.
          </p>
        )}
        {draft.added.map((secret, index) => (
          <div key={secret.key} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
            <Input
              aria-label={`${noun === "header" ? "Header" : "Variable"} name`}
              value={secret.name}
              placeholder={kind === "env" ? "GITHUB_TOKEN" : "Authorization"}
              spellCheck={false}
              autoComplete="off"
              className={`${FIELD} font-mono`}
              onChange={(event) =>
                set({
                  added: draft.added.map((s, at) =>
                    at === index ? { ...s, name: event.target.value } : s,
                  ),
                })
              }
            />
            <Input
              aria-label={`Value for ${secret.name.trim() === "" ? `the new ${noun}` : secret.name.trim()}`}
              type="password"
              value={secret.value}
              placeholder="Value"
              autoComplete="new-password"
              className={FIELD}
              onChange={(event) =>
                set({
                  added: draft.added.map((s, at) =>
                    at === index ? { ...s, value: event.target.value } : s,
                  ),
                })
              }
            />
            <Button
              type="button"
              variant="ghost"
              size={phone ? "icon-touch" : "icon"}
              aria-label={`Remove ${secret.name.trim() === "" ? `this ${noun}` : secret.name.trim()}`}
              onClick={() => set({ added: draft.added.filter((_, at) => at !== index) })}
            >
              <XIcon aria-hidden />
            </Button>
          </div>
        ))}
        <div>
          <Button
            type="button"
            variant="link"
            className="h-auto px-0"
            onClick={() => {
              set({ added: [...draft.added, { key: nextKey, name: "", value: "" }] });
              setNextKey(nextKey + 1);
            }}
          >
            <PlusIcon aria-hidden />
            {kind === "env" ? "Add variable" : "Add header"}
          </Button>
        </div>
        <p className="text-meta text-muted-foreground">
          Mend seals {noun} values when you save the server. Nobody can read them back, but you can
          replace them later.
        </p>
      </fieldset>
      {issue === null ? null : (
        <p role="alert" className="text-row text-destructive">
          {issue}
        </p>
      )}
      {save.isError ? (
        <p role="alert" className="text-row text-destructive">
          {saved === null ? `Mend didn't add ${name}.` : `Mend didn't save ${name}.`}{" "}
          {failureWords(save.error, "Check your connection and try again.")}
        </p>
      ) : null}
      <div className="flex justify-end gap-2.5 pt-1 max-lg:*:flex-1">
        <Button
          type="button"
          variant="outline"
          size={phone ? "touch" : "default"}
          disabled={save.isPending}
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button type="submit" size={phone ? "touch" : "default"} disabled={save.isPending}>
          {save.isPending ? <Spinner aria-hidden /> : null}
          {save.isPending ? "Saving…" : saved === null ? "Add server" : "Save server"}
        </Button>
      </div>
    </form>
  );
}

/** What is still missing, said when Add or Save is pressed too early. */
const incomplete = (draft: McpDraft): string =>
  draft.name.trim() === ""
    ? "Name the server."
    : draft.kind === "stdio"
      ? draft.command.trim() === ""
        ? "Fill in the command."
        : "Fill in each value, or remove its row."
      : draft.url.trim() === ""
        ? "Fill in the URL."
        : "Fill in each value, or remove its row.";
