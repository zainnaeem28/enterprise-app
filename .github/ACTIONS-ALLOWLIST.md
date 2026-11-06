# Allowed GitHub Actions

`scripts/ci/check-workflow-hygiene.mjs` fails any `uses:` that is not pinned to a full 40-character commit SHA or whose `owner/repo` is not listed in the first column below. This is the technical control on every plan. GitHub's own organisation or repository allow-list and the "require full-length commit SHA" setting are a second layer that the repository owner configures (DEVOPS-PLAN 4.1, DPR-14); on the current plan that layer is **procedural only** (see `scripts/ci/README.md`, "GitHub state found").

Adding an action is a reviewed change to this file: name, pinned SHA of a release the reviewer inspected, why it is needed, and why a pinned, checksum-verified binary (`scripts/ci/tools.lock`) is not enough. Third-party actions are avoided in R1; every scanner runs from a binary whose sha256 is pinned in `scripts/ci/tools.lock`.

| Action                    | Pinned SHA                                 | Release | Publisher | Reason                                                      | Added                 |
| ------------------------- | ------------------------------------------ | ------- | --------- | ----------------------------------------------------------- | --------------------- |
| `actions/checkout`        | `3d3c42e5aac5ba805825da76410c181273ba90b1` | v7.0.1  | GitHub    | Check out the repository (credentials are not persisted)    | 2026-11-05 (HEAAA-68) |
| `actions/setup-node`      | `949feb2413d6458794dcd2491c4babbbce0c15c1` | v7.1.0  | GitHub    | Node.js at the version pinned in `.nvmrc`                   | 2026-11-05 (HEAAA-68) |
| `actions/upload-artifact` | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` | v7.0.2  | GitHub    | Upload scan, test and SBOM reports for the reviewer to read | 2026-11-05 (HEAAA-68) |

SHAs were resolved with `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` (all three tags are lightweight tags that point straight at a commit). Dependabot (`.github/dependabot.yml`) proposes updates as pull requests that keep the SHA pin and the version comment.
