#!/bin/bash
# Rebuilds the library and both example apps (release builds), installs and launches them on the
# phones. Devices: lab.env.
S=$(cd "$(dirname "$0")" && pwd)
R=$(cd "$S/../.." && pwd)
. "$S/lab.env"
N=$(date +%H%M%S)
cd "$R" && npx bob build > "$S/bob-$N.log" 2>&1 && node tools/copy-vendor-types.js || { echo "bob failed"; exit 1; }
cd "$R/examples/LivestreamExample"
# Gradle does not see changes to the library's JS (it lives outside the app): a fresh bundle, always.
rm -rf android/app/build/generated/assets/react android/app/build/generated/res/react android/app/build/generated/sourcemaps/react android/app/build/intermediates/sourcemaps/react
(cd android && ./gradlew assembleRelease > "$S/android-$N.log" 2>&1) || { echo "android build failed: $S/android-$N.log"; exit 1; }
adb install -r android/app/build/outputs/apk/release/app-release.apk | tail -1
adb shell monkey -p com.fluxlabs.webrtclivestreamexample -c android.intent.category.LAUNCHER 1 > /dev/null 2>&1
[ -n "$IOS_UDID" ] || { echo "IOS_UDID is not set: iOS skipped"; exit 0; }
(cd ios && xcodebuild -workspace WebRTCLivestream.xcworkspace -scheme WebRTCLivestream -configuration Release -destination "id=$IOS_UDID" -derivedDataPath "$S/ls-ios-dev-dd" ${DEVELOPMENT_TEAM:+DEVELOPMENT_TEAM=$DEVELOPMENT_TEAM} build > "$S/ios-$N.log" 2>&1) || { echo "ios build failed: $S/ios-$N.log"; exit 1; }
# ios-deploy's --justlaunch sometimes kills the app as the debugger detaches: launch until the
# phone shows up in the lab.
for i in 1 2 3 4 5; do
  ios-deploy --id "$IOS_UDID" --bundle "$S/ls-ios-dev-dd/Build/Products/Release-iphoneos/WebRTCLivestream.app" --justlaunch > "$S/ios-deploy-$N-$i.log" 2>&1
  sleep 9
  if curl -s "$LAB/lab/devices" | python3 -c "import json,sys; sys.exit(0 if any(x['device']=='$IOS_NAME' for x in json.load(sys.stdin)) else 1)"; then echo "ios up (attempt $i)"; break; fi
done
curl -s "$LAB/lab/devices" | python3 -c "import json,sys; print([(d['device'], d['connectedAt'][11:19]) for d in json.load(sys.stdin)])"
