---
"@cosyte/pathways": patch
---

A Docker Compose example, and a `.env.example` that lists every environment variable Pathways reads.

- `pathways init` now also writes `compose.yaml` and `.env.example`. `docker compose up` runs the project's channels on the published image of this version beside a PostgreSQL server, each with a health check, the database and the message folders in named volumes, the message folders' volume the engine's user's alone (mode 700). `PATHWAYS_VERSION` in `.env` takes a version tag, or a tag and its digest (`0.1.0@sha256:<digest>`) to pin the image. `.env.example` lists every variable Pathways reads by name, each with a comment and no secret; `.env` is added to the starter's `.gitignore`. A project made by an earlier `init` changes nothing: copy the two files from a new starter to use them.
- The repository's `examples/docker-compose/` holds the same two files with the starter's channel, and a new page, "Run Pathways with Docker Compose", walks through starting it and sending a synthetic message through.
