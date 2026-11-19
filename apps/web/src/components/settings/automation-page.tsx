import { Switch } from "@mend/ui/components/ui/switch";
import { toast } from "@mend/ui/components/ui/toast";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import {
  type AutomationKey,
  type AutomationSwitch,
  LANDING_SWITCH,
  REVIEW_SWITCHES,
  SETTLE_SWITCH,
  savedWords,
  withSwitch,
} from "#/lib/automation";
import { failureWords } from "#/lib/refusal";
import { sendInTurn } from "#/lib/serial-writes";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

import { SettingRow, SettingSection } from "./setting-row.tsx";
import { SettingsPage } from "./settings-page.tsx";

/** The frame words some lines shorter on a phone: the desk's words, and the phone's. */
function Worded({ desk, phone }: { readonly desk: string; readonly phone: string }) {
  return (
    <>
      <span className="max-lg:hidden">{desk}</span>
      <span className="lg:hidden">{phone}</span>
    </>
  );
}

/**
 * Settings → Account → Your automation (Doop "Settings · Account · Your automation"): what Mend
 * does in your sessions without being asked, as plain switches saved to your account. Nothing
 * inherits (docs/adr/0025): there is no Inherit and no organization value. Each switch saves the
 * moment it changes. The route's loader read both documents first.
 */
export function AutomationPage() {
  const trpc = useTRPC();
  const automation = useSuspenseQuery(trpc.platform.automation.queryOptions()).data.own;
  const settle = useSuspenseQuery(trpc.platform.settleSettings.queryOptions()).data;
  return (
    <SettingsPage
      page="a-automation"
      intro={
        <Worded
          desk="What Mend does on its own in your sessions. These are saved to your account, so they apply in every organization and project. Switches save as soon as you change them."
          phone="What Mend does on its own in your sessions, in every organization and project. Switches save as soon as you change them."
        />
      }
    >
      <SettingSection
        title="Review"
        description="Mend looks at the change after each turn, using your agent login."
      >
        {REVIEW_SWITCHES.map((item) => (
          <AutomationRow key={item.key} item={item} on={automation[item.key]} />
        ))}
      </SettingSection>
      <SettingSection
        title="Landing"
        description={
          <Worded
            desk="Mend only lands after you ask for a change, not after a question. It opens a pull request but doesn't merge it."
            phone="Mend only lands after you ask for a change. It opens a pull request but doesn't merge it."
          />
        }
      >
        <AutomationRow
          item={LANDING_SWITCH}
          on={automation.autoLand}
          more={
            <Worded
              desk="New sessions start from this choice in the composer. You can change it there for one session, and that session keeps what you picked."
              phone="New sessions start from this choice. You can change it in the composer for one session."
            />
          }
        />
      </SettingSection>
      <SettingSection title="T3 Code" description="For sessions you work on from T3 Code.">
        <SettleRow on={settle.stopSessionOnSettle} />
      </SettingSection>
    </SettingsPage>
  );
}

/**
 * One of the automation switches. Saves on one account document go out one after another, each
 * built from what the server answered to the one before, so turning two switches quickly never
 * undoes the first.
 */
function AutomationRow({
  item,
  on,
  more,
}: {
  readonly item: AutomationSwitch;
  readonly on: boolean;
  readonly more?: ReactNode;
}) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const key = trpc.platform.automation.queryKey();
  const save = (wanted: boolean) =>
    sendInTurn(
      queryClient,
      "platform.automation",
      () => {
        const held = queryClient.getQueryData(key)?.own;
        if (held === undefined) throw new Error("Mend hasn't read your automation yet.");
        return client.platform.setAutomation.mutate(withSwitch(held, item.key, wanted));
      },
      (saved) => queryClient.setQueryData(key, saved),
    );
  return (
    <SwitchRow
      label={item.label}
      description={item.description}
      more={more}
      on={on}
      save={save}
      savedKey={item.key}
    />
  );
}

/** Whether settling a thread in T3 Code stops its session: the person's settle settings. */
function SettleRow({ on }: { readonly on: boolean }) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const key = trpc.platform.settleSettings.queryKey();
  const save = (wanted: boolean) =>
    sendInTurn(
      queryClient,
      "platform.settleSettings",
      () => client.platform.setSettleSettings.mutate({ stopSessionOnSettle: wanted }),
      (saved) => queryClient.setQueryData(key, saved),
    );
  return (
    <SwitchRow
      label={SETTLE_SWITCH.label}
      description={SETTLE_SWITCH.description}
      on={on}
      save={save}
      savedKey="stopSessionOnSettle"
    />
  );
}

/**
 * A switch row. It shows its new position while it saves ("Saving…" beside it), says so in a toast
 * once saved, and goes back with a sentence and Try again under it if the save fails.
 */
function SwitchRow({
  label,
  description,
  more,
  on,
  save,
  savedKey,
}: {
  readonly label: string;
  readonly description: string;
  readonly more?: ReactNode;
  readonly on: boolean;
  readonly save: (wanted: boolean) => Promise<unknown>;
  readonly savedKey: AutomationKey | "stopSessionOnSettle";
}) {
  const mutation = useMutation({
    mutationFn: save,
    onSuccess: (_saved, wanted) => {
      toast.add({ description: savedWords(savedKey, wanted) });
    },
  });
  const wanted = mutation.isPending ? mutation.variables : on;
  return (
    <SettingRow
      label={label}
      description={description}
      note={
        more === undefined && !mutation.isError ? null : (
          <>
            {more === undefined ? null : <p className="text-muted-foreground">{more}</p>}
            {mutation.isError ? (
              <p role="alert" className="mt-1 text-destructive">
                Mend didn't save this.{" "}
                {failureWords(mutation.error, "Check your connection and try again.")} The switch is
                back to {on ? "On" : "Off"}.{" "}
                <button
                  type="button"
                  className="font-medium text-foreground underline underline-offset-2"
                  onClick={() => mutation.mutate(mutation.variables)}
                >
                  Try again
                </button>
              </p>
            ) : null}
          </>
        )
      }
      control={
        <>
          {mutation.isPending ? (
            <span role="status" className="text-row text-muted-foreground">
              Saving…
            </span>
          ) : null}
          <Switch
            aria-label={label}
            checked={wanted}
            disabled={mutation.isPending}
            onCheckedChange={(next) => mutation.mutate(next)}
          />
        </>
      }
    />
  );
}
