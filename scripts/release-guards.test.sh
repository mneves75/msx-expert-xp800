#!/usr/bin/env bash
# Proves the guards of scripts/release.sh and scripts/verify-live.sh without a network or a Cloudflare
# login. Each case builds a throwaway Git repository with a local bare remote, copies both scripts
# into it and runs them against fake `pnpm`, `node` (which also answers for Wrangler, because the
# release runs it as `node node_modules/wrangler/bin/wrangler.js`) and `curl` programs on PATH.
# The scripts are the real ones; only the programs they call at the edge are fake. The fake `curl`
# serves bodies, headers and statuses from files, so no server runs and nothing leaves the machine.
#
# Adapted from the reference release-guards.test.sh of mneves-ship-deploy. Its secrets cases are
# gone (this Worker reads no secrets), its /health cases became page-and-header cases, and its
# "placeholder" case is gone (there are no placeholders).
#
# Usage: bash scripts/release-guards.test.sh     (also: pnpm run test:release)
# Needs bash 3.2+, git, sed, awk, tr.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/release-guards.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

# Keep the owner's Git configuration (signing, hooks, aliases) out of the throwaway repositories.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid

# The scripts carry the real URLs; the fake curl answers for them.
STAGING_URL="https://msx-expert-xp800-staging.mvneves.workers.dev"
PRODUCTION_URL="https://msx-expert-xp800.mvneves.workers.dev"

export FAKE_STATE="$tmp/state" FAKE_WEB="$tmp/web"
mkdir -p "$tmp/bin" "$FAKE_STATE" "$FAKE_WEB"
export FAKE_NODE_VERSION="v26.10.0" FAKE_PNPM_VERSION="11.27.0" FAKE_FAIL_GATE="" FAKE_BUILD_COMMIT="" FAKE_BUILD_LEAK="" FAKE_LOGIN_FAILS=""
export VERIFY_LIVE_ATTEMPTS=1 VERIFY_LIVE_DELAY=0
unset RELEASE_COMMIT

# ---- Fake programs ----
cat > "$tmp/bin/pnpm" <<'FAKE'
#!/bin/bash
echo "pnpm $*" >> "$FAKE_STATE/calls.log"
build() {
  mkdir -p dist
  c="${FAKE_BUILD_COMMIT:-$RELEASE_COMMIT}"
  printf '<!doctype html><html><head><meta name="application-version" content="1.2.3"><meta name="app-commit" content="%s"><title>Gradiente Expert XP-800</title></head><body>%s</body></html>\n' "$c" "${FAKE_BUILD_LEAK:+/Users/someone/project/}" > dist/index.html
  printf '/*\n  X-Test: 1\n' > dist/_headers
}
case "$1" in
  --version) echo "$FAKE_PNPM_VERSION" ;;
  audit) [ "$FAKE_FAIL_GATE" = audit ] && { echo "audit failed" >&2; exit 1; } ;;
  run)
    [ "$2" = "$FAKE_FAIL_GATE" ] && { echo "gate $2 failed" >&2; exit 1; }
    case "$2" in build | verify:all) build ;; esac ;;
esac
exit 0
FAKE
# node: `--version`, or Wrangler when the first argument is its entry point.
cat > "$tmp/bin/node" <<'FAKE'
#!/bin/bash
if [ "${1:-}" = "node_modules/wrangler/bin/wrangler.js" ]; then
  shift
  echo "wrangler $*" >> "$FAKE_STATE/calls.log"
  env=""; prev=""
  for a in "$@"; do [ "$prev" = --env ] && env="$a"; prev="$a"; done
  live="$FAKE_STATE/live-$env"
  case "$1" in
    whoami) [ -n "$FAKE_LOGIN_FAILS" ] && { echo "Not logged in" >&2; exit 1; }; echo "logged in" ;;
    deployments)
      v="ver-0"; [ -f "$live" ] && v="$(cat "$live")"
      printf '{\n  "id": "d1",\n  "source": "wrangler",\n  "versions": [\n    {\n      "version_id": "%s",\n      "percentage": 100\n    }\n  ],\n  "created_on": "2026-10-04T03:24:29.574306Z"\n}\n' "$v" ;;
    deploy)
      case " $* " in *" --dry-run "*) echo "--dry-run: nothing uploaded"; exit 0 ;; esac
      n=1; [ -f "$FAKE_STATE/count" ] && n=$(( $(cat "$FAKE_STATE/count") + 1 ))
      echo "$n" > "$FAKE_STATE/count"; echo "ver-$n" > "$live"; echo "Deployed ver-$n" ;;
    *) ;;
  esac
  exit 0
fi
echo "node $*" >> "$FAKE_STATE/calls.log"
[ "${1:-}" = "--version" ] && echo "$FAKE_NODE_VERSION"
exit 0
FAKE
# curl: the body of a URL is the file named after it in $FAKE_WEB (scheme dropped, / ? & = as _). For a
# method other than GET the file is <name>.<METHOD>. A sibling <file>.status sets the HTTP status
# (default 200) and <file>.headers the response headers. -f turns a status >= 400 into exit 22, -o sends
# the body to a file, -D writes the headers to a file and -w '%{http_code}' prints the status.
cat > "$tmp/bin/curl" <<'FAKE'
#!/bin/bash
echo "curl $*" >> "$FAKE_STATE/calls.log"
url=""; fail=0; code=0; method=GET; out=""; dump=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift ;;
    -o) out="$2"; shift ;;
    -D) dump="$2"; shift ;;
    -w) code=1; shift ;;
    -H | --max-time) shift ;;
    http://* | https://*) url="$1" ;;
    --*) ;;
    -*f*) fail=1 ;;
  esac
  shift
done
key="$(printf '%s' "${url#*://}" | sed 's|[/?&=]|_|g')"
file="$FAKE_WEB/$key"; [ "$method" = GET ] || file="$file.$method"
status=404; body=""
if [ -f "$file" ]; then
  status=200; [ -f "$file.status" ] && status="$(cat "$file.status")"; body="$(cat "$file")"
fi
if [ -n "$dump" ]; then
  { printf 'HTTP/2 %s\r\n' "$status"; if [ -f "$file.headers" ]; then sed 's/$/\r/' "$file.headers"; fi; } > "$dump"
fi
if [ -n "$out" ]; then printf '%s\n' "$body" > "$out"; fi
if [ "$code" = 1 ]; then printf '%s' "$status"; exit 0; fi
if [ "$fail" = 1 ] && [ "$status" -ge 400 ]; then exit 22; fi
[ -n "$out" ] || printf '%s\n' "$body"
FAKE
chmod +x "$tmp/bin/"*
export PATH="$tmp/bin:$PATH"

# ---- Helpers ----
failures=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; shift; [ "$#" -eq 0 ] || printf '    | %s\n' "$@"; failures=$((failures + 1)); }

# new_repo <name>: a clone on main with a bare origin, one pushed commit, version 1.2.3, a CHANGELOG
# entry and a runtime pin. Sets $work and $origin.
new_repo() {
  origin="$tmp/$1.git"; work="$tmp/$1"
  git init -q --bare "$origin"
  git --git-dir="$origin" symbolic-ref HEAD refs/heads/main
  git init -q "$work"
  (
    cd "$work"
    git checkout -q -b main
    git remote add origin "$origin"
    mkdir scripts
    cp "$here/release.sh" "$here/verify-live.sh" scripts/
    chmod +x scripts/release.sh scripts/verify-live.sh
    printf '{\n  "name": "demo",\n  "version": "1.2.3",\n  "engines": {\n    "node": ">=22"\n  },\n  "packageManager": "pnpm@11.27.0"\n}\n' > package.json
    printf '# Changelog\n\n## [1.2.3] — 2026-01-01\n\n- first\n' > CHANGELOG.md
    printf '.scratch/\ndist/\nnode_modules/\n' > .gitignore
    git add -A
    git commit -q -m "init"
    git push -q origin main
  )
  : > "$FAKE_STATE/calls.log"; rm -f "$FAKE_STATE"/live-* "$FAKE_STATE/count"
  rm -rf "$FAKE_WEB"; mkdir -p "$FAKE_WEB"
  FAKE_NODE_VERSION="v26.10.0"; FAKE_PNPM_VERSION="11.27.0"; FAKE_FAIL_GATE=""; FAKE_BUILD_COMMIT=""; FAKE_BUILD_LEAK=""; FAKE_LOGIN_FAILS=""
  export FAKE_NODE_VERSION FAKE_PNPM_VERSION FAKE_FAIL_GATE FAKE_BUILD_COMMIT FAKE_BUILD_LEAK FAKE_LOGIN_FAILS
}
head_sha() { git -C "$work" rev-parse HEAD; }
commit_push() { git -C "$work" add -A && git -C "$work" commit -q -m "$1" && git -C "$work" push -q origin main; }
web_key() { printf '%s' "${1#*://}" | sed 's|[/?&=]|_|g'; }

# serve <base url> <commit> [version]: the page, headers, entry script and refusals of a healthy deployment.
serve() {
  local k page
  k="$(web_key "$1/")"
  page="<!doctype html><html lang=\"pt-BR\"><head><meta charset=\"UTF-8\"><title>Gradiente Expert XP-800 — Réplica</title>"
  [ -z "$2" ] || page="$page<meta name=\"application-version\" content=\"${3:-1.2.3}\"><meta name=\"app-commit\" content=\"$2\">"
  page="$page<script type=\"module\" crossorigin src=\"/assets/index-abc.js\"></script></head><body><div id=\"app\"></div></body></html>"
  printf '%s' "$page" > "$FAKE_WEB/$k"
  printf "content-type: text/html\nstrict-transport-security: max-age=63072000; includeSubDomains; preload\ncontent-security-policy: default-src 'self'; object-src 'none'; frame-ancestors 'none'\n" > "$FAKE_WEB/$k.headers"
  printf 'console.log(1)' > "$FAKE_WEB/${k}assets_index-abc.js"
  printf 'content-type: text/javascript\n' > "$FAKE_WEB/${k}assets_index-abc.js.headers"
  : > "$FAKE_WEB/$k.OPTIONS"; printf '405' > "$FAKE_WEB/$k.OPTIONS.status"
}

out=""; code=0
# run <release.sh args...>: in $work, stdin closed; sets $out and $code.
run() {
  code=0
  out="$(cd "$work" && "$BASH" scripts/release.sh "$@" 2>&1 < /dev/null)" || code=$?
}
# expect <name> <exit code> <text the output must contain> -- <args...>
expect() {
  local name="$1" want="$2" text="$3"; shift 4
  run "$@"
  if [ "$code" = "$want" ] && printf '%s\n' "$out" | grep -F -- "$text" > /dev/null; then pass "$name"
  else fail "$name (exit $code, wanted $want and \"$text\")" "$out"; fi
}
log_has() { grep -E -- "$1" "$FAKE_STATE/calls.log" > /dev/null; }
remote_tags() { git -C "$work" ls-remote --tags origin; }
check() { # <name> <command...>: passes when the command succeeds
  local name="$1"; shift
  if "$@"; then pass "$name"; else fail "$name" "$out"; fi
}
# A real deploy is a Wrangler `deploy` without --dry-run.
real_deploy() { grep -E '^wrangler deploy( |$)' "$FAKE_STATE/calls.log" | grep -vF -- '--dry-run' > /dev/null; }
no_deploy() { ! real_deploy; }
no_build() { ! log_has '^pnpm (install|run|audit)' && ! log_has '^wrangler'; }
# release_json: the evidence file of the last release in $work, or nothing.
release_json() { find "$work/.scratch" -name release.json 2> /dev/null | head -1 || true; }
no_tags() { [ -z "$(remote_tags)" ] && [ -z "$(git -C "$work" tag)" ]; }

# ==== Usage and flags ====
new_repo usage
expect "no arguments prints usage" 2 "usage:" --
expect "an unknown target prints usage" 2 "usage:" -- prod --check
for flag in --skip-checks --skip-gates --no-verify --force; do
  expect "a blanket bypass ($flag) is rejected" 2 "usage:" -- staging --check "$flag"
done
expect "--waive without a reason is rejected" 2 "usage:" -- staging --check --waive audit
expect "--waive with an empty reason is rejected" 2 "reason" -- staging --check --waive "audit="
expect "--waive of an unknown gate is rejected" 2 "unknown gate" -- staging --check --waive "bogus=because"

# ==== --check ====
new_repo check
sha="$(head_sha)"
expect "--check plans the release" 0 "tag v1.2.3-beta1" -- staging --check
for line in "target staging" "version 1.2.3" "commit $sha" "url $STAGING_URL"; do
  expect "--check prints '${line%% *}'" 0 "$line" -- staging --check
done
check "--check builds nothing and deploys nothing" no_build
check "--check creates no worktree" test ! -e "$work/.scratch"
git -C "$work" tag v1.2.3-beta1 && git -C "$work" push -q origin v1.2.3-beta1 && git -C "$work" tag -d v1.2.3-beta1 > /dev/null
expect "the beta number follows the tags origin has" 0 "tag v1.2.3-beta2" -- staging --check

# ==== Staging guards ====
new_repo guards
git -C "$work" commit -q --allow-empty -m "local only"
expect "staging refuses a HEAD that is not pushed" 1 "HEAD is not pushed" -- staging --check
git -C "$work" reset -q --hard origin/main
printf '# Changelog\n' > "$work/CHANGELOG.md"; commit_push "drop the entry"
expect "staging refuses a version with no changelog entry" 1 "CHANGELOG.md has no" -- staging --check
git -C "$work" revert --no-edit HEAD > /dev/null && git -C "$work" push -q origin main
git -C "$work" tag v1.2.3 && git -C "$work" push -q origin v1.2.3 && git -C "$work" tag -d v1.2.3 > /dev/null
expect "staging refuses a version production already has" 1 "bump the version" -- staging --check
git -C "$work" push -q origin :refs/tags/v1.2.3
FAKE_NODE_VERSION="v20.0.0"
expect "a Node older than engines.node is refused" 1 "older than the declared engines.node" -- staging --check
FAKE_NODE_VERSION="v26.10.0"
FAKE_PNPM_VERSION="10.0.0"
expect "a package manager that differs from the pin is refused" 1 "does not match the pinned 11.27.0" -- staging --check
FAKE_PNPM_VERSION="11.27.0"
printf '{\n  "name": "demo",\n  "version": "1.2.3"\n}\n' > "$work/package.json"
commit_push "drop the pin"
expect "a repository with no declared runtime pin is refused" 1 "no runtime pin" -- staging --check

# ==== Production guards ====
new_repo prod
sha="$(head_sha)"
serve "$STAGING_URL" "$sha"
expect "production refuses without a staging tag" 1 "no staging tag" -- production --check
git -C "$work" tag v1.2.3-beta1 && git -C "$work" push -q origin v1.2.3-beta1
expect "production promotes the commit staging serves (control)" 0 "tag v1.2.3 (promotes v1.2.3-beta1)" -- production --check
expect "production plans the staged commit" 0 "commit $sha" -- production --check
serve "$STAGING_URL" "abcdef1234567"
expect "production refuses when staging serves another commit" 1 "staging serves abcdef1" -- production --check
serve "$STAGING_URL" "${sha}-dirty"
expect "production refuses a dirty staging build" 1 "is not a commit id" -- production --check
serve "$STAGING_URL" ""
expect "production refuses a staging page that names no commit" 1 "reports no app-commit" -- production --check
serve "$STAGING_URL" "$sha"
git -C "$work" tag v1.2.3 && git -C "$work" push -q origin v1.2.3
expect "production refuses a version that already has its tag" 1 "already exists on origin" -- production --check
git -C "$work" push -q origin :refs/tags/v1.2.3 && git -C "$work" tag -d v1.2.3 > /dev/null
expect "production without --yes and without a terminal is refused" 1 "needs --yes" -- production

# ==== A whole staging release ====
new_repo staging
sha="$(head_sha)"
serve "$STAGING_URL" "$sha"
expect "staging releases a pushed commit" 0 "Released v1.2.3-beta1" -- staging
check "the tag is pushed after the live proof" test -n "$(remote_tags | grep 'refs/tags/v1.2.3-beta1')"
json="$(release_json)"
for field in '"target": "staging"' '"tag": "v1.2.3-beta1"' '"version": "1.2.3"' "\"commit\": \"$sha\"" \
  '"deployedVersionId": "ver-1"' '"previousVersionId": "ver-0"' '"waivers": []' "\"url\": \"$STAGING_URL\""; do
  if [ -f "$json" ] && grep -F -- "$field" "$json" > /dev/null; then pass "release.json records $field"; else fail "release.json records $field" "$out"; fi
done
for gate in 'audit' 'run test:release' 'run verify:all' 'run build'; do check "gate '$gate' ran" log_has "^pnpm $gate"; done
check "the install is frozen to the lockfile" log_has '^pnpm install --frozen-lockfile'
check "the deploy is the target's own environment" log_has '^wrangler deploy .*--env staging( |$)'
check "the deploy carries the tag and a message" log_has '^wrangler deploy --tag v1.2.3-beta1 --message'
check "no Wrangler --var is passed (there is no script to read it)" sh -c "! grep -E '^wrangler deploy.* --var' '$FAKE_STATE/calls.log'"

# ==== A waiver ====
new_repo waive
sha="$(head_sha)"
serve "$STAGING_URL" "$sha"
expect "--waive audit=<reason> is accepted" 0 "WAIVED gate audit: GHSA-test has no patched release" -- staging --waive "audit=GHSA-test has no patched release"
json="$(release_json)"
if [ -f "$json" ] && grep -F '{"gate": "audit", "reason": "GHSA-test has no patched release"}' "$json" > /dev/null; then pass "release.json records the waiver"
else fail "release.json records the waiver" "$out"; fi
check "the waived gate did not run" sh -c "! grep -E '^pnpm audit' '$FAKE_STATE/calls.log'"
for gate in 'run test:release' 'run verify:all' 'run build'; do check "the other gate '$gate' still ran" log_has "^pnpm $gate"; done

# ==== A failing gate ====
new_repo gate
serve "$STAGING_URL" "$(head_sha)"
FAKE_FAIL_GATE="verify:all"; export FAKE_FAIL_GATE
expect "a failing gate stops the release" 1 "gate verify failed" -- staging
check "a failing gate deploys nothing" no_deploy
check "a failing gate leaves no tag" no_tags
FAKE_FAIL_GATE=""; export FAKE_FAIL_GATE
FAKE_BUILD_LEAK=1; export FAKE_BUILD_LEAK
expect "a local path baked into dist/ stops the release" 1 "gate dist-scan failed" -- staging
check "a leaking build deploys nothing" no_deploy
FAKE_BUILD_LEAK=""; export FAKE_BUILD_LEAK

# ==== --dry-run ====
new_repo dry
serve "$STAGING_URL" "$(head_sha)"
expect "--dry-run runs the gates and stops" 0 "dry run passed" -- staging --dry-run
check "--dry-run asks Wrangler for its own dry run" log_has '^wrangler deploy --dry-run .*--env staging( |$)'
check "--dry-run deploys nothing" no_deploy
check "--dry-run leaves no tag" no_tags

# ==== Target parity ====
new_repo parity
serve "$STAGING_URL" "$(head_sha)"
FAKE_BUILD_COMMIT="1111111111111111111111111111111111111111"; export FAKE_BUILD_COMMIT
expect "a build that names another commit stops the release" 1 "not the released commit" -- staging
check "a wrong baked commit deploys nothing" no_deploy
FAKE_BUILD_COMMIT=""; export FAKE_BUILD_COMMIT
FAKE_LOGIN_FAILS=1; export FAKE_LOGIN_FAILS
expect "a missing Wrangler login stops the release" 1 "Cloudflare login check failed: Not logged in" -- staging
check "a missing login deploys nothing" no_deploy
FAKE_LOGIN_FAILS=""; export FAKE_LOGIN_FAILS

# ==== A failing live proof ====
new_repo live
serve "$STAGING_URL" "0000000000000000000000000000000000000000"
expect "a failing verify-live fails the release" 1 "NOT tagged" -- staging
check "a failing verify-live leaves no tag" no_tags
if printf '%s\n' "$out" | grep -F 'wrangler.js rollback ver-0 --env staging' > /dev/null; then pass "the rollback command names the version it replaced"
else fail "the rollback command names the version it replaced" "$out"; fi
check "a failing verify-live writes no release.json" test -z "$(release_json)"

# ==== A whole production release ====
new_repo promote
sha="$(head_sha)"
serve "$STAGING_URL" "$sha"
serve "$PRODUCTION_URL" "$sha"
git -C "$work" tag -a v1.2.3-beta1 -m staged && git -C "$work" push -q origin v1.2.3-beta1
expect "production releases the commit staging serves" 0 "Released v1.2.3 to production" -- production --yes
check "the production tag is pushed" test -n "$(remote_tags | grep -F 'refs/tags/v1.2.3^{}')"
check "the deploy is the production environment" log_has '^wrangler deploy .*--env production( |$)'

# ==== verify-live.sh on its own (read-only; the same script serves a schedule and an agent) ====
new_repo live2
sha="$(head_sha)"
vl() { code=0; out="$(cd "$work" && "$BASH" scripts/verify-live.sh "$@" 2>&1 < /dev/null)" || code=$?; }
vl_expect() { # <name> <exit code> <text> -- <args>
  local name="$1" want="$2" text="$3"; shift 4
  vl "$@"
  if [ "$code" = "$want" ] && printf '%s\n' "$out" | grep -F -- "$text" > /dev/null; then pass "$name"
  else fail "$name (exit $code, wanted $want and \"$text\")" "$out"; fi
}
skey="$(web_key "$STAGING_URL/")"
vl_expect "verify-live without a target prints usage" 2 "usage:" --
serve "$STAGING_URL" "$sha"
vl_expect "verify-live passes on a healthy target (control)" 0 "all assertions passed" -- staging
export EXPECT_COMMIT="${sha:0:7}" EXPECT_VERSION="1.2.3"
vl_expect "verify-live accepts a released commit given as a short id" 0 "all assertions passed" -- staging
export EXPECT_COMMIT="1111111111111111111111111111111111111111"
vl_expect "verify-live fails when another commit is served" 1 "served commit is the released commit" -- staging
export EXPECT_COMMIT="$sha" EXPECT_VERSION="9.9.9"
vl_expect "verify-live fails when another version is served" 1 "served version is the released version" -- staging
unset EXPECT_COMMIT EXPECT_VERSION
serve "$STAGING_URL" "${sha}-dirty"
vl_expect "verify-live fails on a dirty build" 1 "page carries a commit id" -- staging
serve "$STAGING_URL" ""
vl_expect "verify-live fails on a page that names no commit" 1 "page carries a commit id" -- staging
serve "$STAGING_URL" "$sha"
printf '<html><title>Some other site</title></html>' > "$FAKE_WEB/$skey"
vl_expect "verify-live fails when the page is not the real one" 1 "answers with the real page" -- staging
serve "$STAGING_URL" "$sha"
printf '500' > "$FAKE_WEB/$skey.status"
vl_expect "verify-live fails on a page that answers 500" 1 "page answers 200" -- staging
rm -f "$FAKE_WEB/$skey.status"
serve "$STAGING_URL" "$sha"
printf '<!doctype html><title>x</title>' > "$FAKE_WEB/${skey}assets_index-abc.js"
printf 'content-type: text/html\n' > "$FAKE_WEB/${skey}assets_index-abc.js.headers"
vl_expect "verify-live fails when the entry script is the HTML fallback" 1 "entry script is served as JavaScript" -- staging
serve "$STAGING_URL" "$sha"
printf "content-type: text/html\ncontent-security-policy: default-src 'self'; object-src 'none'; frame-ancestors 'none'\n" > "$FAKE_WEB/$skey.headers"
vl_expect "verify-live fails when HSTS is missing" 1 "Strict-Transport-Security" -- staging
printf "content-type: text/html\nstrict-transport-security: max-age=63072000; includeSubDomains\n" > "$FAKE_WEB/$skey.headers"
vl_expect "verify-live fails when the CSP from _headers is missing" 1 "Content-Security-Policy" -- staging
serve "$STAGING_URL" "$sha"
printf '200' > "$FAKE_WEB/$skey.OPTIONS.status"
vl_expect "verify-live fails when the request that must be refused succeeds" 1 "is refused" -- staging
serve "$STAGING_URL" "$sha"
: > "$FAKE_STATE/calls.log"; vl staging
if ! grep -E '^(wrangler|pnpm|node)' "$FAKE_STATE/calls.log" > /dev/null &&
  ! grep -E 'curl .*(-X (POST|PUT|DELETE|PATCH)|-d |--data|--upload|-T )' "$FAKE_STATE/calls.log" > /dev/null; then pass "verify-live only reads (GET, and OPTIONS for the refusal control)"
else fail "verify-live only reads (GET, and OPTIONS for the refusal control)" "$(cat "$FAKE_STATE/calls.log")"; fi

# ==== The header names the Wrangler surface the script relies on ====
header="$(sed -n '1,/^set -euo pipefail/p' "$here/release.sh")"
# `secret list` and `--var` are absent on purpose: this Worker reads no secrets and has no script.
for needle in 'deployments status --json' 'version_id' 'percentage' 'deploy --tag --message' 'rollback <id> -m "<message>" -y'; do
  if printf '%s\n' "$header" | grep -F -- "$needle" > /dev/null; then pass "release.sh header names $needle"
  else fail "release.sh header names $needle"; fi
done

# ==== A pushed tag is never moved ====
if grep -E 'tag +(-f|--force)|push +[^#]*(--force|-f )' "$here/release.sh" > /dev/null; then fail "release.sh never moves or force-pushes a tag"
else pass "release.sh never moves or force-pushes a tag"; fi

if [ "$failures" -ne 0 ]; then echo "release guard tests FAILED ($failures)"; exit 1; fi
echo "release guard tests passed"
