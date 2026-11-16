// Resume a stopped session from its page, on the box (flows.md: boat-stop-resume). The session is
// $MAIN_RUN_SESSION, stopped with `mend stop` just before; the CLI stops it again afterwards.
//
//   MAIN_RUN_SESSION=<id> node .agents/skills/verify/scripts/drive-web.mjs ... \
//     --recipe .agents/skills/box-main-run/recipes/resume.mjs --timeout 300000
export default async ({ page, web, capture, note }) => {
  const id = process.env.MAIN_RUN_SESSION;
  if (!id) throw new Error("MAIN_RUN_SESSION is not set");
  await page.goto(`${web}/sessions/${id}`);
  const main = page.getByRole("main");
  await main.getByText("Stopped", { exact: true }).first().waitFor();
  note("the page reads Stopped");
  await capture("stopped");
  await main.getByRole("button", { name: "codex", exact: true }).click();
  note("pressed resume with: codex");
  await main
    .getByText(/^Running/)
    .first()
    .waitFor({ timeout: 240_000 });
  note("the page reads Running");
  await capture("resumed");
};
