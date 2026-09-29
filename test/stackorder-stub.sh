#!/usr/bin/env bash
set -euo pipefail

command=$1
shift
echo "$command $*" >> "$RUNNER_TEMP/stackorder-calls.log"

flag() {
  local name=$1
  shift
  while [ $# -gt 1 ]; do
    if [ "$1" = "$name" ]; then
      echo "$2"
      return
    fi
    shift
  done
  echo "missing $name" >&2
  exit 1
}

case "$command" in
  resolve)
    {
      echo "run-id=00000000-0000-4000-8000-000000000001"
      echo 'matrix={"include":[{"stack":"stacks/app","key":"stacks/app:blue","instance":"blue","workspace":"","environment":"blue","wave":0,"tool":"terraform","tool_version":"","plan_output":"full"}]}'
      echo 'waves=[["stacks/app:blue"]]'
      echo 'affected=[{"key":"stacks/app:blue","path":"stacks/app","instance":"blue","wave":0,"reasons":["changed"]}]'
      echo "count=1"
      echo "unconfirmed=false"
    } >> "$GITHUB_OUTPUT"
    ;;
  plan)
    stack=$(flag --stack "$@")
    slug="${stack//[\/:]/-}-$(printf '%s' "$stack" | sha256sum | cut -c1-8)"
    artifact="stackorder-plan-$slug-$GITHUB_SHA"
    mkdir -p "$STACKORDER_PLAN_DIR"
    echo "plan of $stack" > "$STACKORDER_PLAN_DIR/$artifact.tfplan"
    {
      echo "has-changes=true"
      echo "artifact=$artifact"
      echo "plan-file=$STACKORDER_PLAN_DIR/$artifact.tfplan"
      echo 'summary={"adds":1,"changes":0,"destroys":0,"replaces":0}'
      echo "unconfirmed=false"
    } >> "$GITHUB_OUTPUT"
    ;;
  apply)
    plan_file=$(flag --plan-file "$@")
    grep -q "^plan of " "$plan_file"
    echo 'summary={"adds":1,"changes":0,"destroys":0,"replaces":0}' >> "$GITHUB_OUTPUT"
    ;;
  drift)
    code=${STUB_DRIFT_EXIT:-2}
    drifted=false
    [ "$code" -ne 2 ] || drifted=true
    {
      echo "drifted=$drifted"
      echo 'summary={"adds":0,"changes":1,"destroys":0,"replaces":0}'
    } >> "$GITHUB_OUTPUT"
    exit "$code"
    ;;
  *)
    echo "unexpected command: $command" >&2
    exit 1
    ;;
esac
