import { Button } from "@mend/ui/components/ui/button";
import { Input } from "@mend/ui/components/ui/input";
import { Spinner } from "@mend/ui/components/ui/spinner";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import {
  MIN_PASSWORD,
  nameProblem,
  newPasswordProblem,
  passwordDatesOptions,
  passwordLine,
  type PasswordRefusal,
  passwordRefusal,
} from "#/lib/account";
import { accountNameOptions, authClient } from "#/lib/auth-client";
import { useServerHost } from "#/lib/online";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";
import { useViewer } from "#/lib/use-viewer";

import { SIGN_OUT_FAILED, useSignOut } from "../account-menu.tsx";
import { PasswordField } from "../auth-fields.tsx";
import { Overlay } from "../projects/overlay.tsx";
import { SettingRow, SettingSection } from "./setting-row.tsx";
import { SettingsPage } from "./settings-page.tsx";

/** A control's height: the frames' 36px on the desk, a 44px touch target on a phone. */
const CONTROL = "h-9 max-lg:h-11 max-lg:text-base";

/**
 * Settings → Account → Profile (Doop "Settings · Account · Profile"): the account's name, which
 * people in the organization see, its email, its password, and signing this browser out. The
 * route's loader read the organization's roster, which names the account, before the page drew.
 */
export function ProfilePage() {
  const trpc = useTRPC();
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  const members = useSuspenseQuery(trpc.organization.members.queryOptions()).data;
  // The roster names every member, the signed-in one included.
  const me = members.find((member) => member.userId === viewer.userId);
  const account = { name: me?.name ?? "", email: me?.email ?? "" };
  return (
    <SettingsPage
      page="a-profile"
      intro="Your name shows on your sessions, messages and comments. You sign in with your email."
    >
      <SettingSection title="Profile">
        <NameRow name={account.name} />
        <SettingRow
          layout="stack"
          label="Email"
          labelFor="profile-email"
          description="You sign in with this email. Mend doesn't send email to it."
          control={
            <Input
              id="profile-email"
              type="email"
              value={account.email}
              readOnly
              className={`${CONTROL} w-80 text-muted-foreground max-lg:w-full`}
            />
          }
        />
        <PasswordRow />
      </SettingSection>
      <SettingSection title="Sign out">
        <SignOutRow />
      </SettingSection>
    </SettingsPage>
  );
}

/**
 * The name, saved when the field is left or Enter is pressed. Better Auth keeps it on the
 * account; the organization's roster and every name in Mend read it from there.
 */
function NameRow({ name }: { readonly name: string }) {
  const { organizationName } = useViewer();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const [draft, setDraft] = useState(name);
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async (next: string) => {
      const result = await authClient.updateUser({ name: next });
      if (result.error !== null) {
        throw new Error(result.error.message ?? "Check your connection and try again.");
      }
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: accountNameOptions().queryKey }),
        queryClient.invalidateQueries(trpc.organization.members.queryFilter()),
      ]),
  });
  const commit = () => {
    const next = draft.trim();
    if (next === name) return;
    const refused = nameProblem(next);
    setProblem(refused);
    if (refused === null) save.mutate(next);
  };
  const note = save.isPending ? (
    <span role="status" className="text-muted-foreground">
      Saving…
    </span>
  ) : problem !== null ? (
    <span role="alert" className="text-destructive">
      {problem}
    </span>
  ) : save.isError ? (
    <span role="alert" className="text-destructive">
      Mend didn't save your name. {save.error.message}{" "}
      <button
        type="button"
        className="font-medium text-foreground underline underline-offset-2"
        onClick={commit}
      >
        Try again
      </button>
    </span>
  ) : save.isSuccess && draft.trim() === name ? (
    <span role="status" className="text-muted-foreground">
      Saved.
    </span>
  ) : null;
  return (
    <SettingRow
      layout="stack"
      label="Name"
      labelFor="profile-name"
      description={`People in ${organizationName} see this name.`}
      note={note}
      control={
        <Input
          id="profile-name"
          value={draft}
          autoComplete="name"
          aria-invalid={problem !== null || save.isError}
          onChange={(event) => {
            setDraft(event.target.value);
            setProblem(null);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") {
              setDraft(name);
              setProblem(null);
            }
          }}
          className={`${CONTROL} w-80 max-lg:w-full`}
        />
      }
    />
  );
}

/** The password: when it was last changed, and Change password…, which opens its dialog. */
function PasswordRow() {
  const dates = useQuery(passwordDatesOptions());
  const [open, setOpen] = useState(false);
  // A line beside the setting, not something to wait for: while it loads, or if Better Auth can't
  // list the account's sign-ins, the row goes without it.
  const description =
    dates.isPending || dates.isError || dates.data === null
      ? undefined
      : passwordLine(dates.data, new Date());
  return (
    <>
      <SettingRow
        layout="stack"
        label="Password"
        description={description}
        control={
          <Button type="button" variant="outline" className={CONTROL} onClick={() => setOpen(true)}>
            Change password…
          </Button>
        }
      />
      <ChangePassword open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * Change password (Better Auth's `change-password`): the current password, then the new one.
 * Other browsers signed in with the old password are signed out; this one stays signed in, and
 * so do paired phones and the mend CLI, which hold their own keys.
 */
function ChangePassword({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [shown, setShown] = useState(false);
  const [refusal, setRefusal] = useState<PasswordRefusal | null>(null);
  const change = useMutation({
    mutationFn: async () => {
      const result = await authClient.changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: true,
      });
      if (result.error !== null) throw passwordRefusal(result.error);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: passwordDatesOptions().queryKey }),
  });
  const close = (keepOpen: boolean) => {
    if (!keepOpen) {
      // Nothing typed stays in the page once the dialog is gone.
      setCurrent("");
      setNext("");
      setShown(false);
      setRefusal(null);
      change.reset();
    }
    onOpenChange(keepOpen);
  };
  const submit = async () => {
    const problem = newPasswordProblem(current, next);
    setRefusal(problem);
    if (problem !== null) return;
    try {
      await change.mutateAsync();
      close(false);
    } catch (error) {
      setRefusal(isRefusal(error) ? error : passwordRefusal({ message: messageOf(error) }));
    }
  };
  const busy = change.isPending;
  return (
    <Overlay
      open={open}
      onOpenChange={close}
      size="md"
      title="Change password"
      description="Other browsers signed in as you are signed out. This browser, your paired phones and the mend CLI stay signed in."
      footer={
        <>
          <Button type="button" variant="outline" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button type="submit" form="change-password" disabled={busy}>
            {busy ? <Spinner aria-hidden /> : null}
            {busy ? "Changing…" : "Change password"}
          </Button>
        </>
      }
    >
      <form
        id="change-password"
        noValidate
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <PasswordField
          id="current-password"
          label="Current password"
          value={current}
          onChange={(value) => {
            setCurrent(value);
            if (refusal?.field === "current") setRefusal(null);
          }}
          autoComplete="current-password"
          problem={refusal?.field === "current" ? refusal.message : undefined}
          shown={shown}
          onToggle={() => setShown((was) => !was)}
        />
        <PasswordField
          id="new-password"
          label="New password"
          value={next}
          onChange={(value) => {
            setNext(value);
            if (refusal?.field === "new") setRefusal(null);
          }}
          autoComplete="new-password"
          hint={`At least ${MIN_PASSWORD} characters.`}
          problem={refusal?.field === "new" ? refusal.message : undefined}
          shown={shown}
          onToggle={() => setShown((was) => !was)}
        />
        {refusal?.field === "form" ? (
          <p role="alert" className="text-row text-destructive">
            {refusal.message}
          </p>
        ) : null}
      </form>
    </Overlay>
  );
}

const isRefusal = (error: unknown): error is PasswordRefusal =>
  typeof error === "object" && error !== null && "field" in error && "message" in error;

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message !== ""
    ? error.message
    : "Check your connection and try again.";

/** Signing this browser out: the others, the phone and the CLI keep their sign-ins. */
function SignOutRow() {
  const host = useServerHost();
  const signOut = useSignOut();
  const leaving = signOut.isPending || signOut.isSuccess;
  const where = host === "" ? "this server" : host;
  return (
    <SettingRow
      layout="stack"
      label="This browser"
      description={
        <>
          You're signed in to {where}. Your phone and the mend CLI stay signed in. You can sign them
          out in{" "}
          <Link
            to="/settings/devices"
            className="text-foreground underline-offset-2 hover:underline"
          >
            Devices and access keys
          </Link>
          .
        </>
      }
      note={
        signOut.isError ? (
          <span role="alert" className="text-destructive">
            {SIGN_OUT_FAILED}
          </span>
        ) : null
      }
      control={
        <Button
          type="button"
          variant="outline"
          className={CONTROL}
          disabled={leaving}
          onClick={() => signOut.mutate()}
        >
          {leaving ? "Signing out…" : "Sign out"}
        </Button>
      }
    />
  );
}
