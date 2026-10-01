---
"@sealant/mend": minor
---

`mend connect pi` sends your pi setup to Mend, and every pi session you start receives it: your
extensions, themes, prompt templates, settings, `mcp.json` and keybindings. A setup Home Manager
links in is read through its links, and a package named by local path is copied in. Before pi
starts, the session installs what your extensions import and the packages your settings declare. A
package that fails to install, such as one that needs a compiler the image lacks, is left out of
that session and the terminal says why, instead of stopping pi. Settings changed inside a session
keep their values. `--dry-run` shows what would be sent and what stays on your machine: your login,
sessions and installed packages never leave it.
