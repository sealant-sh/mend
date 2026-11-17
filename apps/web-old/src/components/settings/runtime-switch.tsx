import {
  movesAnything,
  offeredMoves,
  runtimeName,
  type RuntimeSwitchMoves,
  type WorkspaceImage,
} from "@mend/domain";
import type { ReactNode } from "react";

import { Button } from "#/components/kit/button";
import { ModalDialog } from "#/components/kit/modal";
import type { OrganizationRuntimeSwitchDto } from "#/lib/api";
import { clockTime } from "#/lib/session-view";
import { OS_LABELS, workspaceImageSummary } from "#/lib/workspace-environment";

type Impact = OrganizationRuntimeSwitchDto["impact"];
type Observed = Extract<Impact, { state: "observed" }>;
type ProjectImpact = Observed["projects"][number];

/** What Mend moves an environment to: an OS family with Mend's default packages. */
const targetWords = (image: WorkspaceImage): string =>
  image.mode === "custom"
    ? workspaceImageSummary(image)
    : `${OS_LABELS[image.os]} with Mend's default packages`;

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

function Row({ name, children }: { readonly name: ReactNode; readonly children: ReactNode }) {
  return (
    <li className="grid gap-0.5 px-3 py-2">
      <span className="font-mono text-[12px] text-ink">{name}</span>
      {children}
    </li>
  );
}

function Fact({ children, why }: { readonly children: ReactNode; readonly why?: string }) {
  return (
    <span className="text-[12.5px] leading-relaxed text-ink-2">
      {children}
      {why === undefined ? null : <span className="text-muted-foreground"> · {why}</span>}
    </span>
  );
}

function ProjectRow({
  project,
  runtime,
}: {
  readonly project: ProjectImpact;
  readonly runtime: string;
}) {
  const environment = project.environment;
  return (
    <Row name={project.name}>
      {environment === null ? null : environment.inherited ? (
        <Fact why={environment.refusal}>
          Follows the organization&apos;s environment, {workspaceImageSummary(environment.from)}
          {environment.to === null ? "" : ", and moves with it"}
        </Fact>
      ) : (
        <Fact why={environment.refusal}>
          {workspaceImageSummary(environment.from)}
          {environment.to === null
            ? `, and ${runtime} runs no environment Mend can move it to`
            : ` → ${targetWords(environment.to)}`}
        </Fact>
      )}
      {project.services.map((service) => (
        <Fact key={`${service.name}:${service.port}`}>
          Service {service.name} on port {service.port} cannot listen: {runtime} holds that port
        </Fact>
      ))}
      {project.serverFolders === null ? null : (
        <Fact why={project.serverFolders.refusal}>
          {plural(project.serverFolders.count, "server folder")}: sessions start without them
        </Fact>
      )}
    </Row>
  );
}

/**
 * What the runtime would not run, as Sealant reported it: the organization's environment, each
 * project the viewer can see, and a count of those they cannot. Pure: the page owns state.
 */
export function RuntimeImpactList({
  impact,
  organization,
}: {
  readonly impact: Observed;
  readonly organization: string;
}) {
  const runtime = runtimeName(impact.runtime);
  const defaultMove = impact.organizationDefault;
  return (
    <ul
      aria-label={`What ${runtime} would not run`}
      className="divide-y divide-rule-faint rounded-lg border border-rule-faint"
    >
      {defaultMove === null ? null : (
        <Row name={`${organization}'s environment`}>
          <Fact why={defaultMove.refusal}>
            {workspaceImageSummary(defaultMove.from)}
            {defaultMove.inherited ? ", from the instance" : ""}
            {defaultMove.to === null ? "" : ` → ${targetWords(defaultMove.to)}`}
          </Fact>
        </Row>
      )}
      {impact.projects.map((project) => (
        <ProjectRow key={project.id} project={project} runtime={runtime} />
      ))}
      {impact.unseen === 0 ? null : (
        <Row name={plural(impact.unseen, "private project")}>
          <Fact>
            {impact.unseen === 1
              ? `Another member's private project uses something ${runtime} does not run. Mend does not name or move it; its creator can change it.`
              : `Other members' private projects use something ${runtime} does not run. Mend does not name or move them; their creators can change them.`}
          </Fact>
        </Row>
      )}
    </ul>
  );
}

/** One line saying what Mend does not know, or that the runtime is not launched here. */
const unknownWords = (impact: Exclude<Impact, { state: "observed" }>, organization: string) =>
  impact.state === "unread"
    ? `Not checked: Mend could not read what the new runtime runs (${impact.reason}), so it cannot tell which projects in ${organization} would stop starting.`
    : `Sealant on this server does not launch ${runtimeName(impact.runtime)} workspaces (observed at ${clockTime(impact.observedAt)}). No new session in ${organization} would start there until it does.`;

export interface RuntimeSwitchBodyProps {
  readonly view: OrganizationRuntimeSwitchDto;
  readonly organization: string;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onSwitch: (moves: RuntimeSwitchMoves | undefined) => void;
}

/**
 * Before the switch: what the new runtime would not run, the moves Mend offers in the same step,
 * and switching without them. Nothing is saved until the owner presses one.
 */
export function RuntimeSwitchBody({
  view,
  organization,
  pending,
  onCancel,
  onSwitch,
}: RuntimeSwitchBodyProps) {
  const { impact } = view;
  const moves = offeredMoves(impact);
  const movable = movesAnything(moves);
  const runtime = view.effective === null ? "the new runtime" : runtimeName(view.effective);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {impact.state === "observed" ? (
        <>
          <p
            role="alert"
            className="border-l-2 border-[var(--sw-amber)] pl-3 text-[13px] leading-relaxed text-ink-2 break-words"
          >
            {runtime} cannot run everything in {organization} as it is, as Sealant reported at{" "}
            {clockTime(impact.observedAt)}. Existing worktrees keep where they run; this is about
            new sessions.
          </p>
          <RuntimeImpactList impact={impact} organization={organization} />
          {movable ? (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              Move and switch gives each environment above the one after its arrow; packages a
              project added are not kept. The next session in each moved project builds it, which
              takes a few minutes the first time. Services and server folders stay as they are.
            </p>
          ) : null}
        </>
      ) : (
        <p
          role="alert"
          className="border-l-2 border-[var(--sw-amber)] pl-3 text-[13px] leading-relaxed text-ink-2 break-words"
        >
          {unknownWords(impact, organization)}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2.5">
        <Button variant="ghost" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant={movable ? "default" : "primary"}
          disabled={pending}
          onClick={() => onSwitch(undefined)}
        >
          {movable ? "Switch without moving" : `Switch to ${runtime} anyway`}
        </Button>
        {movable ? (
          <Button variant="primary" disabled={pending} onClick={() => onSwitch(moves)}>
            {pending ? "Switching…" : "Move and switch"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** The dialog around the body: open while `view` is set. */
export function RuntimeSwitchDialog({
  view,
  ...body
}: Omit<RuntimeSwitchBodyProps, "view"> & { readonly view: OrganizationRuntimeSwitchDto | null }) {
  return (
    <ModalDialog
      open={view !== null}
      onOpenChange={(open) => {
        if (!open && !body.pending) body.onCancel();
      }}
      width={560}
      title={
        view?.effective === null || view === null
          ? "Before new sessions move"
          : `Before new sessions run on ${runtimeName(view.effective)}`
      }
    >
      {view === null ? null : <RuntimeSwitchBody view={view} {...body} />}
    </ModalDialog>
  );
}
