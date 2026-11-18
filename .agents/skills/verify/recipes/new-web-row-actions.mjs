// A session row's actions in the new web app's sidebar inbox (apps/web, route PR 8, SLNT-1122):
// rename, snooze, mark done, copy link, from the row's "…", its right-click menu, and on a phone
// its sheet. Run the CLI batch once per stack first; it starts one session to review and one that
// keeps running:
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-row-actions-sessions.json
//   pnpm verify drive new-web --recipe new-web-row-actions
//
// Feature ids: now-and-sessions.md `inbox-snooze-settle` (snooze until a time, mark done, bring
// back), `now-menus` (the row's right-click menu); attach-resume.md `rename-web` (set and clear a
// label). The recipe puts back every mark and label it sets, so it can run again.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const RUNNING = "row-running";
const REVIEW = "row-review";
const RENAMED = "Row actions renamed";
const MENU_ITEMS = ["Open session", "Snooze", "Mark done", "Rename", "Copy link"];
/** The workspace's actions and the phone app's Approve, which a session row's menu never holds. */
const NOT_IN_MENU = ["Copy branch name", "Land…", "Approve…", "Approve"];
const REFUSAL = "The verify recipe refused this on purpose.";
const pad = (n) => String(n).padStart(2, "0");

export default async ({ page, web, capture, note }) => {
  const settled = () => page.waitForTimeout(500);
  const setTheme = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  /** Captures the page in light and dark, as it stands. */
  const both = async (name) => {
    for (const theme of ["light", "dark"]) {
      await setTheme(theme);
      await capture(`${name}-${theme}`);
    }
    await setTheme("light");
  };
  const inbox = () => page.getByRole("navigation", { name: "Inbox" }).filter({ visible: true });
  const group = (label) => inbox().getByRole("region", { name: label, exact: true });
  const heading = (label) => group(label).getByRole("button", { name: new RegExp(`^${label}`) });
  const isOpen = async (label) => (await heading(label).getAttribute("aria-expanded")) === "true";
  const setOpen = async (label, open) => {
    if ((await isOpen(label)) !== open) await heading(label).click();
    await group(label)
      .getByRole("button", { name: new RegExp(`^${label}`), expanded: open })
      .waitFor({ timeout: 5_000 });
  };
  const showAll = async (label) => {
    const more = group(label).getByRole("button", { name: /^Show \d+ more$/ });
    if ((await more.count()) > 0) await more.click();
  };
  const row = (label, title) => group(label).getByRole("link", { name: new RegExp(`^${title}`) });
  /** A toast, in the toasts' own region (Base UI also reads it out in a live region). */
  const toasts = () => page.getByRole("region", { name: "Notifications" });
  const toast = (text) => toasts().getByText(text, { exact: true });
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
    await page.waitForFunction(() => {
      const control = document.querySelector("[data-slot=collapsible-trigger]");
      return control !== null && Object.keys(control).some((key) => key.startsWith("__reactProps"));
    });
  };
  const open = async (path) => {
    if (path === undefined) await page.reload();
    else await page.goto(`${web}${path}`);
    await hydrated();
  };
  const api = (path, method, body) =>
    page.evaluate(
      async ({ path: to, method: verb, body: sent }) => {
        const response = await fetch(
          `/api${to}`,
          sent === undefined
            ? { method: verb }
            : {
                method: verb,
                headers: { "content-type": "application/json" },
                body: JSON.stringify(sent),
              },
        );
        return { status: response.status, json: await response.json().catch(() => null) };
      },
      { path, method, body },
    );
  /** Every row the server lists, by its label or title. */
  const sessionId = async (titles) => {
    const { json } = await api("/session-inbox", "GET");
    const found = json.find((each) => titles.includes(each.title));
    if (found === undefined) throw new Error(`no session titled ${titles.join(" or ")}`);
    return found.session.id;
  };
  /** Puts back what this recipe changes: every mark this account holds, and the renamed label. */
  const reset = async () => {
    const { json: marks } = await api("/session-inbox-marks", "GET");
    for (const mark of marks.filter((each) => each.state !== "inbox"))
      await api(`/sessions/${mark.sessionId}/inbox-mark`, "PUT", { mark: { _tag: "Inbox" } });
    const id = await sessionId([RUNNING, RENAMED]);
    const { status } = await api(`/sessions/${id}/label`, "POST", { label: RUNNING });
    if (status !== 200) throw new Error(`putting the label back answered ${status}`);
  };
  /** Answers every tRPC call for `path` with a 500, one error per call in a batch. */
  const refuse = (path) =>
    page.route("**/trpc/**", async (route) => {
      const url = new URL(route.request().url());
      const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
      if (!paths.includes(path)) return route.continue();
      const error = {
        error: {
          json: {
            message: REFUSAL,
            code: -32603,
            data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
          },
        },
      };
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify(paths.map(() => error)),
      });
    });
  /** The row's "…": shown once the pointer is over the row. */
  const moreButton = async (label, title) => {
    await row(label, title).hover();
    const button = group(label).getByRole("button", { name: `Actions for ${title}` });
    await button.waitFor();
    return button;
  };
  const menu = () => page.getByRole("menu").filter({ visible: true }).first();
  const menuItem = (name) =>
    page.getByRole("menuitem", { name: new RegExp(`^${name}`) }).filter({ visible: true });
  const menuNames = () =>
    menu()
      .getByRole("menuitem")
      .evaluateAll((items) => items.map((item) => item.textContent?.trim() ?? ""));

  await page.setViewportSize(DESKTOP);
  await page.goto(`${web}/no-such-page`);
  await page.evaluate(() => {
    document.cookie = "mend-inbox-folds=; path=/; max-age=0";
    document.cookie = "mend-inbox-filters=; path=/; max-age=0";
    localStorage.setItem("mend-theme", "light");
  });
  await reset();
  await open("/");
  await setOpen("Running", true);
  await row("Running", RUNNING).waitFor();
  await showAll("To review");
  await row("To review", REVIEW).waitFor();

  // The row's "…" on hover, and its menu (frame zBtWEPVF9h): the session's own actions only.
  const more = await moreButton("Running", RUNNING);
  await capture("row-hover-desktop-light");
  await more.click();
  await menuItem("Open session").waitFor();
  const names = await menuNames();
  for (const name of MENU_ITEMS)
    if (!names.some((each) => each.startsWith(name))) throw new Error(`the menu lacks ${name}`);
  for (const name of NOT_IN_MENU)
    if (names.some((each) => each.startsWith(name))) throw new Error(`the menu holds ${name}`);
  note(`now-menus: the "…" menu reads ${names.join(" | ")}`);
  await menuItem("Snooze").hover();
  await menuItem("Tomorrow morning").waitFor();
  const choices = await page
    .getByRole("menu")
    .filter({ visible: true })
    .last()
    .getByRole("menuitem")
    .evaluateAll((items) => items.map((item) => item.textContent?.trim() ?? ""));
  note(`inbox-snooze-settle: the snooze choices read ${choices.join(" | ")}`);
  await both("menu-snooze-times-desktop");

  // Snooze: the row moves to Snoozed at once and says when it comes back; a toast says so.
  await menuItem("Tomorrow morning").click();
  await setOpen("Snoozed", true);
  await row("Snoozed", RUNNING)
    .getByText(/^Back tomorrow at 09:00$/)
    .waitFor();
  await toast(`Snoozed "${RUNNING}" until tomorrow at 09:00.`).waitFor();
  await both("snoozed-desktop");
  await open();
  await row("Snoozed", RUNNING).waitFor();
  note("inbox-snooze-settle: snoozed until tomorrow at 09:00; still under Snoozed after a reload");

  // Back from Snoozed, from the row's right-click menu.
  await row("Snoozed", RUNNING).click({ button: "right" });
  await menuItem("Unsnooze").click();
  await row("Running", RUNNING).waitFor();
  await toast(`Moved "${RUNNING}" out of Snoozed.`).waitFor();
  note("inbox-snooze-settle: Unsnooze from the right-click menu put it back under Running");

  // Rename in place, from the right-click menu (frame 5O6d7RDIIl): Enter saves.
  await row("Running", RUNNING).click({ button: "right" });
  await menuItem("Open session").waitFor();
  const contextNames = await menuNames();
  if (JSON.stringify(contextNames) !== JSON.stringify(names))
    throw new Error(`the right-click menu reads ${contextNames.join(" | ")}`);
  await both("context-menu-desktop");
  await menuItem("Rename").click();
  const box = inbox().getByRole("textbox", { name: "Session name" });
  await box.waitFor();
  const selected = await box.evaluate((input) =>
    input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0),
  );
  if (selected !== RUNNING) throw new Error(`the box selected "${selected}"`);
  await both("renaming-desktop");
  await box.fill(RENAMED);
  await box.press("Enter");
  await row("Running", RENAMED).waitFor();
  await toast(`Renamed to "${RENAMED}".`).waitFor();
  await capture("renamed-desktop-light");
  await open();
  await row("Running", RENAMED).waitFor();
  note(`rename-web: renamed to "${RENAMED}" in place; the name stays after a reload`);
  // F2 on the focused row opens the box; Esc leaves the name as it was.
  await row("Running", RENAMED).focus();
  await page.keyboard.press("F2");
  await box.waitFor();
  await box.fill("Not saved");
  await box.press("Escape");
  await row("Running", RENAMED).waitFor();
  if (!(await row("Running", RENAMED).evaluate((link) => link === document.activeElement)))
    throw new Error("the focus did not go back to the row");
  note("rename-web: F2 opens the box on the focused row; Esc keeps the name and the focus");
  // An empty name clears the label: the row shows its worktree's name.
  await row("Running", RENAMED).click({ button: "right" });
  await menuItem("Rename").click();
  await box.fill("");
  await box.press("Enter");
  await row("Running", RENAMED).waitFor({ state: "detached" });
  const cleared = await group("Running")
    .locator("a[data-session-id]")
    .evaluateAll((links) => links.map((link) => link.textContent));
  note(`rename-web: an empty name cleared the label; Running reads ${cleared.join(" | ")}`);

  // Mark done (frame fK6mqX5IgQ): the row moves to Done, marked by hand, and Undo puts it back.
  await (await moreButton("To review", REVIEW)).click();
  await menuItem("Mark done").click();
  await setOpen("Done", true);
  await showAll("Done");
  await row("Done", REVIEW).getByText("Marked done", { exact: true }).waitFor();
  await toast(`Moved "${REVIEW}" to Done.`).waitFor();
  await both("marked-done-desktop");
  await toasts()
    .getByRole("dialog")
    .filter({ hasText: `Moved "${REVIEW}" to Done.` })
    .getByRole("button", { name: "Undo" })
    .click();
  await showAll("To review");
  await row("To review", REVIEW).waitFor();
  await open();
  await showAll("To review");
  await row("To review", REVIEW).waitFor();
  note("inbox-snooze-settle: Mark done moved row-review to Done; Undo put it back under To review");

  // A row marked done offers Mark not done, which brings it back out of Done.
  await (await moreButton("To review", REVIEW)).click();
  await menuItem("Mark done").click();
  await row("Done", REVIEW).waitFor();
  await (await moreButton("Done", REVIEW)).click();
  const doneNames = await menuNames();
  if (doneNames.some((each) => each.startsWith("Mark done") || each.startsWith("Snooze")))
    throw new Error(`a Done row's menu reads ${doneNames.join(" | ")}`);
  await menuItem("Mark not done").click();
  await showAll("To review");
  await row("To review", REVIEW).waitFor();
  await toast(`Moved "${REVIEW}" out of Done.`).waitFor();
  note(
    `inbox-snooze-settle: in Done the menu reads ${doneNames.join(" | ")}; Mark not done put it back`,
  );

  // Open session opens the session's page.
  const reviewRowId = await row("To review", REVIEW).getAttribute("data-session-id");
  await (await moreButton("To review", REVIEW)).click();
  await menuItem("Open session").click();
  await page.waitForURL(new RegExp(`/sessions/${reviewRowId}$`));
  note("Open session opened /sessions/<id>, the session's page");
  await open("/");
  await showAll("To review");

  // Someone else's session has no Rename: only its owner renames it. The stack has one account, so
  // the inbox read is answered with one more row, a copy of row-review owned by someone else.
  const THEIRS = "Grace's session";
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    const at = paths.indexOf("sessions.inbox");
    if (at === -1) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const answer = Array.isArray(body) ? body[at] : body;
    const { json, meta } = answer.result.data;
    const index = json.findIndex((each) => each.title === REVIEW);
    const copy = structuredClone(json[index]);
    copy.session.id = "00000000-0000-4000-8000-000000000122";
    copy.session.ownerUserId = "someone-else";
    copy.session.label = THEIRS;
    copy.title = THEIRS;
    json.push(copy);
    for (const [key, value] of Object.entries(meta?.values ?? {}))
      if (key.startsWith(`${index}.`))
        meta.values[key.replace(/^\d+\./, `${json.length - 1}.`)] = value;
    await route.fulfill({ response, json: body });
  });
  await page.getByRole("button", { name: /^Inbox filters:/ }).click();
  await page.getByRole("menuitemradio", { name: "Everyone" }).click();
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    void window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries({
      queryKey: [["sessions", "inbox"]],
    });
  });
  await row("To review", THEIRS).waitFor();
  await (await moreButton("To review", THEIRS)).click();
  const theirNames = await menuNames();
  if (theirNames.some((each) => each.startsWith("Rename")))
    throw new Error(`someone else's row offers Rename: ${theirNames.join(" | ")}`);
  await capture("theirs-menu-desktop-light");
  await page.keyboard.press("Escape");
  await page.unroute("**/trpc/**");
  await page.getByRole("button", { name: /^Inbox filters:/ }).click();
  await page.getByRole("menuitemradio", { name: "Mine" }).click();
  await page.keyboard.press("Escape");
  note(
    `rename-web: someone else's session (a fixture row) has no Rename: ${theirNames.join(" | ")}`,
  );

  // Copy link (frame 0GWI0PsSOW): the session's address on this server, and a toast.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const reviewId = await row("To review", REVIEW).getAttribute("data-session-id");
  await (await moreButton("To review", REVIEW)).click();
  await menuItem("Copy link").click();
  await toast(`Copied the link to "${REVIEW}".`).waitFor();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const origin = new URL(page.url()).origin;
  if (copied !== `${origin}/sessions/${reviewId}`) throw new Error(`the link copied is ${copied}`);
  await both("link-copied-desktop");
  note(`copy link: the clipboard holds ${copied.replace(reviewId ?? "", "<id>")}`);

  // A refused change goes back, and says why.
  await refuse("sessions.setInboxMark");
  await (await moreButton("To review", REVIEW)).click();
  await menuItem("Mark done").click();
  await toast(`Couldn't mark done "${REVIEW}". ${REFUSAL}`).waitFor();
  await row("To review", REVIEW).waitFor();
  await both("mark-refused-desktop");
  await page.unroute("**/trpc/**");
  await refuse("sessions.setLabel");
  await (await moreButton("To review", REVIEW)).click();
  await menuItem("Rename").click();
  await box.fill("Refused name");
  await box.press("Enter");
  await toast(`Couldn't rename "${REVIEW}". ${REFUSAL}`).waitFor();
  await row("To review", REVIEW).waitFor();
  await capture("rename-refused-desktop-light");
  await page.unroute("**/trpc/**");
  note(
    "refused: a mark done and a rename the server refused went back, each with a toast saying why",
  );

  // Phone: the row's 44px "…" opens a sheet of 52px rows (frame rzB1j65Fxw).
  await page.setViewportSize(PHONE);
  await open("/");
  const phoneMore = inbox().getByRole("button", { name: `Actions for ${REVIEW}` });
  await phoneMore.waitFor();
  const size = await phoneMore.boundingBox();
  if (size === null || size.height < 44 || size.width < 44)
    throw new Error(`the phone's "…" is ${size?.width}×${size?.height}`);
  await phoneMore.click();
  const sheet = page.getByRole("dialog", { name: REVIEW });
  await sheet.waitFor();
  const heights = await sheet
    .getByRole("menuitem")
    .evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().height)));
  if (heights.some((height) => height < 44))
    throw new Error(`sheet rows are ${heights.join(", ")}`);
  note(
    `phone: the "…" is ${size.width}×${size.height}; the sheet's rows are ${heights.join(", ")}px`,
  );
  await both("phone-row-actions");
  await sheet.getByRole("menuitem", { name: "Snooze" }).click();
  await page.getByRole("dialog", { name: "Snooze until" }).waitFor();
  await both("phone-snooze-times");
  await page.getByRole("button", { name: "Back" }).click();
  await sheet.getByRole("menuitem", { name: "Rename…" }).click();
  await page.getByRole("dialog", { name: "Rename session" }).waitFor();
  await both("phone-rename");
  await page.getByRole("button", { name: "Cancel" }).click();
  await phoneMore.click();
  await sheet.getByRole("menuitem", { name: "Snooze" }).click();
  await page.getByRole("menuitem", { name: /^In an hour/ }).click();
  await page.getByRole("region", { name: "Snoozed", exact: true }).waitFor();
  await toast(/^Snoozed "row-review" until today at \d\d:\d\d\.$/)
    .waitFor()
    .catch(async () => {
      // Past 23:00 an hour from now is tomorrow.
      await toast(/^Snoozed "row-review" until tomorrow at \d\d:\d\d\.$/).waitFor();
    });
  await both("phone-snoozed");
  note(
    "phone: the sheet's Snooze → In an hour moved row-review to Snoozed, with a full-width toast",
  );

  // Pick a time: the phone's own snooze choice, any time ahead.
  const pick = new Date(Date.now() + 24 * 60 * 60_000);
  const local = `${pick.getFullYear()}-${pad(pick.getMonth() + 1)}-${pad(pick.getDate())}T10:30`;
  await inbox()
    .getByRole("button", { name: `Actions for ${RUNNING}` })
    .click();
  await page
    .getByRole("dialog", { name: RUNNING })
    .getByRole("menuitem", { name: "Snooze" })
    .click();
  await page.getByRole("menuitem", { name: "Pick a time…" }).click();
  await page.getByRole("dialog", { name: "Pick a time" }).waitFor();
  await page.getByLabel("Snooze until").fill(local);
  await both("phone-pick-a-time");
  await page.getByRole("button", { name: "Snooze", exact: true }).click();
  await page
    .getByRole("region", { name: "Snoozed", exact: true })
    .getByText("Back tomorrow at 10:30", { exact: true })
    .waitFor();
  await capture("phone-picked-time-light");
  note("phone: Pick a time… snoozed row-running until tomorrow at 10:30");

  await reset();
  note(
    "reset: every mark this account holds is back to the inbox, and row-running's label is back",
  );
};
