---
"@sealant/mend": minor
---

`mend server setup` runs two mirrors beside Mend, on by default: an npm mirror (nginx caching
registry.npmjs.org, capped at 10g, least recently used out) and a Docker mirror (registry:3 caching
Docker Hub, each layer kept seven days after it was fetched). Neither publishes a host port.
`mend server upgrade` adds both to an install from before them. `--no-npm-mirror`,
`--no-docker-mirror` and `--npm-mirror-max-size` change them, and `--docker-hub-username` with
`--docker-hub-token-stdin` gives the Docker mirror a Docker Hub login, kept in `server.env` only.
`mend server status` reports each mirror's container, cache size and traffic as observed.
