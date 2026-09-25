# Livestream example

A livestream viewer and host on this library, as an Expo app (SDK 57, React Native 0.86, New Architecture).

- **Watch** plays a stream from a WHEP endpoint or Ant Media's WebSocket signalling (`src/antMedia.ts`: the library's `LivestreamViewer` with Ant Media's signalling on top). It plays whatever the server has, however the host published it: WHIP from the Go live tab, or RTMP or SRT from an encoder or another app. It shows the video (with picture-in-picture), a quality line that says what holds it back, audio only on a weak connection, the voice leveller with an A/B switch and its levels (iOS), and the stream's numbers: resolution, bitrate, the buffer it plays with, loss, freezes, round trip and route. The screen stays on while it plays.
- **Go live** publishes the camera and microphone over WHIP, with a choice of microphone processing and bitrate, and shows what goes out: resolution, bitrate, what limits the video, loss at the server.

One tab runs at a time, so a phone never plays its own microphone back into itself.

## Run it

The library is linked from `../..`, not installed from npm.

```sh
cd examples/LivestreamExample
npm install
npx expo run:ios       # or run:android
```

Fields can be prefilled: copy `.env.example` to `.env.local` and restart Metro.

A link opens a stream too, for example with `adb shell am start -d '<link>'`:

- `webrtclivestream://watch?url=<WHEP URL>`
- `webrtclivestream://watch?url=<Ant Media WebSocket URL>&stream=<stream ID>`
- `webrtclivestream://live?url=<WHIP URL>`

With `&token=` for either, `&fallback=0|1` for audio only on a weak connection, and `webrtclivestream://watch?stop=1` to stop.

The livestream audio options are in `app.json`, under the `react-native-webrtc` plugin. They are built into the native app, so run `npx expo prebuild` again after changing them. `expo-build-properties` allows plain HTTP on Android, for a test server on the local network; a production app talks HTTPS.

## A local server

[mediamtx](https://github.com/bluenviron/mediamtx) speaks WHIP and WHEP, and takes RTMP, RTSP and SRT, so it can stand in for a streaming server:

```yaml
# mediamtx.yml
webrtcAdditionalHosts: [192.168.1.10]   # the computer's address on the network the phone is on
paths:
  all_others:
```

```sh
mediamtx mediamtx.yml
```

- Go live to `http://192.168.1.10:8889/show/whip`, and watch it at `http://192.168.1.10:8889/show/whep`.
- Or publish from anything else and watch the same way. A test pattern with stereo tones, over RTSP:

  ```sh
  ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 \
    -f lavfi -i "aevalsrc=0.25*sin(2*PI*440*t)|0.25*sin(2*PI*660*t):s=48000:c=stereo" \
    -c:v libx264 -preset veryfast -tune zerolatency -g 60 -bf 0 -c:a libopus -b:a 128k \
    -f rtsp rtsp://127.0.0.1:8554/show
  ```

- From RTMP, as most phone publishing libraries and OBS send it, the video plays but the audio does not: RTMP carries AAC, WebRTC plays Opus, and mediamtx does not transcode. Ant Media, Wowza and Red5 do. For audio from mediamtx, publish Opus: over RTSP or SRT, or WHIP.

The Android emulator reaches the computer at its network address, as a phone would.
