# Verifying a release

How to check that the Fiscus you run is exactly a published release, built from the source at its
tag, with nothing added. Design: [ADR 0014](../adr/0014-verifiable-confidentiality.md) Tier 1.4
(#309). Code: `scripts/build-image.sh`, `.github/workflows/release.yml`.

## What it proves, and what it doesn't

| Check | Proves | Doesn't prove |
|---|---|---|
| **Digest** matches the release notes | You run the image that was released | That the release was built from the source |
| **Signature** (cosign) verifies | The image came out of this repository's release workflow, at that tag; the signing is in a public log | That the workflow did nothing else |
| **Rebuild** gives the same digest | The image is exactly what the source at the tag builds: no hidden changes | That the source is free of bugs. That's what review and audits (#316) are for |
| **SBOM** | Which packages, at which versions, are in the image | That they're free of vulnerabilities |

The rebuild is the strongest check, and the one that doesn't need trusting GitHub or Sigstore. Each
release rebuilds every image from scratch on a second runner before tagging it, so a release whose
images don't reproduce never goes out.

All of this checks the image. It can't tell you what a server you don't control is running; for a
hosted Fiscus that's "Verify this server" (#313), which builds on these digests.

One thing a browser runs isn't in any image: **Plaid Link**. Connecting a bank through Plaid loads
Plaid's script from `https://cdn.plaid.com` on the connect pages only (Plaid doesn't allow bundling
or self-hosting it, and serves its latest version). A verified image tells you nothing about that
script; the Content-Security-Policy keeps it off every other page ([threat model](../design/threat-model.md)
T4). Instances that never connect through Plaid never load it.

## 1. Which image are you running?

Each release's notes list every image's digest. That's what `docker pull` resolves the tag to.
Compare it with what your containers run:

```sh
for svc in api worker web; do
  image=$(docker inspect --format '{{.Image}}' "$(docker compose ps -q "$svc")")
  echo "$svc $(docker image inspect --format '{{join .RepoDigests " "}}' "$image")"
done
```

Each line should show `ghcr.io/ahanel13/fiscus-<service>@sha256:...` with the digest from the
release notes. To get the digest of a release from the registry instead:

```sh
docker buildx imagetools inspect ghcr.io/ahanel13/fiscus-api:0.3.0
```

`Digest:` at the top is the release's (it covers both platforms). The `Manifests:` below list one
per platform, which is what a single-platform rebuild (§3) reproduces.

## 2. Check the signature

With [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) 3.0 or later
(releases are signed with cosign 3, whose signatures older versions don't find):

```sh
cosign verify \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/ahanel13/fiscus/\.github/workflows/release\.yml@refs/tags/v' \
  ghcr.io/ahanel13/fiscus-api@sha256:<digest>
```

It succeeds only for an image signed by `release.yml` running on a version tag of this repository.
To also require the tag's exact commit, add `--certificate-github-workflow-sha "$(git rev-parse
v0.3.0^{commit})"` (from a clone); the certificate records it. Releases are signed
keylessly: no key is kept anywhere to steal. Each signature is recorded in Sigstore's public
transparency log ([Rekor](https://search.sigstore.dev)), so a signature can't be made quietly,
even by someone who got into the workflow.

Verify by **digest**, not by tag: a tag can be moved, a digest can't.

## 3. Rebuild it yourself

On Linux or macOS with Docker and Buildx, from a fresh clone:

```sh
git clone --branch v0.3.0 https://github.com/ahanel13/fiscus.git && cd fiscus
docker buildx create --name fiscus-verify --use    # a BuildKit container, 0.13 or later
scripts/build-image.sh api --platform linux/amd64 --oci /tmp/api.tar
```

It prints the digest of what it built. Compare it with the `linux/amd64` entry of
`docker buildx imagetools inspect ghcr.io/ahanel13/fiscus-api:0.3.0`. Use `linux/arm64` on an
arm64 machine. To rebuild both platforms and compare with the release's own digest, leave out
`--platform` (on amd64 that needs arm64 emulation: `docker run --privileged --rm
tonistiigi/binfmt --install arm64`).

The script builds exactly as the release does: file times come from the commit, labels name only
the commit, and no build-time attestations go into the image. Don't use plain `docker build`;
its output differs. On Windows, clone inside WSL so files keep Unix line endings.

### What makes the images reproducible

- **Pinned inputs.** Base images by digest, packages from `pnpm-lock.yaml` (`--frozen-lockfile`),
  tool versions in the Dockerfiles, and Alpine packages by exact version. Renovate updates them
  all, each as a reviewed change.
- **No timestamps.** `SOURCE_DATE_EPOCH` is the commit's time; BuildKit clamps every file to it
  (`rewrite-timestamp`), and the Dockerfiles drop the two files that recorded when they ran:
  `apk`'s log and pnpm's `.modules.yaml`.
- **No checkout dependence.** File modes and times are normalized after copying the source, so
  the umask of whoever cloned it, and when they did, don't reach the image.
- **Checked on every PR.** CI builds each image twice, the second time without cache, and fails
  if the digests differ.

### The limit: Alpine's repositories

The api image installs `pg_dump` and `age` from Alpine's package repositories. Their versions are
pinned, but Alpine keeps only the latest version of each package. Once Alpine replaces one, older
releases' api images can't be rebuilt; the build fails at `apk add` rather than producing a
different image. Rebuild a release while it's current, or compare everything but that layer.

### When a rebuild doesn't match

Make sure the clone is clean (`git status`), at the tag, and that you used the script. If it
still differs, compare your archive with the published image using
[diffoci](https://github.com/reproducible-containers/diffoci) (`diffoci diff --semantic`) to see
which files differ, and please [open an issue](https://github.com/ahanel13/fiscus/issues): an
image that doesn't reproduce is a bug.

## 4. The SBOM

Each release attaches an SPDX SBOM per image and platform
(`fiscus-<service>-<version>-linux-<arch>.spdx.json`), generated with
[Syft](https://github.com/anchore/syft). The same SBOM is attested to the image, signed like the
image itself:

```sh
cosign verify-attestation --type spdxjson \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/ahanel13/fiscus/\.github/workflows/release\.yml@refs/tags/v' \
  ghcr.io/ahanel13/fiscus-api@sha256:<platform digest> \
  | jq -r '.payload | @base64d | fromjson | .predicate' > api.spdx.json
```

Scan it for known vulnerabilities with, for example, `grype sbom:api.spdx.json`.
