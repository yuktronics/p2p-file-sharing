#!/usr/bin/env bash
# Cron-friendly early warning for enumeration/limiter abuse.
#
#   ./scripts/rate-alert.sh              # ok (exit 0) or ALERT (exit 1)
#   ./scripts/rate-alert.sh --file m.txt # same, but read metrics from a file
#                                        # (fixture input for testing)
#
# Watches the global `rate_limited` counter (all buckets — create, turn,
# report, nearby — feed it): a sustained 429 storm is what a nearby-code
# walk or a limiter-probe looks like from the inside. Compares against the
# previous run recorded in ~/.cache; first run always reports ok and stores
# state. Thresholds via env, so cron callers tune without editing.
#
#   RATE_ALERT_THRESHOLD=100   hits since last run that trigger ALERT
#   RATE_ALERT_MAX_AGE=86400   ignore state older than this (seconds)
set -euo pipefail

THRESHOLD="${RATE_ALERT_THRESHOLD:-100}"
MAX_AGE="${RATE_ALERT_MAX_AGE:-86400}"
STATE="${RATE_ALERT_STATE:-$HOME/.cache/p2p-file-sharing-rate-alert}"
HERE="$(dirname "$0")"

metrics=""
if [ "${1:-}" = "--file" ]; then
  metrics="$(cat "${2:?usage: rate-alert.sh --file <metrics>}")"
else
  metrics="$("$HERE/metrics.sh" --raw)"
fi
current="$(printf '%s\n' "$metrics" | awk '$1=="p2pfilesharing_rate_limited"{print $2; exit}')"
[ -n "$current" ] || { echo "rate-alert: no rate_limited line in metrics"; exit 2; }
now="$(date +%s)"

if [ -f "$STATE" ]; then
  prev_ts="$(cut -d' ' -f1 "$STATE")"
  prev_val="$(cut -d' ' -f2 "$STATE")"
  if [[ "$prev_ts" =~ ^[0-9]+$ && "$prev_val" =~ ^[0-9]+$ ]] && \
     [ "$((now - prev_ts))" -le "$MAX_AGE" ] && [ "$current" -ge "$prev_val" ]; then
    delta="$((current - prev_val))"
    printf '%s %s\n' "$now" "$current" > "$STATE"
    if [ "$delta" -ge "$THRESHOLD" ]; then
      echo "ALERT: rate_limited +$delta since last run (threshold $THRESHOLD)"
      exit 1
    fi
    echo "ok: rate_limited +$delta since last run"
    exit 0
  fi
  # Stale state or counter reset (restart zeroes volatile counters): re-baseline.
fi
mkdir -p "$(dirname "$STATE")"
printf '%s %s\n' "$now" "$current" > "$STATE"
echo "ok: baseline stored (rate_limited=$current)"
