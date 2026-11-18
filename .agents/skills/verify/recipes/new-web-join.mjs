// The new web app's join page (apps/web, SLNT-1105), driven by organization.md's `join`,
// `join-signed-in` and `join-refused`, with invitations the stack's owner makes:
//
//   pnpm verify drive new-web --recipe new-web-join --account <account.json>
//
// - `join`: the old /join/<token> form moves to /join#<token>; the form's problems, the server's
//   "there's already an account" with Sign in instead, then a new person creates an account and
//   lands on setup (/welcome, the not-found screen until its route lands).
// - `join-signed-in`: signing in from the page, as the owner, who is already a member: a stack runs
//   one organization (MEND_TENANCY=single), so a signed-in account is always in it. Joining a second
//   organization while signed in needs `multi`, which a stack doesn't run.
// - `join-refused`: a link already used, one the owner revoked, one that expired (the preview is
//   answered in the browser: an invitation lasts at least a day), and one that is no invitation.
//
// Every state is captured light and dark, at 1280px and 390px.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
// A token in the invitation's shape that no owner ever made.
const MADE_UP_TOKEN = "verifyNoSuchInvitation0000";

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
  // Better Auth lets one address sign in 3 times in 10 seconds.
  const outOfTheLimit = () => page.waitForTimeout(11_000);
  const button = (name) => page.getByRole("button", { name, exact: true });

  // A page's buttons on a phone are 44px touch targets. A link inside a sentence is text, not one.
  const touchTargets = async () => {
    for (const control of await page.locator("main button, main a[href]").all()) {
      if (!(await control.isVisible())) continue;
      if (await control.evaluate((element) => element.closest("p") !== null)) continue;
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

  const signIn = async () => {
    await page.getByRole("textbox", { name: "Email" }).fill(account.email);
    await account.typePassword(page.getByLabel("Password", { exact: true }));
    await button("Sign in").click();
  };

  /** The owner's API, from the signed-in page: what Settings and `mend invite` call. */
  const api = (method, url, body) =>
    page.evaluate(
      async ({ verb, address, payload }) => {
        const response = await fetch(address, {
          method: verb,
          headers: { "content-type": "application/json" },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        });
        const text = await response.text();
        return { status: response.status, body: text === "" ? null : JSON.parse(text) };
      },
      { verb: method, address: url, payload: body },
    );

  // The owner signs in on the new app and makes two links, then revokes the second.
  await signedOut();
  await open("/login");
  await heading("Sign in");
  await signIn();
  await page.waitForURL((url) => url.pathname !== "/login");
  const organization = await api("GET", "/api/organization");
  if (organization.status !== 200) throw new Error(`/api/organization: ${organization.status}`);
  const org = organization.body.organization.name;
  const made = [];
  for (const _ of [1, 2]) {
    const created = await api("POST", "/api/organization/invitations", { role: "member" });
    if (created.status !== 200) throw new Error(`creating an invitation: ${created.status}`);
    registerSecret(`invitation-token-${made.length + 1}`, created.body.token);
    made.push({ id: created.body.invitation.id, token: created.body.token });
  }
  const [used, revoked] = made;
  const revoke = await api("DELETE", `/api/organization/invitations/${revoked.id}`);
  if (revoke.status >= 300) throw new Error(`revoking an invitation: ${revoke.status}`);
  note(`the owner made two member invitations in ${org} and revoked the second`);

  // join-signed-in, as far as one organization goes: the owner opens a link to their own.
  await open(`/join#${used.token}`);
  await heading(`Join ${org}`);
  await page.getByText(`You're already a member of ${org}. The invitation stays unused.`).waitFor();
  await page.getByRole("link", { name: "Open Mend" }).waitFor();
  note(
    "signed in as a member, the link says 'You're already a member', with the account and Open Mend",
  );
  await captureAll("join-already-member");

  // join: the older /join/<token> form moves the token into the fragment.
  await signedOut();
  await open(`/join/${used.token}`);
  await heading(`Join ${org}`);
  expectPath(`/join#${used.token}`);
  await page.getByText(`You're invited to join ${org} on Mend as a member.`).waitFor();
  await page.getByRole("list", { name: "Setup steps" }).waitFor({ state: "attached" });
  note("/join/<token> moved to /join#<token>: 'Join <org>', step 1 of 4, the account fields");
  await captureAll("join-invitation");

  // Sent empty: each problem under its field, nothing sent.
  await button("Create account and join").click();
  await page.getByText("Enter your email address.").waitFor();
  await page.getByText("Fix the 2 fields above to continue.").waitFor();
  note("sent empty: 'Enter your email address.', 'Enter a password.', 'Fix the 2 fields above'");

  // An email that has an account: the server says so under the field, with Sign in instead.
  await page.getByRole("textbox", { name: "Name" }).fill("Verify Joiner");
  await page.getByRole("textbox", { name: "Email" }).fill(account.email);
  await typeSecret(
    page.getByLabel("Password", { exact: true }),
    "new-password",
    "a-new-verify-password",
  );
  await typeSecret(page.getByLabel("Confirm password"), "new-password", "a-new-verify-password");
  await button("Create account and join").click();
  await page.getByText(`There's already an account for ${account.email} on this server.`).waitFor();
  await page.getByText("Fix the field above to continue.").waitFor();
  await typeSecret(page.getByLabel("Confirm password"), "other-password", "a-new-verify-passwort");
  await button("Create account and join").click();
  await page.getByText("The passwords don't match.").waitFor();
  await page.getByText("Fix the 2 fields above to continue.").waitFor();
  note(
    "the stack's own email: 'There's already an account for <email> on this server.' and Sign in instead; then passwords that differ: 2 fields to fix",
  );
  // A screenshot is withheld while a password field holds anything typed, so the capture is of the
  // same form with its passwords emptied: the email's problem and 'Enter a password.'
  for (const field of await page.locator('input[type="password"]').all()) await field.fill("");
  await page.getByText("Enter a password.").waitFor();
  await page.getByText("Fix the 2 fields above to continue.").waitFor();
  await captureAll("join-fields-need-fixing");

  // Sign in instead: the sign-in form on the same page, with the email carried over.
  await button("Sign in instead").click();
  await heading(`Sign in to join ${org}`);
  const carried = await page.getByRole("textbox", { name: "Email" }).inputValue();
  if (carried !== account.email) throw new Error(`the sign-in form holds ${carried}`);
  note(
    "Sign in instead opened 'Sign in to join <org>' with the email filled in, and Back to invitation",
  );
  await captureAll("join-sign-in-to-accept");
  await button("Back to invitation").click();
  await heading(`Join ${org}`);
  await page.getByText("Already have an account?").waitFor();

  // Signing in from the page comes back to the invitation, signed in.
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await heading(`Sign in to join ${org}`);
  await outOfTheLimit();
  await signIn();
  await page.getByText(`You're already a member of ${org}.`).waitFor();
  expectPath(`/join#${used.token}`);
  note("signed in from the page as the owner: back on the invitation, which says they're a member");

  // join: a new person creates an account and joins, and lands on setup.
  await signedOut();
  await open(`/join#${used.token}`);
  await heading(`Join ${org}`);
  const joiner = `verify-joiner-${Date.now()}@example.invalid`;
  await page.getByRole("textbox", { name: "Name" }).fill("Verify Joiner");
  await page.getByRole("textbox", { name: "Email" }).fill(joiner);
  await typeSecret(
    page.getByLabel("Password", { exact: true }),
    "joiner-password",
    "a-joiner-verify-password",
  );
  await typeSecret(
    page.getByLabel("Confirm password"),
    "joiner-password",
    "a-joiner-verify-password",
  );
  await button("Create account and join").click();
  await page.waitForURL((url) => url.pathname === "/welcome");
  await heading("Page not found");
  note(
    `'Create account and join' as ${joiner} landed on /welcome (not found until Git access lands)`,
  );

  // The new member reopens the link they joined with.
  await open(`/join#${used.token}`);
  await page.getByText(`You're already a member of ${org}.`).waitFor();
  await page.getByText("Verify Joiner").waitFor();
  note(
    "the new member reopening their link: 'You're already a member', signed in as Verify Joiner",
  );

  // The owner's roster has the new member.
  await signedOut();
  await open("/login");
  await outOfTheLimit();
  await signIn();
  await page.waitForURL((url) => url.pathname !== "/login");
  const members = await api("GET", "/api/organization/members");
  const joined = members.body.find?.((member) => member.email === joiner);
  if (joined === undefined) throw new Error(`${joiner} is not in ${org}'s members`);
  note(`the owner's roster lists ${joiner} as ${joined.role}`);

  // join-refused: the used link, signed out.
  await signedOut();
  await open(`/join#${used.token}`);
  await heading(`Join ${org}`);
  await page.getByText("This invitation can't be used. Someone already used it to join.").waitFor();
  await page.getByRole("link", { name: "Sign in" }).waitFor();
  note(
    "the used link, signed out: 'This invitation can't be used. Someone already used it to join.'",
  );
  await captureAll("join-cant-be-used-used");

  // join-refused: the revoked link.
  await open(`/join#${revoked.token}`);
  await page.getByText("This invitation can't be used. An owner revoked it.").waitFor();
  note("the revoked link: 'This invitation can't be used. An owner revoked it.'");
  await captureAll("join-cant-be-used-revoked");

  // join-refused: an expired link. The server makes links that last at least a day, so the preview
  // is answered in the browser, in the shape the server sends.
  await page.route("**/trpc/organization.invitationPreview**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          result: {
            data: {
              json: {
                organizationId: organization.body.organization.id,
                organizationName: org,
                role: "member",
                state: "expired",
                expiresAt: "2026-11-17T10:42:00.000Z",
              },
              meta: { values: { expiresAt: ["Date"] } },
            },
          },
        },
      ]),
    }),
  );
  await open(`/join#${revoked.token}`);
  await page
    .getByText(/^This invitation can't be used\. It expired on 17 November at \d\d:42\./)
    .waitFor();
  note("an expired link (preview answered in the browser): 'It expired on 17 November at <time>.'");
  await captureAll("join-cant-be-used-expired");
  await page.unroute("**/trpc/organization.invitationPreview**");

  // join-refused: no invitation by that token, and no token at all.
  await open(`/join#${MADE_UP_TOKEN}`);
  await heading("This link is not an invitation");
  note("a token no owner made: 'This link is not an invitation'");
  await captureAll("join-not-an-invitation");
  await open("/join");
  await heading("This link is not an invitation");
  note("/join with no token: 'This link is not an invitation'");

  // The page's reads fail: Try again reads them again.
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
  await open(`/join#${used.token}`);
  await page.getByText("The verify recipe failed this read on purpose.").waitFor();
  await captureAll("join-failed-to-load");
  await page.unroute("**/trpc/**");
  await button("Try again").click();
  await heading(`Join ${org}`);
  note("a failed read shows 'This didn't load.' with Try again, which reads it again");
};
