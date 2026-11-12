# Changesets

[Changesets](https://github.com/changesets/changesets) drives the version bump and the publish for
`@cosyte/pathways`, through `.github/workflows/release.yml`. Add one for each change a user of the
package would notice:

```bash
pnpm changeset
```

Once a changeset is on `main`, the release workflow opens a "Version Packages" pull request. Nothing
is published until that pull request merges and a reviewer approves the `release` environment.
That pull request fails `test/release-status.test.ts` until every item it releases has moved from
the README's "In the next release" up to "What the latest release ships". Once that pull
request has consumed every changeset, the "In the next release" section may be left empty or
removed; while any changeset is pending, it lists at least one item.
