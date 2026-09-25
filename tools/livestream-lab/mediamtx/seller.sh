#!/bin/sh
# A seller app's stream, as react-native-nitro-rtmp-publisher sends it: H.264 Constrained Baseline (the
# iOS hardware profile), 720x1280 at 30 fps, 4 Mbps, a keyframe every 2 s, no B-frames; AAC 128k
# stereo at 48 kHz. Over RTMP to app "live", stream id = the backend's stream id.
ID=${1:-90001}
exec ffmpeg -hide_banner -loglevel warning -re \
  -f lavfi -i "testsrc2=size=720x1280:rate=30" \
  -f lavfi -i "aevalsrc=0.3*sin(2*PI*440*t)*(0.6+0.4*sin(2*PI*0.5*t))|0.3*sin(2*PI*660*t)*(0.6+0.4*cos(2*PI*0.5*t)):s=48000:c=stereo" \
  -c:v libx264 -preset veryfast -tune zerolatency -profile:v baseline -pix_fmt yuv420p \
  -g 60 -keyint_min 60 -sc_threshold 0 -bf 0 -b:v 4000k -maxrate 4000k -bufsize 2000k \
  -c:a aac -b:a 128k -ar 48000 -ac 2 \
  -f flv rtmp://127.0.0.1:1935/live/$ID
