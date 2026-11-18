import type { WorktreeId } from "@mend/domain";
import {
  loadBytes,
  resourceAdditionDefinition,
  resourceAdditionOf,
  type ResourceAdded,
  resourceTableToml,
} from "@mend/domain/workbench";
import { InlineAlert } from "@mend/ui/components/banner";
import { Segmented } from "@mend/ui/components/segmented";
import { Button } from "@mend/ui/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@mend/ui/components/ui/field";
import { Input } from "@mend/ui/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@mend/ui/components/ui/input-group";
import { NativeSelect, NativeSelectOption } from "@mend/ui/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@mend/ui/components/ui/radio-group";
import { toast } from "@mend/ui/components/ui/toast";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileArchiveIcon } from "lucide-react";
import { useId, useState } from "react";

import { usePhone } from "#/lib/phone";
import type { LoadRequest, LoadTarget } from "#/lib/resource-load";
import { addResource, removeResourceInstance, type ResourceSettingView } from "#/lib/resources";
import { portFlags } from "#/lib/resources-model";
import { useTRPC } from "#/lib/trpc";

import { Overlay } from "../projects/overlay.tsx";

/** A worktree a dialog can name: where to write a table, whose database to load. */
export interface WorktreeName {
  readonly id: WorktreeId;
  readonly name: string;
}

type Kind = "postgres" | "redis" | "mysql" | "image";

const DEFAULT_VERSION: Readonly<Record<Exclude<Kind, "image">, string>> = {
  postgres: "17",
  redis: "8",
  mysql: "8.4",
};

/** What the form holds, as the add command's flags: one parse for the preview and the write. */
const additionOf = (form: {
  readonly name: string;
  readonly kind: Kind;
  readonly version: string;
  readonly image: string;
  readonly ports: string;
}) =>
  resourceAdditionOf([
    form.name.trim().replace(/^@/, ""),
    ...(form.kind === "image"
      ? ["--image", form.image.trim(), ...portFlags(form.ports)]
      : ["--preset", form.kind, "--version", form.version.trim()]),
  ]);

/**
 * Add a resource… (Doop "Project · Resources · add a resource"): Mend writes a `[resource.<name>]`
 * table into `.mend/mend.toml` in the worktree picked here, and starts nothing. The table it will
 * write shows as it is typed. A project with no worktree gets the table to copy instead.
 */
export function AddResource({
  projectId,
  worktrees,
  open,
  onOpenChange,
}: {
  readonly projectId: string;
  readonly worktrees: ReadonlyArray<WorktreeName>;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const ids = useId();
  const [worktreeId, setWorktreeId] = useState<WorktreeId | null>(null);
  const [kind, setKind] = useState<Kind>("postgres");
  const [name, setName] = useState("db");
  const [version, setVersion] = useState(DEFAULT_VERSION.postgres);
  const [image, setImage] = useState("");
  const [ports, setPorts] = useState("");
  const worktree = worktrees.find((row) => row.id === worktreeId) ?? worktrees[0];
  const parsed = additionOf({ name, kind, version, image, ports });
  const table = parsed.ok ? resourceTableToml(resourceAdditionDefinition(parsed.definition)) : null;
  const add = useMutation({
    mutationFn: async (): Promise<ResourceAdded> => {
      if (!parsed.ok) throw new Error(parsed.message);
      const outcome = await addResource(projectId, {
        worktreeId: worktree?.id ?? null,
        definition: parsed.definition,
      });
      if (!outcome.ok) throw new Error(outcome.message);
      return outcome.result;
    },
    onSuccess: (answer) =>
      answer.kind === "written"
        ? queryClient.invalidateQueries(trpc.resources.pathFilter())
        : undefined,
  });
  const reset = () => {
    setWorktreeId(null);
    setKind("postgres");
    setName("db");
    setVersion(DEFAULT_VERSION.postgres);
    setImage("");
    setPorts("");
    add.reset();
  };
  const close = () => {
    reset();
    onOpenChange(false);
  };
  const submit = () => {
    if (add.isPending) return;
    add.mutate(undefined, {
      onSuccess: (answer) => {
        if (answer.kind !== "written") return;
        close();
        toast.add({
          description: `Wrote @${parsed.ok ? parsed.definition.name : name} into ${answer.path} in ${answer.worktree}.`,
        });
      },
    });
  };
  const size = phone ? "touch" : "default";
  const field = cn("font-mono", phone && "h-11 text-lead");
  const answer = add.data;

  return (
    <Overlay
      open={open}
      onOpenChange={(next) => {
        if (add.isPending) return;
        if (next) onOpenChange(true);
        else close();
      }}
      title="Add a resource"
      description={
        worktrees.length === 0
          ? "This project has no worktree to write into yet, so Mend shows the table to copy into .mend/mend.toml."
          : "Mend writes the resource into .mend/mend.toml in the worktree you pick. Sessions there can start it straight away; everyone else gets it once that change lands."
      }
      size="md"
      footer={
        answer !== undefined && answer.kind !== "written" ? (
          <Button size={size} onClick={close}>
            Done
          </Button>
        ) : (
          <>
            {phone ? null : (
              <Button variant="ghost" size={size} disabled={add.isPending} onClick={close}>
                Cancel
              </Button>
            )}
            <Button type="submit" form={`${ids}-form`} size={size} disabled={add.isPending}>
              {add.isPending
                ? "Writing…"
                : worktree === undefined
                  ? "Show the table to copy"
                  : "Write to mend.toml"}
            </Button>
          </>
        )
      }
    >
      <form
        id={`${ids}-form`}
        className="flex flex-col gap-5"
        aria-busy={add.isPending || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {worktree === undefined ? null : (
          <Field>
            <FieldLabel htmlFor={`${ids}-worktree`}>Write into</FieldLabel>
            <NativeSelect
              id={`${ids}-worktree`}
              value={worktree.id}
              disabled={add.isPending}
              onChange={(event) =>
                setWorktreeId(worktrees.find((row) => row.id === event.target.value)?.id ?? null)
              }
              className={cn("w-full font-mono", phone && "[&_select]:h-11 [&_select]:text-lead")}
            >
              {worktrees.map((row) => (
                <NativeSelectOption key={row.id} value={row.id}>
                  {row.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        )}
        <Field>
          <FieldLabel id={`${ids}-kind`}>Kind</FieldLabel>
          <Segmented
            aria-label="Kind"
            size={size}
            className={cn(phone && "w-full")}
            value={kind}
            disabled={add.isPending}
            onValueChange={(next) => {
              setKind(next);
              if (next !== "image") setVersion(DEFAULT_VERSION[next]);
              if (name === "db" || name === "redis" || name === "mysql" || name === "")
                setName(next === "postgres" ? "db" : next === "image" ? "" : next);
            }}
            options={[
              { value: "postgres", label: "Postgres" },
              { value: "redis", label: "Redis" },
              { value: "mysql", label: "MySQL" },
              { value: "image", label: "Image" },
            ]}
          />
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${ids}-name`}>Name</FieldLabel>
            <InputGroup className={cn(phone && "h-11")}>
              <InputGroupAddon>
                <InputGroupText className="font-mono">@</InputGroupText>
              </InputGroupAddon>
              <InputGroupInput
                id={`${ids}-name`}
                value={name}
                required
                disabled={add.isPending}
                placeholder="search"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setName(event.target.value.toLowerCase().replace(/^@/, ""))}
                className={cn("-ml-1.5", field)}
              />
            </InputGroup>
          </Field>
          {kind === "image" ? (
            <Field>
              <FieldLabel htmlFor={`${ids}-ports`}>Ports</FieldLabel>
              <Input
                id={`${ids}-ports`}
                value={ports}
                required
                disabled={add.isPending}
                placeholder="7700"
                autoComplete="off"
                onChange={(event) => setPorts(event.target.value)}
                className={field}
              />
            </Field>
          ) : (
            <Field>
              <FieldLabel htmlFor={`${ids}-version`}>Version</FieldLabel>
              <Input
                id={`${ids}-version`}
                value={version}
                required
                disabled={add.isPending}
                autoComplete="off"
                onChange={(event) => setVersion(event.target.value)}
                className={field}
              />
            </Field>
          )}
        </div>
        {kind === "image" ? (
          <Field>
            <FieldLabel htmlFor={`${ids}-image`}>Image</FieldLabel>
            <Input
              id={`${ids}-image`}
              value={image}
              required
              disabled={add.isPending}
              placeholder="getmeili/meilisearch:v1.11"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setImage(event.target.value)}
              className={field}
            />
            <FieldDescription>
              Name more than one port as <span className="font-mono">smtp=1025 http=8025</span>.
            </FieldDescription>
          </Field>
        ) : null}
        {table === null ? null : (
          <div className="flex flex-col gap-2">
            <p className="text-row text-muted-foreground">
              Mend adds this to <span className="font-mono">.mend/mend.toml</span>:
            </p>
            <pre
              aria-label="The table Mend writes"
              className="overflow-x-auto rounded-lg bg-muted px-4 py-3 font-mono text-meta leading-relaxed text-foreground"
            >
              {table.trimEnd()}
            </pre>
          </div>
        )}
        {answer === undefined || answer.kind === "written" ? null : (
          <InlineAlert tone="info" size={size} title={answer.statusLine}>
            Copy the table above into <code>.mend/mend.toml</code>.
          </InlineAlert>
        )}
        {add.isError ? <InlineAlert size={size}>{add.error.message}</InlineAlert> : null}
      </form>
    </Overlay>
  );
}

/** One instance to remove: the project's, or a worktree's own. */
export interface RemovalTarget {
  readonly entry: ResourceSettingView;
  /** The worktree whose own instance it is; null for the project's. */
  readonly worktree: string | null;
  /** How many worktrees use the project's instance now. */
  readonly using: number;
  readonly worktrees: number;
}

/**
 * Remove… (Doop "Project · Resources · remove"): Mend stops the instance and removes its
 * container; its data volumes are kept. Closes once Mend has archived it; a refusal stays here.
 */
export function RemoveResource({
  projectId,
  target,
  onClose,
  onRemoved,
}: {
  readonly projectId: string;
  readonly target: RemovalTarget | null;
  readonly onClose: () => void;
  readonly onRemoved: (target: RemovalTarget, statusLine: string) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const remove = useMutation({
    mutationFn: async (removing: RemovalTarget) => {
      const outcome = await removeResourceInstance(
        projectId,
        removing.entry,
        removing.entry.worktreeId,
      );
      if (!outcome.ok) throw new Error(outcome.message);
      return outcome.result;
    },
    onSuccess: () => queryClient.invalidateQueries(trpc.resources.pathFilter()),
  });
  const close = () => {
    remove.reset();
    onClose();
  };
  const name = target?.entry.spec.name ?? "";
  const volumes = target?.entry.spec.volumes.map((volume) => volume.name) ?? [];
  const size = phone ? "touch" : "default";
  const whose = target?.worktree === null ? "the project's" : `${target?.worktree ?? ""}'s`;
  return (
    <Overlay
      open={target !== null}
      onOpenChange={(next) => {
        if (!next && !remove.isPending) close();
      }}
      title={`Remove ${whose} @${name}?`}
      description={`Mend stops @${name} and removes its container. Its data volumes are kept.`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" size={size} disabled={remove.isPending} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size={size}
            disabled={remove.isPending || target === null}
            onClick={() => {
              if (target === null) return;
              remove.mutate(target, {
                onSuccess: (answer) => {
                  onRemoved(target, answer.statusLine);
                  close();
                },
              });
            }}
          >
            {remove.isPending ? "Removing…" : `Remove @${name}`}
          </Button>
        </>
      }
    >
      <dl className="divide-y border-y text-prose">
        <div className="flex items-baseline justify-between gap-4 py-2.5">
          <dt>Worktrees that use it</dt>
          <dd className="text-right text-muted-foreground">
            {target === null
              ? ""
              : target.worktree !== null
                ? `Only ${target.worktree}`
                : target.using === 0
                  ? "None"
                  : target.using === target.worktrees
                    ? `All ${target.using}, until it starts again`
                    : `${target.using}, until it starts again`}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-4 py-2.5">
          <dt>Volumes kept</dt>
          <dd className="text-right font-mono text-meta text-muted-foreground">
            {volumes.length === 0 ? "None declared" : volumes.join(" · ")}
          </dd>
        </div>
      </dl>
      {remove.isError ? <InlineAlert size={size}>{remove.error.message}</InlineAlert> : null}
    </Overlay>
  );
}

/** Where a load can go: the shared database, and the worktrees whose own one its reader may replace. */
export interface LoadTargets {
  readonly shared: { readonly users: ReadonlyArray<string> } | null;
  readonly own: ReadonlyArray<WorktreeName>;
}

/** `Used by fix-checkout-retry, stripe-webhook-retries and 4 more worktrees`. */
export const usersWords = (users: ReadonlyArray<string>): string => {
  if (users.length === 0) return "No worktree uses it now";
  if (users.length === 1) return `Used by ${users[0]}`;
  if (users.length === 2) return `Used by ${users[0]} and ${users[1]}`;
  const more = users.length - 2;
  return `Used by ${users[0]}, ${users[1]} and ${more} more ${more === 1 ? "worktree" : "worktrees"}`;
};

/**
 * Load data… (Doop "Project · Resources · load data"), Postgres only: which database, and a dump
 * file or a URL Mend's server pulls from. Load data closes the dialog; the load's progress shows
 * on the resource. The URL can hold a password, so it is a password field and leaves the form as
 * soon as it is sent.
 */
export function LoadData({
  projectId,
  name,
  engine,
  targets,
  open,
  onOpenChange,
  onLoad,
}: {
  readonly projectId: string;
  readonly name: string;
  readonly engine: string;
  readonly targets: LoadTargets;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onLoad: (request: LoadRequest) => void;
}) {
  const phone = usePhone();
  const ids = useId();
  const [into, setInto] = useState<string>("shared");
  const [from, setFrom] = useState<"file" | "url">("file");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const choices: ReadonlyArray<{
    readonly value: string;
    readonly target: LoadTarget;
    readonly worktreeId: WorktreeId | null;
    readonly label: string;
    readonly detail: string;
  }> = [
    ...(targets.shared === null
      ? []
      : [
          {
            value: "shared",
            target: "shared" as const,
            worktreeId: null,
            label: "The shared database",
            detail: usersWords(targets.shared.users),
          },
        ]),
    ...targets.own.map((worktree) => ({
      value: worktree.id,
      target: "own" as const,
      worktreeId: worktree.id,
      label: `${worktree.name}'s own database`,
      detail: "Used only by that worktree",
    })),
  ];
  const chosen = choices.find((choice) => choice.value === into) ?? choices[0];
  const ready = chosen !== undefined && (from === "file" ? file !== null : url.trim() !== "");
  const close = () => {
    setInto("shared");
    setFrom("file");
    setFile(null);
    setUrl("");
    onOpenChange(false);
  };
  const submit = () => {
    if (!ready || chosen === undefined) return;
    const source =
      from === "file" && file !== null
        ? { kind: "upload" as const, file }
        : { kind: "pull" as const, url: url.trim() };
    onLoad({ projectId, name, target: chosen.target, worktreeId: chosen.worktreeId, source });
    close();
  };
  const size = phone ? "touch" : "default";

  return (
    <Overlay
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title={`Load data into @${name}`}
      description={
        phone ? engine : "Mend saves the current data as a dump first, so you can go back to it."
      }
      size="md"
      footer={
        <>
          {phone ? null : (
            <Button variant="ghost" size={size} onClick={close}>
              Cancel
            </Button>
          )}
          <Button type="submit" form={`${ids}-form`} size={size} disabled={!ready}>
            Load data
          </Button>
        </>
      }
    >
      <form
        id={`${ids}-form`}
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {phone ? (
          <p className="text-prose text-muted-foreground">
            Mend saves the current data as a dump first, so you can go back to it.
          </p>
        ) : null}
        {choices.length === 0 ? (
          <InlineAlert tone="info" size={size}>
            Nothing can take a load yet. Start @{name} as the project's resource, or start a
            worktree's own database.
          </InlineAlert>
        ) : (
          <Field>
            <FieldLabel id={`${ids}-into`}>Into</FieldLabel>
            <RadioGroup
              aria-labelledby={`${ids}-into`}
              value={chosen?.value ?? ""}
              onValueChange={(value) => {
                if (typeof value === "string") setInto(value);
              }}
              className="gap-3"
            >
              {choices.map((choice) => (
                <label
                  key={choice.value}
                  htmlFor={`${ids}-${choice.value}`}
                  className="flex cursor-pointer items-start gap-3 max-lg:min-h-11"
                >
                  <RadioGroupItem
                    id={`${ids}-${choice.value}`}
                    value={choice.value}
                    aria-describedby={`${ids}-${choice.value}-detail`}
                    className="mt-0.5 size-4.5"
                  />
                  <span className="grid min-w-0 gap-0.5">
                    <span className="text-prose text-foreground">{choice.label}</span>
                    <span
                      id={`${ids}-${choice.value}-detail`}
                      className="text-row text-pretty text-muted-foreground"
                    >
                      {choice.detail}
                    </span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </Field>
        )}
        <Field>
          <FieldLabel id={`${ids}-from`}>From</FieldLabel>
          <Segmented
            aria-label="From"
            size={size}
            className={cn(phone && "w-full")}
            value={from}
            onValueChange={setFrom}
            options={[
              { value: "file", label: "Dump file" },
              { value: "url", label: "Postgres URL" },
            ]}
          />
          {from === "file" ? (
            <>
              <label
                htmlFor={`${ids}-file`}
                className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border border-input px-4 py-2.5 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
              >
                <FileArchiveIcon aria-hidden className="size-4.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-meta">
                  {file === null ? "Choose a dump file…" : file.name}
                </span>
                {file === null ? null : (
                  <span className="shrink-0 text-row text-muted-foreground">
                    {loadBytes(file.size)}
                  </span>
                )}
                <input
                  id={`${ids}-file`}
                  type="file"
                  aria-label="Dump file"
                  className="sr-only"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
              </label>
              <FieldDescription>
                A <span className="font-mono">pg_dump</span> file in custom or plain format. Mend
                replaces everything in the database with it.
              </FieldDescription>
            </>
          ) : (
            <>
              <Input
                type="password"
                aria-label="Postgres URL"
                autoComplete="off"
                value={url}
                placeholder="postgres://user@host/database"
                onChange={(event) => setUrl(event.target.value)}
                className={cn("font-mono", phone && "h-11 text-lead")}
              />
              <FieldDescription>
                Mend's server connects to it and copies the database. It never logs or shows the
                password.
              </FieldDescription>
            </>
          )}
        </Field>
      </form>
    </Overlay>
  );
}
