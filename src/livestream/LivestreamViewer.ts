import MediaStream from '../MediaStream';
import MediaStreamTrack from '../MediaStreamTrack';
import RTCPeerConnection, { type RTCConfiguration } from '../RTCPeerConnection';

import LivestreamSession, { type LivestreamSessionOptions } from './LivestreamSession';
import { type LivestreamStats, type LivestreamStatsHints } from './LivestreamStats';

export type LivestreamViewerOptions = LivestreamSessionOptions & {
    /**
     * The stream to show in an RTCView, with the tracks received so far: called as each track
     * arrives, and again on every reconnection with a new stream.
     */
    onStream?: (stream: MediaStream) => void;
    /** Receive audio. Default true. */
    audio?: boolean;
    /** Receive video. Default true; false for an audio-only player. */
    video?: boolean;
    /** Reconnect when no media arrives for this long while connected, in ms. Default 6000; 0 is never. */
    stallTimeoutMs?: number;
    /**
     * When this device's network cannot carry the video (packets still lost after resends, or
     * the round trip swelling with queues), carry on with the audio alone, and try the video again
     * now and then until the network can take it: for a stream where the voice matters most, like
     * a host selling. A network that loses packets at random keeps the video, which dropping would
     * not help. Default false.
     */
    audioOnlyFallback?: boolean;
    /** The audio-only fallback dropped the video (true), or brought it back (false). */
    onAudioOnlyChange?: (audioOnly: boolean) => void;
};

/**
 * Peer connection settings for any viewer's connection, which the players apply themselves. For a
 * viewer set up some other way: `new RTCPeerConnection({ ...LIVESTREAM_VIEWER_CONFIGURATION, iceServers })`.
 */
export const LIVESTREAM_VIEWER_CONFIGURATION: RTCConfiguration = {
    // Android's audio jitter buffer holds 50 packets, one second of audio, so the burst after a
    // network stall overflows it and it is flushed: a skip. 200 is libwebrtc's default elsewhere,
    // and the headroom a playout delay needs.
    audioJitterBufferMaxPackets: 200,
    bundlePolicy: 'max-bundle',
    continualGatheringPolicy: 'gather_continually',
    rtcpMuxPolicy: 'require'
};

const DEFAULT_STALL_TIMEOUT_MS = 6000;

/**
 * Samples in a row judged bad, with the network congested, before the video is dropped: about 4 s.
 * Congestion is plain to see, and every second of it breaks up the sound: a quarter of it made up
 * for, with real content, whose bitrate peaks with the picture.
 */
const FALLBACK_AFTER_SAMPLES = 2;

/**
 * The first wait before trying the video again, doubled after each try that fails. Audio alone
 * cannot tell whether the network would carry the video now, so the video is tried: soon, and then
 * less often while it keeps failing, as each try costs a few seconds of choppy sound.
 */
const FIRST_PROBE_DELAY_MS = 15000;
const MAX_PROBE_DELAY_MS = 60000;

/** Samples the video must come back without being judged bad to stay. */
const PROBE_SAMPLES = 4;

/**
 * Signs the stream is more than the network carries, rather than a lossy network, where dropping
 * the video would not save the audio: video packets still lost after resends, or queues building
 * up the round trip.
 */
const CONGESTED_VIDEO_LOSS_PERCENT = 10;
const CONGESTED_RTT_RISE_MS = 300;

/**
 * Audio alone does not show whether the video would fit, but its round trip shows the network
 * changing: down by this much from its usual (median) while audio-only, failed tries included,
 * and back near the best the network has had, the video is tried at once. Only near the best, and
 * leaving out the first samples after the video goes: a round trip falls as well while the queue
 * a failed try left drains, back to what it was.
 */
const IMPROVED_RTT_DROP_MS = 100;
const IMPROVED_RTT_NEAR_BEST_MS = 50;
const AUDIO_ONLY_SETTLE_SAMPLES = 2;
const AUDIO_ONLY_RTT_SAMPLES = 30;

/**
 * What every player does, whatever its signalling: receive, hand over the stream, notice when
 * media stops, and fall back to audio when the network cannot carry the video; with the session's
 * reconnecting, network following and stats. WHEPClient is one; for a server with signalling of
 * its own, subclass it and implement the signalling:
 *
 * - `negotiate(current)`: set up one connection. Create the peer connection with
 *   `createPeerConnection(current)` (and `addReceivers(pc)` if this side offers), exchange the
 *   descriptions, and pass the server's candidates to it. Throwing reconnects; a refusal goes to
 *   `refuse()`, a stream that ended to `reconnect(reason, 'offline')`.
 * - `onLocalCandidate(pc, candidate)`: send this side's candidates.
 * - `setVideoReceiving(receiving)`: stop or resume the video, for the audio-only fallback: by
 *   asking the server, or with `restart()`.
 * - `onTeardown()` and `closeSignalling()`: end a connection's session, and close for good.
 * - `statsHints()`, `onStall()`: optional, for what the server reports.
 */
export default abstract class LivestreamViewer extends LivestreamSession {
    protected readonly viewer: LivestreamViewerOptions;

    private stream: MediaStream | null = null;
    private stalledFor = 0;
    private _audioOnly = false;
    // The fallback leaves video out.
    private videoDropped = false;
    private badSamples = 0;
    // Samples since the video came back on trial; null when not on trial.
    private probeSamples: number | null = null;
    private probeDelayMs = FIRST_PROBE_DELAY_MS;
    private probeTimer: ReturnType<typeof setTimeout> | null = null;
    // The shortest round trip on this network: its round trip without queues.
    private minRttMs: number | null = null;
    // While audio-only: samples since the video last went, and the latest round trips since
    // audio-only began, queues drained.
    private audioOnlySamples = 0;
    private audioOnlyRtts: number[] = [];

    protected constructor(options: LivestreamViewerOptions) {
        super(options);
        this.viewer = options;
    }

    /** Playing the audio alone: the audio-only fallback dropped the video for the network. */
    get audioOnly(): boolean {
        return this._audioOnly;
    }

    start(): void {
        if (!this.active) {
            this.resetFallback();
        }

        super.start();
    }

    stop(): void {
        super.stop();
        this.resetFallback();
    }

    /** Stops or resumes receiving the video: on the connection there is, or the next. */
    protected abstract setVideoReceiving(receiving: boolean): void;

    /** The video is received: asked for, and not dropped for the network. */
    protected get receivesVideo(): boolean {
        return this.viewer.video !== false && !this.videoDropped;
    }

    protected defaultConfiguration(): RTCConfiguration {
        return LIVESTREAM_VIEWER_CONFIGURATION;
    }

    /** Receivers for a connection this side offers. */
    protected addReceivers(pc: RTCPeerConnection): void {
        if (this.viewer.audio !== false) {
            pc.addTransceiver('audio', { direction: 'recvonly' });
        }

        if (this.receivesVideo) {
            pc.addTransceiver('video', { direction: 'recvonly' });
        }
    }

    protected onPeerConnection(pc: RTCPeerConnection): void {
        pc.addEventListener('track', event => {
            if (!this.isCurrent(pc)) {
                return;
            }

            const { streams, track } = event as unknown as { streams: MediaStream[], track: MediaStreamTrack };

            this.stream = streams[0] ?? this.ownStream(track);
            this.viewer.onStream?.(this.stream);
        });
    }

    protected statsHints(): LivestreamStatsHints {
        return { videoPaused: this.videoDropped };
    }

    protected onStatsSample(stats: LivestreamStats): void {
        if (this.checkStall(stats)) {
            return;
        }

        if (this.viewer.audioOnlyFallback && this.viewer.video !== false) {
            this.followQuality(stats);
        }
    }

    protected onTeardown(): void {
        this.stream = null;
        this.stalledFor = 0;
    }

    /** Another network may carry the video: try it now, rather than when the wait runs out. */
    protected onNetworkChange(): void {
        this.minRttMs = null;
        this.audioOnlyRtts = [];

        if (this.videoDropped && this.probeTimer) {
            this.probeDelayMs = FIRST_PROBE_DELAY_MS;
            this.scheduleProbe(0);
        }
    }

    /** How long media has not arrived, in ms, as sampled. */
    protected get stalledMs(): number {
        return this.stalledFor;
    }

    /**
     * No media for `stallTimeoutMs` while connected: the publisher went away, or the server
     * dropped the session without closing it. By default a new connection finds out which.
     */
    protected onStall(): void {
        this.reconnect('no media');
    }

    /** Whether the stall handling took over. */
    private checkStall(stats: LivestreamStats): boolean {
        const timeoutMs = this.viewer.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
        const kbps = (stats.inbound.video?.kbps ?? 0) + (stats.inbound.audio?.kbps ?? 0);

        if (timeoutMs <= 0 || kbps > 0) {
            this.stalledFor = 0;

            return false;
        }

        this.stalledFor += stats.intervalSeconds * 1000;

        if (this.stalledFor < timeoutMs) {
            return false;
        }

        this.onStall();

        return true;
    }

    private followQuality(stats: LivestreamStats): void {
        if (stats.rttMs !== null) {
            this.minRttMs = Math.min(this.minRttMs ?? stats.rttMs, stats.rttMs);
        }

        const congested = (stats.inbound.video?.lossPercent ?? 0) >= CONGESTED_VIDEO_LOSS_PERCENT
            || (stats.rttMs !== null && this.minRttMs !== null && stats.rttMs >= this.minRttMs + CONGESTED_RTT_RISE_MS);
        const bad = stats.quality === 'bad' && stats.qualityLimitation === 'network' && congested;

        if (this.probeSamples !== null) {
            // The video is back on trial, and fails at the first sign of congestion: every second
            // of it breaks up the sound. Not at a frozen picture: the first frames wait for a
            // keyframe, and a new connection's quality is not judged at first.
            this.probeSamples++;

            if (congested) {
                this.probeDelayMs = Math.min(MAX_PROBE_DELAY_MS, this.probeDelayMs * 2);
                this.probeSamples = null;
                this.dropVideo();
            } else if (this.probeSamples >= PROBE_SAMPLES) {
                this.probeDelayMs = FIRST_PROBE_DELAY_MS;
                this.probeSamples = null;
                this.audioOnlyRtts = [];
                this.setAudioOnly(false);
            }

            return;
        }

        if (this.videoDropped) {
            this.watchForBetterNetwork(stats);

            return;
        }

        this.badSamples = bad ? this.badSamples + 1 : 0;

        if (this.badSamples >= FALLBACK_AFTER_SAMPLES) {
            this.dropVideo();
            this.setAudioOnly(true);
        }
    }

    /** While audio-only: tries the video at once when the round trip shows the network got better. */
    private watchForBetterNetwork(stats: LivestreamStats): void {
        if (stats.rttMs === null || !this.probeTimer || ++this.audioOnlySamples <= AUDIO_ONLY_SETTLE_SAMPLES) {
            return;
        }

        const rtts = [ ...this.audioOnlyRtts ].sort((a, b) => a - b);
        const usual = rtts.length > 0 ? rtts[Math.floor(rtts.length / 2)] : null;
        const nearBest = this.minRttMs !== null && stats.rttMs <= this.minRttMs + IMPROVED_RTT_NEAR_BEST_MS;

        if (nearBest && usual !== null && stats.rttMs <= usual - IMPROVED_RTT_DROP_MS) {
            this.scheduleProbe(0);
        }

        this.audioOnlyRtts.push(stats.rttMs);

        if (this.audioOnlyRtts.length > AUDIO_ONLY_RTT_SAMPLES) {
            this.audioOnlyRtts.shift();
        }
    }

    /** Leaves the video out, and tries it again after a while. */
    private dropVideo(): void {
        this.badSamples = 0;
        this.audioOnlySamples = 0;
        this.videoDropped = true;
        this.setVideoReceiving(false);
        this.scheduleProbe(this.probeDelayMs);
    }

    private scheduleProbe(delayMs: number): void {
        this.clearProbe();
        this.probeTimer = setTimeout(() => {
            this.probeTimer = null;

            if (!this.active) {
                return;
            }

            // Still audio-only to the app until the video proves it can stay.
            this.videoDropped = false;
            this.probeSamples = 0;
            this.setVideoReceiving(true);
        }, delayMs);
    }

    private setAudioOnly(audioOnly: boolean): void {
        if (this._audioOnly !== audioOnly) {
            this._audioOnly = audioOnly;
            this.viewer.onAudioOnlyChange?.(audioOnly);
        }
    }

    private resetFallback(): void {
        this.clearProbe();
        this.minRttMs = null;
        this.audioOnlyRtts = [];
        this._audioOnly = false;
        this.videoDropped = false;
        this.badSamples = 0;
        this.probeSamples = null;
        this.probeDelayMs = FIRST_PROBE_DELAY_MS;
    }

    private clearProbe(): void {
        if (this.probeTimer) {
            clearTimeout(this.probeTimer);
            this.probeTimer = null;
        }
    }

    /** A stream for tracks a server sent without one (no msid), collecting them as they arrive. */
    private ownStream(track: MediaStreamTrack): MediaStream {
        if (!this.stream) {
            return new MediaStream([ track ]);
        }

        this.stream.addTrack(track);

        return this.stream;
    }
}
