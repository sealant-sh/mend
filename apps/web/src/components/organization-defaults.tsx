import { organizationDefaultSources } from "@mend/domain";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { ErrorLine, Panel, QuietButton, describe } from "#/components/organization-settings";
import { WorkspaceEnvironmentEditor } from "#/components/workspace-environment-editor";
import {
  putOrganizationSettings,
  saveOrganizationWorkspaceEnvironment,
  type OrganizationSettingsViewDto,
  type OrganizationViewDto,
} from "#/lib/api";
import {
  appliesLine,
  DEFAULT_SWITCHES,
  defaultsAccess,
  onOff,
  sourceWord,
  type DefaultSwitch,
} from "#/lib/organization-defaults";
import { useTRPC, type TrpcProxy } from "#/lib/trpc";
import { workspaceImageSummary } from "#/lib/workspace-environment";

/** Every read a default feeds: the instance's document, and what organizations inherit from it. */
export const invalidateDefaults = (queryClient: QueryClient, trpc: TrpcProxy) =>
  Promise.all([
    queryClient.invalidateQueries(trpc.settings.pathFilter()),
    queryClient.invalidateQueries(trpc.organization.settings.queryFilter()),
  ]);

const CHOICE =
  "rounded-xl border px-3.5 py-1.5 font-sans text-xs font-medium shadow-xs transition-colors disabled:opacity-60";
const CHOSEN =
  "border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash text-foreground";
const UNCHOSEN = "border-border bg-card text-muted-foreground hover:text-foreground";

/**
 * The instance's defaults, which only the operator sees (docs/adr/0003, "Operator" and
 * "Interface"): anyone else gets nothing here, not editors that refuse.
 */
export function InstanceDefaults({
  view,
  children,
}: {
  readonly view: OrganizationViewDto | undefined;
  readonly children: ReactNode;
}) {
  if (!defaultsAccess(view).instance) return null;
  return (
    <>
      <div className="pt-4">
        <p className="ev-eyebrow">instance · operator</p>
        <p className="mt-2 max-w-[64ch] text-sm leading-relaxed text-muted-foreground">
          Defaults for this whole Mend. A project inherits them where its organization sets none of
          its own.
        </p>
      </div>
      {children}
    </>
  );
}

/**
 * The defaults every project in the caller's organization inherits. Owners set them over the
 * instance's; members read them with where each came from. Nothing renders outside an
 * organization.
 */
export function OrganizationDefaults() {
  const trpc = useTRPC();
  const current = useQuery(
    trpc.organization.current.queryOptions(undefined, { retry: false }),
  ).data;
  const settings = useQuery(
    trpc.organization.settings.queryOptions(undefined, { retry: false }),
  ).data;
  if (current === undefined || settings === undefined) return null;
  const name = current.organization.name;
  return (
    <>
      <OrganizationEnvironmentPanel view={settings} organizationName={name} />
      <OrganizationSwitchesPanel view={settings} organizationName={name} />
    </>
  );
}

function OrganizationEnvironmentPanel({
  view,
  organizationName,
}: {
  readonly view: OrganizationSettingsViewDto;
  readonly organizationName: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [customizing, setCustomizing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const own = view.organization.workspaceImage;
  const inherited = sourceWord(own === null ? "instance" : "organization", organizationName);

  const followInstance = () => {
    setPending(true);
    setError(null);
    setCustomizing(false);
    void saveOrganizationWorkspaceEnvironment(null)
      .then((result) =>
        queryClient.setQueryData(
          trpc.organization.settings.queryOptions().queryKey,
          result.settings,
        ),
      )
      .catch((cause: unknown) => setError(describe(cause)))
      .finally(() => setPending(false));
  };

  return (
    <section
      id="organization-environment"
      className="rounded-2xl bg-panel p-6 shadow-[var(--shadow-sm)]"
    >
      <h2 className="font-sans text-sm font-semibold">
        Workspace environment · {organizationName}
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
        {appliesLine(organizationName)} Applied whenever a session starts or resumes; workspaces
        already running are unchanged.
      </p>
      {view.editable && (own !== null || customizing) ? (
        <WorkspaceEnvironmentEditor
          savedImage={own ?? view.effective.workspaceImage}
          allowScan={false}
          onSave={async (image) => {
            const result = await saveOrganizationWorkspaceEnvironment(image);
            queryClient.setQueryData(
              trpc.organization.settings.queryOptions().queryKey,
              result.settings,
            );
            return {
              saved: result.saved ? result.settings.organization.workspaceImage : null,
              resolutions: result.resolutions,
            };
          }}
          secondaryAction={
            own === null ? (
              <QuietButton onClick={() => setCustomizing(false)}>Cancel</QuietButton>
            ) : (
              <QuietButton disabled={pending} onClick={followInstance}>
                {pending ? "Saving…" : "Follow the instance"}
              </QuietButton>
            )
          }
        />
      ) : (
        <div className="mt-5 flex items-center justify-between gap-4 border-t border-[var(--sw-faint-rule)] pt-5">
          <p className="font-mono text-[12.5px] text-ink-2">
            {workspaceImageSummary(view.effective.workspaceImage)} · {inherited}
          </p>
          {view.editable ? (
            <button
              type="button"
              onClick={() => setCustomizing(true)}
              className="inline-flex min-h-9 shrink-0 items-center justify-center rounded-xl border border-border bg-panel px-3.5 font-sans text-[13px] font-medium text-foreground shadow-[var(--shadow-xs)] transition-[transform,border-color] hover:-translate-y-0.5 hover:border-input"
            >
              Set for {organizationName}
            </button>
          ) : null}
        </div>
      )}
      {error === null ? null : (
        <div className="mt-4">
          <ErrorLine error={error} />
        </div>
      )}
    </section>
  );
}

function OrganizationSwitchesPanel({
  view,
  organizationName,
}: {
  readonly view: OrganizationSettingsViewDto;
  readonly organizationName: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<DefaultSwitch | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = (key: DefaultSwitch, value: boolean | null) => {
    if (view.organization[key] === value) return;
    setPending(key);
    setError(null);
    void putOrganizationSettings({ ...view.organization, [key]: value })
      .then((saved) =>
        queryClient.setQueryData(trpc.organization.settings.queryOptions().queryKey, saved),
      )
      .catch((cause: unknown) => setError(describe(cause)))
      .finally(() => setPending(null));
  };

  return (
    <OrganizationSwitches
      view={view}
      organizationName={organizationName}
      pending={pending}
      error={error}
      onChoose={choose}
    />
  );
}

/**
 * The switches as a viewer sees them. An owner picks the instance's value, on or off for each; a
 * member reads each value and where it came from.
 */
export function OrganizationSwitches({
  view,
  organizationName,
  pending,
  error,
  onChoose,
}: {
  readonly view: OrganizationSettingsViewDto;
  readonly organizationName: string;
  readonly pending: DefaultSwitch | null;
  readonly error: string | null;
  readonly onChoose: (key: DefaultSwitch, value: boolean | null) => void;
}) {
  const sources = organizationDefaultSources(view.organization);
  return (
    <Panel
      id="organization-defaults"
      title={`Defaults · ${organizationName}`}
      description={`${appliesLine(organizationName)} "Instance" follows this Mend's own defaults.`}
    >
      {DEFAULT_SWITCHES.map((row) => {
        const own = view.organization[row.key];
        const choices: ReadonlyArray<{ readonly value: boolean | null; readonly label: string }> = [
          { value: null, label: `Instance · ${onOff(view.instance[row.key])}` },
          { value: true, label: "On" },
          { value: false, label: "Off" },
        ];
        return (
          <div key={row.key} className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="font-sans text-sm font-medium text-foreground">{row.label}</p>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{row.detail}</p>
            </div>
            {view.editable ? (
              <div className="flex shrink-0 gap-2">
                {choices.map((choice) => (
                  <button
                    key={String(choice.value)}
                    type="button"
                    disabled={pending !== null}
                    aria-pressed={own === choice.value}
                    onClick={() => onChoose(row.key, choice.value)}
                    className={`${CHOICE} ${own === choice.value ? CHOSEN : UNCHOSEN}`}
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
            ) : (
              <p className="shrink-0 font-mono text-[12.5px] text-ink-2">
                {onOff(view.effective[row.key])} · {sourceWord(sources[row.key], organizationName)}
              </p>
            )}
          </div>
        );
      })}
      <ErrorLine error={error} />
    </Panel>
  );
}
