#!/usr/bin/env bash
# Print the signal server's metrics without typing SSH.
#
#   ./scripts/metrics.sh              # the counters you actually care about
#   ./scripts/metrics.sh files_completed
#   ./scripts/metrics.sh --raw       # the whole exposition, for grepping
#
# Why a script rather than SIGNAL_PUBLIC_METRICS=1: /metrics is token-gated on
# purpose, and docs/SECURITY.md records that the surface is meant to be
# unconfirmed to the internet. Turning it public to save an SSH would contradict
# that for the sake of a convenience. This keeps the gate and removes the typing.
#
# The admin token never leaves the VPS: it is read there and only the metric
# lines are printed back.
#
# Layouts: template units (signal@<app> → /etc/apps/<app>/) first, with the
# old single-host /etc/signal path as fallback. SIGNAL_UNIT picks the unit
# (default signal@files); SIGNAL_APP overrides just the app name.
set -euo pipefail

# Operator config: no defaults — export these in your shell (never commit values).
#   SIGNAL_SSH_KEY   path to the SSH private key for the VPS
#   SIGNAL_SSH_HOST  ssh target, e.g. deploy@203.0.113.10
KEY="${SIGNAL_SSH_KEY:?set SIGNAL_SSH_KEY to your SSH private key path}"
HOST="${SIGNAL_SSH_HOST:?set SIGNAL_SSH_HOST to your ssh target (e.g. deploy@203.0.113.10)}"
UNIT="${SIGNAL_UNIT:-signal@files}"
# Resolved locally so the remote side never receives an empty operand: ssh
# flattens the remote command into one string, and an empty quoted arg
# vanishes in transit — every later positional would shift down one and the
# filter would silently become the unit name.
APP="${SIGNAL_APP:-${UNIT#*@}}"

raw=0
filter=""
for a in ${@+"$@"}; do
  case "$a" in
    --raw) raw=1 ;;
    *)     filter="$a" ;;
  esac
done

# --remote is a small script run ON the VPS: it reads the token as root (the
# unprivileged ssh user cannot), scrapes /metrics locally, and prints only the
# lines we want.
# NOTE: only the trailing filter may be empty — see the APP comment above.
# The remote defaults mirror the local ones so a dropped trailing arg still lands.
ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "$HOST" bash -s -- "$raw" "$UNIT" "$APP" "${filter:-}" <<'REMOTE'
set -euo pipefail
raw="${1:-0}"; unit="${2:-signal@files}"; app="${3:-${unit#*@}}"; filter="${4:-}"
# Template units keep token + env per app; the old single-host path is fallback.
if sudo test -f "/etc/apps/$app/admin-token"; then
  TOK=$(sudo cat "/etc/apps/$app/admin-token")
  addr=$(sudo grep -E '^SIGNAL_ADDR=' "/etc/apps/$app/signal.env" 2>/dev/null | cut -d= -f2- | tr -d ' \t\r\n')
  addr="${addr:-127.0.0.1:8090}"
else
  TOK=$(sudo cat /etc/signal/admin-token)
  addr="127.0.0.1:8090"
fi
m=$(curl -sS -m 10 -H "Authorization: Bearer $TOK" "http://$addr/metrics")

if [ "$raw" = "1" ]; then
  printf '%s\n' "$m" | grep -E '^p2pfilesharing_'
  exit 0
fi
if [ -n "$filter" ]; then
  printf '%s\n' "$m" | grep -E "^p2pfilesharing_${filter} " || echo "no metric matching '$filter'"
  exit 0
fi

# The three that answer "is it working, and is anything using it?".
printf '%s\n' "$m" | grep -E '^p2pfilesharing_(files_completed|rooms_created|signals_routed|rooms_active|ws_conns|rate_limited|report_log) ' \
  | sed 's/^p2pfilesharing_//'
printf '  reported   %s\n' "$(printf '%s\n' "$m" | grep -c '^p2pfilesharing_')"
REMOTE
