# Releasing the kit

For the kit's maintainers. **This file does not ship:** this file is not in `package.json` `"files"`, so a project that
installs the package never sees it (`tests/genericity.test.mjs` walks exactly that list).

A release is a git tag on `main`, published to the npm registry under the same version. Projects install from the
registry (`npm i -D builder-pipeline`) or from the tag (`npm i -D github:geopjinfo/builder-pipeline#<tag>`), so nothing
reaches them until a tag exists and they bump to it. The first registry release is 2.0.0.

## The routine

0. **Once per clone of the kit repo:** `node cli.js git-hooks` — the kit keeps its own rule, commits carry human
   authors only (no AI co-author trailers, no "Generated with" lines).
1. **Work on a branch** in the kit repository — never on `main`. Small commits; each one with the suite green.
2. **Suite green** from the kit root:

   ```
   node tests/run.mjs
   ```

   Every test passes. (A test known to flake under full-suite load is re-run on its own, and the release notes say
   so; it is never skipped.)
3. **CHANGELOG release heading.** Rename `## [Unreleased]` to the release — `## [X.Y.Z] — YYYY-MM-DD` — and open a
   fresh empty `## [Unreleased]` above it. Every change since the last release is described there, with its tests.
4. **Version bump** in `package.json` to the same `X.Y.Z`. It is the version's one home: `npx builder --version`
   prints it, and `tests/version.test.mjs` fails when it differs from the newest released CHANGELOG heading. Run the
   suite again.
5. **The maintainer fast-forwards `main`** to the release commit and creates an **annotated tag** on it:

   ```
   git checkout main
   git merge --ff-only <branch>
   git tag -a vX.Y.Z -m "builder kit X.Y.Z"
   git push origin main vX.Y.Z
   ```

   `main` only ever moves by fast-forward to a commit whose suite passed; the tag name is `v` + the package version.
6. **Each consuming project** bumps its one dependency line and upgrades:

   ```
   npm i -D github:geopjinfo/builder-pipeline#vX.Y.Z
   npx builder upgrade --dry-run
   npx builder upgrade   # the install's tools and flags come from builder.lock.json; add --prune to remove what the release dropped
   npx builder verify
   ```

   It reads the CHANGELOG entries between its old tag and the new one first; `upgrade` keeps its local edits and its
   recorded choices, and never touches its project-owned files.

## Version numbers

- Semver. Until 1.0.0 a minor bump may change behaviour; the CHANGELOG says how.
- **Release candidates** are releases: `X.Y.Z-rc.N` in `package.json`, `## [X.Y.Z-rc.N] — YYYY-MM-DD` in the
  CHANGELOG, tag `vX.Y.Z-rc.N`. The final release gets its own heading and tag; the rc headings stay as history.
- No build metadata (`+…`) — a tag carries none, and `tests/version.test.mjs` refuses it.

## Folder-copy releases

A project that copies the kit in as a folder takes a release archive cut from the tag, never a working copy:

```
git archive --format=zip --prefix=builder/ -o builder-X.Y.Z.zip vX.Y.Z
```

(`UNPACK.md` § Receive the pack.)
