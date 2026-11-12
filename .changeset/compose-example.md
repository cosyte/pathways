---
"@cosyte/pathways": patch
---

A Docker Compose example, and a `.env.example` that lists every environment variable Pathways reads by a fixed name (names that configuration gives, such as `PATHWAYS_KEY` in the Compose config or any `{ env: NAME }` setting, are read but not listed).

- `pathways init` now also writes `compose.yaml` and `.env.example`. `docker compose up` runs the project's channels on the published image of this version beside a PostgreSQL server, each with a health check, the database and the message folders in named volumes, the message folders' volume the engine's user's alone (mode 700). `PATHWAYS_VERSION` in `.env` takes a version tag, or a tag and its digest (`0.1.0@sha256:<digest>`) to pin the image. `.env.example` lists the variables Pathways reads by a fixed name, each with a comment and no secret; `.env` is added to the starter's `.gitignore`. A project made by an earlier `init` changes nothing: copy the two files from a new starter to use them.
- The repository's `examples/docker-compose/` holds the same two files with the starter's channel, and a new page, "Run Pathways with Docker Compose", walks through starting it and sending a synthetic message through.
- How the list is kept: the source exports `ENGINE_VARIABLES`, the variables Pathways reads by a fixed name, and a test compares each `.env.example` with it both ways. The type checker and lint refuse the listed ways for the source to read a fixed-name variable outside that list; any other route is caught by review, not by a check. Nothing in the package's exports changes.
