import type { WorktreeId } from "@mend/domain";
import { resourceAdditionOf, type ResourceAdded } from "@mend/domain/workbench";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button, Pick } from "#/components/kit/button";
import { Field, FieldPair, GroupField, TextInput } from "#/components/kit/field";
import { FuzzyFinder } from "#/components/kit/finder";
import { Icon } from "#/components/kit/icons";
import { ModalDialog } from "#/components/kit/modal";
import { Segment } from "#/components/kit/segment";
import { addResource } from "#/lib/resources";
import { useTRPC } from "#/lib/trpc";

type Kind = "postgres" | "redis" | "mysql" | "image";

const DEFAULT_VERSION: Readonly<Record<Exclude<Kind, "image">, string>> = {
  postgres: "17",
  redis: "8",
  mysql: "8.4",
};

/**
 * Add a resource: writes its declaration into a worktree's `.mend/mend.toml` and starts nothing.
 * With no worktree to write to, Mend answers with the table to copy instead.
 */
export function AddResourceDialog({
  projectId,
  worktrees,
}: {
  readonly projectId: string;
  readonly worktrees: ReadonlyArray<{ readonly id: WorktreeId; readonly name: string }>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <ModalDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button>
          <Icon name="plus" size={14} />
          Add a resource
        </Button>
      }
      title="Add a resource"
      description="Writes the resource into a worktree's .mend/mend.toml. Nothing starts until someone starts it."
      width={520}
    >
      {open ? (
        <AddResourceForm
          projectId={projectId}
          worktrees={worktrees}
          onDone={() => setOpen(false)}
        />
      ) : null}
    </ModalDialog>
  );
}

function AddResourceForm({
  projectId,
  worktrees,
  onDone,
}: {
  readonly projectId: string;
  readonly worktrees: ReadonlyArray<{ readonly id: WorktreeId; readonly name: string }>;
  readonly onDone: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [worktreeId, setWorktreeId] = useState<WorktreeId | null>(worktrees[0]?.id ?? null);
  const [name, setName] = useState("db");
  const [kind, setKind] = useState<Kind>("postgres");
  const [version, setVersion] = useState("17");
  const [image, setImage] = useState("");
  const [ports, setPorts] = useState("");
  const worktree = worktrees.find((row) => row.id === worktreeId);

  const add = useMutation({
    mutationFn: async (): Promise<ResourceAdded> => {
      const parsed = resourceAdditionOf([
        name,
        ...(kind === "image"
          ? [
              "--image",
              image,
              ...ports
                .split(/[\s,]+/)
                .filter(Boolean)
                .flatMap((port) => ["--port", port]),
            ]
          : ["--preset", kind, "--version", version]),
      ]);
      if (!parsed.ok) throw new Error(parsed.message);
      const result = await addResource(projectId, {
        worktreeId: worktree?.id ?? null,
        definition: parsed.definition,
      });
      if (!result.ok) throw new Error(result.message);
      return result.result;
    },
    onSuccess: (answer) => {
      if (answer.kind === "written")
        void queryClient.invalidateQueries(trpc.resources.pathFilter());
    },
  });

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!add.isPending) add.mutate();
      }}
    >
      <GroupField label="Write into">
        {worktrees.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            This project has no worktree to write to; Mend answers with the table to copy.
          </p>
        ) : (
          <FuzzyFinder
            label="Write into worktree"
            items={worktrees}
            itemKey={(row) => row.id}
            itemText={(row) => row.name}
            onPick={(row) => setWorktreeId(row.id)}
            placeholder="Find a worktree"
            trigger={
              <Pick className="w-fit font-mono" disabled={add.isPending}>
                {worktree?.name ?? "Choose a worktree"}
              </Pick>
            }
          />
        )}
      </GroupField>
      <GroupField label="Definition">
        <Segment
          label="Definition"
          value={kind}
          disabled={add.isPending}
          options={[
            { value: "postgres", label: "Postgres" },
            { value: "redis", label: "Redis" },
            { value: "mysql", label: "MySQL" },
            { value: "image", label: "Image" },
          ]}
          onChange={(next) => {
            setKind(next);
            if (next !== "image") setVersion(DEFAULT_VERSION[next]);
          }}
        />
      </GroupField>
      <FieldPair columns={kind === "image" ? "1fr 2fr" : "1fr 1fr"}>
        <Field label="Name">
          {(id) => (
            <TextInput
              id={id}
              required
              value={name}
              disabled={add.isPending}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        {kind === "image" ? (
          <Field label="Image">
            {(id) => (
              <TextInput
                id={id}
                required
                value={image}
                placeholder="axllent/mailpit:v1.21"
                disabled={add.isPending}
                onChange={(event) => setImage(event.target.value)}
              />
            )}
          </Field>
        ) : (
          <Field label="Version">
            {(id) => (
              <TextInput
                id={id}
                required
                value={version}
                disabled={add.isPending}
                onChange={(event) => setVersion(event.target.value)}
              />
            )}
          </Field>
        )}
      </FieldPair>
      {kind === "image" ? (
        <Field label="Ports">
          {(id) => (
            <TextInput
              id={id}
              required
              value={ports}
              placeholder="smtp=1025 http=8025"
              disabled={add.isPending}
              onChange={(event) => setPorts(event.target.value)}
            />
          )}
        </Field>
      ) : null}
      <p role="alert" className="font-mono text-[12px] text-danger empty:hidden">
        {add.isError ? add.error.message : ""}
      </p>
      {add.data === undefined ? null : (
        <div role="status" className="grid gap-2">
          <p className="font-mono text-[12px] text-foreground">{add.data.statusLine}</p>
          {add.data.kind === "written" ? null : (
            <pre className="overflow-x-auto rounded-[10px] bg-secondary p-3 font-mono text-[12px] text-ink-2">
              {add.data.table}
            </pre>
          )}
        </div>
      )}
      <div className="flex items-center justify-end gap-2.5">
        <Button variant="ghost" onClick={onDone} disabled={add.isPending}>
          {add.data === undefined ? "Cancel" : "Close"}
        </Button>
        <Button type="submit" variant="primary" disabled={add.isPending}>
          {add.isPending
            ? "Writing…"
            : worktree === undefined
              ? "Show the table to copy"
              : "Write the declaration"}
        </Button>
      </div>
    </form>
  );
}
