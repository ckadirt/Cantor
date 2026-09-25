#!/usr/bin/env bash
# Sample the app's cost on a USB-attached phone while you use it.
#
#   scripts/perf-sample.sh [seconds] [label]
#
# Prints one line a second: app CPU% (100% = one core), battery temperature,
# and the thermal status. Ends with the frame summary Android kept for the
# app over the run (gfxinfo is reset at the start). Run it with the PerfHud
# off: the HUD's own frame callback keeps the UI thread awake.
set -euo pipefail

SECONDS_TO_RUN=${1:-30}
LABEL=${2:-run}
APP=com.cantor.app

pid=$(adb shell pidof "$APP" | tr -d '\r')
if [[ -z "$pid" ]]; then
  echo "$APP is not running" >&2
  exit 1
fi

adb shell dumpsys gfxinfo "$APP" reset >/dev/null
echo "# $LABEL · pid $pid · ${SECONDS_TO_RUN}s"
printf '%4s  %6s  %6s  %s\n' t cpu% temp thermal

total=0
for ((t = 1; t <= SECONDS_TO_RUN; t++)); do
  cpu=$(adb shell top -b -n 1 -p "$pid" | awk -v pid="$pid" '$1 == pid { print $9 }' | tr -d '\r')
  temp=$(adb shell dumpsys battery | awk -F': ' '/temperature/ { printf "%.1f", $2 / 10 }' | tr -d '\r')
  thermal=$(adb shell dumpsys thermalservice | awk -F': ' '/Thermal Status/ { print $2; exit }' | tr -d '\r')
  printf '%4d  %6s  %6s  %s\n' "$t" "${cpu:-?}" "${temp:-?}" "${thermal:-?}"
  total=$(awk -v a="$total" -v b="${cpu:-0}" 'BEGIN { print a + b }')
  sleep 1
done

awk -v s="$total" -v n="$SECONDS_TO_RUN" 'BEGIN { printf "# mean cpu%% %.1f\n", s / n }'
adb shell dumpsys gfxinfo "$APP" |
  grep -E 'Total frames rendered|Janky frames|50th percentile|90th percentile|99th percentile' |
  sed 's/^/# /'
