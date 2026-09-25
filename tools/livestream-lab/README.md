# Livestream lab

Tests the livestream players on real phones against a live platform's pipeline, run locally, through
networks that can be made as bad as needed. The pipeline is the common one for phone sellers: the host
publishes RTMP (H.264 and AAC), the server turns the AAC into Opus, and viewers play over WebRTC with
Ant Media's WebSocket signalling, or WHEP. The numbers in the README's
[Weak and changing networks](../../README.md#weak-and-changing-networks) come from here.

```
seller.sh / seller-mp4.sh --RTMP--> mediamtx live/<id> --ffmpeg: AAC to Opus--> mediamtx ams/<id>
                                                                                      |
phones (example app, lab hooks) <--WebRTC, impaired per phone-- zooplab <--WHEP-------+
                                --telemetry, remote control-->
```

## Parts

- **mediamtx** (`mediamtx/mediamtx.yml`): takes the seller's RTMP on `live/<id>`, and converts the
  audio to Opus 128 kbps stereo into `ams/<id>`, as Ant Media does. WebRTC on `:8889`, ICE on UDP
  `:8189`, API on `127.0.0.1:9997`.
- **Sellers**, sending the way react-native-nitro-rtmp-publisher does (H.264 Constrained Baseline,
  720×1280 at 30 fps, no B-frames, AAC 128 kbps stereo):
  - `mediamtx/seller.sh [id]`: a test pattern with stereo tones, 4 Mbps, a keyframe every 2 s.
  - `mediamtx/seller-mp4.sh <file> [id] [kbps] [keyframe seconds]`: a video file, looped and cropped
    to portrait. [Tears of Steel](https://mango.blender.org/) (CC BY 3.0) makes good test content.
- **zooplab** (`zooplab/`, Go and pion; `./run.sh` builds and starts it on `:5080`, `./run.sh stop`):
  - `/{app}/websocket`: Ant Media's WebSocket play protocol (`play`, server offer, `takeCandidate`,
    `toggleVideo`, `stop`, `ping`, `bitrateMeasurement` from the congestion controller,
    `no_stream_exist`, `play_finished`), relaying `ams/<id>` from mediamtx.
  - `/whep/<path>`: WHEP through an impaired relay, for comparison.
  - Network conditions per phone address (`/lab/link`): rate, queue, delay, jitter, loss, loss in
    bursts, outage.
    - Presets: `clean`, `wifi`, `4g`, `4g-poor`, `3g`, `edge`, `lossy-2`, `lossy-5`, `lossy-10`,
      `burst`, `outage`, `cap-3000`, `cap-2000`, `cap-1500`.
    - Schedules, which step through presets: `fluctuate`, `flaky`, `dips`, `long-outage`.
  - `/lab/app`: the phones connect here and send their state and stats every 2 s, written to
    `zooplab/logs/app-<device>.jsonl`. `/lab/open` sends a phone a link to open; `/lab/devices`
    lists them.
  - `/lab/ams`: makes the Ant Media stand-in fail on purpose.
  - It builds pion/interceptor with two fixes to its congestion controller
    (`zooplab/third_party/interceptor.patch`), without which the estimate behind
    `bitrateMeasurement` freezes once the link queues or loses packets.
  - `labclient`: a test viewer in Go; `-dump file.h264` saves what it receives.
- **Scripts:**
  - `scenario.sh <name> <seconds> <preset or schedule> [ams|whep] [fallback 0|1]`: sets each phone's
    network, opens the stream on both, and summarises each phone's telemetry. `KEEP=1` keeps the
    session playing, `DEVICES` picks phones, `TIMELINE=1` prints every sample.
  - `factor.sh <name> <seconds> '<json link>'`: a network of your own on both phones.
  - `labsum.py <jsonl> --since <ms> --until <ms> [--timeline]`: a summary of any window.
  - `phases.py <lab dir> <scenario> [schedule]`: a schedule run, broken down by network.
  - `rebuild.sh`: builds the library, and release builds of the example, installed and launched on
    the phones.
  - `results/scenarios.txt`: every run's name, start and end (epoch ms) and settings, to find it in
    the telemetry.

## Set up

1. Set the addresses in `lab.env` (this computer's, and each phone's) and in `mediamtx/mediamtx.yml`.
2. Give the example app its lab hooks, and point it at the lab. The hooks are kept out of the example:

   ```sh
   git apply tools/livestream-lab/example-lab.patch      # git apply -R … takes them out again
   echo "EXPO_PUBLIC_LAB_URL=ws://<this computer>:5080/lab/app" >> examples/LivestreamExample/.env.local
   ```

3. Build and install: `tools/livestream-lab/rebuild.sh`, once the example's native projects exist
   (`npx expo prebuild`), with `IOS_UDID` and `DEVELOPMENT_TEAM` set for the iPhone.

## Run

```sh
cd tools/livestream-lab/mediamtx && nohup mediamtx mediamtx.yml > mediamtx.log 2>&1 &
cd tools/livestream-lab/mediamtx && nohup ./seller.sh 90001 > seller.log 2>&1 &
curl -s 127.0.0.1:9997/v3/paths/list      # live/90001 (H264, MPEG-4 Audio) and ams/90001 (H264, Opus)
cd tools/livestream-lab/zooplab && ./run.sh
# Open the example on the phones: they appear in curl -s 127.0.0.1:5080/lab/devices
tools/livestream-lab/scenario.sh clean-baseline 30 clean
tools/livestream-lab/scenario.sh fluctuate-1 190 fluctuate
```

## Gotchas

- **Android plays old JS after a library change.** Gradle takes the bundle as up to date when only the
  library's JS changed, since the library lives outside the app. `rebuild.sh` deletes the bundle
  outputs first.
- **`ios-deploy --justlaunch` sometimes kills the app** as the debugger detaches (a SIGTRAP in
  `lldb_image_notifier`, not a crash). `rebuild.sh` launches again until the phone shows up.
- **Keep the video on screen and the phone awake** (`adb shell svc power stayon usb`). A dimmed
  screen, or the video scrolled away, slows the renderer, and Android's decoder then drops frames.
- **Leave the phones alone during a run.** Leaving the app puts the video in picture-in-picture, and
  the Go live tab stops the player.
- **A zooplab restart forgets each phone's network conditions.**
- **The Android emulator takes `127.0.0.1:8554`** for its gRPC server, which is why mediamtx's
  transcoder reads RTSP from the computer's network address.
- `idevicescreenshot` shows the iOS video black (a Metal layer): not a playback problem.
