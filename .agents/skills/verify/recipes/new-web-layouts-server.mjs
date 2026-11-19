// A person's saved layouts, on the server (SLNT-1175, ADR 0026 "Layouts"; flow
// `session-page.new-web-layouts`). No screen yet: route PR 16 adds the layout menu. Every call
// goes from the signed-in page, as the web app's data layer makes it, to the stack's API built
// from this commit: `/api/me/layouts` and the web app's own `layouts` procedures under `/trpc`.
// Two people in the stack's one organization: its first account, and a member who joins through
// an invitation. The recipe removes every layout it saved, so it runs again on the same stack.
//
//   pnpm verify drive new-web --recipe new-web-layouts-server
const PREFIX = "Verify ";
const tile = (tabs) => ({ kind: "tile", tabs, active: 0 });
const conversation = { kind: "session" };
const change = { kind: "view", view: "change" };
const beside = {
  version: 1,
  root: {
    kind: "split",
    direction: "row",
    children: [tile([conversation]), tile([change])],
    sizes: [55, 45],
  },
  focus: 0,
};
const nineTiles = {
  version: 1,
  root: {
    kind: "split",
    direction: "row",
    children: Array.from({ length: 9 }, () => tile([conversation])),
    sizes: Array.from({ length: 9 }, () => 100 / 9),
  },
  focus: 0,
};

/** One person's calls, from their signed-in page. */
const callsOf = (on) => async (method, url, body) =>
  on.evaluate(
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
const expect = (what, ok, seen) => {
  if (!ok) throw new Error(`${what}: saw ${JSON.stringify(seen).slice(0, 400)}`);
};

/** One person's saved layout names. */
const names = async (as) =>
  ((await as("GET", "/api/me/layouts")).body?.layouts ?? []).map((layout) => layout.name);

/** Removes every layout this recipe saved for one person. */
const removeOurs = async (as) => {
  const listed = (await as("GET", "/api/me/layouts")).body?.layouts ?? [];
  for (const layout of listed.filter((each) => each.name.startsWith(PREFIX)))
    await as("DELETE", `/api/me/layouts/${layout.id}`);
};

export default async ({ page, web, capture, note, typeSecret, registerSecret }) => {
  const transcript = [];
  /** A call, kept for the transcript the recipe captures at its end. */
  const record = (who, call) => async (method, url, body) => {
    const answer = await call(method, url, body);
    const shown =
      answer.status >= 400
        ? `${answer.body?._tag ?? ""} ${answer.body?.message ?? ""}`.trim()
        : JSON.stringify(answer.body).slice(0, 160);
    transcript.push(`${who}: ${method} ${url} → ${answer.status} ${shown}`);
    return answer;
  };
  await page.goto(`${web}/`);
  await page.getByRole("heading", { name: "New session", exact: true }).waitFor();
  const owner = record("owner", callsOf(page));
  // A run that stopped half way left its layouts: start from none of ours.
  await removeOurs(owner);
  const before = await names(owner);
  note(`the owner starts with ${before.length} saved layouts of their own`);

  // Save, then read back through the API and the web app's procedures.
  const saved = await owner("POST", "/api/me/layouts", { name: `${PREFIX}Review`, layout: beside });
  expect("the save", saved.status === 200 && typeof saved.body?.id === "string", saved);
  expect(
    "the saved layout as sent",
    JSON.stringify(saved.body.layout) === JSON.stringify(beside),
    saved,
  );
  expect("its times", typeof saved.body.createdAt === "string", saved.body);
  const id = saved.body.id;
  note(`saved "${PREFIX}Review" (${id.slice(0, 8)}): a conversation beside Change, 55 to 45`);
  expect("listed", (await names(owner)).includes(`${PREFIX}Review`), await names(owner));
  const viaTrpc = await owner("POST", "/trpc/layouts.list");
  const trpcNames = (viaTrpc.body?.result?.data?.json?.layouts ?? []).map((each) => each.name);
  expect("the layouts procedure lists it", trpcNames.includes(`${PREFIX}Review`), viaTrpc);
  const trpcSave = await owner("POST", "/trpc/layouts.save", {
    json: { name: `${PREFIX}From the app`, layout: { ...beside, focus: 1 } },
  });
  expect("the save procedure", trpcSave.status === 200, trpcSave);
  note("the web app's layouts.list reads it, and layouts.save saves another");

  // Refusals, each leaving the list as it was.
  const listedBefore = await names(owner);
  const sameName = await owner("POST", "/api/me/layouts", {
    name: `${PREFIX}REVIEW`,
    layout: beside,
  });
  expect("a name used in another case", sameName.status === 409, sameName);
  expect("its tag", sameName.body?._tag === "SavedLayoutNameTaken", sameName.body);
  note(`a name already used, in capitals: 409, "${sameName.body.message}"`);
  const trpcSameName = await owner("POST", "/trpc/layouts.save", {
    json: { name: `${PREFIX}review`, layout: beside },
  });
  expect("the same refusal through the app", trpcSameName.status === 409, trpcSameName);
  for (const [what, layout] of [
    [
      "a layout naming a session",
      { ...beside, root: tile([{ kind: "session", sessionId: "s-1" }]) },
    ],
    ["a version the server doesn't know", { ...beside, version: 2 }],
    ["nine tiles", nineTiles],
  ]) {
    const refused = await owner("POST", "/api/me/layouts", { name: `${PREFIX}Refused`, layout });
    expect(what, refused.status === 400, refused);
    note(`${what}: refused with 400`);
  }
  expect(
    "nothing refused was stored",
    JSON.stringify(await names(owner)) === JSON.stringify(listedBefore),
    await names(owner),
  );

  const renamed = await owner("PATCH", `/api/me/layouts/${id}`, { name: `${PREFIX}Side by side` });
  expect("the rename", renamed.status === 200 && renamed.body?.id === id, renamed);
  expect("only the name", JSON.stringify(renamed.body.layout) === JSON.stringify(beside), renamed);
  note(`renamed to "${PREFIX}Side by side", same id and layout`);

  // A second person sees none of the owner's layouts, and can't change one.
  const invitation = await callsOf(page)("POST", "/api/organization/invitations", {
    role: "member",
  });
  expect("an invitation", invitation.status === 200, invitation.status);
  registerSecret("invitation-token", invitation.body.token);
  const second = await page.context().browser().newContext();
  const memberPage = await second.newPage();
  const joinHeading = memberPage.getByRole("heading", { name: /^Join / });
  await memberPage.goto(`${web}/join#${invitation.body.token}`);
  await joinHeading.waitFor({ timeout: 45_000 }).catch(async () => {
    note("the join page didn't show its heading; loading it again");
    await memberPage.goto(`${web}/join#${invitation.body.token}`);
    await joinHeading.waitFor({ timeout: 60_000 });
  });
  await memberPage.getByRole("textbox", { name: "Name" }).fill("Lin Verify");
  await memberPage
    .getByRole("textbox", { name: "Email" })
    .fill(`verify-layouts-${Date.now()}@example.invalid`);
  await typeSecret(
    memberPage.getByLabel("Password", { exact: true }),
    "member-password",
    "a-layouts-verify-password",
  );
  await typeSecret(
    memberPage.getByLabel("Confirm password"),
    "member-password",
    "a-layouts-verify-password",
  );
  await memberPage.getByRole("button", { name: "Create account and join", exact: true }).click();
  await memberPage.waitForURL((url) => url.pathname === "/welcome");
  const member = record("member", callsOf(memberPage));
  const theirs = await member("GET", "/api/me/layouts");
  expect(
    "the member's own list",
    theirs.status === 200 && theirs.body.layouts.length === 0,
    theirs,
  );
  note("a second person joined: their list is empty, none of the owner's");
  const notTheirs = await member("PATCH", `/api/me/layouts/${id}`, { name: "Mine now" });
  expect("renaming the owner's", notTheirs.status === 404, notTheirs);
  const notRemoved = await member("DELETE", `/api/me/layouts/${id}`);
  expect("removing the owner's", notRemoved.body?.removed === false, notRemoved);
  expect("the owner's is untouched", (await names(owner)).includes(`${PREFIX}Side by side`), null);
  note(`the member renaming it: 404, "${notTheirs.body.message}"; removing it: removed false`);
  const theirOwn = await member("POST", `/api/me/layouts`, {
    name: `${PREFIX}Review`,
    layout: beside,
  });
  expect("the member may use the owner's name", theirOwn.status === 200, theirOwn);
  await removeOurs(member);
  await second.close();

  // The limit: 20 per person.
  const count = (await names(owner)).length;
  for (let n = count + 1; n <= 20; n += 1) {
    const one = await owner("POST", "/api/me/layouts", { name: `${PREFIX}${n}`, layout: beside });
    expect(`layout ${n}`, one.status === 200, one);
  }
  const past = await owner("POST", "/api/me/layouts", { name: `${PREFIX}21`, layout: beside });
  expect("the 21st", past.status === 409 && past.body?._tag === "SavedLayoutLimitReached", past);
  note(`20 saved, the 21st: 409, "${past.body.message}"`);

  const removed = await owner("DELETE", `/api/me/layouts/${id}`);
  expect("removing it", removed.body?.removed === true, removed);
  await removeOurs(owner);
  const after = await names(owner);
  expect("the list ends as it began", JSON.stringify(after) === JSON.stringify(before), after);
  note("removed every layout the recipe saved: the owner's list is as it began");

  // The transcript, as the page shows it, for the evidence.
  await page.evaluate((lines) => {
    document.body.innerHTML = "";
    const pre = document.createElement("pre");
    pre.style.cssText =
      "font: 13px/1.5 ui-monospace, monospace; padding: 24px; white-space: pre-wrap";
    pre.textContent = lines.join("\n");
    document.body.append(pre);
  }, transcript);
  await capture("transcript");
};
