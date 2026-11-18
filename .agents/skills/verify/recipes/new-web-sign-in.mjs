// The new web app's sign-in, password reset and first account (apps/web, SLNT-1097), driven by the
// sign-in feature's ids (features/sign-in.md) and organization.md's `member-removal`:
//
//   pnpm verify drive new-web --recipe new-web-sign-in
//
// - `web-sign-in`: signed out, a page walks to /login#next=<page>; a wrong password says so; a
//   server that doesn't answer says so and offers Try again; the right password returns to the
//   page, and /login?next= (the API's /preview-auth) does the same.
// - `registration-closed`: an account exists, so the page is sign-in only, with the invitation line.
// - `member-removal`: /login?reason=access shows the removed banner.
// - `password-reset`: /reset with no link, the old /reset/<token> form moving to /reset#<token>,
//   fields to fix, a token the server never made, then a real link the operator makes: the
//   password it sets signs in, and the same link again can't be used.
// - `first-account`: the stack already has its first account, so the instance read is answered
//   "no accounts" in the browser; the form's checks run, and the server's own refusal shows.
//
// Every state is captured light and dark, at 1280px and 390px. The stack's account signs in on the
// new page through `account.typePassword`, so the password never reaches this file.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const INVITATION_LINE = "No account? Ask an owner of your organization for an invitation.";
// A token in the reset link's shape that no reset ever made.
const MADE_UP_TOKEN = "verifyNoSuchResetToken0000";

export default async ({ page, web, capture, note, typeSecret, registerSecret, account }) => {
  if (account === null)
    throw new Error("this recipe signs in on the new page: run it with --account");
  const heading = (name) => page.getByRole("heading", { name, exact: true }).waitFor();
  const settled = () => page.waitForTimeout(500);
  const path = () => {
    const url = new URL(page.url());
    return `${url.pathname}${url.search}${url.hash}`;
  };
  const expectPath = (want) => {
    if (path() !== want) throw new Error(`the browser is at ${path()}, not ${want}`);
  };
  const signedOut = () => page.context().clearCookies();
  // A full load each time: a goto that changes only the fragment would stay in the same document.
  const open = async (to) => {
    await page.goto("about:blank");
    await page.goto(`${web}${to}`);
  };

  // A page's main buttons on a phone are 44px touch targets, pinned to the foot of the screen.
  const touchTargets = async () => {
    for (const control of await page.locator("main button, main a[href]").all()) {
      if (!(await control.isVisible())) continue;
      const name = (await control.textContent())?.trim() ?? "";
      if (name === "") continue;
      let height = 0;
      for (let tries = 0; tries < 20 && height < 44; tries += 1) {
        if (tries > 0) await page.waitForTimeout(100);
        height = (await control.boundingBox())?.height ?? 0;
      }
      if (height < 44) throw new Error(`${name} is ${height}px tall on a phone, under 44px`);
    }
  };

  /** The page as it is now, light and dark, desktop and phone, without reloading it. */
  const captureAll = async (name) => {
    for (const [viewport, size] of [
      ["desktop", DESKTOP],
      ["phone", PHONE],
    ]) {
      await page.setViewportSize(size);
      for (const theme of ["light", "dark"]) {
        await page.evaluate(
          (on) => document.documentElement.classList.toggle("dark", on),
          theme === "dark",
        );
        await settled();
        if (viewport === "phone") await touchTargets();
        await capture(`${name}-${viewport}-${theme}`);
      }
    }
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize(DESKTOP);
    await settled();
  };

  // A screenshot is withheld while a password field holds anything (drive-web.mjs), so a state
  // reached with a typed password is captured after its password fields are emptied.
  const emptyPasswords = async () => {
    for (const field of await page.locator('input[type="password"]').all()) await field.fill("");
  };
  // Better Auth lets one address sign in 3 times in 10 seconds; the next is refused with "Too many
  // requests". Each real sign-in waits out the window first.
  const outOfTheLimit = () => page.waitForTimeout(11_000);

  const fillSignIn = async (email, password) => {
    await page.getByRole("textbox", { name: "Email" }).fill(email);
    await password(page.getByLabel("Password", { exact: true }));
  };

  // web-sign-in, registration-closed: signed out, a page walks to sign-in with the page to return to.
  await signedOut();
  await open("/settings/profile");
  await heading("Sign in");
  expectPath("/login#next=%2Fsettings%2Fprofile");
  await page.getByText("After you sign in, Mend takes you back to").waitFor();
  await page.getByText(INVITATION_LINE).waitFor();
  note(
    "signed out, /settings/profile walked to /login#next=%2Fsettings%2Fprofile, with the invitation line",
  );
  await captureAll("sign-in-to-continue");

  await open("/login");
  await heading("Sign in");
  await page.getByText(INVITATION_LINE).waitFor();
  if ((await page.getByText("After you sign in").count()) !== 0)
    throw new Error("a plain /login names a page to return to");
  await captureAll("sign-in");

  // A wrong password.
  await fillSignIn(account.email, (field) =>
    typeSecret(field, "wrong-password", "not-the-verify-password"),
  );
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByText("Wrong email or password.").waitFor();
  expectPath("/login");
  note("a wrong password: 'Wrong email or password. Check both and try again.', still on /login");
  await emptyPasswords();
  await captureAll("sign-in-wrong-password");

  // Signing in, held, then a server that doesn't answer.
  let release = () => {};
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/auth/sign-in/email", async (route) => {
    await held;
    await route.abort("connectionrefused");
  });
  await open("/login#next=%2Fprojects");
  await heading("Sign in");
  await fillSignIn(account.email, account.typePassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Signing in…" }).waitFor();
  if (!(await page.getByRole("button", { name: "Signing in…" }).isDisabled()))
    throw new Error("the Signing in… button can be pressed again");
  note("while the request runs, the button reads 'Signing in…' and is disabled");
  await emptyPasswords();
  await captureAll("sign-in-signing-in");
  release();
  await page.getByText("Mend's server didn't answer.").waitFor();
  await page.getByRole("button", { name: "Try again" }).waitFor();
  note("a request that never reached the server: 'Mend's server didn't answer.' and Try again");
  await captureAll("sign-in-unreachable");

  // Try again, with the server back: the browser returns to the page that asked.
  await page.unroute("**/api/auth/sign-in/email");
  await outOfTheLimit();
  await account.typePassword(page.getByLabel("Password", { exact: true }));
  await page.getByRole("button", { name: "Try again" }).click();
  await page.waitForURL((url) => url.pathname !== "/login");
  expectPath("/projects");
  note(
    "Try again signed in and returned to /projects (the not-found screen until its route lands)",
  );

  // The API's /preview-auth sends the page in the query instead.
  await signedOut();
  await open("/login?next=%2Fchanges%2Fc1");
  await heading("Sign in");
  await outOfTheLimit();
  await fillSignIn(account.email, account.typePassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname !== "/login");
  expectPath("/changes/c1");
  note("/login?next=%2Fchanges%2Fc1 signed in and returned to /changes/c1");

  // An unsafe continuation goes home instead.
  await signedOut();
  await open(`/login#next=${encodeURIComponent("//evil.example/")}`);
  await heading("Sign in");
  await outOfTheLimit();
  await fillSignIn(account.email, account.typePassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname !== "/login");
  expectPath("/");
  await heading("Page not found");
  note("#next=//evil.example/ signed in and went to / (the not-found screen until home lands)");

  // member-removal: a removed member's browser.
  await signedOut();
  await open("/login?reason=access");
  await heading("Sign in");
  await page.getByText("You were removed from your organization.").waitFor();
  note("/login?reason=access shows the removed banner over the sign-in form");
  await captureAll("sign-in-access-removed");

  // password-reset: no link.
  await open("/reset");
  await heading("Reset your password");
  await page.getByRole("link", { name: "Sign in" }).waitFor();
  note("/reset with no link explains who makes one, and links to sign-in");
  await captureAll("reset-no-link");

  // The old /reset/<token> form opens the page at /reset#<token>.
  await open(`/reset/${MADE_UP_TOKEN}`);
  await heading("Set a new password");
  expectPath(`/reset#${MADE_UP_TOKEN}`);
  note(`/reset/<token> moved to /reset#<token> and shows the form`);
  await captureAll("reset");

  // Fields to fix: sent empty, then with a short password (its screenshot is withheld).
  await page.getByRole("button", { name: "Set password" }).click();
  await page.getByText("Enter a password.").waitFor();
  await page.getByText("Fix the field above to continue.").waitFor();
  note("sent empty: 'Enter a password.' under the field, and the count beside the button");
  await captureAll("reset-fields-need-fixing");
  await typeSecret(page.getByLabel("New password", { exact: true }), "short-password", "short1");
  await typeSecret(page.getByLabel("Confirm new password"), "other-password", "short12");
  await page.getByText("Use at least 8 characters. This one has 6.").waitFor();
  note("a 6-character password: 'Use at least 8 characters. This one has 6.'");
  await capture("reset-short-password-desktop-light");

  // A link the server never made.
  await typeSecret(
    page.getByLabel("New password", { exact: true }),
    "new-password",
    "a-new-verify-password",
  );
  await typeSecret(
    page.getByLabel("Confirm new password"),
    "new-password",
    "a-new-verify-password",
  );
  await page.getByRole("button", { name: "Set password" }).click();
  await page.getByText("This reset link can't be used.").waitFor();
  note("a token the server never made: 'This reset link can't be used.' and a way to sign in");

  // A real reset link, made by the operator through the endpoint `mend operator reset-link` calls.
  // The new password is the account's own, so the stack's account keeps working afterwards.
  await open(`/login`);
  await heading("Sign in");
  await outOfTheLimit();
  await fillSignIn(account.email, account.typePassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname !== "/login");
  const link = await page.evaluate(async (email) => {
    const response = await fetch("/api/operator/password-resets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    return { status: response.status, body: await response.json() };
  }, account.email);
  if (link.status !== 200 || typeof link.body.path !== "string")
    throw new Error(`the operator's reset link was refused: ${link.status}`);
  const resetPath = link.body.path;
  registerSecret("reset-link-token", resetPath.split("#")[1] ?? resetPath);
  note(`the operator made a reset link: /reset#<token> (HTTP ${link.status})`);
  await signedOut();
  await open(resetPath);
  await heading("Set a new password");
  await account.typePassword(page.getByLabel("New password", { exact: true }));
  await account.typePassword(page.getByLabel("Confirm new password"));
  await page.getByRole("button", { name: "Set password" }).click();
  await page.getByText("Password changed.").waitFor();
  expectPath("/login?reason=reset");
  note("Set password with the real link: /login?reason=reset says 'Password changed.'");
  await emptyPasswords();
  await captureAll("reset-done");
  await outOfTheLimit();
  await fillSignIn(account.email, account.typePassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname !== "/login");
  expectPath("/");
  note("the password set through the link signs in");

  // The same link again: spent.
  await signedOut();
  await open(resetPath);
  await heading("Set a new password");
  await account.typePassword(page.getByLabel("New password", { exact: true }));
  await account.typePassword(page.getByLabel("Confirm new password"));
  await page.getByRole("button", { name: "Set password" }).click();
  await page.getByText("This reset link can't be used.").waitFor();
  await page.getByRole("link", { name: "Sign in" }).waitFor();
  note("the same link again: 'This reset link can't be used.' with Sign in");
  await captureAll("reset-link-cant-be-used");

  // first-account: the instance read answers "no accounts yet".
  await page.route("**/trpc/platform.instance**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { result: { data: { json: { users: "none", registration: "open" } } } },
      ]),
    }),
  );
  await open("/login");
  await heading("Create the first account");
  await page.getByRole("list", { name: "Setup steps" }).waitFor({ state: "attached" });
  note("a server with no accounts opens on 'Create the first account', step 1 of 4");
  await captureAll("first-account");

  await page.getByRole("textbox", { name: "Name" }).fill("Verify");
  await page.getByRole("textbox", { name: "Email" }).fill("verify@verify-stack");
  await page.getByRole("button", { name: "Create account and continue" }).click();
  await page.getByText("Enter a whole email address, like ada@example.com.").waitFor();
  await page.getByText("Enter a password.").waitFor();
  await page.getByText("Fix the 2 fields above to continue.").waitFor();
  note("sent with a partial email and no password: each problem under its field, nothing sent");
  await captureAll("first-account-fields-need-fixing");

  await typeSecret(
    page.getByLabel("Password", { exact: true }),
    "new-password",
    "a-new-verify-password",
  );
  await typeSecret(page.getByLabel("Confirm password"), "other-password", "a-new-verify-passwort");
  await page.getByRole("button", { name: "Create account and continue" }).click();
  await page.getByText("Enter a whole email address, like ada@example.com.").waitFor();
  await page.getByText("The passwords don't match.").waitFor();
  await page.getByText("Fix the 2 fields above to continue.").waitFor();
  note("passwords that differ: 'The passwords don't match.' under the second, nothing sent");
  await capture("first-account-mismatch-desktop-light");

  // The server decides: it already has an account, so it refuses a second first account.
  await page.getByRole("textbox", { name: "Email" }).fill("second@verify-stack.invalid");
  await typeSecret(page.getByLabel("Confirm password"), "new-password", "a-new-verify-password");
  await page.getByRole("button", { name: "Create account and continue" }).click();
  await page.getByText("Mend didn't create the account.").waitFor();
  note(`the server refused it: ${(await page.getByRole("alert").first().textContent())?.trim()}`);
  await capture("first-account-refused-desktop-light");
  await page.unroute("**/trpc/platform.instance**");

  // The server's instance read fails: the page's error screen, and Try again recovers.
  await page.route("**/trpc/**", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify([
        {
          error: {
            json: {
              message: "The verify recipe failed this read on purpose.",
              code: -32603,
              data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
            },
          },
        },
      ]),
    }),
  );
  await open("/login");
  await heading("This page didn't load");
  await page.getByText("The verify recipe failed this read on purpose.").waitFor();
  await capture("sign-in-failed-to-load-desktop-light");
  await page.unroute("**/trpc/**");
  await page.getByRole("button", { name: "Try again" }).click();
  await heading("Sign in");
  note("a failed instance read shows the error screen; Try again reads it again and shows sign-in");
};
