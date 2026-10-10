---
"@sealant/mend": minor
---

`mend server setup` runs two mirrors beside Mend, on by default: an npm mirror (nginx caching
registry.npmjs.org, capped at 10g, least recently used out) and a Docker mirror (registry:3.1
caching Docker Hub, each layer kept seven days after it was fetched). A guard runs the Docker
mirror: it clears the cache when it passes its cap (20g) and pauses the mirror while less than 5 GiB
is free on its disk; session Docker daemons pull from Docker Hub meanwhile. Neither mirror publishes
a host port. Each has a healthcheck that passes without reaching Docker Hub or registry.npmjs.org.
`mend server upgrade` adds both to an install from before them. `--no-npm-mirror`,
`--no-docker-mirror`, `--npm-mirror-max-size` and `--docker-mirror-max-size` change them.
`--docker-hub-username` with `--docker-hub-token-stdin` and `--docker-hub-public-only` gives the
Docker mirror a Docker Hub login, kept in `server.env` only: the last flag is the operator's
statement that the token is scoped Public Repo Read-only, because every session can pull what it can
read. `mend server status` reports each mirror's container, cache size, free disk and traffic as
observed, and a paused Docker mirror with what its guard found left of the cache.
