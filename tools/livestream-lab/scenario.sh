#!/bin/bash
# Drives one scenario on the phones through zooplab, and prints each phone's summary.
#
#   scenario.sh <name> <seconds> <preset> [path] [fallback]
#     path:     ams (Ant Media WebSocket, default) | whep (WHEP through the lab relay)
#     fallback: 1 (default) | 0
#   DEVICES selects phones (default both, by their names in lab.env); PRESET_ANDROID / PRESET_IOS
#   override the preset per phone.
#   KEEP=1 keeps the current session instead of opening a new one (to change conditions mid-play).

S=$(cd "$(dirname "$0")" && pwd)
. "$S/lab.env"
mkdir -p "$S/results"
NAME=$1; SECS=$2; PRESET=$3; PATHKIND=${4:-ams}; FALLBACK=${5:-1}
DEVICES=${DEVICES:-"$ANDROID_NAME $IOS_NAME"}
ip_of() { case $1 in "$ANDROID_NAME") echo "$ANDROID_IP";; "$IOS_NAME") echo "$IOS_IP";; esac; }

enc() { python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }

if [ "$PATHKIND" = whep ]; then
  LINK="webrtclivestream://watch?url=$(enc http://$LAB_IP:5080/whep/ams/90001)&fallback=$FALLBACK"
else
  LINK="webrtclivestream://watch?url=$(enc ws://$LAB_IP:5080/live/websocket)&stream=90001&fallback=$FALLBACK"
fi

for d in $DEVICES; do
  p=$PRESET
  [ "$d" = "$ANDROID_NAME" ] && [ -n "$PRESET_ANDROID" ] && p=$PRESET_ANDROID
  [ "$d" = "$IOS_NAME" ] && [ -n "$PRESET_IOS" ] && p=$PRESET_IOS
  curl -s -X POST "$LAB/lab/link?preset=$p&client=$(ip_of $d)" > /dev/null
done

START=$(python3 -c 'import time; print(int(time.time()*1000))')
if [ -z "$KEEP" ]; then
  for d in $DEVICES; do
    curl -s -X POST "$LAB/lab/open?device=$d&url=$(enc "$LINK")" > /dev/null
  done
fi
echo "== $NAME: $PRESET over $PATHKIND, fallback=$FALLBACK, ${SECS}s (start $START)"
sleep "$SECS"
END=$(python3 -c 'import time; print(int(time.time()*1000))')
echo "$NAME $START $END $PRESET $PATHKIND $FALLBACK" >> "$S/results/scenarios.txt"
for d in $DEVICES; do
  echo "-- $d"
  python3 "$S/labsum.py" "$S/zooplab/logs/app-$d.jsonl" --since $START --until $END ${TIMELINE:+--timeline}
done
