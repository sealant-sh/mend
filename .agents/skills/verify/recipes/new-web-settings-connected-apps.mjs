// Settings → Account → Connected apps in the new web app (route PR 44, SLNT-1159): the person's own
// Slack and Executor links and their Doppler token, the Slack link page (`/slack/link#<code>` and
// old `/slack/link/<code>`), the Executor return (`/executor/callback`), and old
// `/settings/workspace`.
//
//   pnpm verify drive new-web --recipe new-web-settings-connected-apps
//
// Feature ids: slack.md `slack-link` (the link page, Unlink), `slack-default-project`; doppler.md
// `doppler-settings` (connect, replace; the config is picked per project under "Only you", a
// later route PR), `doppler-disconnect`. A stack has no Slack workspace, no Executor and no Doppler
// account, so those come from recorded answers (tRPC answers the recipe writes): Slack connected
// and linked, a link code and its confirmation, Executor set up, Executor's answer to a link, and
// configs picked in three projects. The Doppler token itself is real on the stack: connect, replace
// and disconnect go to the server, with one of the verify skill's fakes as the token, typed with
// typeSecret, and the field is empty in every picture. The recipe disconnects Doppler at the end.
import { FAKES } from "../scripts/fakes.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const LINKED_AT = "2026-11-04T09:00:00.000Z";
const EXPIRES = "2026-11-19T10:52:00.000Z";

const visible = (locator) => locator.filter({ visible: true }).first();

/** A recorded `slack.me`: Slack connected to the organization, and this person linked. */
const SLACK_LINKED = {
  json: {
    workspace: { teamId: "T0NORTH", teamName: "Northwind" },
    link: {
      teamId: "T0NORTH",
      slackUserId: "U04R2K7N1",
      userId: "verify",
      userName: "Ada Lovelace",
      createdAt: LINKED_AT,
    },
    defaultProjectId: null,
  },
  meta: { values: { "link.createdAt": ["Date"] } },
};

/** A recorded `slack.previewLink` for a code, replacing another link or not. */
const preview = (replaces) => ({
  json: {
    teamId: "T0NORTH",
    teamName: "Northwind",
    slackUserId: "U04R2K7N1",
    slackUserName: "ada",
    slackRealName: "Ada Lovelace",
    requestText: "@mend fix the flaky login test in checkout-api",
    expiresAt: EXPIRES,
    replacesSlackUserId: replaces ? "U02J9X4QD" : null,
  },
  meta: { values: { expiresAt: ["Date"] } },
});

const CONFIRMED = {
  json: {
    link: {
      teamId: "T0NORTH",
      slackUserId: "U04R2K7N1",
      userId: "verify",
      userName: "Ada Lovelace",
      createdAt: LINKED_AT,
    },
    requestQueued: true,
  },
  meta: { values: { "link.createdAt": ["Date"] } },
};

/** A recorded `executor.personal`: Executor set up, and this person's link in `state`. */
const executor = (state) => ({
  json: { configured: true, url: null, link: { state, observedAt: null } },
});

export default async ({ page, web, capture, note, typeSecret, account }) => {
  const settled = () => page.waitForTimeout(500);
  const heading = (name) => visible(page.getByRole("heading", { name, exact: true })).waitFor();
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined, null, {
      timeout: 90_000,
    });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("a[href], button")].some((element) =>
          Object.keys(element).some((key) => key.startsWith("__reactProps")),
        ),
      null,
      { timeout: 90_000 },
    );
  };
  const open = async (to) => {
    await page.goto(`${web}${to}`);
    await hydrated();
    await page.waitForTimeout(1_000);
    await page.locator("vite-error-overlay").evaluateAll((all) => all.forEach((el) => el.remove()));
  };
  /** A page with no link or button to tell hydration by (the Slack link page's end states). */
  const load = async (to) => {
    await page.goto(`${web}${to}`);
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined, null, {
      timeout: 90_000,
    });
    await page.locator("vite-error-overlay").evaluateAll((all) => all.forEach((el) => el.remove()));
  };
  const navigate = (to) => page.evaluate((href) => window["__TSR_ROUTER__"].navigate({ href }), to);
  const reread = () =>
    page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries());
  const shot = async (name) => {
    await page.mouse.move(1, 1);
    await settled();
    await capture(name);
  };
  const paint = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  const app = (name) => visible(page.getByRole("region", { name, exact: true }));
  const toast = (text) =>
    visible(page.getByRole("region", { name: /Notifications/ }).getByText(text)).waitFor();
  const dialog = page.getByRole("dialog");

  // tRPC answers this recipe writes, by procedure: `{ json, meta }` or `{ error, code }`.
  const stubs = new Map();
  await page.route("**/trpc/**", async (route) => {
    const paths = decodeURIComponent(
      new URL(route.request().url()).pathname.replace(/^\/trpc\//, ""),
    )
      .split(",")
      .filter((p) => p !== "");
    if (!paths.some((p) => stubs.has(p))) return route.continue();
    const real = paths.every((p) => stubs.has(p)) ? null : await route.fetch();
    const list = real === null ? [] : await real.json();
    const answers = Array.isArray(list) ? list : [list];
    let status = 200;
    const out = paths.map((p, index) => {
      const stub = stubs.get(p);
      if (stub === undefined) return answers[index];
      if (stub.error !== undefined) {
        const httpStatus = stub.code === "NOT_FOUND" ? 404 : 500;
        status = paths.length === 1 ? httpStatus : 207;
        return {
          error: {
            json: {
              message: stub.error,
              code: -32603,
              data: { code: stub.code ?? "INTERNAL_SERVER_ERROR", httpStatus },
            },
          },
        };
      }
      return { result: { data: stub.meta === undefined ? { json: stub.json } : stub } };
    });
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(route.request().url().includes("batch=1") ? out : out[0]),
    });
  });

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(DESKTOP);
  await open("/settings/profile");
  // A run starts with no Doppler token.
  await page.evaluate(() =>
    window["__TSR_ROUTER__"].options.context.trpcClient.doppler.disconnect.mutate(),
  );

  // --- As the stack has it: no Slack, no Executor, Doppler not connected ----------------------
  await navigate("/settings/connected-apps");
  await heading("Connected apps");
  await page.getByText("Only you", { exact: true }).first().waitFor();
  await app("Slack")
    .getByText(/hasn't connected Slack/)
    .waitFor();
  await app("Executor")
    .getByText(/hasn't set up Executor/)
    .waitFor();
  await app("Doppler")
    .getByText("Not connected. Connect it to use your Doppler secrets in sessions.")
    .waitFor();
  note(
    "as the stack is: Slack and Executor not set up for the organization, Doppler not connected",
  );
  await shot("apps-doppler-not-connected-desktop-light");

  // --- Doppler: connect, replace (real, with a fake token) -------------------------------------
  await app("Doppler").getByRole("button", { name: "Connect…" }).click();
  await heading("Connect Doppler");
  await shot("apps-connect-dialog-desktop-light");
  await typeSecret(dialog.getByLabel("Doppler token"), "doppler-token", FAKES.github);
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await toast("Connected Doppler.");
  await app("Doppler")
    .getByText(/^Connected on .+\. You haven't picked a config in any project yet\.$/)
    .waitFor();
  const text = await page.locator("body").textContent();
  if (text.includes(FAKES.github) || text.includes(FAKES.github.slice(-4)))
    throw new Error("the page shows part of the Doppler token");
  note("doppler-settings: connected with a token; no part of it shows anywhere on the page");
  await shot("apps-doppler-connected-desktop-light");
  await app("Doppler").getByRole("button", { name: "Replace token…" }).click();
  await heading("Replace Doppler token");
  if ((await dialog.getByLabel("Doppler token").inputValue()) !== "")
    throw new Error("the replace dialog filled in the saved token");
  await shot("apps-replace-dialog-desktop-light");
  await typeSecret(dialog.getByLabel("Doppler token"), "doppler-token-2", FAKES.anthropicKey);
  await dialog.getByRole("button", { name: "Replace token" }).click();
  await toast("Replaced your Doppler token.");
  note("doppler-settings: replaced the token; the field started empty");

  // --- Disconnect, counting projects from the server's answer ----------------------------------
  stubs.set("doppler.status", {
    json: {
      connected: true,
      name: null,
      updatedAt: LINKED_AT,
      mappings: ["checkout-api", "billing", "web"].map((name, index) => ({
        projectId: `p${index}`,
        dopplerProject: "checkout",
        config: "dev",
        projectName: name,
      })),
    },
    meta: { values: { updatedAt: ["Date"] } },
  });
  await reread();
  await app("Doppler")
    .getByText(/where you've picked a config/)
    .waitFor();
  await app("Doppler").getByRole("button", { name: "Disconnect…" }).click();
  await heading("Disconnect Doppler?");
  await dialog.getByText(/the config you picked in 3 projects/).waitFor();
  note("disconnect confirmation counts the 3 configs the server returned (recorded answer)");
  await shot("apps-disconnect-dialog-desktop-light");
  stubs.delete("doppler.status");
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  await toast("Disconnected Doppler.");
  await app("Doppler").getByRole("button", { name: "Connect…" }).waitFor();
  note("doppler-disconnect: the server removed the token; the row reads Not connected again");

  // --- Slack linked, and Executor set up (recorded answers) ------------------------------------
  stubs.set("slack.me", SLACK_LINKED);
  stubs.set("executor.personal", executor("active"));
  await reread();
  await app("Slack")
    .getByText(/^Linked as Slack user U04R2K7N1 in Northwind on /)
    .waitFor();
  await app("Executor").getByText("Mend uses your link before", { exact: false }).waitFor();
  note(
    "Slack linked and Executor linked (recorded): the Executor row says your link is used first",
  );
  await shot("apps-desktop-light");
  await paint("dark");
  await shot("apps-desktop-dark");
  await paint("light");
  // The choice is sent to the server, which answers with the account's Slack view.
  let sentDefault = null;
  stubs.set("slack.setDefaultProject", SLACK_LINKED);
  page.on("request", (request) => {
    if (request.url().includes("slack.setDefaultProject")) sentDefault = request.postData();
  });
  const select = app("Slack").getByLabel("Your default project");
  await select.waitFor();
  const options = await select.locator("option").evaluateAll((all) => all.map((o) => o.value));
  const project = options.find((value) => value !== "");
  if (project === undefined) throw new Error("Your default project lists no project");
  await select.selectOption(project);
  await page.waitForTimeout(1_000);
  if (sentDefault === null || !sentDefault.includes(project))
    throw new Error(`choosing a default project sent ${sentDefault}`);
  note("slack-default-project: choosing a project sends slack.setDefaultProject with its id");
  stubs.set("slack.unlink", { json: { removed: true } });
  await app("Slack").getByRole("button", { name: "Unlink…" }).click();
  await heading("Unlink Slack?");
  await shot("apps-unlink-slack-dialog-desktop-light");
  stubs.set("slack.me", { json: { ...SLACK_LINKED.json, link: null } });
  await dialog.getByRole("button", { name: "Unlink", exact: true }).click();
  await toast("Unlinked Slack.");
  await app("Slack")
    .getByText(/^Not linked\./)
    .waitFor();
  note("slack-link: Unlink confirmed; the row reads Not linked (recorded answers)");
  stubs.set("executor.personal", executor("unlinked"));
  await reread();
  await app("Executor").getByRole("button", { name: "Link", exact: true }).waitFor();
  note("Executor not linked: the row names the shared account and offers Link");
  await shot("apps-executor-unlinked-desktop-light");

  // --- /executor/callback ----------------------------------------------------------------------
  stubs.set("executor.finish", { json: { url: null, target: "person" } });
  await page.goto(`${web}/executor/callback?code=verify-code&state=verify-state`);
  await page.waitForURL((url) => url.pathname === "/settings/connected-apps", { timeout: 60_000 });
  if (page.url().includes("code=")) throw new Error("the link's code stayed in the address");
  note("/executor/callback finished a person's link and came back to Connected apps, code gone");
  stubs.set("executor.finish", { error: "Executor didn't accept this link. Start it again." });
  await page.goto(`${web}/executor/callback?code=verify-code&state=verify-state`);
  await heading("The Executor link didn't finish");
  await page.getByText("Executor didn't accept this link. Start it again.").waitFor();
  await shot("executor-callback-refused-desktop-light");
  note("a refused Executor link says why and links back");
  stubs.delete("executor.finish");
  await page.goto(`${web}/executor/callback?error=access_denied`);
  await heading("The Executor link didn't finish");
  note("a link Executor sent back with an error says it didn't finish");

  // --- Old /settings/workspace -----------------------------------------------------------------
  await open("/settings/workspace");
  await page.waitForURL((url) => url.pathname === "/settings/connected-apps");
  note("old /settings/workspace (Executor's return after linking) opens Connected apps");

  // --- The Slack link page ---------------------------------------------------------------------
  stubs.set("slack.previewLink", preview(false));
  await load("/slack/link#verify-link-code");
  await heading("Link your Slack account");
  await page.getByText("Ada Lovelace (@ada)").waitFor();
  note("slack-link: the page names the workspace, the Slack user and the Mend account");
  await shot("slack-link-desktop-light");
  stubs.set("slack.previewLink", preview(true));
  await load("/slack/link#verify-link-code-2");
  await page.getByText("This replaces your current link.").waitFor();
  await shot("slack-link-replaces-desktop-light");
  stubs.set("slack.confirmLink", CONFIRMED);
  await page.getByRole("button", { name: "Link accounts" }).click();
  await heading("Slack account linked");
  note("slack-link: Link accounts confirms; the request runs in the thread (recorded answers)");
  await shot("slack-linked-desktop-light");
  stubs.delete("slack.previewLink");
  stubs.delete("slack.confirmLink");
  await load("/slack/link#not-a-real-code");
  await heading("Link your Slack account");
  await page.getByText("This link can't be used.").waitFor();
  note("a code the server doesn't know (asked for real) can't be used");
  await shot("slack-link-unusable-desktop-light");
  await load("/slack/link/verify-old-code");
  await page.waitForURL((url) => url.pathname === "/slack/link" && url.hash !== "");
  note("old /slack/link/<code> moves the code into the fragment");

  // Signed out, in a browser with no session: the page signs in itself and keeps the code.
  const fresh = await page.context().browser().newContext();
  const out = await fresh.newPage();
  await out.goto(`${web}/slack/link#verify-link-code`);
  await visible(out.getByRole("heading", { name: "Sign in", exact: true })).waitFor({
    timeout: 90_000,
  });
  if (!out.url().includes("#verify-link-code"))
    throw new Error("signing in from the Slack link page lost the code");
  note("signed out: the Slack link page asks to sign in on the same address, code kept");
  // Signing in there comes back to the same code's confirmation.
  await out.route("**/trpc/**", async (route) => {
    if (!route.request().url().includes("slack.previewLink")) return route.continue();
    const { json, meta } = preview(false);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        route.request().url().includes("batch=1")
          ? [{ result: { data: { json, meta } } }]
          : { result: { data: { json, meta } } },
      ),
    });
  });
  await out.getByLabel("Email").fill(account.email);
  await account.typePassword(out.getByLabel("Password", { exact: true }));
  await out.getByRole("button", { name: "Sign in", exact: true }).click();
  await visible(out.getByRole("heading", { name: "Link your Slack account", exact: true })).waitFor(
    {
      timeout: 90_000,
    },
  );
  await out.getByText("Ada Lovelace (@ada)").waitFor();
  note("after signing in there, the same code's confirmation shows (recorded preview)");
  await fresh.close();

  // --- Phone -----------------------------------------------------------------------------------
  stubs.clear();
  stubs.set("slack.me", SLACK_LINKED);
  stubs.set("executor.personal", executor("active"));
  await page.setViewportSize(PHONE);
  await open("/settings/connected-apps");
  await visible(page.getByText("Doppler", { exact: true })).waitFor();
  const connect = visible(page.getByRole("button", { name: "Connect…" }));
  const height = (await connect.boundingBox())?.height ?? 0;
  if (height < 44) throw new Error(`Connect… is ${height}px tall on a phone, under 44px`);
  for (const theme of ["light", "dark"]) {
    await paint(theme);
    await shot(`phone-apps-${theme}`);
  }
  await paint("light");
  await connect.click();
  await visible(page.getByText("Connect Doppler", { exact: true })).waitFor();
  await shot("phone-apps-connect-sheet-light");
  await page.keyboard.press("Escape");
  stubs.set("slack.previewLink", preview(false));
  await load("/slack/link#verify-link-code");
  await shot("phone-slack-link-light");
  stubs.clear();
  await page.setViewportSize(DESKTOP);
  note("phone: 44px buttons, the connect dialog as a sheet, the Slack link page");
};
