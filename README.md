<a href="https://cosyte.com">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://cosyte.com/tile/cosyte-lockup-tile-on-dark-1200x300.png">
    <img alt="The Cosyte logo on its own white ground: the icon beside the word Cosyte." src="https://cosyte.com/tile/cosyte-lockup-tile-on-light-1200x300.png">
  </picture>
</a>

# Pathways

A code-first healthcare integration engine for Node.js. Channels are YAML files in git, transforms
are TypeScript functions, and both are tested like any other code.

> **Pathways is early.** We are building it in the open, and it is not released yet. The package is
> not on npm, and nothing here is ready to run.

## What we are building

- **Channels in git.** A channel is a YAML file that wires a source to its destinations. Its
  transform is a TypeScript file that receives the parsed message and returns what to send.
- **Formats.** HL7 v2, FHIR, X12, and C-CDA arrive parsed, through Cosyte's open-source
  [`@cosyte/*`](https://github.com/cosyte) libraries. Anything else passes through as text or JSON.
- **Connectors.** MLLP, HTTP, and files, in and out.
- **Nothing lost.** Every message is stored before it is acknowledged. When a destination is down,
  Pathways retries and keeps that destination's messages in order. A failed message can be replayed
  once the transform is fixed.
- **Storage.** SQLite to start with no setup; PostgreSQL, MySQL or MariaDB, and SQL Server for
  production.
- **Tests.** `pathways test` will run synthetic messages through a channel and compare the output with
  saved snapshots.
- **Security controls.** TLS in transit, encryption at rest, an audit log of operator actions, and no
  message contents in logs or errors. Compliance is a property of how an organization runs software,
  so we describe the controls Pathways provides rather than claim compliance for it.

## Status

Today the repository holds working slices; nothing is released yet:

- Sources and destinations for MLLP, HTTP, and files, over TLS by default, with a bearer token or
  mutual TLS on every endpoint that listens.
- HL7 v2, FHIR R4 JSON, X12, C-CDA, JSON, and text, each parsed for a TypeScript transform that
  runs in its own worker thread.
- Storage on SQLite, PostgreSQL, MySQL or MariaDB, and SQL Server, with every stored message
  encrypted at rest.
- An audit log of every operator action, and the commands to inspect, replay, and clear messages.
- Your own connectors, hooks, storage, and key providers, loaded from YAML.
- A health endpoint, a Docker image, and the `pathways init`, `pathways start`, and
  `pathways test` commands.

Watch or star the repository to follow along.

## License

[MIT](LICENSE)
