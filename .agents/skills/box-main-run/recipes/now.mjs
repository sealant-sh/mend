// The Now page's inbox lists this run's session, on the box (flows.md: web-now). The session is
// $MAIN_RUN_SESSION.
//
//   MAIN_RUN_SESSION=<id> node .agents/skills/verify/scripts/drive-web.mjs ... \
//     --recipe .agents/skills/box-main-run/recipes/now.mjs
export default async ({ page, web, capture, note }) => {
  const id = process.env.MAIN_RUN_SESSION;
  if (!id) throw new Error("MAIN_RUN_SESSION is not set");
  await page.goto(`${web}/`);
  const inbox = page.getByRole("complementary", { name: "Sessions" });
  await inbox.waitFor();
  await inbox.locator(`a[href$="/sessions/${id}"]`).first().waitFor();
  note(`the Sessions inbox has a row linking to ${id.slice(0, 8)}`);
  await capture("now");
};
