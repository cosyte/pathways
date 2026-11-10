# Changesets

[Changesets](https://github.com/changesets/changesets) drives the version bump and the publish for
`@cosyte/pathways`, through `.github/workflows/release.yml`. Add one for each change a user of the
package would notice:

```bash
pnpm changeset
```

Once a changeset is on `main`, the release workflow opens a "Version Packages" pull request. Nothing
is published until that pull request merges and a reviewer approves the `release` environment, and
the first release is a maintainer's call.
