import { Switch } from "@mend/ui/components/ui/switch";
import { toast } from "@mend/ui/components/ui/toast";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { InfoIcon } from "lucide-react";

import {
  isPhone,
  NOTIFICATION_SWITCHES,
  type NotificationSwitch,
  type NotificationValues,
  savedWords,
  withSwitch,
} from "#/lib/notifications";
import { failureWords } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";

import { SettingRow, SettingSection } from "./setting-row.tsx";
import { settingsLink } from "./settings-links.tsx";
import { SettingsPage } from "./settings-page.tsx";

const day = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/**
 * Settings → Account → Notifications (Doop "Settings · Account · Notifications"): what the Mend
 * app on a person's phones tells them about the sessions they started, and which phones those
 * are. Each switch saves the moment it changes. The route's loader read the setting first.
 */
export function NotificationsPage() {
  const trpc = useTRPC();
  const settings = useSuspenseQuery(trpc.devices.notificationSettings.queryOptions()).data;
  return (
    <SettingsPage
      page="a-notifications"
      intro="Mend sends these to the Mend app on your phone, for sessions you started. Switches save as soon as you change them."
    >
      <SettingSection title="Phone notifications">
        {NOTIFICATION_SWITCHES.map((item) => (
          <SwitchRow key={item.key} item={item} values={settings} />
        ))}
      </SettingSection>
      <Phones />
    </SettingsPage>
  );
}

/**
 * One switch. It shows its new position while it saves ("Saving…" beside it), and goes back with
 * a sentence and Try again under it if the save fails. The cache takes the saved answer, so the
 * next switch sends every value as the server now holds it.
 */
function SwitchRow({
  item,
  values,
}: {
  readonly item: NotificationSwitch;
  readonly values: NotificationValues;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const save = useMutation(
    trpc.devices.setNotificationSettings.mutationOptions({
      onSuccess: (saved, sent) => {
        queryClient.setQueryData(trpc.devices.notificationSettings.queryKey(), saved);
        toast.add({ description: savedWords(item.key, sent[item.key]) });
      },
    }),
  );
  const turn = (on: boolean) => {
    const current =
      queryClient.getQueryData(trpc.devices.notificationSettings.queryKey()) ?? values;
    save.mutate(withSwitch(current, item.key, on));
  };
  const wanted = save.isPending ? save.variables[item.key] : values[item.key];
  return (
    <SettingRow
      label={item.label}
      description={item.description}
      note={
        save.isError ? (
          <span role="alert" className="text-destructive">
            Mend didn't save this.{" "}
            {failureWords(save.error, "Check your connection and try again.")} The switch is back to{" "}
            {values[item.key] ? "On" : "Off"}.{" "}
            <button
              type="button"
              className="font-medium text-foreground underline underline-offset-2"
              onClick={() => turn(save.variables[item.key])}
            >
              Try again
            </button>
          </span>
        ) : null
      }
      control={
        <>
          {save.isPending ? (
            <span role="status" className="text-row text-muted-foreground">
              Saving…
            </span>
          ) : null}
          <Switch
            aria-label={item.label}
            checked={wanted}
            disabled={save.isPending}
            onCheckedChange={turn}
          />
        </>
      }
    />
  );
}

/**
 * The phones the Mend app is paired on. Mend sends to each one where the app is signed in and
 * allowed to show notifications; the server keeps no record of when it last sent one.
 */
function Phones() {
  const trpc = useTRPC();
  const devices = useQuery(trpc.devices.list.queryOptions());
  const devicesLink = (
    <Link
      {...settingsLink("a-devices")}
      className="text-primary underline-offset-2 hover:underline"
    >
      Devices and access keys
    </Link>
  );
  const phones = devices.isSuccess ? devices.data.filter((device) => isPhone(device.platform)) : [];
  return (
    <SettingSection
      title="Sent to"
      description="Each phone where the Mend app is signed in as you and allowed to show notifications."
    >
      {devices.isPending ? (
        <p role="status" className="py-3.5 text-row text-muted-foreground max-lg:px-4">
          Reading your phones…
        </p>
      ) : devices.isError ? (
        <p role="alert" className="py-3.5 text-row text-destructive max-lg:px-4">
          Mend couldn't list your phones. {failureWords(devices.error, "Try again.")}{" "}
          <button
            type="button"
            className="font-medium text-foreground underline underline-offset-2"
            onClick={() => void devices.refetch()}
          >
            Try again
          </button>
        </p>
      ) : phones.length === 0 ? (
        <SettingRow
          label="No phones"
          description={<>Pair the Mend app on your phone in {devicesLink} to get notifications.</>}
        />
      ) : (
        phones.map((phone) => (
          <SettingRow
            key={phone.id}
            label={phone.name}
            description={`Mend app, paired ${day.format(new Date(phone.createdAt))}.`}
          />
        ))
      )}
      <div className="mt-3 grid gap-2 text-row text-muted-foreground max-lg:px-4 [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0">
        {phones.length === 0 ? null : (
          <p className="flex gap-2">
            <InfoIcon aria-hidden />
            <span>To get notifications on another phone, pair it in {devicesLink}.</span>
          </p>
        )}
        <p className="flex gap-2">
          <InfoIcon aria-hidden />
          <span>
            Mend doesn't send email. In the browser, sessions that are waiting on you show in the
            sidebar.
          </span>
        </p>
      </div>
    </SettingSection>
  );
}
