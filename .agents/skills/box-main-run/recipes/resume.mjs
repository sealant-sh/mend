// Resume a stopped session as a person does from the Now inbox, on the box (flows.md:
// attach-resume.boat-stop-resume). The session is $MAIN_RUN_SESSION, stopped with `mend stop` just
// before; the CLI stops it again afterwards. The row's context menu carries `Resume session` (the
// session page's `resume with:` buttons went in #1390); it opens the session page.
//
//   MAIN_RUN_SESSION=<id> node .agents/skills/verify/scripts/drive-web.mjs ... \
//     --recipe .agents/skills/box-main-run/recipes/resume.mjs --timeout 180000
import { inboxRow } from "./inbox.lib.mjs";

export default async ({ page, web, capture, note }) => {
  const id = process.env.MAIN_RUN_SESSION;
  if (!id) throw new Error("MAIN_RUN_SESSION is not set");
  const row = await inboxRow(page, web, id, note);
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Resume session", exact: true }).click();
  note("chose Resume session on its row");
  await page.waitForURL(new RegExp(`/sessions/${id}`));
  await page
    .getByRole("main")
    .getByText(/^running/i)
    .first()
    .waitFor({ timeout: 150_000 });
  note("the session page reads running");
  await capture("resumed");
};
