#!/usr/bin/env bash
# The release of the Gradiente Expert XP-800 site: a static-assets Cloudflare Worker with two
# Wrangler environments (top level = production, `staging`), no script, no database, no secrets.
#
#   scripts/release.sh <staging|production> [--check] [--dry-run] [--waive <gate>=<reason>]... [--yes]
#
#   staging     the tip of the remote default branch; tag vX.Y.Z-betaN after verify-live passes
#   production  the commit of the newest staging tag, only while staging serves it; tag vX.Y.Z
#   --check     print the plan (target, version, commit, tag, URL), check the runtime pin, exit
#   --dry-run   everything up to the deploy, plus `wrangler deploy --dry-run`; nothing is published
#   --waive     skip ONE named gate for a stated reason; recorded in release.json (repeatable)
#   --yes       skip the production confirmation prompt (the owner already approved the candidate)
# There is no flag that skips every gate: an unknown argument prints the usage and exits 2.
#
# Order: the commit is pushed first, then built and gated in a clean checkout, then deployed, then
# proved live by scripts/verify-live.sh, and only then tagged. The `deploy` and `deploy:staging`
# package scripts remain for a manual deploy; they run none of this and tag nothing.
#
# Guarantees covered (references/release-contract.md): 1 pushed source, 2 promotion, 3 runtime pin,
# 4 gates and waivers, 6 target parity (the built page carries the released commit and version),
# 7 live proof with a rollback command, 8 tag after proof, 9 release.json, 10 --check.
# Not applicable here:
#   5 recovery point  there is no database, so there is no data to export or restore.
#   secrets           the Worker reads none, so there is nothing to compare on the target.
#   schedules         wrangler.jsonc declares no triggers, so there is no cron list to compare.
# A rollback reverts the assets of the Worker; nothing else is deployed with them.
#
# Differences from the reference script, all forced by this being a static page:
#   - no /health: the served commit is <meta name="app-commit"> in the built HTML, which
#     vite.config.ts writes from RELEASE_COMMIT. `wrangler deploy --var` is not used (no script).
#   - no ACCOUNT_ID: this repository is public and its wrangler.jsonc names no account. Wrangler
#     uses the login (or CLOUDFLARE_ACCOUNT_ID from the caller's environment); the release proves
#     access by reading the target Worker's deployment.
#   - pnpm replaces npm, and Wrangler runs under Node, never Bun (AGENTS.md).
#   - the Node pin is the `engines.node` minimum, because the repository pins no exact Node.
#
# Wrangler surface it relies on, checked against the pinned 4.119.0: `whoami` exiting 0;
# `deployments status --json` printing a `versions` array whose items carry `version_id` and
# `percentage`; `deploy --tag --message` and `rollback <id> -m "<message>" -y`; each with
# `--env <target>`.
#
# The browser gate honors MSX_BROWSER_CHANNEL from the caller's environment (for example
# MSX_BROWSER_CHANNEL=chrome where Playwright's headless shell is unusable).
# Needs bash 3.2+, git, curl, sed, awk, tr, node, pnpm at the version package.json pins, and a
# Wrangler login. The repository ignores `.scratch/`: evidence and the build checkout live there.
set -euo pipefail

usage="usage: scripts/release.sh <staging|production> [--check] [--dry-run] [--waive <gate>=<reason>]... [--yes]"

STAGING_URL="https://msx-expert-xp800-staging.mvneves.workers.dev"
PRODUCTION_URL="https://msx-expert-xp800.mvneves.workers.dev"
# One gate per line: <name>=<command>. Each runs in the fresh checkout; --waive names one of these.
# They mirror CI (.github/workflows/ci.yml) and AGENTS.md "Releases". `verify` runs lint, the
# production build, the guard tests and the offline browser checks; `build` then rebuilds dist/
# with RELEASE_COMMIT, which is the directory that is deployed.
GATES="audit=pnpm audit --audit-level moderate
release-guards=pnpm run test:release
verify=pnpm run verify:all
build=pnpm run build
dist-scan=! grep -rEq '/(Users|home)/[A-Za-z0-9._-]+/' dist/ && test -f dist/_headers && test -f dist/index.html"

die() { echo "release: $*" >&2; exit 1; }
say() { printf '\n==> %s\n' "$*"; }
bad_usage() { echo "release: $*" >&2; echo "$usage" >&2; exit 2; }

gate_names() { printf '%s\n' "$GATES" | sed -n 's/^\([^=]*\)=.*/\1/p'; }

# ---- Arguments ----
target="${1:-}"
case "$target" in staging | production) shift ;; *) echo "$usage" >&2; exit 2 ;; esac
check=0 dry=0 yes=0 waivers=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) check=1 ;;
    --dry-run) dry=1 ;;
    --yes) yes=1 ;;
    --waive)
      [ "$#" -ge 2 ] || bad_usage "--waive needs <gate>=<reason>"
      case "$2" in *=*) ;; *) bad_usage "--waive needs <gate>=<reason>, got '$2'" ;; esac
      w_gate="${2%%=*}"
      w_reason="$(printf '%s' "${2#*=}" | tr -d '\n\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
      [ -n "$w_reason" ] || bad_usage "--waive $w_gate needs a reason a reader can check"
      gate_names | awk -v g="$w_gate" '$0 == g { found = 1 } END { exit !found }' ||
        bad_usage "unknown gate '$w_gate' (gates: $(gate_names | tr '\n' ' '))"
      waivers="$waivers$w_gate=$w_reason
"
      shift ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
  shift
done

waiver_reason() { printf '%s' "$waivers" | awk -F= -v g="$1" '$1 == g { sub(/^[^=]*=/, ""); print; exit }'; }
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
# meta_content <html> <name>: the content of <meta name="<name>" ...>, whatever the attribute order.
meta_content() {
  printf '%s' "$1" | tr '\n' ' ' | { grep -oE "<meta[^>]*name=\"$2\"[^>]*>" || true; } | head -1 |
    sed -n 's/.*content="\([^"]*\)".*/\1/p'
}

root="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a Git repository"
cd "$root"

# ---- Guards (Git and the live staging page; nothing is written) ----
# The remote's own answer: a local tracking ref can be stale, so it is never trusted. This also
# names the default branch, so nothing here hard-codes `main`.
symref="$(git ls-remote --symref origin HEAD)" || die "cannot reach origin"
default_ref="$(printf '%s\n' "$symref" | sed -n 's/^ref: \(refs\/heads\/[^[:space:]]*\)[[:space:]]*HEAD$/\1/p')"
remote_tip="$(printf '%s\n' "$symref" | awk '$2 == "HEAD" && $1 !~ /^ref:/ { print $1; exit }')"
[ -n "$default_ref" ] && [ "${#remote_tip}" -ge 40 ] || die "cannot read the default branch of origin"
default_branch="${default_ref#refs/heads/}"
git fetch --quiet origin "$default_branch" || die "cannot fetch $default_branch from origin"
git cat-file -e "$remote_tip^{commit}" 2>/dev/null || die "origin's $default_branch ($remote_tip) could not be fetched"

# Tags as origin has them, one "<commit><TAB><tag>" per line (annotated tags peeled to their commit).
remote_tags="$(git ls-remote --tags origin | awk -F'\t' '{
  ref = $2; peeled = (substr(ref, length(ref) - 2) == "^{}")
  if (peeled) ref = substr(ref, 1, length(ref) - 3)
  sub(/^refs\/tags\//, "", ref)
  if (peeled || !(ref in sha)) sha[ref] = $1
} END { for (t in sha) print sha[t] "\t" t }')"
tag_exists() { printf '%s\n' "$remote_tags" | awk -F'\t' -v t="$1" '$2 == t { found = 1 } END { exit !found }'; }
# Files of a commit are read into a variable first: a reader that stops early would kill `git show`
# with SIGPIPE, which pipefail reports as a missing file once the file outgrows the pipe buffer.
version_at() {
  local pkg
  pkg="$(git show "$1:package.json")"
  printf '%s\n' "$pkg" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
}
changelog_has() {
  local log
  log="$(git show "$1:CHANGELOG.md")" || return 1
  printf '%s\n' "$log" | grep -E "^## \\[${2//./\\.}\\]" > /dev/null
}

if [ "$target" = staging ]; then
  commit="$(git rev-parse HEAD)"
  [ "$commit" = "$remote_tip" ] || die "HEAD is not pushed: it differs from origin/$default_branch (${remote_tip:0:7})"
  version="$(version_at "$commit")"
  [ -n "$version" ] || die "package.json at ${commit:0:7} has no version"
  changelog_has "$commit" "$version" || die "CHANGELOG.md has no '## [$version]' entry at ${commit:0:7}"
  ! tag_exists "v$version" || die "v$version already exists on origin (released to production): bump the version"
  last="$(printf '%s\n' "$remote_tags" | awk -F'\t' -v p="v$version-beta" 'index($2, p) == 1 { n = substr($2, length(p) + 1); if (n ~ /^[0-9]+$/ && n + 0 > max) max = n + 0 } END { print max + 0 }')"
  tag="v$version-beta$((last + 1))"
  url="$STAGING_URL"
  plan_tag="tag $tag"
else
  # The newest staging tag of the highest version on origin.
  staged_tag="$(printf '%s\n' "$remote_tags" | awk -F'\t' '$2 ~ /^v[0-9]+\.[0-9]+\.[0-9]+-beta[0-9]+$/ {
    split($2, p, /^v|\.|-beta/)
    printf "%06d.%06d.%06d.%06d\t%s\n", p[2], p[3], p[4], p[5], $2
  }' | sort | tail -1 | cut -f2)"
  [ -n "$staged_tag" ] || die "no staging tag (vX.Y.Z-betaN) on origin: release to staging first"
  commit="$(printf '%s\n' "$remote_tags" | awk -F'\t' -v t="$staged_tag" '$2 == t { print $1 }')"
  version="${staged_tag#v}"
  version="${version%-beta*}"
  git cat-file -e "$commit^{commit}" 2>/dev/null || git fetch --quiet origin "refs/tags/$staged_tag:refs/tags/$staged_tag" ||
    die "cannot fetch $staged_tag"
  ! tag_exists "v$version" || die "v$version already exists on origin: production already has this version"
  [ "$(version_at "$commit")" = "$version" ] || die "$staged_tag points at a commit whose package.json is not $version"
  changelog_has "$commit" "$version" || die "CHANGELOG.md has no '## [$version]' entry at $staged_tag"
  git merge-base --is-ancestor "$commit" "$remote_tip" || die "the staged commit ${commit:0:7} ($staged_tag) is not on origin/$default_branch"
  page="$(curl -fsS --max-time 20 "$STAGING_URL/")" || die "cannot read $STAGING_URL/"
  live="$(meta_content "$page" app-commit)"
  [ -n "$live" ] || die "$STAGING_URL/ reports no app-commit"
  case "$live" in *[!0-9a-f]*) die "staging serves a value that is not a commit id: $live" ;; esac
  # A served id of 7 or more characters that starts the staged commit; anything else is another commit.
  case "$commit" in "$live"*) ;; *) die "staging serves $live, not the staged commit ${commit:0:7} ($staged_tag): restage before promoting" ;; esac
  [ "${#live}" -ge 7 ] || die "staging serves an id too short to name one commit: $live"
  tag="v$version"
  url="$PRODUCTION_URL"
  plan_tag="tag $tag (promotes $staged_tag)"
fi

short="$(git rev-parse --short=7 "$commit")"
# A tag left behind locally (an earlier failed push) would make the tag step fail after the deploy.
! git rev-parse -q --verify "refs/tags/$tag" > /dev/null ||
  die "the tag $tag already exists locally but not on origin: inspect it, then delete it with git"

say "Release plan"
echo "target $target"
echo "version $version"
echo "commit $commit"
echo "$plan_tag"
echo "url $url"
dirty="$(git status --porcelain --untracked-files=no | wc -l | tr -d ' ')"
[ "$dirty" -eq 0 ] || echo "note: $dirty uncommitted tracked file(s) in this checkout are NOT part of this release"

# ---- Runtime pin: the tools in use equal what the commit declares ----
pin_matches() { [ "$2" = "$1" ] || case "$2" in "$1".*) true ;; *) false ;; esac; }
check_pin() {
  local pkg pm node_min name want have major
  pkg="$(git show "$commit:package.json")"
  pm="$(printf '%s\n' "$pkg" | sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  node_min="$(printf '%s\n' "$pkg" | sed -n 's/.*"node"[[:space:]]*:[[:space:]]*">=\([0-9][0-9]*\).*/\1/p' | head -1)"
  [ -n "$pm$node_min" ] || die "no runtime pin at $short: declare packageManager and engines.node in package.json"
  if [ -n "$pm" ]; then
    name="${pm%%@*}"; want="${pm#*@}"; want="${want%%+*}"
    have="$("$name" --version)" || die "cannot run '$name --version'"
    pin_matches "$want" "$have" || die "runtime pin: $name $have does not match the pinned $want"
    echo "pin ok: $name $have"
  fi
  if [ -n "$node_min" ]; then
    have="$(node --version | sed 's/^v//')" || die "cannot run 'node --version'"
    major="${have%%.*}"
    [ "$major" -ge "$node_min" ] 2> /dev/null || die "runtime pin: node $have is older than the declared engines.node >=$node_min"
    echo "pin ok: node $have (engines.node >=$node_min)"
  fi
}
check_pin
[ "$check" -eq 0 ] || { echo; echo "guards passed (--check: nothing built or deployed)"; exit 0; }

# ---- Build and verify in a fresh checkout of the commit ----
export WRANGLER_SEND_METRICS=false
export RELEASE_COMMIT="$commit"
run_dir="$root/.scratch/release/$tag-$(date +%Y%m%d-%H%M%S)"
work="$run_dir/worktree"
evidence="$run_dir/evidence"
mkdir -p "$evidence"
wrangler_err="$(mktemp "${TMPDIR:-/tmp}/release-wrangler.XXXXXX")"
cleanup() { rm -f "$wrangler_err"; git -C "$root" worktree remove --force "$work" 2> /dev/null || true; }
trap cleanup EXIT

say "Checkout of $short and a clean install"
git worktree add --quiet --detach "$work" "$commit"
cd "$work"
[ -x scripts/verify-live.sh ] || die "$short has no executable scripts/verify-live.sh: it predates this release flow"
PATH="$work/node_modules/.bin:$PATH"
pnpm install --frozen-lockfile < /dev/null

# Wrangler runs under Node from the checkout's own install, never through a shim that could pick Bun.
wrangler_env() { node node_modules/wrangler/bin/wrangler.js "$@" --env "$target"; }
# live_version: the version id serving 100% of the target Worker; fails when it cannot be read.
live_version() {
  local out
  out="$(wrangler_env deployments status --json 2> "$wrangler_err")" || return 1
  printf '%s' "$out" | tr -d ' \n\t' | tr '{' '\n' | { grep '"percentage":100[,}]' || true; } |
    sed -n 's/.*"version_id":"\([^"]*\)".*/\1/p' | head -1
}

say "Cloudflare login"
node node_modules/wrangler/bin/wrangler.js whoami > /dev/null 2> "$wrangler_err" ||
  die "Cloudflare login check failed: $(cat "$wrangler_err")"
echo "logged in"

say "Current $target deployment (the rollback target)"
previous=""
if previous="$(live_version)" && [ -n "$previous" ]; then
  echo "live version $previous"
elif grep -q "code: 10007" "$wrangler_err"; then
  echo "no $target Worker yet: this is its first deploy, so there is nothing to roll back to"
else
  die "cannot read the current deployment: $(cat "$wrangler_err")"
fi

say "Gates"
while IFS= read -r line; do
  [ -n "$line" ] || continue
  name="${line%%=*}"; cmd="${line#*=}"
  reason="$(waiver_reason "$name")"
  if [ -n "$reason" ]; then echo "WAIVED gate $name: $reason"; continue; fi
  echo "gate $name: $cmd"
  # stdin is closed so a gate cannot read the rest of the gate list.
  bash -c "$cmd" < /dev/null || die "gate $name failed ('$cmd'); fix it, or waive this one gate with --waive $name=<reason>"
done << GATE_LIST
$GATES
GATE_LIST

# ---- Target parity: the page that will be deployed names this commit and this version ----
say "Built page"
[ -f dist/index.html ] || die "dist/index.html does not exist after the gates"
built="$(cat dist/index.html)"
built_commit="$(meta_content "$built" app-commit)"
built_version="$(meta_content "$built" application-version)"
[ "$built_commit" = "$commit" ] || die "dist/index.html carries app-commit '$built_commit', not the released commit $commit"
[ "$built_version" = "$version" ] || die "dist/index.html carries application-version '$built_version', not $version"
echo "dist/index.html carries commit $short and version $version"

if [ "$dry" -eq 1 ]; then
  say "wrangler deploy --dry-run"
  wrangler_env deploy --dry-run --tag "$tag" --message "$tag $short" < /dev/null
  echo; echo "dry run passed: $tag ($short) verified; nothing deployed, no tag"
  exit 0
fi

if [ "$target" = production ] && [ "$yes" -eq 0 ]; then
  [ -t 0 ] || die "production needs --yes when not run from a terminal"
  read -r -p "Type 'production' to deploy $tag ($short) to $PRODUCTION_URL: " answer
  [ "$answer" = production ] || die "not confirmed"
fi

# ---- Deploy ----
say "Deploy $tag ($short) to $target"
wrangler_env deploy --tag "$tag" --message "$tag $short" < /dev/null 2>&1 | tee "$evidence/deploy.log"
deployed="$(live_version)" || die "deployed, but cannot read the new version: $(cat "$wrangler_err")"
echo "deployed version $deployed"

rollback_hint() {
  echo >&2
  echo "The live checks failed: $tag is deployed but NOT tagged. Investigate, or roll back:" >&2
  if [ -n "$previous" ]; then
    echo "  node node_modules/wrangler/bin/wrangler.js rollback $previous --env $target -m \"rollback $tag\" -y" >&2
  else
    echo "  first $target deploy: there is no earlier version; fix forward and release again" >&2
  fi
  echo "Evidence: $evidence" >&2
  exit 1
}

# ---- Live proof (retried: an edge location can answer with the previous version for a while) ----
say "Live checks against $url"
attempts="${VERIFY_LIVE_ATTEMPTS:-18}"
delay="${VERIFY_LIVE_DELAY:-10}"
proved=0
n=0
while [ "$n" -lt "$attempts" ]; do
  n=$((n + 1))
  if EXPECT_COMMIT="$commit" EXPECT_VERSION="$version" scripts/verify-live.sh "$target" > "$evidence/verify-live.log" 2>&1; then proved=1; break; fi
  if [ "$n" -lt "$attempts" ]; then echo "verify-live attempt $n failed; retrying in ${delay}s"; sleep "$delay"; fi
done
cat "$evidence/verify-live.log"
[ "$proved" -eq 1 ] || rollback_hint

# ---- Tag (only after the proof; a pushed tag is never moved) ----
say "Tag $tag"
tag_failed=0
if git -C "$root" tag -a "$tag" "$commit" -m "$target release $tag ($short)" && git -C "$root" push --quiet origin "refs/tags/$tag"; then
  echo "pushed $tag"
else
  echo "release: $tag is live and passed its checks, but the tag was not pushed. Finish by hand:" >&2
  echo "  git tag -a $tag $commit -m '$target release $tag ($short)'; git push origin refs/tags/$tag" >&2
  tag_failed=1
fi

# ---- Evidence ----
waiver_json=""
while IFS= read -r line; do
  [ -n "$line" ] || continue
  waiver_json="$waiver_json${waiver_json:+,
    }{\"gate\": \"$(json_escape "${line%%=*}")\", \"reason\": \"$(json_escape "${line#*=}")\"}"
done << WAIVER_LIST
$waivers
WAIVER_LIST
if [ -n "$waiver_json" ]; then waiver_json="
    $waiver_json
  "; fi
cat > "$evidence/release.json" << JSON
{
  "target": "$target",
  "tag": "$tag",
  "version": "$version",
  "commit": "$commit",
  "deployedVersionId": "$deployed",
  "previousVersionId": "$previous",
  "waivers": [$waiver_json],
  "url": "$url",
  "releasedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
say "Released $tag to $target"
echo "release.json: $evidence/release.json"
cat "$evidence/release.json"
[ "$tag_failed" -eq 0 ] || exit 1
