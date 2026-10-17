# Default shell profile execution fixture

The shell-profile tests execute the bytes returned by `loadShellProfile` in a disposable zsh
container. The fixture isolates the profile's absolute `/usr/share` and `/root` plugin paths, which
an isolated host HOME cannot hide. It contains zsh and no optional prompt programs or plugins.
Controlled files and programs are mounted by each test; the profile is not rewritten.

Build the fixture once before running these tests locally:

```sh
docker build -t mend-shell-profile-test:alpine-3.22 packages/sessions/test/fixtures/shell-profile
pnpm --filter @mend/sessions exec vitest run src/shell-profile.test.ts
```

Docker, a nonroot Unix user and this local image are required. Missing prerequisites fail the tests
rather than skip them. CI builds the image before the normal test lane. Only image preparation
downloads packages; test containers have no network, run as a nonroot user with no capabilities, and
mount only owned synthetic fixture directories. Their HOME is writable; the image and plugin mounts
are read-only.

These tests cover actual zsh startup and controlled program/plugin interfaces. They do not attest
real fzf, direnv or starship versions, every supported distribution, or a live workspace delivery.
