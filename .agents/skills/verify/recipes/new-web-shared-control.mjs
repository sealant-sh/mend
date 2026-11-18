// Shared control for one person (shared-control.md, `ask`, `withdraw`, `grant`, `take-back`,
// `switch-ends-grants`, `audit`; SLNT-1149), through the new web app's data layer: no screen asks or
// grants yet (route PR 34). Two people in the stack's one organization: its owner (the stack's first
// account, `page`) and a member who joins through an invitation in a second browser (`member`).
// The session is the owner's `mend run` session the CLI batch beside this recipe starts:
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-shared-control-setup.json
//   pnpm verify drive new-web --recipe new-web-shared-control --account <account.json>
//
// The recipe sets verify-fixture to shared for the member, and puts it back to private, stops the
// session and leaves nobody holding or asking for shared control at its end.
const SESSION_PREFIX = "share-";

/** One person's API, from their signed-in page: what the web app's data layer calls. */
const apiOf = (on) => (method, url, body) =>
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
const names = (people) => (people ?? []).map((person) => person.userId);

export default async ({ page, web, capture, note, typeSecret, registerSecret, account }) => {
  if (account === null) throw new Error("this recipe signs the owner in: run it with --account");
  const owner = apiOf(page);

  await page.goto(`${web}/`);
  const me = await owner("GET", "/api/organization");
  expect("the owner's organization", me.status === 200, me);
  const ownerId = me.body.userId;

  // The owner's live `mend run` session from the CLI batch.
  const listed = await owner("GET", "/api/sessions");
  const session = (listed.body ?? [])
    .filter(
      (row) =>
        row.ownerUserId === ownerId &&
        [row.label, row.worktree, row.branch].some((name) => (name ?? "").includes(SESSION_PREFIX)),
    )
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  expect("the batch's session", session !== undefined, listed.status);
  const id = session.id;
  const base = `/api/sessions/${id}/shared-control`;
  note(
    `the owner's session ${id.slice(0, 8)} (${session.label ?? session.worktree}), ${session.status}`,
  );

  // The member sees the project: verify-fixture shared, then a second person joins.
  const project = session.projectId;
  const shared = await owner("PUT", `/api/projects/${project}/visibility`, {
    visibility: "shared",
  });
  expect("verify-fixture shared", shared.status === 200, shared);
  const invitation = await owner("POST", "/api/organization/invitations", { role: "member" });
  expect("an invitation", invitation.status === 200, invitation.status);
  registerSecret("invitation-token", invitation.body.token);

  const second = await page.context().browser().newContext();
  const memberPage = await second.newPage();
  await memberPage.goto(`${web}/join#${invitation.body.token}`);
  await memberPage.getByRole("heading", { name: /^Join / }).waitFor();
  const email = `verify-share-${Date.now()}@example.invalid`;
  await memberPage.getByRole("textbox", { name: "Name" }).fill("Ada Verify");
  await memberPage.getByRole("textbox", { name: "Email" }).fill(email);
  await typeSecret(
    memberPage.getByLabel("Password", { exact: true }),
    "member-password",
    "a-share-verify-password",
  );
  await typeSecret(
    memberPage.getByLabel("Confirm password"),
    "member-password",
    "a-share-verify-password",
  );
  await memberPage.getByRole("button", { name: "Create account and join", exact: true }).click();
  await memberPage.waitForURL((url) => url.pathname === "/welcome");
  const member = apiOf(memberPage);
  const memberMe = await member("GET", "/api/organization");
  expect(
    "the member's organization",
    memberMe.status === 200 && memberMe.body.role === "member",
    memberMe,
  );
  const memberId = memberMe.body.userId;
  note(`a second person joined as a member (${email})`);

  try {
    // Before anything: nobody but the owner steers.
    const before = await member("GET", base);
    expect(
      "the member's first read",
      before.status === 200 &&
        before.body.acts.ask === true &&
        before.body.steer === false &&
        before.body.everyoneSince === null &&
        before.body.granted.length === 0,
      before,
    );
    note(
      `member reads: steer false, acts.ask true, everyoneSince null, granted [], turnsOnSendersLogin ${before.body.turnsOnSendersLogin}`,
    );

    // ask
    const asked = await member("POST", `${base}/ask`);
    expect(
      "the ask",
      asked.status === 200 &&
        names(asked.body.asked).join() === memberId &&
        asked.body.acts.withdraw === true,
      asked,
    );
    const again = await member("POST", `${base}/ask`);
    expect("asking again", again.status === 200 && again.body.asked.length === 1, again);
    note("member asks: 200, asked names them, acts.withdraw true; asking again: still one ask");

    const inbox = await owner("GET", "/api/session-inbox");
    const row = (inbox.body ?? []).find((entry) => entry.session.id === id);
    expect(
      "the owner's inbox row",
      names(row?.sharedControlAsks).join() === memberId,
      row?.sharedControlAsks,
    );
    const ownerView = await owner("GET", base);
    expect(
      "the owner's read",
      names(ownerView.body.asked).join() === memberId && ownerView.body.acts.decide === true,
      ownerView,
    );
    note(
      "owner's inbox row: sharedControlAsks names the member; owner's read: asked names them, acts.decide true",
    );

    // Only the owner grants.
    const selfGrant = await member("POST", `${base}/people/${memberId}/grant`);
    expect("the member granting themselves", selfGrant.status === 403, selfGrant);
    note(
      `member grants themselves: ${selfGrant.status} ${selfGrant.body?._tag}: ${selfGrant.body?.message}`,
    );

    // grant
    const granted = await owner("POST", `${base}/people/${memberId}/grant`);
    expect(
      "the grant",
      granted.status === 200 &&
        names(granted.body.granted).join() === memberId &&
        granted.body.everyoneSince === null &&
        granted.body.asked.length === 0,
      granted,
    );
    const detail = await member("GET", `/api/sessions/${id}`);
    expect(
      "the member's session detail",
      detail.body?.control?.steer === true &&
        detail.body?.control?.terminalInput === false &&
        detail.body?.session?.sharedControlEnabledAt === null &&
        (detail.body?.session?.sharedControlUserIds ?? []).join() === memberId,
      detail.body?.control,
    );
    note(
      "owner grants: 200, granted names the member, everyoneSince null; member's detail: control.steer true, terminalInput false, session.sharedControlUserIds [member], sharedControlEnabledAt null",
    );

    const twice = await owner("POST", `${base}/people/${memberId}/grant`);
    expect("granting twice", twice.status === 409 && twice.body?.reason === "not-asked", twice);
    note(
      `granting again: 409 ${twice.body?._tag} reason ${twice.body?.reason}: ${twice.body?.message}`,
    );

    // take-back
    const back = await owner("POST", `${base}/people/${memberId}/take-back`);
    expect("the take-back", back.status === 200 && back.body.granted.length === 0, back);
    const after = await member("GET", `/api/sessions/${id}`);
    expect("the member's detail after", after.body?.control?.steer === false, after.body?.control);
    note("owner takes it back: 200, granted []; member's detail: control.steer false");

    // switch-ends-grants: ask, grant, then the switch for everyone turned off.
    await member("POST", `${base}/ask`);
    await owner("POST", `${base}/people/${memberId}/grant`);
    const off = await owner("PUT", base, { enabled: false });
    expect(
      "the switch off",
      off.status === 200 &&
        (off.body?.sharedControlUserIds ?? []).length === 0 &&
        off.body?.sharedControlEnabledAt === null,
      off.body,
    );
    const afterOff = await member("GET", base);
    expect(
      "the member's read after off",
      afterOff.body.granted.length === 0 && afterOff.body.steer === false,
      afterOff.body,
    );
    note(
      "ask, grant, then PUT shared-control {enabled:false} (the old switch): sharedControlUserIds [], member steers no more",
    );

    // withdraw
    await member("POST", `${base}/ask`);
    const withdrawn = await member("POST", `${base}/withdraw`);
    expect(
      "the withdrawal",
      withdrawn.status === 200 && withdrawn.body.asked.length === 0,
      withdrawn,
    );
    const grantWithdrawn = await owner("POST", `${base}/people/${memberId}/grant`);
    expect(
      "granting a withdrawn ask",
      grantWithdrawn.status === 409 && grantWithdrawn.body?.reason === "not-asked",
      grantWithdrawn,
    );
    note("member asks then withdraws: asked []; owner's grant of it: 409 not-asked");

    // The control log and the audit log.
    const events = await owner("GET", `/api/sessions/${id}/control-events`);
    const kinds = (events.body ?? [])
      .filter((event) => event.kind.startsWith("shared-control"))
      .map((event) => `${event.kind}${event.refId === memberId ? "(member)" : ""}`);
    expect(
      "the control log",
      [
        "shared-control-ask(member)",
        "shared-control-grant(member)",
        "shared-control-take-back(member)",
        "shared-control-off",
        "shared-control-withdraw(member)",
      ].every((kind) => kinds.includes(kind)),
      kinds,
    );
    note(`control log: ${kinds.join(", ")}`);
    const audit = await owner("GET", "/api/organization/audit?limit=20");
    const actions = (audit.body ?? [])
      .map((entry) => entry.event.action)
      .filter((action) => action.startsWith("session.shared_control"));
    expect(
      "the audit log",
      actions.includes("session.shared_control_granted") &&
        actions.includes("session.shared_control_taken_back"),
      actions,
    );
    note(`audit log: ${actions.join(", ")}`);

    await page.goto(`${web}/`);
    await capture("owner-after-shared-control");
  } finally {
    await owner("POST", `/api/sessions/${id}/stop`);
    await owner("PUT", `/api/projects/${project}/visibility`, { visibility: "private" });
    await second.close();
    note("restored: session stopped, verify-fixture private again");
  }
};
