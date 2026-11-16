// The Now inbox's row for one session: a link to /sessions/<id> in the `Sessions` inbox, under its
// group or, once settled, under the `Settled` fold. The row has no name a recipe can know ahead
// (its title is the session's label or worktree), so it is found by its link's target.
export const inboxRow = async (page, web, id, note) => {
  await page.goto(`${web}/`);
  const inbox = page.getByRole("complementary", { name: "Sessions" });
  await inbox.waitFor();
  const row = inbox.locator(`a[href$="/sessions/${id}"]`).first();
  if ((await row.count()) === 0) {
    await inbox.getByRole("button", { name: /^Settled/ }).click();
    note("opened the Settled fold");
  }
  await row.waitFor();
  return row;
};
