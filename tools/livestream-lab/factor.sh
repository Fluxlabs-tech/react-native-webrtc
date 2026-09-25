#!/bin/bash
# factor.sh <name> <seconds> '<json profile>'  — applies a custom link to both phones, keeps the session.
S=$(cd "$(dirname "$0")" && pwd)
. "$S/lab.env"
mkdir -p "$S/results"
for ip in "$ANDROID_IP" "$IOS_IP"; do curl -s -X POST "$LAB/lab/link?client=$ip" -H 'Content-Type: application/json' -d "$3" > /dev/null; done
sleep 4
START=$(python3 -c 'import time; print(int(time.time()*1000))'); sleep "$2"; END=$(python3 -c 'import time; print(int(time.time()*1000))')
echo "$1 $START $END custom $3" >> "$S/results/scenarios.txt"
echo "== $1: $3"
for d in "$ANDROID_NAME" "$IOS_NAME"; do echo "-- $d"; python3 "$S/labsum.py" "$S/zooplab/logs/app-$d.jsonl" --since $START --until $END | grep -E "video:|audio:|quality|freezes"; done
