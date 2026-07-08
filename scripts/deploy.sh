#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Building React app..."
cd "$REPO_ROOT"
npm run build

echo "==> Deploying infrastructure and uploading dist/..."
cd "$REPO_ROOT/infra"
npm install
AWS_PROFILE=bitsculpt npx cdk deploy --require-approval never

echo ""
echo "==> Done! Site live at https://kubevis.bitsculpt.top"
