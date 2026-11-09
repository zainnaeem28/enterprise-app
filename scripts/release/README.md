# Release build (DO-05, HEAAA-89)

Producer side of the release contract: `.github/workflows/build-release.yml` runs these scripts on every push to `main`.
Source: DEVOPS-PLAN 4.2, 6.1, 6.2 (DEV-1), 15.3. **Build and publish only. No deploy step, no environment mutation.**

## What one run does

| Step                            | Script                                                                     | Result                                                                                                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Release number                  | `release-number.mjs`                                                       | `git rev-list --first-parent --count <sha>` on a full clone; `r<n>.<sha12>`                                                                                                                      |
| Checks before anything is built | `test/*.test.mjs`                                                          | release scripts tests; `pnpm build`; **refusal-path test** against the built API                                                                                                                 |
| Portal bundles                  | `build-bundles.mjs`                                                        | built with `CLIENT_RELEASE=r<n>.<sha12>`; `release.json` `{release_number, git_sha12, built_at}`; fails if the value is not in the shipped JS; listing sha256                                    |
| Images (built once)             | `build-images.sh`                                                          | `docker build`, Trivy (HIGH/CRITICAL with a fix, root user, no HEALTHCHECK fail), Syft CycloneDX SBOM per image                                                                                  |
| Inventory                       | `inventory.mjs`                                                            | migrations (name + sha256 + combined), lockfile hashes, base-image digests, tool versions                                                                                                        |
| Store check (main)              | `store.mjs decide`                                                         | `release_number` greater than every other manifest, or the same commit again (idempotent reuse)                                                                                                  |
| Publish (main)                  | `aws-login.sh`, `publish-images.sh`, `store.mjs put-bundles`               | OIDC to `gh-build`; push `r<n>.<sha12>` (immutable tag); resolve the digest; `cosign sign`, SBOM and provenance attestations; verify them back; bundles under `releases/<sha>/bundles/<portal>/` |
| Manifest                        | `assemble-manifest.mjs`, `validate-manifest.mjs`, `store.mjs put-manifest` | `release-manifest.json` + `.sha256`; written last and never overwritten (`If-None-Match: *`)                                                                                                     |

Modes: `refs/heads/main` = publish. `refs/heads/ci/release-dry-run/**` = the same build with no cloud credentials and nothing published (manifest `mode: "dry-run"`, images not claimed as published); artifacts are uploaded for inspection.

## Release numbers

- `release_number` is assigned once per build of `main`; the same number is used in every environment.
- An older build that finishes after a newer one fails the `release_number` check **by design** (`store.mjs decide`, tests in `test/lib.test.mjs`). The workflow group is non-cancelling; GitHub keeps one pending run per group, so a middle commit of a burst may never be built. It then has no manifest and is not deployable.
- `min_client_release` is **not** decided at build time: DEVOPS-PLAN 6.2 sets it at deploy to the number of the previous _released_ manifest (`previous_manifest_hash` of the approved-release record), never the previous commit. `lib/release-number.mjs: resolveMinClientRelease` is the rule (previous released number; first release = its own number; any other hand-set value refused) for DO-06 to call. The manifest carries the rule as `min_client_release.rule` with `value: null`.

## Manifest fields (6.1)

`git_sha`, `git_tree_hash`, `release_number`, `client_release`, `images` (reference `repo@sha256:`, digest, SBOM hash, attestations), `images_not_built` (with reasons), `bundles` (listing sha256, embedded release, S3 prefix), `migrations`, `iac` (no plan applied here), `locks` (lockfile sha256, base-image digests), `tools`, `checks` (run id and URL), `signatures`, `source_sbom`. The manifest hash is the sha256 of the exact bytes written (`.sha256` file).

## Configuration (repository variables, not secrets; nothing is read from a secret)

`RELEASE_AWS_REGION`, `RELEASE_BUILD_ROLE_ARN` (`gh-build`), `RELEASE_ECR_REGISTRY`, `RELEASE_ECR_REPOSITORY_PREFIX` (repositories `<prefix>/api`, `<prefix>/worker`), `RELEASE_STORE_BUCKET`, `RELEASE_SIGNING_KEY_ARN`. On `main` an unset variable fails the run before anything is published.

## Known limits (also in the evidence comment)

- **Signing is by KMS key (`awskms://`), not keyless.** DEVOPS-PLAN 6.1 says keyless GitHub OIDC; DO-04's `gh-build` policy grants `kms:Sign` on the release key and no Sigstore path, and keyless would publish the private repository's identity to the public log. Transparency log upload is off; verify with the KMS public key. Needs the plan's wording to follow.
- **Provenance is self-generated** (in-toto/SLSA v1 predicate signed with the release key), not an isolated-builder SLSA L3 claim.
- **`gh-build` IAM gap (DO-04 follow-up, not editable here):** this workflow lists `manifests/by-number/` (`s3:ListBucket`) and, for a re-run, reads `releases/<sha>/release-manifest.json` (`s3:GetObject`); the role has `s3:PutObject` only, and no read on the portal-bundle prefix. Without them `decide` fails with AccessDenied (it does not skip).
- **`build` environment** and the `ci` approved-release record must exist before the first publish; GitHub environment availability on the current plan is unverified (DEVOPS-PLAN 4.1).
- **Reproducibility** (build twice, compare layer digests) is not proven; image labels carry the commit time, but BuildKit timestamps are not rewritten.
- Only `api` and `worker` images and the `staff` bundle exist in this candidate; `site`, `cms` and `patient` are recorded as not-built with reasons and become required in `release.config.json` when their tickets land.
- cosign flags (`--tlog-upload=false`, `verify --insecure-ignore-tlog`) were not executed against AWS KMS in this ticket; the dry-run cannot exercise signing.
- Local tests: `node --test scripts/release/test/*.test.mjs` (the refusal-path test needs `pnpm build`).
