/**
 * The pure parts of signing in and first contact: where sign-in returns to, what the account
 * fields must hold before the server sees them, and how a failed sign-in reads. Kept free of React
 * so they are testable as plain functions. Copied from the old app's `lib/onboarding.ts`.
 */

/** Better Auth's own floor; checking it here names the problem before a round trip. */
export const MIN_PASSWORD_LENGTH = 8;

/** The four setup steps a new person goes through before the app opens (the Setup steps). */
export const SETUP_STEPS = ["Account", "Git access", "Agent login", "First project"] as const;

/**
 * Where to walk after signing in. Keep a same-origin root-relative path unchanged;
 * full URLs, authority prefixes and invalid URLs fall back to the workbench.
 */
export const safeNextPath = (value: unknown): string => {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  // URL parsing removes tabs and newlines and treats backslashes as slashes in HTTP URLs.
  // Refuse authority prefixes even when their host matches the validation origin below.
  if (/^\/[\t\r\n]*[\\/]/.test(value)) return "/";
  try {
    const origin = "https://mend.invalid";
    return new URL(value, origin).origin === origin ? value : "/";
  } catch {
    return "/";
  }
};

/**
 * The page sign-in returns to. The app's own walk carries it in the fragment (`#next=`, so it never
 * reaches a server log); the API's `/preview-auth` sends it in the query (`?next=`).
 */
export const continuationOf = (location: {
  readonly search: string;
  readonly hash: string;
}): string => {
  const walked = new URLSearchParams(location.hash.replace(/^#/, "")).get("next");
  const sentByTheApi = new URLSearchParams(location.search).get("next");
  return safeNextPath(walked ?? sentByTheApi);
};

/** The fields of the account forms, each with its own problem. */
export type AccountField = "email" | "password" | "confirm";
export type AccountProblems = Partial<Record<AccountField, string>>;

/** Enough of an address to send: something, an `@`, and a domain with a dot. */
const WHOLE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const emailProblem = (email: string): string | null => {
  const trimmed = email.trim();
  if (trimmed === "") return "Enter your email address.";
  return WHOLE_EMAIL.test(trimmed) ? null : "Enter a whole email address, like ada@example.com.";
};

export const passwordProblem = (password: string): string | null => {
  if (password === "") return "Enter a password.";
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters. This one has ${password.length}.`;
  }
  return null;
};

export const confirmProblem = (password: string, confirm: string): string | null =>
  confirm === password ? null : "The passwords don't match.";

/**
 * Every problem a new password and its confirmation have, and the email when the form asks for
 * one. Empty when the form can be sent.
 */
export const accountProblems = (form: {
  readonly email?: string;
  readonly password: string;
  readonly confirm: string;
}): AccountProblems => {
  const problems: AccountProblems = {};
  const email = form.email === undefined ? null : emailProblem(form.email);
  const password = passwordProblem(form.password);
  const confirm = password === null ? confirmProblem(form.password, form.confirm) : null;
  if (email !== null) problems.email = email;
  if (password !== null) problems.password = password;
  if (confirm !== null) problems.confirm = confirm;
  return problems;
};

/** The line beside the submit button while fields need fixing. */
export const fixFieldsNote = (count: number): string =>
  count === 1 ? "Fix the field above to continue." : `Fix the ${count} fields above to continue.`;

/** What an auth request's failure means to the person who sent it. */
export type AuthFailure =
  | { readonly kind: "wrong-credentials" }
  | { readonly kind: "unreachable" }
  | { readonly kind: "refused"; readonly message: string };

/**
 * Better Auth answers a refusal as `{ status, code, message }`. A request the browser could not
 * send throws instead (`thrown`), and a proxy in front of an API that is down answers 502 to 504.
 */
export const authFailureOf = (
  failure:
    | { readonly thrown: unknown }
    | {
        readonly status: number;
        readonly code?: string | undefined;
        readonly message?: string | undefined;
      },
): AuthFailure => {
  if ("thrown" in failure) return { kind: "unreachable" };
  if (failure.status === 0 || (failure.status >= 502 && failure.status <= 504)) {
    return { kind: "unreachable" };
  }
  if (failure.code === "INVALID_EMAIL_OR_PASSWORD") return { kind: "wrong-credentials" };
  const message = failure.message?.trim() ?? "";
  return {
    kind: "refused",
    message: message === "" ? "The server refused it and gave no reason." : message,
  };
};
