import { queryOptions } from "@tanstack/react-query";

import { authClient } from "./auth-client.ts";

/**
 * The signed-in account as Settings → Profile changes it, through Better Auth's own endpoints,
 * which the API serves whole under `/api/auth`: the name (`update-user`) and the password
 * (`change-password`). The email can't change: Better Auth's change-email is off, and Mend sends no
 * email to confirm one. Profile reads the name and email from the organization's roster, which the
 * server renders.
 */

/** When the password was set, and last changed; null when the account has none. */
export interface PasswordDates {
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The account's password sign-in, read from Better Auth's own list of the account's sign-ins: a
 * password sign-in's row changes only when its password does.
 */
export const passwordDatesOptions = () =>
  queryOptions({
    queryKey: ["auth", "password-dates"],
    queryFn: async (): Promise<PasswordDates | null> => {
      const accounts = await authClient.listAccounts();
      if (accounts.error !== null) {
        throw new Error(accounts.error.message ?? "Mend couldn't read your sign-ins.");
      }
      const password = accounts.data.find((account) => account.providerId === "credential");
      return password === undefined
        ? null
        : { createdAt: new Date(password.createdAt), updatedAt: new Date(password.updatedAt) };
    },
    staleTime: 60_000,
  });

/** "2 March", with the year when it isn't this one. */
export const dayOf = (date: Date, now: Date): string =>
  date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });

/** The line under Password: when it was last changed, or set if it never was. */
export const passwordLine = (dates: PasswordDates, now: Date): string =>
  // A row written once has the same two times, give or take the write.
  dates.updatedAt.getTime() - dates.createdAt.getTime() < 60_000
    ? `You set it on ${dayOf(dates.createdAt, now)}.`
    : `You last changed it on ${dayOf(dates.updatedAt, now)}.`;

/** Better Auth's shortest password, unless the server sets its own. */
export const MIN_PASSWORD = 8;

/** What is wrong with a name before it is sent, or null. */
export const nameProblem = (name: string): string | null =>
  name.trim() === "" ? "Your name can't be empty." : null;

/** Which field a refusal of a password change belongs beside. */
export interface PasswordRefusal {
  readonly field: "current" | "new" | "form";
  readonly message: string;
}

/** A refusal Better Auth answered, as a person reads it, by its code. */
export const passwordRefusal = (error: {
  readonly code?: string | undefined;
  readonly status?: number | undefined;
  readonly message?: string | undefined;
}): PasswordRefusal => {
  switch (error.code) {
    case "INVALID_PASSWORD":
      return { field: "current", message: "That isn't your current password." };
    case "PASSWORD_TOO_SHORT":
      return { field: "new", message: `Use at least ${MIN_PASSWORD} characters.` };
    case "PASSWORD_TOO_LONG":
      return { field: "new", message: "That password is too long. Use a shorter one." };
    case "CREDENTIAL_ACCOUNT_NOT_FOUND":
      return {
        field: "form",
        message: "This account has no password to change. Ask an owner for a reset link.",
      };
  }
  if (error.status === 429) {
    return { field: "form", message: "Too many tries. Wait a minute, then try again." };
  }
  return {
    field: "form",
    message: `Mend didn't change your password. ${error.message ?? "Check your connection and try again."}`,
  };
};

/** What is wrong with a new password before it is sent, or null. */
export const newPasswordProblem = (current: string, next: string): PasswordRefusal | null => {
  if (current === "") return { field: "current", message: "Enter your current password." };
  if (next.length < MIN_PASSWORD) {
    return { field: "new", message: `Use at least ${MIN_PASSWORD} characters.` };
  }
  if (next === current) {
    return { field: "new", message: "That's your current password. Choose a new one." };
  }
  return null;
};
