// Sets who sees `main-run-second` (SKILL.md, step 6's warm-up): `Everyone in Default` while the
// second account starts its one session there, then `Only you` again. Run it as the owner, with the
// project's id from `M projects --json`:
//
//   MAIN_RUN_PROJECT=<id> MAIN_RUN_VISIBILITY=shared|private \
//     ~/.local/state/mend-main-run/lanes/a/bin/web <out dir> .agents/skills/box-main-run/recipes/second-visibility.mjs
//
// It reads the choice back after a reload, and fails when the page does not hold it.
export default async ({ page, web, capture, note }) => {
  const project = process.env.MAIN_RUN_PROJECT;
  const visibility = process.env.MAIN_RUN_VISIBILITY;
  if (!project) throw new Error("MAIN_RUN_PROJECT is not set");
  if (visibility !== "shared" && visibility !== "private")
    throw new Error("MAIN_RUN_VISIBILITY is shared or private");
  const name = visibility === "shared" ? "Everyone in Default" : "Only you";
  const pressed = () =>
    page.waitForFunction(
      (label) =>
        [...document.querySelectorAll("button")].some(
          (button) =>
            button.textContent === label && button.getAttribute("aria-pressed") === "true",
        ),
      name,
      { timeout: 20000 },
    );
  await page.goto(`${web}/projects/${project}/settings/general`);
  await page.getByRole("button", { name, exact: true }).click();
  await pressed();
  await page.reload();
  await page.getByRole("heading", { name: "General", exact: true }).waitFor();
  await pressed();
  note(`main-run-second reads ${name} after a reload`);
  await capture(`second-${visibility}`);
};
