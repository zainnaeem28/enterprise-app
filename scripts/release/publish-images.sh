#!/usr/bin/env bash
# Push the images built by build-images.sh to ECR (tag r<n>.<sha12>, immutable), resolve the registry digest, sign it
# and attach the SBOM and provenance attestations. Runs only on main, after aws-login.sh.
# Usage: publish-images.sh <out_dir> <release_number> <git_sha>
# Env: RELEASE_ECR_REGISTRY, RELEASE_ECR_REPOSITORY_PREFIX, RELEASE_SIGNING_KEY_ARN, AWS_REGION (all repository variables).
. "$(dirname "${BASH_SOURCE[0]}")/../ci/lib.sh"
require_tool docker; require_tool aws; require_tool cosign; require_tool jq
: "${RELEASE_ECR_REGISTRY:?}"; : "${RELEASE_ECR_REPOSITORY_PREFIX:?}"; : "${RELEASE_SIGNING_KEY_ARN:?}"; : "${AWS_REGION:?}"
out="$1"; n="$2"; sha="$3"
tag="r${n}.${sha:0:12}"
key="awskms:///$RELEASE_SIGNING_KEY_ARN"
built_at="$(date -u +%FT%TZ)"
lock_sha="$(sha256sum "$CI_ROOT/pnpm-lock.yaml" | cut -d' ' -f1)"
export COSIGN_YES=true
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$RELEASE_ECR_REGISTRY" >/dev/null
mkdir -p "$out/provenance"
published="$out/images.published.json"; rm -f "$published"

for name in $(jq -r 'keys[]' "$out/images.json"); do
  repo="$RELEASE_ECR_REGISTRY/$RELEASE_ECR_REPOSITORY_PREFIX/$name"
  # An existing tag means an earlier run published part of this release: stop for a human, never overwrite or guess.
  if aws ecr describe-images --repository-name "$RELEASE_ECR_REPOSITORY_PREFIX/$name" --image-ids "imageTag=$tag" >/dev/null 2>&1; then
    echo "::error::$repo:$tag already exists with no stored manifest (partial earlier publish). Not overwriting; a person decides." >&2; exit 1
  fi
  docker tag "ehr-release/$name:$tag" "$repo:$tag"
  docker push "$repo:$tag"
  digest="$(aws ecr describe-images --repository-name "$RELEASE_ECR_REPOSITORY_PREFIX/$name" --image-ids "imageTag=$tag" --query 'imageDetails[0].imageDigest' --output text)"
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "::error::could not resolve digest of $repo:$tag" >&2; exit 1; }
  ref="$repo@$digest"
  cosign sign --key "$key" --tlog-upload=false "$ref"
  cosign attest --key "$key" --tlog-upload=false --type cyclonedx --predicate "$out/sbom/$name.cdx.json" "$ref"
  node "$CI_ROOT/scripts/release/write-provenance.mjs" --image "$repo" --digest "$digest" --release-number "$n" \
    --lockfile-sha256 "$lock_sha" --built-at "$built_at" --out "$out/provenance/$name.statement.json" --predicate-out "$out/provenance/$name.predicate.json"
  cosign attest --key "$key" --tlog-upload=false --type slsaprovenance1 --predicate "$out/provenance/$name.predicate.json" "$ref"
  # Prove what was just written: signature and both attestations verify against the KMS public key.
  cosign verify --key "$key" --insecure-ignore-tlog=true "$ref" >"$out/provenance/$name.verify-signature.json"
  for t in cyclonedx slsaprovenance1; do
    cosign verify-attestation --key "$key" --insecure-ignore-tlog=true --type "$t" "$ref" >"$out/provenance/$name.verify-$t.json"
  done
  sbom_sha="$(jq -r --arg n "$name" '.[$n].sbom.sha256' "$out/images.json")"
  node "$CI_ROOT/scripts/release/record-image.mjs" --file "$published" --name "$name" --digest "$digest" --reference "$ref" --tag "$tag" \
    --sbom "$out/sbom/$name.cdx.json" --sbom-sha256 "$sbom_sha" --signed true --published true --attestations sbom,provenance
  echo "image $name: published $ref, signed, SBOM and provenance attested and verified"
done
mv "$published" "$out/images.json"
