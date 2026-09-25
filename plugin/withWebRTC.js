//
// Expo config plugin for react-native-webrtc: permissions, picture-in-picture, background audio,
// and livestream audio.
//
// Livestream audio is built before React Native starts: the peer connection factory reads its
// audio device and field trials once, and no JS runs early enough to set them. So its options
// travel through the native project: this plugin writes them to Info.plist (iOS, key
// `WebRTCLivestream`) and to `<meta-data>` in the AndroidManifest (Android, names prefixed
// `com.fluxlabs.webrtc.livestream.`), and the native side reads them at launch.
//
// Usage in app.json / app.config.js. Every option is optional:
//
//   "plugins": [
//     ["react-native-webrtc", {
//       "cameraPermission": "Allow $(PRODUCT_NAME) to use your camera to go live",
//       "microphonePermission": "Allow $(PRODUCT_NAME) to use your microphone to go live",
//       "capture": true,              // false for a watch-only app: no camera or microphone
//                                     // permission on Android
//       "pictureInPicture": true,     // Android activity attributes, iOS audio background mode
//       "backgroundAudio": true,      // iOS: keep playing when the app is in the background
//       "livestream": {
//         "leveller": true,           // voice leveller behind a -1 dBFS limiter
//         "levellerInputGainDb": 15,  // how far a quiet speaker is lifted
//         "networkResilience": true,  // full-RTT resend wait, 1 MB receive buffer
//         "playoutDelayMs": 1200,     // iOS: play this far behind live
//         "maxPlayoutDelayMs": 2500,  // iOS: how far it may drift under jitter
//         "ios": { "manageAudioSession": true },
//         "android": { "audioFocus": true, "audioSource": "mic" }
//       }
//     }]
//   ]
//
// In `livestream`, top-level keys apply to both platforms, and a key in `ios` / `android` wins
// over the same key at the top level, except the playout delay, which at the top level applies to
// iOS only. Android has no hook for holding audio back to match a delayed picture, so there the
// voice runs ahead of the picture for the first seconds of every session; set
// `android.playoutDelayMs` explicitly to accept that. `"enabled": false` (top level or per
// platform) keeps libwebrtc's call audio, with echo cancellation, for apps whose audio goes both
// ways.

// Expo's own copy, as the app has it; loaded when the plugin runs. Looked up from the app's
// directory too: from a linked checkout, or under pnpm, this file's own directory has no Expo.
function configPlugins() {
    for (const name of [ 'expo/config-plugins', '@expo/config-plugins' ]) {
        for (const paths of [ undefined, [ process.cwd() ] ]) {
            try {
                return require(paths ? require.resolve(name, { paths }) : name);
            } catch {
                // The next place.
            }
        }
    }

    throw new Error(`[${PACKAGE}] the config plugin needs Expo: expo/config-plugins was not found.`);
}

const PACKAGE = 'react-native-webrtc';
const INFO_PLIST_KEY = 'WebRTCLivestream';
const META_PREFIX = 'com.fluxlabs.webrtc.livestream.';

const COMMON = {
    enabled: 'boolean',
    leveller: 'boolean',
    levellerInputGainDb: 'number',
    networkResilience: 'boolean'
};
const DELAY = {
    playoutDelayMs: 'number',
    maxPlayoutDelayMs: 'number'
};
const IOS_ONLY = { manageAudioSession: 'boolean' };
const ANDROID_ONLY = { audioFocus: 'boolean', audioSource: 'string' };
const AUDIO_SOURCES = [ 'mic', 'camcorder', 'voiceCommunication', 'unprocessed' ];

const DEFAULT_CAMERA_PERMISSION = 'Allow $(PRODUCT_NAME) to use your camera';
const DEFAULT_MICROPHONE_PERMISSION = 'Allow $(PRODUCT_NAME) to use your microphone';

function pick(source, schema, where) {
    const out = {};

    if (source == null) {
        return out;
    }

    if (typeof source !== 'object' || Array.isArray(source)) {
        throw new Error(`[${PACKAGE}] ${where} must be an object.`);
    }

    for (const [ key, type ] of Object.entries(schema)) {
        if (source[key] === undefined) {
            continue;
        }

        if (typeof source[key] !== type || (type === 'number' && !Number.isFinite(source[key]))) {
            throw new Error(`[${PACKAGE}] ${where}.${key} must be a ${type}.`);
        }

        out[key] = source[key];
    }

    return out;
}

function check(options, platform) {
    const { playoutDelayMs, maxPlayoutDelayMs, levellerInputGainDb, audioSource } = options;

    if (playoutDelayMs !== undefined && (playoutDelayMs < 0 || playoutDelayMs > 10000)) {
        throw new Error(`[${PACKAGE}] livestream (${platform}): playoutDelayMs must be between 0 and 10000.`);
    }

    if (maxPlayoutDelayMs !== undefined && maxPlayoutDelayMs < (playoutDelayMs ?? 0)) {
        throw new Error(`[${PACKAGE}] livestream (${platform}): maxPlayoutDelayMs must not be below playoutDelayMs.`);
    }

    if (levellerInputGainDb !== undefined && (levellerInputGainDb < 0 || levellerInputGainDb > 30)) {
        throw new Error(`[${PACKAGE}] livestream (${platform}): levellerInputGainDb must be between 0 and 30.`);
    }

    if (audioSource !== undefined && !AUDIO_SOURCES.includes(audioSource)) {
        throw new Error(`[${PACKAGE}] livestream (android): audioSource must be one of ${AUDIO_SOURCES.join(', ')}.`);
    }

    return options;
}

function resolveLivestream(props = {}) {
    const common = pick(props, COMMON, 'livestream');
    const topDelay = pick(props, DELAY, 'livestream');
    const ios = check({
        ...common,
        ...topDelay,
        ...pick(props.ios, { ...COMMON, ...DELAY, ...IOS_ONLY }, 'livestream.ios')
    }, 'ios');
    const android = check({
        ...common,
        ...pick(props.android, { ...COMMON, ...DELAY, ...ANDROID_ONLY }, 'livestream.android')
    }, 'android');

    return { ios, android };
}

function resolveOptions(props = {}) {
    const options = pick(props, {
        capture: 'boolean',
        pictureInPicture: 'boolean',
        backgroundAudio: 'boolean'
    }, 'options');

    for (const key of [ 'cameraPermission', 'microphonePermission' ]) {
        if (props[key] !== undefined && typeof props[key] !== 'string') {
            throw new Error(`[${PACKAGE}] options.${key} must be a string.`);
        }
    }

    return {
        capture: options.capture !== false,
        pictureInPicture: options.pictureInPicture === true,
        backgroundAudio: options.backgroundAudio === true,
        cameraPermission: props.cameraPermission,
        microphonePermission: props.microphonePermission,
        livestream: resolveLivestream(props.livestream)
    };
}

function addUsesFeature(manifest, name) {
    const features = manifest.manifest['uses-feature'] ?? [];

    if (!features.some(feature => feature.$['android:name'] === name)) {
        features.push({ $: { 'android:name': name, 'android:required': 'false' } });
    }

    manifest.manifest['uses-feature'] = features;
}

const withWebRTC = (config, props) => {
    const { AndroidConfig, withAndroidManifest, withInfoPlist } = configPlugins();
    const options = resolveOptions(props);

    config = withInfoPlist(config, cfg => {
        const plist = cfg.modResults;

        // App Store review asks for both of any app linking WebRTC, whether or not it captures.
        plist.NSCameraUsageDescription =
            options.cameraPermission ?? plist.NSCameraUsageDescription ?? DEFAULT_CAMERA_PERMISSION;
        plist.NSMicrophoneUsageDescription =
            options.microphonePermission ?? plist.NSMicrophoneUsageDescription ?? DEFAULT_MICROPHONE_PERMISSION;

        // Picture-in-picture plays on with the app in the background, which takes the audio mode.
        if (options.pictureInPicture || options.backgroundAudio) {
            const modes = new Set(plist.UIBackgroundModes ?? []);

            modes.add('audio');
            plist.UIBackgroundModes = [ ...modes ];
        }

        plist[INFO_PLIST_KEY] = options.livestream.ios;

        return cfg;
    });

    config = withAndroidManifest(config, cfg => {
        const manifest = cfg.modResults;
        const permissions = [ 'android.permission.INTERNET', 'android.permission.ACCESS_NETWORK_STATE' ];

        if (options.capture) {
            permissions.push(
                'android.permission.CAMERA',
                'android.permission.RECORD_AUDIO',
                'android.permission.MODIFY_AUDIO_SETTINGS'
            );
            addUsesFeature(manifest, 'android.hardware.camera');
            addUsesFeature(manifest, 'android.hardware.microphone');
        }

        AndroidConfig.Permissions.ensurePermissions(manifest, permissions);

        if (options.pictureInPicture) {
            const activity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest);
            const changes = new Set((activity.$['android:configChanges'] ?? '').split('|').filter(Boolean));

            for (const change of [ 'screenSize', 'smallestScreenSize', 'screenLayout', 'orientation' ]) {
                changes.add(change);
            }

            activity.$['android:supportsPictureInPicture'] = 'true';
            activity.$['android:configChanges'] = [ ...changes ].join('|');
        }

        const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);

        // Replace, not merge: an option removed from app.json must leave the manifest too.
        for (const key of Object.keys({ ...COMMON, ...DELAY, ...ANDROID_ONLY })) {
            AndroidConfig.Manifest.removeMetaDataItemFromMainApplication(app, META_PREFIX + key);
        }

        for (const [ key, value ] of Object.entries(options.livestream.android)) {
            AndroidConfig.Manifest.addMetaDataItemToMainApplication(app, META_PREFIX + key, String(value));
        }

        return cfg;
    });

    return config;
};

module.exports = withWebRTC;
module.exports.resolveOptions = resolveOptions;
