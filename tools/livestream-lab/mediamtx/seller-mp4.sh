#!/bin/sh
# A seller app's stream with real content: loops a video file and sends it the way
# react-native-nitro-rtmp-publisher does. H.264 Constrained Baseline, 720x1280 at 30 fps (cropped
# to portrait from the middle), 4 Mbps, a keyframe every 2 s, no B-frames; AAC 128 kbps stereo at
# 48 kHz. Over RTMP to app "live".
#
#   ./seller-mp4.sh <file> [stream id] [video kbps] [keyframe seconds]
FILE=${1:?usage: seller-mp4.sh <file> [stream id] [video kbps] [keyframe seconds]}
ID=${2:-90001}
KBPS=${3:-4000}
GOP=$(( ${4:-2} * 30 ))
exec ffmpeg -hide_banner -loglevel warning -re -stream_loop -1 -i "$FILE" \
  -vf "crop=ih*9/16:ih,scale=720:1280,fps=30" \
  -c:v libx264 -preset veryfast -tune zerolatency -profile:v baseline -pix_fmt yuv420p \
  -g $GOP -keyint_min $GOP -sc_threshold 0 -bf 0 -b:v ${KBPS}k -maxrate ${KBPS}k -bufsize $((KBPS / 2))k \
  -c:a aac -b:a 128k -ar 48000 -ac 2 \
  -f flv rtmp://127.0.0.1:1935/live/$ID
