import { InlineAlert } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import { cn } from "@mend/ui/lib/utils";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { EllipsisIcon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { brokeredBlockedLine, deliveryTitle, deliveryWords } from "#/lib/access-policies";
import { secretSetLine } from "#/lib/project-environment";
import { readOnlyLine } from "#/lib/project-settings";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";
import { useProjectSettings } from "#/lib/use-project-settings";

import { QueryView } from "../query-view.tsx";
import { ClusterBindingsSection } from "./cluster-bindings-section.tsx";
import {
  ImportDialog,
  RemoveEntryDialog,
  SecretDeliveryDialog,
  SecretDialog,
  type SecretRow,
  VariableDialog,
  type VariableRow,
} from "./environment-dialogs.tsx";
import { SettingSection } from "./setting-row.tsx";
import { SettingsPage } from "./settings-page.tsx";

/** A control's height: the frames' 36px on the desk, a 44px touch target on a phone. */
const CONTROL = "h-9 max-lg:h-11 max-lg:text-base";

/** Which dialog is open, and on what. A counter keys each opening, so a dialog starts fresh. */
type Open =
  | { readonly kind: "variable"; readonly row: VariableRow | null; readonly n: number }
  | { readonly kind: "secret"; readonly row: SecretRow | null; readonly n: number }
  | { readonly kind: "import"; readonly n: number }
  | { readonly kind: "delivery"; readonly row: SecretRow; readonly n: number }
  | null;

type Removing =
  | { readonly lane: "variable"; readonly row: VariableRow }
  | { readonly lane: "secret"; readonly row: SecretRow }
  | null;

/** The control a dialog was opened from, for focus to return to. */
const remember = (event: { readonly currentTarget: HTMLElement }) => event.currentTarget;

/**
 * Settings → a project → Variables and secrets (Doop "Settings · Project · checkout-api ·
 * Variables and secrets"): the project's environment variables, which anyone who can open the
 * project reads, and its secrets, whose values nobody reads back once saved. The project's
 * creator and the organization's owners add, edit, replace, import and remove them; everyone else
 * reads the names (and the variables' values) and who can change them. They belong to this project
 * alone: nothing in the organization or on the server supplies them (docs/adr/0025). On a server
 * that runs workspaces on Kubernetes, the project's cluster bindings follow.
 */
export function ProjectSecretsPage({ projectId }: { readonly projectId: string }) {
  const trpc = useTRPC();
  const { detail, people } = useProjectSettings(projectId);
  const { project, capabilities } = detail;
  const manage = capabilities.manage;
  const variables = useQuery(trpc.environment.environment.queryOptions({ projectId }));
  const secrets = useQuery(trpc.environment.secrets.queryOptions({ projectId }));
  // The project's own Access policy: whether its Brokered secrets may reach a workspace.
  const policy = useQuery(trpc.accessPolicies.project.queryOptions({ projectId }));
  const owner = useSuspenseQuery(signedInOptions(trpc)).data.role === "owner";
  const projectPolicy = policy.isPending || policy.isError ? null : policy.data.policy;
  const [open, setOpen] = useState<Open>(null);
  const [removing, setRemoving] = useState<Removing>(null);
  const opened = useRef(0);
  // Focus goes back to what opened a dialog; a row's menu item is gone by then, so its trigger.
  const focusBack = useRef<HTMLElement | null>(null);
  const openDialog = (next: NonNullable<Open>, from: HTMLElement | null) => {
    focusBack.current = from;
    opened.current += 1;
    setOpen({ ...next, n: opened.current });
  };
  return (
    <SettingsPage
      page="p-secrets"
      project={{ id: project.id, name: project.name }}
      intro={
        manage
          ? `These are the variables and secrets every ${project.name} session gets. Once you save a secret, nobody can read it back here.`
          : `These are the variables and secrets every ${project.name} session gets. Once someone saves a secret, nobody can read it back here. ${readOnlyLine(people)}`
      }
    >
      <SettingSection
        title="Environment variables"
        description={`Anyone who can see ${project.name} can read these.`}
        action={
          manage ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                className={CONTROL}
                onClick={(event) => openDialog({ kind: "import", n: 0 }, remember(event))}
              >
                Import .env file…
              </Button>
              <Button
                variant="outline"
                className={CONTROL}
                onClick={(event) =>
                  openDialog({ kind: "variable", row: null, n: 0 }, remember(event))
                }
              >
                Add variable…
              </Button>
            </div>
          ) : undefined
        }
      >
        <QueryView query={variables}>
          {(snapshot) => (
            <EntryList
              label="Environment variables"
              empty="No variables yet."
              columns={["Name", "Value"]}
              rows={snapshot.variables.map((variable) => ({
                id: variable.id,
                name: variable.name,
                detail: <span className="font-mono">{variable.value}</span>,
                actions: manage
                  ? [
                      {
                        label: "Edit…",
                        run: (from: HTMLElement | null) =>
                          openDialog({ kind: "variable", row: variable, n: 0 }, from),
                      },
                      {
                        label: "Remove…",
                        run: (from: HTMLElement | null) => {
                          focusBack.current = from;
                          setRemoving({ lane: "variable", row: variable });
                        },
                      },
                    ]
                  : [],
              }))}
            />
          )}
        </QueryView>
        {manage ? (
          <div className="grid gap-2 px-4 pt-3 lg:hidden">
            <Button
              variant="outline"
              size="touch"
              onClick={(event) =>
                openDialog({ kind: "variable", row: null, n: 0 }, remember(event))
              }
            >
              Add variable…
            </Button>
            <Button
              variant="outline"
              size="touch"
              onClick={(event) => openDialog({ kind: "import", n: 0 }, remember(event))}
            >
              Import .env file…
            </Button>
          </div>
        ) : null}
      </SettingSection>
      <SettingSection
        title="Secrets"
        description="A Direct secret reaches sessions as an environment variable. A Brokered one reaches them as a placeholder, and the workspace's egress proxy puts the value into one header on requests to the hosts you choose. You can replace a secret, but you can't see it."
        action={
          manage ? (
            <Button
              variant="outline"
              className={CONTROL}
              onClick={(event) => openDialog({ kind: "secret", row: null, n: 0 }, remember(event))}
            >
              Add secret…
            </Button>
          ) : undefined
        }
      >
        <QueryView query={secrets}>
          {(snapshot) => (
            <>
              <BrokeredBlocked
                projectId={project.id}
                line={brokeredBlockedLine(
                  project.name,
                  projectPolicy,
                  snapshot.secrets.filter((secret) => secret.delivery.mode === "brokered").length,
                )}
              />
              <EntryList
                label="Secrets"
                empty="No secrets yet."
                columns={["Name", "Delivery", "Set"]}
                rows={snapshot.secrets.map((secret) => ({
                  id: secret.id,
                  name: secret.name,
                  detail: (
                    <>
                      <span title={deliveryTitle(secret.delivery)} className="max-lg:flex-none">
                        {deliveryWords(secret.delivery)}
                      </span>
                      <span className="text-muted-foreground">
                        {secretSetLine(secret.updatedAt)}
                      </span>
                    </>
                  ),
                  actions: manage
                    ? [
                        {
                          label: "Replace…",
                          run: (from: HTMLElement | null) =>
                            openDialog({ kind: "secret", row: secret, n: 0 }, from),
                        },
                        {
                          label: "Delivery…",
                          run: (from: HTMLElement | null) =>
                            openDialog({ kind: "delivery", row: secret, n: 0 }, from),
                        },
                        {
                          label: "Remove…",
                          run: (from: HTMLElement | null) => {
                            focusBack.current = from;
                            setRemoving({ lane: "secret", row: secret });
                          },
                        },
                      ]
                    : [],
                }))}
              />
            </>
          )}
        </QueryView>
        {manage ? (
          <div className="px-4 pt-3 lg:hidden">
            <Button
              variant="outline"
              size="touch"
              className="w-full"
              onClick={(event) => openDialog({ kind: "secret", row: null, n: 0 }, remember(event))}
            >
              Add secret…
            </Button>
          </div>
        ) : null}
      </SettingSection>
      <ClusterBindingsSection projectId={project.id} projectName={project.name} manage={manage} />
      {open?.kind === "variable" ? (
        <VariableDialog
          key={open.n}
          projectId={project.id}
          projectName={project.name}
          editing={open.row}
          open
          onOpenChange={(next) => {
            if (!next) setOpen(null);
          }}
          finalFocus={focusBack}
        />
      ) : null}
      {open?.kind === "secret" ? (
        <SecretDialog
          key={open.n}
          projectId={project.id}
          projectName={project.name}
          replacing={open.row}
          policy={projectPolicy}
          open
          onOpenChange={(next) => {
            if (!next) setOpen(null);
          }}
          finalFocus={focusBack}
        />
      ) : null}
      {open?.kind === "delivery" ? (
        <SecretDeliveryDialog
          key={open.n}
          projectId={project.id}
          projectName={project.name}
          secret={open.row}
          owner={owner}
          policy={projectPolicy}
          onOpenChange={(next) => {
            if (!next) setOpen(null);
          }}
          finalFocus={focusBack}
        />
      ) : null}
      {open?.kind === "import" ? (
        <ImportDialog
          key={open.n}
          projectId={project.id}
          open
          onOpenChange={(next) => {
            if (!next) setOpen(null);
          }}
          finalFocus={focusBack}
        />
      ) : null}
      <RemoveEntryDialog
        projectId={project.id}
        entry={removing}
        onClose={() => setRemoving(null)}
        finalFocus={focusBack}
      />
    </SettingsPage>
  );
}

interface EntryAction {
  readonly label: string;
  readonly run: (from: HTMLElement | null) => void;
}

/**
 * Variables or secrets as the frames list them: a table with the actions as plain buttons on the
 * desk; under 1024px, each name with its value or when it was set under it and a "…" holding the
 * same actions.
 */
function EntryList({
  label,
  empty,
  columns,
  rows,
}: {
  readonly label: string;
  readonly empty: string;
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly detail: ReactNode;
    readonly actions: ReadonlyArray<EntryAction>;
  }>;
}) {
  const hasActions = rows.some((row) => row.actions.length > 0);
  if (rows.length === 0) {
    return (
      <p className="border-b border-border py-3.5 text-row text-muted-foreground max-lg:px-4">
        {empty}
      </p>
    );
  }
  return (
    <ul aria-label={label}>
      {/* The headings sit in the same boxes as the rows' cells, actions included, so they line up. */}
      <li
        aria-hidden
        className="flex items-center gap-6 border-b border-border py-2.5 text-row text-muted-foreground max-lg:hidden"
      >
        <div className="flex min-w-0 flex-1 items-center gap-6">
          <span className="w-1/3 flex-none">{columns[0]}</span>
          <span className="flex min-w-0 flex-1 items-center gap-6 [&>*]:min-w-0 [&>*]:flex-1">
            {columns.slice(1).map((column) => (
              <span key={column}>{column}</span>
            ))}
          </span>
        </div>
        {hasActions ? <span className={ACTIONS} /> : null}
      </li>
      {rows.map((row) => (
        <li
          key={row.id}
          className="flex items-center gap-6 border-b border-border py-3 max-lg:gap-3 max-lg:px-4"
        >
          <div className="flex min-w-0 flex-1 items-center gap-6 max-lg:flex-col max-lg:items-start max-lg:gap-0.5">
            <span className="w-1/3 flex-none truncate font-mono text-sm max-lg:w-full max-lg:text-base">
              {row.name}
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-6 truncate text-sm max-lg:text-muted-foreground [&>*]:min-w-0 [&>*]:flex-1 [&>*]:truncate">
              {row.detail}
            </span>
          </div>
          {row.actions.length === 0 ? null : (
            <>
              <div className={cn(ACTIONS, "max-lg:hidden")}>
                {row.actions.map((action) => (
                  <Button
                    key={action.label}
                    variant="ghost"
                    size="sm"
                    aria-label={`${action.label.replace("…", "")} ${row.name}`}
                    onClick={(event) => action.run(event.currentTarget)}
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
              <RowMenu name={row.name} actions={row.actions} />
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The desk's actions column: as wide as its buttons, so every row's cells line up. */
const ACTIONS = "flex w-64 flex-none justify-end gap-1";

/**
 * A Brokered secret under a policy that doesn't allow Brokered secrets: every launch is refused
 * until one side changes, so the page says so above the list, with where to change the policy.
 */
function BrokeredBlocked({
  projectId,
  line,
}: {
  readonly projectId: string;
  readonly line: string | null;
}) {
  if (line === null) return null;
  return (
    <InlineAlert tone="warning" title="Sessions won't start." className="mt-3 mb-3 max-lg:mx-4">
      {line}{" "}
      <Link
        to="/projects/$projectId/settings/workspace"
        params={{ projectId }}
        className="text-primary underline-offset-2 hover:underline"
      >
        Open Workspace
      </Link>
    </InlineAlert>
  );
}

/** A row's "…" on a phone, holding the same actions as the desk's buttons. */
function RowMenu({
  name,
  actions,
}: {
  readonly name: string;
  readonly actions: ReadonlyArray<EntryAction>;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        ref={trigger}
        render={
          <Button
            variant="ghost"
            size="icon-touch"
            aria-label={`${name} actions`}
            className="lg:hidden"
          />
        }
      >
        <EllipsisIcon aria-hidden className="size-5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((action) => (
          <DropdownMenuItem key={action.label} onClick={() => action.run(trigger.current)}>
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
