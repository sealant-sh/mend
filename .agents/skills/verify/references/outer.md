# The outer server, its tools, and capacity

Read this before the first `pnpm verify stack up` on a machine, or when it is blocked by its outer
server, a slot, or Docker Hub. In this file, Launch is `pnpm verify stack up` and Cleanup is
`pnpm verify stack down`. `$E` is the run's evidence directory, `$P` its private directory, `$wt`
its outer worktree and `$web` its tunnel; `.verify/stack/current.json` names each for the run that
is up.

- The outer server has the `mend` project adopted (shared), and its sessions can start a Docker
  service (the default). With no shared outer server free for a run (the box busy, or none),
  `local-outer.sh` makes one on this machine (Linux, Docker): a real Mend in Docker-in-Docker, named
  `st-verify-outer`, serving the tree under test as project `mend`:

  ```sh
  .agents/skills/verify/scripts/local-outer.sh up   # Mend 0.36.0-next.658 on 127.0.0.1:23105, budgets for parallel verifiers
  .agents/skills/verify/scripts/local-outer.sh serve HEAD   # prints the served commit, for --expect-mend
  export MEND_VERIFY_MACHINE_XDG=${XDG_CONFIG_HOME:-}      # this machine's own, before it changes
  export XDG_CONFIG_HOME=~/.cache/mend-verify/outer-cli   # the mend CLI now talks to it
  export MEND_VERIFY_OUTER_URL=http://127.0.0.1:23105      # and the guard lets it through
  .agents/skills/verify/scripts/local-outer.sh down   # after Cleanup: the container and its volumes
  ```

  Its defaults make one outer per machine. A second verifier on the same machine sets its own
  `MEND_VERIFY_OUTER_NAME`, `MEND_VERIFY_OUTER_PORT`, `MEND_VERIFY_OUTER_CONFIG` and
  `MEND_VERIFY_OUTER_WORK` for every `local-outer.sh` call (and its `XDG_CONFIG_HOME` and
  `MEND_VERIFY_OUTER_URL` to match): with the defaults, its `up` meets the first one's container and
  its `serve` writes into the first one's served repository.

  **Docker Hub pulls.** Docker Hub gives this machine's address 100 anonymous pulls an hour, and
  every outer and every stack would otherwise pull the same images; past the limit a pull fails with
  `toomanyrequests` and so does the run. Two things keep a run off it; neither logs in to Docker
  Hub.
  - **Seeding.** `up` loads the images this machine's Docker already holds into the outer's daemon,
    and `local-outer.sh seed` does it again for the Docker service of each session running in the
    outer (`stack up` does it): from this machine, or from the outer's daemon, which pulls an image
    once for all its sessions. A copy is loaded only while Docker Hub still names its digest for the
    tag; a stale one is reported and pulled instead. When Docker Hub refuses to say (its limit
    spent), the copy is loaded anyway and the line says `unchecked`. Every seeding line also goes to
    the outer's `/st-verify/seed.log`, which `seed` prints first, so a run's `seed.txt` holds what
    `up` loaded too. The network guard's image stays one pull per stack: it is named by digest, and
    a loaded image carries none.
  - **Held images are reused, and reported.** `stack.mjs` pulls only what its daemon lacks, and
    `seed` reuses what a daemon already holds: pulling a held tag would spend the limit again.
    Whenever Docker Hub does not confirm a held copy (a HEAD on the manifest, which it does not
    count), the run says `held <ref> <digest> · Hub has <digest>` (or `· Docker Hub did not answer`;
    a loaded copy is named by its image id). `stack.mjs` prints it in its log and keeps it in its
    state's `held`, which the doctor prints; `seed` keeps it in the seed log. With
    `MEND_VERIFY_REFRESH_IMAGES=1`, a held copy whose repo digest is provably another is pulled
    instead.
  - **One pull-through cache.** `local-outer.sh hub-cache up` starts `st-verify-hub-cache`
    (registry:2) on a Docker network of its own, `st-verify-hub-cache`, and publishes no port: this
    machine's firewall drops what containers send to the Docker bridge's address, and no LAN address
    ever reaches it. An outer brought up with
    `MEND_VERIFY_REGISTRY_MIRROR=http://st-verify-hub-cache:5000` joins that network and asks the
    cache first, so the cache pulls each image from Docker Hub once for every outer on this machine,
    and serves its copy while Docker Hub refuses. This machine reaches it by its container address,
    which `hub-cache status` prints with what it holds and Docker Hub's remaining pulls.
    `hub-cache down` removes the container and keeps its volume and network on purpose: the cache is
    shared by every outer on this machine, and the network may still hold running outers. A
    session's Docker service under Mend 0.36.0-next.658 takes no mirror, which is why `seed` fills
    it from the outer's daemon.

  ```sh
  .agents/skills/verify/scripts/local-outer.sh hub-cache up   # once per machine; it restarts with Docker
  export MEND_VERIFY_REGISTRY_MIRROR=http://st-verify-hub-cache:5000   # before `up`
  ```

  It always serves a complete repository (one parentless commit of the tree, then each serve on
  top), never a shallow clone: Mend refuses to adopt a shallow repository (mend#654), and a worktree
  whose history it cannot walk never finishes its Stop (`final seal · refused · unrestorable`). The
  outer session checks out the Mend branch under test, which must carry `scripts/verify-stack/` and
  this skill's `scripts/` (main does once #616, #617 and #642 land).

- `jq`, `curl`, `od`, `timeout`, `ps` and Node 26 on this machine.
- Playwright, kept outside every checkout, installed once. The subshell keeps your directory:

  ```sh
  (mkdir -p ~/.cache/mend-verify/playwright && cd ~/.cache/mend-verify/playwright \
    && npm init -y >/dev/null && npm install --no-audit --no-fund playwright-core \
    && node node_modules/playwright-core/cli.js install chromium-headless-shell)
  ```

## Isolation and capacity

- **One stack per verifier session.** The stack takes the product's own names (Compose project
  `mend`, volumes `mend-store`, `mend-control`, `mend-garage`), so its Docker daemon holds one, and
  `stack.mjs` refuses a daemon that already runs one. Each outer session has a Docker service of its
  own, so each verifier starts its own session, in a worktree of its own: the run's name carries a
  random suffix, and `mend run --name` joins a worktree that already has the name.
- **Everything the run makes is named `st-verify-<run>`:** the outer worktree, the stack's Service,
  the evidence directory, and every project a recipe adopts (`st-verify-<run>-<n>`). The stack's own
  inner names (`verify-fixture`, `verifier@verify-stack.invalid`) are the stack's.
- **Drive only what this run started:** the stack whose doctor matched, the tunnel `tunnel.mjs`
  recorded, the sessions whose ids you recorded. Never the owner's Mend ([guard.md](guard.md),
  refuses any `mend` not aimed at the declared outer server), and never another verifier's
  `st-verify-` session.
- **How many at once: at most 4 stacks live and 2 building, across the machine.** That is the limit
  the verify stack's author recommends from the box's numbers (12 CPUs and 39 GB, shared with the
  server and everyone's sessions). Per stack on the box, in #616's runs: 1.7 to 2.0 GiB idle (every
  process of its Docker daemon), 6.3 GiB at the build peak, plus about 0.6 GiB for the outer
  session's workspace. **Cold builds are the limit**: one keeps all 12 CPUs busy for 3 to 4 minutes,
  and two at once share them. `stack.mjs` cannot enforce this, since each session has its own Docker
  daemon, so Launch counts (`slots.mjs`, steps 1 and 4). The owner's decision on the roadmap ("how
  many stacks the box runs at once") may change the numbers: pass them as `--max` and
  `--max-building`.
- **The box.** Start no stack while an `st-bench-` session is starting or running
  (`mend sessions --all`), or during a server upgrade.
