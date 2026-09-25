import WebRTCModule from '../NativeWebRTCModule';

/**
 * What livestream audio runs with. Fixed for the life of the app: the native side builds the audio
 * device before any JS runs, so these come from the config plugin (Info.plist / AndroidManifest).
 */
export type LivestreamAudioConfig = {
    /** How far behind live remote audio and video play, in ms; 0 plays each frame the moment it can. */
    playoutDelayMs: number;
    /** How far the playout delay may drift under heavy jitter, in ms. */
    maxPlayoutDelayMs: number;
    /** The voice leveller is built into the playout path. */
    leveller: boolean;
    /** How far the leveller lifts a quiet speaker, in dB. */
    levellerInputGainDb: number;
    /** iOS: the audio session's category is set while playing or recording. Always false on Android. */
    manageAudioSession: boolean;
    /** Android: audio focus is held while playing or recording. Always false on iOS. */
    audioFocus: boolean;
    /** Wait a whole round trip for resent packets, and a 1 MB socket receive buffer. */
    networkResilience: boolean;
    /** Android: where a host's microphone is recorded from. */
    audioSource?: 'mic' | 'camcorder' | 'voiceCommunication' | 'unprocessed';
};

/** The leveller's peaks since the previous read. */
export type LivestreamAudioLevels = {
    /** Loudest sample received, in dBFS. -120 is silence. */
    inputPeakDb: number;
    /** Loudest sample played, in dBFS. Never above the -1 dBFS ceiling. */
    outputPeakDb: number;
    /** Deepest gain reduction applied (compressor and limiter), in dB. */
    maxReductionDb: number;
};

type State = {
    installed: boolean;
    playing?: boolean;
    recording?: boolean;
    levellerEnabled?: boolean;
    config?: LivestreamAudioConfig;
};

function state(): State {
    return WebRTCModule.livestreamAudioState();
}

/**
 * Livestream audio: remote audio played as media through a voice leveller, and a host's microphone
 * captured as it sounds. It is in place from launch, with no code needed; this reads it back and
 * switches the leveller.
 */
const livestreamAudio = {
    /**
     * Livestream audio is in place. false when the config plugin turned it off, when the app set
     * its own audio device, and on platforms without it.
     */
    get isInstalled(): boolean {
        return state().installed;
    },

    /** Remote audio is playing through it right now. */
    get isPlaying(): boolean {
        return state().playing === true;
    },

    /** The microphone is recording through it right now. */
    get isRecording(): boolean {
        return state().recording === true;
    },

    /** What it runs with; null when not installed. */
    get config(): LivestreamAudioConfig | null {
        return state().config ?? null;
    },

    /** The leveller, which can be switched while playing to compare by ear. */
    get levellerEnabled(): boolean {
        return state().levellerEnabled === true;
    },

    set levellerEnabled(enabled: boolean) {
        WebRTCModule.livestreamAudioSetLevellerEnabled(enabled);
    },

    /**
     * The leveller's peaks since the previous call; null while nothing plays through it, and
     * always on Android, whose effect has no metering.
     */
    takeLevels(): LivestreamAudioLevels | null {
        return WebRTCModule.livestreamAudioTakeLevels();
    }
};

export default livestreamAudio;
