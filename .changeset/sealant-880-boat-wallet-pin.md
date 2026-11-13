---
"@sealant/mend": patch
---

Update the bundled sealant SDK and images to 0.40.0-next.880.

- **A personal Boat key now bills one wallet, fixed when it is connected.** sealant pins a personal
  key to the wallet it bills at that moment, and every request names that wallet from then on, so
  switching your active wallet in Boat no longer moves Mend's bill. Every VM and image sealant makes
  in Boat is recorded with the wallet it was made in. A key connected before this upgrade is pinned
  to the wallet it bills within about a minute; until then it starts no new Boat session, and
  sessions already running on it carry on.
- **Boat keys need the `account.read` permission.** The command on the Boat page always asked for
  it; sealant now requires it. A key made without it keeps its running sessions but starts no new
  one, and the Boat page and `mend boat status` say so. Boat never adds a permission to an existing
  key: replace it with one made with the command on the page.
- **Boat images nothing uses any more are removed.** Once an hour sealant deletes the saved Boat
  images it built that no session can start from any more: none used in the last day, and none a
  session stopped in the last 14 days would start from. An image goes at the first hourly pass after
  it is both unused and older than that day, so the saved snapshot count drops as each old image
  reaches that point, not all at the first pass. Each Boat account's saved snapshot slots fill up
  much more slowly.
- **Nix sessions on Boat start with the shell their environment declares.** This changes a file in
  every Boat image, so each Boat environment's image is built once more, at its next session start.
