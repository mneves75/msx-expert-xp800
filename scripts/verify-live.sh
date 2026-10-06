#!/usr/bin/env bash
# Live assertions for the Gradiente Expert XP-800 site, a static-assets Worker.
#
#   scripts/verify-live.sh <staging|production>
#
# Read-only: it sends GET requests and one OPTIONS request, prints PASS or FAIL per assertion, and
# exits 0 only when every assertion holds. The same script serves the release (after a deploy), a
# schedule between deploys and an agent at the start of a session. It asserts:
#   served commit   the page's <meta name="app-commit"> is the commit being released (EXPECT_COMMIT;
#                   without it, a well-formed commit id: a `-dirty` or `unknown` build fails)
#   version         <meta name="application-version"> equals EXPECT_VERSION when that is set
#   health body     there is no /health: every GET path answers 200 with the HTML shell (single-page
#                   fallback), so the page itself is the health response. It must be 200, carry the
#                   page title `Gradiente Expert XP-800`, and the entry script it references must be
#                   served as JavaScript, not as the HTML fallback (the deploy has its assets)
#   control: real   GET /  (status 200 and the title above, which only the real page has)
#   control: refused  OPTIONS /  must answer 405. A GET cannot be refused here: the fallback turns
#                   every unknown path into a 200, so a 404 probe would never fail or pass.
#                   OPTIONS is a safe method and the 405 comes from the assets Worker itself.
#   wiring          the response headers public/_headers promises reach the deployed host:
#                   Strict-Transport-Security with includeSubDomains, and a Content-Security-Policy
#                   with frame-ancestors 'none' and object-src 'none'. tools/verify-prod.mjs checks
#                   the full policy in a browser; this is the cheap guard that the file was deployed.
# No schedules, bindings or secrets exist, so there are none to compare.
#
# Needs bash 3.2+, curl, sed, awk, tr and grep.
set -euo pipefail

usage="usage: scripts/verify-live.sh <staging|production>"
target="${1:-}"
case "$target" in staging | production) ;; *) echo "$usage" >&2; exit 2 ;; esac
[ "$#" -eq 1 ] || { echo "$usage" >&2; exit 2; }

STAGING_URL="https://msx-expert-xp800-staging.mvneves.workers.dev"
PRODUCTION_URL="https://msx-expert-xp800.mvneves.workers.dev"
PAGE_PATH="/"
PAGE_MARKER="Gradiente Expert XP-800"
REFUSED_METHOD="OPTIONS"
REFUSED_STATUS="405"
if [ "$target" = staging ]; then base="$STAGING_URL"; else base="$PRODUCTION_URL"; fi

failures=0
check() { # <name> <ok: 0|1> [detail]
  if [ "$2" -eq 1 ]; then echo "PASS $1${3:+: $3}"; else echo "FAIL $1${3:+: $3}"; failures=$((failures + 1)); fi
}
ok_if() { if "$@"; then echo 1; else echo 0; fi; }
is_commit_id() { case "$1" in "" | *[!0-9a-f]*) return 1 ;; esac; [ "${#1}" -ge 7 ]; }
# meta_content <html> <name>: the content of <meta name="<name>" ...>, whatever the attribute order.
meta_content() {
  printf '%s' "$1" | tr '\n' ' ' | { grep -oE "<meta[^>]*name=\"$2\"[^>]*>" || true; } | head -1 |
    sed -n 's/.*content="\([^"]*\)".*/\1/p'
}
# header_value <header file> <lowercase name>: the first value of that response header.
header_value() {
  tr -d '\r' < "$1" | awk -v n="$2:" 'index(tolower($0), n) == 1 { sub(/^[^:]*:[[:space:]]*/, ""); print; exit }'
}

scratch="$(mktemp -d "${TMPDIR:-/tmp}/verify-live.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

echo "verify-live: $target at $base"

# ---- The page: status, marker, served commit, version ----
status="$(curl -sS --max-time 20 -H 'Cache-Control: no-cache' -D "$scratch/page.headers" -o "$scratch/page.html" -w '%{http_code}' "$base$PAGE_PATH" 2> "$scratch/page.err")" || status="000"
html="$(cat "$scratch/page.html" 2> /dev/null || true)"
if [ "$status" = 200 ]; then
  check "page answers 200" 1 "$base$PAGE_PATH"
  case "$html" in
    *"<title>$PAGE_MARKER"*) check "control: $PAGE_PATH answers with the real page" 1 ;;
    *) check "control: $PAGE_PATH answers with the real page" 0 "the body lacks the title '$PAGE_MARKER'" ;;
  esac
  commit="$(meta_content "$html" app-commit)"
  version="$(meta_content "$html" application-version)"
  check "page carries a commit id" "$(ok_if is_commit_id "$commit")" "app-commit '$commit'"
  if [ -n "${EXPECT_COMMIT:-}" ]; then
    # Either side may be the shorter id, but never shorter than 7 characters.
    match=0
    case "$EXPECT_COMMIT" in "$commit"*) [ "${#commit}" -ge 7 ] && match=1 ;; esac
    case "$commit" in "$EXPECT_COMMIT"*) [ "${#EXPECT_COMMIT}" -ge 7 ] && match=1 ;; esac
    check "served commit is the released commit" "$match" "serves '$commit', expected '$EXPECT_COMMIT'"
  fi
  if [ -n "${EXPECT_VERSION:-}" ]; then
    check "served version is the released version" "$(ok_if [ "$version" = "$EXPECT_VERSION" ])" "serves '$version', expected '$EXPECT_VERSION'"
  fi

  # The entry script the page references must come back as JavaScript. The fallback would answer
  # 200 text/html for a missing asset, so the status alone proves nothing.
  entry="$(printf '%s' "$html" | tr '\n' ' ' | { grep -oE '<script[^>]*src="/assets/[^"]*\.js"' || true; } | head -1 | sed -n 's/.*src="\([^"]*\)".*/\1/p')"
  if [ -n "$entry" ]; then
    estatus="$(curl -sS --max-time 20 -D "$scratch/entry.headers" -o /dev/null -w '%{http_code}' "$base$entry" 2> /dev/null)" || estatus="000"
    etype="$(header_value "$scratch/entry.headers" content-type 2> /dev/null || true)"
    case "$etype" in
      *javascript*) check "wiring: the entry script is served as JavaScript" "$(ok_if [ "$estatus" = 200 ])" "$entry: status $estatus, $etype" ;;
      *) check "wiring: the entry script is served as JavaScript" 0 "$entry: status $estatus, content-type '$etype'" ;;
    esac
  else
    check "wiring: the entry script is served as JavaScript" 0 "the page references no /assets/*.js script"
  fi

  hsts="$(header_value "$scratch/page.headers" strict-transport-security)"
  csp="$(header_value "$scratch/page.headers" content-security-policy)"
  case "$hsts" in *includeSubDomains*) check "wiring: Strict-Transport-Security includes subdomains" 1 ;; *) check "wiring: Strict-Transport-Security includes subdomains" 0 "header '$hsts'" ;; esac
  case "$csp" in
    *"frame-ancestors 'none'"*"object-src 'none'"* | *"object-src 'none'"*"frame-ancestors 'none'"*) check "wiring: the Content-Security-Policy from _headers is deployed" 1 ;;
    *) check "wiring: the Content-Security-Policy from _headers is deployed" 0 "header '$csp'" ;;
  esac
else
  check "page answers 200" 0 "$base$PAGE_PATH answered $status $(cat "$scratch/page.err" 2> /dev/null || true)"
fi

# ---- The request that must be refused ----
refused="$(curl -sS --max-time 20 -X "$REFUSED_METHOD" -o /dev/null -w '%{http_code}' "$base$PAGE_PATH" 2> /dev/null)" || refused="000"
check "control: $REFUSED_METHOD $PAGE_PATH is refused" "$(ok_if [ "$refused" = "$REFUSED_STATUS" ])" "status $refused, expected $REFUSED_STATUS"

if [ "$failures" -ne 0 ]; then echo "verify-live: $failures assertion(s) failed against $base"; exit 1; fi
echo "verify-live: all assertions passed against $base"
