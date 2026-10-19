#!/bin/bash
# Deploy the committed HEAD to the Alexa-hosted skill (Development stage).
# The hosted CodeCommit repo has its own history, so we create a commit whose
# tree is HEAD's tree and whose parent is alexa/master. That makes the push a
# fast-forward: no force push, and GitHub history is untouched.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Commit your changes first; only committed code is deployed." >&2
  exit 1
fi

git fetch -q alexa master
PARENT=$(git rev-parse alexa/master)
TREE=$(git rev-parse 'HEAD^{tree}')
if [ "$(git rev-parse "$PARENT^{tree}")" = "$TREE" ]; then
  echo "alexa/master already has this tree; nothing to deploy."
  exit 0
fi
MSG="Deploy $(git rev-parse --short HEAD): $(git log -1 --format=%s HEAD)"
COMMIT=$(git commit-tree "$TREE" -p "$PARENT" -m "$MSG")
git push alexa "$COMMIT:refs/heads/master"
echo "Pushed $COMMIT to alexa/master; the hosted build deploys it to Development."
