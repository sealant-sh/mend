import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "#/components/kit/button";
import { Field, FieldPair, GroupField, TextInput } from "#/components/kit/field";
import { ModalDialog } from "#/components/kit/modal";
import { Panel, SettingsSection } from "#/components/kit/section";
import { Segment } from "#/components/kit/segment";
import { SwitchRow } from "#/components/kit/switch";
import { DataTable } from "#/components/kit/table";
import {
  addProjectRecipe,
  removeProjectRecipe,
  type ProjectDetailDto,
  type ServiceRecipeDto,
} from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

import type { SettingsReads } from "./reads";

/** What the Services tab reads before it shows. */
export const servicesReads: SettingsReads = ({ queryClient, trpc }, projectId) => [
  queryClient.ensureQueryData(trpc.projects.recipes.queryOptions({ id: projectId })),
];

/** How a browser reaches the port: a raw port, or a preview over http or https. */
const protocolWords = (recipe: ServiceRecipeDto): string =>
  recipe.protocol === "udp" ? "udp" : (recipe.browserScheme ?? "raw");

const mono = "font-mono text-[12px] text-ink-2";

/**
 * Project settings · Services (screen L3): commands a session can run and expose on a port, each
 * one tap away in every session beside what `.mend/mend.toml` declares. A service with no command
 * adopts a port something already listens on.
 */
export function ServicesSettings({ detail }: { readonly detail: ProjectDetailDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const projectId = detail.project.id;
  const recipes = useSuspenseQuery(trpc.projects.recipes.queryOptions({ id: projectId })).data;
  const remove = useMutation({
    mutationFn: (name: string) => removeProjectRecipe(projectId, name),
    onSettled: () => queryClient.invalidateQueries(trpc.projects.recipes.queryFilter()),
  });
  const removing = remove.isPending ? remove.variables : null;
  if (!detail.capabilities.manage)
    return (
      <Panel className="px-[26px] py-6">
        <p className="text-[13.5px] text-ink-2">
          The project&apos;s creator or an organization owner declares its services.
        </p>
      </Panel>
    );

  return (
    <Panel>
      <SettingsSection
        title="Services"
        why={
          <>
            Commands a session can run with a port; each gets a preview. Sessions also offer what{" "}
            <span className="font-mono text-[12px]">.mend/mend.toml</span> declares.
          </>
        }
      >
        <DataTable
          label="Services"
          className="-mx-4 -mt-1"
          columns={[
            { head: "Name", width: "0.5fr" },
            { head: "Command", width: "2fr" },
            { head: "Port", width: "0.5fr" },
            { head: "Protocol", width: "0.6fr" },
            { head: "", width: "auto" },
          ]}
          empty="No services declared here yet."
          rows={recipes.map((recipe) => ({
            key: recipe.name,
            cells: [
              <span key="name" className={mono}>
                {recipe.name}
              </span>,
              <span key="command" className={`${mono} block truncate`} title={recipe.command ?? ""}>
                {recipe.command ?? <span className="text-faint">adopts a listening port</span>}
              </span>,
              <span key="port" className={mono}>
                :{recipe.port}
              </span>,
              <span key="protocol" className={mono}>
                {protocolWords(recipe)}
              </span>,
              <Button
                key="remove"
                size="sm"
                variant="ghost"
                aria-label={`Remove ${recipe.name}`}
                disabled={removing !== null}
                onClick={() => remove.mutate(recipe.name)}
              >
                {removing === recipe.name ? "Removing…" : "Remove"}
              </Button>,
            ],
          }))}
        />
        <p role="alert" className="mt-2 font-mono text-[11.5px] text-danger empty:hidden">
          {remove.isError ? `${remove.variables} was not removed: ${remove.error.message}` : ""}
        </p>
        <div className="mt-2.5">
          <DeclareService projectId={projectId} taken={recipes.map((recipe) => recipe.name)} />
        </div>
      </SettingsSection>
    </Panel>
  );
}

type Browser = "raw" | "http" | "https";

/** "Declare a service": a name, an optional command, a port, and how a browser reaches it. */
function DeclareService({
  projectId,
  taken,
}: {
  readonly projectId: string;
  readonly taken: ReadonlyArray<string>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <ModalDialog
      open={open}
      onOpenChange={setOpen}
      width={520}
      trigger={<Button size="sm">Declare a service</Button>}
      title="Declare a service"
      description="Every session in this project offers it. Leave the command empty to adopt a port something already listens on."
    >
      {open ? (
        <DeclareServiceForm projectId={projectId} taken={taken} onDone={() => setOpen(false)} />
      ) : null}
    </ModalDialog>
  );
}

function DeclareServiceForm({
  projectId,
  taken,
  onDone,
}: {
  readonly projectId: string;
  readonly taken: ReadonlyArray<string>;
  readonly onDone: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [port, setPort] = useState("");
  const [browser, setBrowser] = useState<Browser>("http");
  const [udp, setUdp] = useState(false);
  const declare = useMutation({
    mutationFn: () =>
      addProjectRecipe(projectId, {
        name: name.trim(),
        command: command.trim() === "" ? null : command.trim(),
        port: Number(port.trim()),
        protocol: udp ? "udp" : "tcp",
        browserScheme: udp || browser === "raw" ? null : browser,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries(trpc.projects.recipes.queryFilter({ id: projectId }));
      onDone();
    },
  });
  const portNumber = Number(port.trim());
  const portIssue =
    port.trim() === ""
      ? null
      : !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535
        ? "A port is a whole number from 1 to 65535."
        : null;
  const nameIssue = taken.includes(name.trim()) ? `${name.trim()} is already declared.` : null;
  const ready =
    name.trim() !== "" && port.trim() !== "" && portIssue === null && nameIssue === null;

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !declare.isPending) declare.mutate();
      }}
    >
      <FieldPair columns="1fr 1fr">
        <Field label="Name">
          {(id) => (
            <>
              <TextInput
                id={id}
                autoFocus
                value={name}
                placeholder="web"
                spellCheck={false}
                aria-invalid={nameIssue !== null || undefined}
                aria-describedby={`${id}-issue`}
                onChange={(event) => setName(event.target.value)}
              />
              <p id={`${id}-issue`} className="text-[12.5px] text-danger empty:hidden">
                {nameIssue}
              </p>
            </>
          )}
        </Field>
        <Field label="Port">
          {(id) => (
            <>
              <TextInput
                id={id}
                value={port}
                inputMode="numeric"
                placeholder="3000"
                aria-invalid={portIssue !== null || undefined}
                aria-describedby={`${id}-issue`}
                onChange={(event) => setPort(event.target.value)}
              />
              <p id={`${id}-issue`} className="text-[12.5px] text-danger empty:hidden">
                {portIssue}
              </p>
            </>
          )}
        </Field>
      </FieldPair>
      <Field label="Command">
        {(id) => (
          <TextInput
            id={id}
            value={command}
            placeholder="pnpm dev · empty adopts a listening port"
            spellCheck={false}
            onChange={(event) => setCommand(event.target.value)}
          />
        )}
      </Field>
      {udp ? null : (
        <GroupField label="In a browser">
          <Segment
            label="In a browser"
            value={browser}
            onChange={setBrowser}
            options={[
              { value: "http", label: "http" },
              { value: "https", label: "https" },
              { value: "raw", label: "Raw port" },
            ]}
          />
        </GroupField>
      )}
      <SwitchRow
        label="UDP"
        detail="A UDP port has no preview."
        checked={udp}
        onCheckedChange={setUdp}
      />
      <p role="alert" className="font-mono text-[11.5px] text-danger empty:hidden">
        {declare.isError ? `The service was not declared: ${declare.error.message}` : ""}
      </p>
      <div className="flex items-center justify-end gap-2.5">
        <Button variant="ghost" onClick={onDone} disabled={declare.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!ready || declare.isPending}>
          {declare.isPending ? "Declaring…" : "Declare service"}
        </Button>
      </div>
    </form>
  );
}
