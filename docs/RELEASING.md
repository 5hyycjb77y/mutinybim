# Releasing MutinyBIM

Every package under `packages/` and the model server (`services/bim-authority`)
share one version and are released together.

Every merge to `main` whose CI passes is a release. The Release workflow
(`.github/workflows/release.yml`) tags that commit `v<version>` and opens a
GitHub Release with generated notes; nobody tags by hand.

- **The version** is one patch above the newest `v*` tag. For a minor or
  major release, run `npm run release:version -- <version>` (for example
  `0.3.0`) in the pull request: it sets the version on every package and in
  both lockfiles, and the merge releases that version. The manifests in git
  keep the version last set by hand; the tag is each release's version.
- **A commit is released once.** A rerun on a tagged commit does nothing, and
  a commit that is not on `main` is refused.
- **By hand**, a maintainer may still push a tag `v<version>` on `main`, or run
  the workflow (Actions → Release → Run workflow) on a commit.

Publishing is a switch: the repository variable `MUTINYBIM_PUBLISH`
(Settings → Secrets and variables → Actions → Variables). Until it is `true`
a release is the tag and the GitHub Release only. When it is `true` the
workflow also publishes, with only its own short-lived token:

- the `@permitzip/bim-*` packages and `@permitzip/bim-authority` to GitHub
  Packages (`https://npm.pkg.github.com`);
- the model server image `ghcr.io/permitzip/mutinybim-authority:v<version>`.

Both carry GitHub build attestations once the repository is public:
`gh attestation verify <file or oci://image> --repo permitzip/mutinybim`.
A rerun skips versions that are already published, and a failed publish tags
nothing, so the next run tries the same version again.

## Installing the packages

GitHub Packages serves npm packages to signed-in users only, even public ones.
Point the `@permitzip` scope at it and use a GitHub token with `read:packages`:

```ini
@permitzip:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

The packages ship TypeScript source (`exports` point at `src/*.ts`). Bundle
them with a TypeScript-aware tool (Next.js `transpilePackages`, esbuild, Vite,
`tsx`).

The image pulls without signing in once the repository is public (packages the
workflow creates inherit the repository's visibility; check Package settings →
visibility after the first release).
