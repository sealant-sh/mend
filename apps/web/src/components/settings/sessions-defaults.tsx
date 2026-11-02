import { organizationDefaultSources, type SettingSource } from "@mend/domain";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { focusRing } from "#/components/kit/button";
import { InheritedValue, type InheritSource } from "#/components/kit/inherit-choice";
import { onOff, type DefaultSwitch } from "#/lib/organization-defaults";
import { useTRPC, type TrpcProxy } from "#/lib/trpc";
import { useSignedInQuery } from "#/lib/viewer";
import type { RouterAppContext } from "#/router";

/** The organization's defaults over the instance's; an account in no organization reads none. */
export const organizationDefaultsOptions = (trpc: TrpcProxy) =>
  trpc.organization.settings.queryOptions(undefined, { retry: false });

/**
 * Warm what the inherited rows read: the organization's defaults, or for an account in no
 * organization the instance's.
 */
export const warmInheritedDefaults = async ({ queryClient, trpc }: RouterAppContext) => {
  try {
    await queryClient.ensureQueryData(organizationDefaultsOptions(trpc));
  } catch {
    await queryClient.ensureQueryData(trpc.settings.get.queryOptions());
  }
};

interface Resolved {
  readonly value: (key: DefaultSwitch) => boolean;
  readonly source: (key: DefaultSwitch) => SettingSource;
  readonly organizationName: string | null;
  readonly owner: boolean;
}

/**
 * What a setting resolves to for this person and where it comes from: the organization's own
 * value, else the instance's. Undefined while it is read.
 */
const useResolvedDefaults = (): Resolved | undefined => {
  const trpc = useTRPC();
  const viewer = useSignedInQuery().data;
  const organization = useQuery(organizationDefaultsOptions(trpc));
  const instance = useQuery({
    ...trpc.settings.get.queryOptions(),
    enabled: organization.isError,
  });
  if (organization.data !== undefined) {
    const view = organization.data;
    const sources = organizationDefaultSources(view.organization);
    return {
      value: (key) => view.effective[key],
      source: (key) => sources[key],
      organizationName: viewer?.organization.name ?? null,
      owner: viewer?.role === "owner",
    };
  }
  if (instance.data !== undefined) {
    const settings = instance.data;
    return {
      value: (key) => settings[key],
      source: () => "instance",
      organizationName: null,
      owner: false,
    };
  }
  return undefined;
};

const sourceOf = (source: SettingSource, organizationName: string | null): InheritSource =>
  source === "organization" && organizationName !== null
    ? {
        title: `From ${organizationName}'s organization defaults`,
        detail: `Owners of ${organizationName} set it for every project. A project can set its own on its settings.`,
      }
    : {
        title: "From the instance default",
        detail:
          organizationName === null
            ? "Set by the operator of this machine. A project can set its own on its settings."
            : `Set by the operator of this machine, and ${organizationName} follows it. A project can set its own on its settings.`,
      };

/**
 * Settings this person follows rather than sets: each row's value and, on hover or focus, where
 * it comes from. Owners get a link to the organization's defaults, where they set them.
 */
export function InheritedDefaults({
  rows,
}: {
  readonly rows: ReadonlyArray<{ readonly key: DefaultSwitch; readonly label: string }>;
}) {
  const resolved = useResolvedDefaults();
  if (resolved === undefined) {
    return <p className="py-2.5 font-mono text-[12px] text-faint">reading defaults…</p>;
  }
  return (
    <>
      {rows.map((row) => (
        <InheritedValue
          key={row.key}
          label={row.label}
          resolved={onOff(resolved.value(row.key))}
          source={sourceOf(resolved.source(row.key), resolved.organizationName)}
        />
      ))}
      {resolved.owner ? (
        <p className="mt-2 text-[13px] text-muted-foreground">
          You set these for everyone in {resolved.organizationName} in{" "}
          <Link
            to="/settings/organization/defaults"
            className={`rounded-sm text-info underline-offset-2 hover:underline ${focusRing}`}
          >
            organization defaults
          </Link>
          .
        </p>
      ) : null}
    </>
  );
}
