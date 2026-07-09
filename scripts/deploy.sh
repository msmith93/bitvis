#!/usr/bin/env bash
set -euo pipefail

# Build every package and deploy all sites (or a single stack).
#
#   ./scripts/deploy.sh              # deploy all: kubevis, opensearchvis, landing
#   ./scripts/deploy.sh KubevisStack # deploy just one stack
#
# Requires the `bitsculpt` AWS profile, so it only runs on the owner's machine.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK="${1:---all}"

echo "==> Installing workspace deps + building apps..."
cd "$REPO_ROOT"
npm install
# The landing package has no build script; --if-present skips it.
npm run build --workspaces --if-present

echo "==> Deploying infrastructure and uploading site assets..."
cd "$REPO_ROOT/infra"
npm install
AWS_PROFILE=bitsculpt npx cdk deploy "$STACK" --require-approval never

echo ""
echo "==> Done!"
echo "    Landing:       https://bitvis.bitsculpt.top"
echo "    kubevis:       https://kubevis.bitsculpt.top"
echo "    opensearchvis: https://opensearchvis.bitsculpt.top"
