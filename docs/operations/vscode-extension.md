# Publishing the VS Code extension

The extension in `apps/vscode` is published as `sealant-sh.mend` to the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=sealant-sh.mend) and
[Open VSX](https://open-vsx.org/extension/sealant-sh/mend) (which VSCodium, Cursor and other VS Code
builds install from). The workflow is `.github/workflows/publish-vscode.yml`. It packages the
extension with no credential in reach, publishes the `.vsix` to Open VSX from the
`vscode-marketplace` environment after an approval, and attaches the same `.vsix` to a
`vscode-vX.Y.Z` GitHub release. The owner uploads that `.vsix` to the Marketplace by hand. Automated
Marketplace publishing would need Azure DevOps or Microsoft Entra ID, and is deliberately not used.

## Versions

The extension's version follows the Mend release it needs: `0.36.x` works with a Mend 0.36 server.
The minor moves with Mend's minor; the patch is the extension's own, so an extension-only fix is
`0.36.1` whether or not Mend has a `0.36.1`. The Marketplace takes `X.Y.Z` only, so the extension
has no `-next.N` builds; a preview of it is a `.vsix` from the workflow's pull request run.

`apps/vscode` is a private package, and `.changeset/config.json` keeps private packages out of
versioning (`privatePackages.version: false`), so the Version Packages pull request never touches
it. A release of the extension is its own pull request: bump `version` in `apps/vscode/package.json`
and add a `## X.Y.Z` section to `apps/vscode/CHANGELOG.md`. The workflow refuses a version without
that section, a tag that does not match `package.json`, and a commit that is not on main.

The tags do not collide with Mend's: `release-cli.yml` ignores `vscode-v*`, and the next-version and
release-pin scripts read only `vX.Y.Z` and `vX.Y.Z-next.N` tags.

## One-time setup (the owner)

Every step needs an account only the owner holds. Nothing here is automated.

1. **Marketplace publisher.** Sign in at <https://marketplace.visualstudio.com/manage> with the
   Microsoft account that will own the extension (a Microsoft account is all it needs; no Azure
   DevOps organization), choose **Create publisher**, and enter ID `sealant-sh` (it must equal
   `publisher` in `apps/vscode/package.json` and cannot be changed later) and name `Sealant`.
2. **Open VSX account.** Register an Eclipse account at <https://accounts.eclipse.org/user/register>
   with the **GitHub Username** field set to the GitHub account you will use. Sign in at
   <https://open-vsx.org> with that GitHub account, open **Settings**, choose **Log in with
   Eclipse**, then **Show Publisher Agreement** and **Agree**.
3. **Open VSX token and namespace.** In **Settings → Access Tokens**, generate a token and copy it.
   Then create the namespace:

   ```sh
   npx ovsx create-namespace sealant-sh -p <open-vsx-token>
   ```

   The namespace works unverified; Open VSX marks it so until ownership is claimed through its
   [namespace access](https://github.com/eclipse/openvsx/wiki/Namespace-Access) process.

4. **The environment and its secret.** In the repository's **Settings → Environments**, create
   `vscode-marketplace`: add yourself as a **required reviewer**, and under **Deployment branches
   and tags** allow the branch `main` and tags matching `vscode-v*`. Store the Open VSX token there
   as the environment secret `OVSX_PAT`, so only the approved publish job can read it:

   ```sh
   gh api -X PUT repos/sealant-sh/Mend/environments/vscode-marketplace
   gh secret set OVSX_PAT --repo sealant-sh/Mend --env vscode-marketplace
   ```

   Add the reviewer and the deployment rules in the web UI. The workflow refuses to publish while
   the environment has no required reviewer, since GitHub would otherwise create it unprotected.
   Without `OVSX_PAT` the run skips Open VSX with a notice, and you upload the `.vsix` there by hand
   too (step 4 of [Publish a version](#publish-a-version)).

## Publish a version

After Mend's own release of the same minor (the extension needs that server):

1. **Push the tag.**

   ```sh
   git tag vscode-v0.36.0 <merged commit on main> && git push origin vscode-v0.36.0
   ```

   or dispatch from main, which tags the commit it published:

   ```sh
   gh workflow run publish-vscode.yml --repo sealant-sh/Mend --ref main
   ```

2. **Approve the run.** Approve the `vscode-marketplace` deployment when the run asks. The run
   publishes to Open VSX, attaches `mend-X.Y.Z.vsix` to the `vscode-vX.Y.Z` release, and says in its
   job summary what is left to upload by hand.
3. **Download the `.vsix`** from the release:

   ```sh
   gh release download vscode-v0.36.0 --repo sealant-sh/Mend --pattern 'mend-*.vsix'
   ```

4. **Upload it to the Marketplace** at
   <https://marketplace.visualstudio.com/manage/publishers/sealant-sh>. The first upload, **New
   extension → Visual Studio Code**, creates the listing; later versions use **Update** on the
   `Mend` row (the **⋯** menu). The Marketplace checks the package before it shows the version,
   which can take a few minutes. If `OVSX_PAT` is not set, upload the same file at
   <https://open-vsx.org/user-settings/extensions> as well.

A re-run, or a dispatch from the existing `vscode-vX.Y.Z` tag, skips what Open VSX already has and
adds a missing release asset; it never replaces a published version. A version is published from one
commit: a tag that already names another commit is refused, so a change needs a version bump.

Check the result:

```sh
npx @vscode/vsce show sealant-sh.mend
curl -s https://open-vsx.org/api/sealant-sh/mend | jq -r .version
```
