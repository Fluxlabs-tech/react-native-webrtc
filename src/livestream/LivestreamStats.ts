import RTCPeerConnection from '../RTCPeerConnection';

export type InboundVideoStats = {
    codec: string | null;
    width: number;
    height: number;
    /** Frames decoded per second over the interval. */
    fps: number;
    kbps: number;
    /** Share of packets lost over the interval, resends that arrived in time not counted. */
    lossPercent: number;
    /** Average time a frame waited in the jitter buffer over the interval: the buffer the stream plays with. */
    jitterBufferMs: number;
    /** Share of the interval the picture stood still, once it had started. */
    frozenPercent: number;
    /** Since the connection started. */
    freezeCount: number;
    freezeSeconds: number;
    framesDropped: number;
    nackCount: number;
    pliCount: number;
};

export type InboundAudioStats = {
    codec: string | null;
    kbps: number;
    lossPercent: number;
    jitterBufferMs: number;
    /** Share of samples libwebrtc had to make up for over the interval: lost packets or underruns. */
    concealedPercent: number;
    /** Level of the audio received, from 0 to 1. */
    level: number;
};

export type OutboundVideoStats = {
    codec: string | null;
    /** Of the largest layer being sent. */
    width: number;
    height: number;
    fps: number;
    /** All layers together. */
    kbps: number;
    /** What is holding the video back, if anything. */
    qualityLimitationReason: 'none' | 'cpu' | 'bandwidth' | 'other';
    /** Share of packets the server reports lost. */
    remoteLossPercent: number;
    nackCount: number;
    pliCount: number;
};

export type OutboundAudioStats = {
    codec: string | null;
    kbps: number;
    remoteLossPercent: number;
};

/**
 * How watching, or sending, is going:
 *
 * - `excellent`: nothing to notice.
 * - `good`: small blemishes: a late frame now and then, packets resent.
 * - `poor`: noticeable: stutter, a softer picture, the odd gap in the audio.
 * - `bad`: hard to follow: long freezes, broken-up audio.
 */
export type LivestreamQuality = 'excellent' | 'good' | 'poor' | 'bad';

/**
 * What holds quality back:
 *
 * - `network`: this device's connection: loss, delay, or less bandwidth than the stream needs.
 * - `source`: the stream itself: frames arrive few and far between with nothing lost on the way,
 *   so the host's connection or device is struggling, or the server's.
 * - `device`: this device: frames dropped in decoding, or the encoder held back by the CPU.
 * - `none`: nothing.
 */
export type LivestreamQualityLimitation = 'none' | 'network' | 'source' | 'device';

export type LivestreamStats = {
    /** Seconds the numbers cover. 0 for a sampler's first sample, which only sets the baseline. */
    intervalSeconds: number;
    /**
     * Over the last few intervals: it worsens at once and recovers once they have all been
     * better, so it does not flicker.
     */
    quality: LivestreamQuality;
    qualityLimitation: LivestreamQualityLimitation;
    rttMs: number | null;
    /** The bandwidth estimate for sending, when sending. */
    availableOutgoingKbps: number | null;
    /**
     * The bandwidth estimate for receiving, when there is one: libwebrtc has one only for servers
     * that use REMB, and a player can pass on a server's own (see LivestreamStatsHints).
     */
    availableIncomingKbps: number | null;
    /** The ICE route in use: candidate types (`host`, `srflx`, `prflx`, `relay`) and protocol. */
    route: { local: string, remote: string, protocol: string } | null;
    inbound: { video: InboundVideoStats | null, audio: InboundAudioStats | null };
    outbound: { video: OutboundVideoStats | null, audio: OutboundAudioStats | null };
};

/** What a sample cannot see in the peer connection's stats. */
export type LivestreamStatsHints = {
    /** The server's estimate of the bandwidth for receiving, in kbps. */
    availableIncomingKbps?: number | null;
    /** Video is paused on purpose, as by an audio-only fallback: no frames is not a freeze. */
    videoPaused?: boolean;
};

type Report = Record<string, any>;

type Snapshot = { time: number, byId: Map<string, Report> };

/** The numbers quality is judged on, beyond those in the stats. */
type Signals = {
    receivingKbps: number;
    /** The worse of audio and video. */
    lossPercent: number;
    /** Interarrival jitter of the audio, in ms. */
    audioJitterMs: number;
    /**
     * Nothing at all came over the connection, not even RTCP: this device's network is down. A
     * stream that stalls at the source still has the server's reports coming.
     */
    linkQuiet: boolean;
    concealedPercent: number | null;
    /** Received video judged by its frames: started, and not paused. */
    videoJudged: boolean;
    videoFps: number;
    videoFrozenPercent: number;
    /** Share of received frames dropped before display: decoding that cannot keep up. */
    videoDroppedPercent: number;
    /** Frames sent per second, when sending video. */
    sentFps: number | null;
};

type Assessment = { level: number, limitation: LivestreamQualityLimitation };

const QUALITIES: LivestreamQuality[] = [ 'excellent', 'good', 'poor', 'bad' ];

/** Intervals quality is judged over: it recovers only once they have all been better. */
const QUALITY_WINDOW = 3;

/**
 * Intervals at the start not judged: audio is made up for until the jitter buffer fills, and
 * video waits for a keyframe, on the best of connections.
 */
const WARM_UP_INTERVALS = 2;

/**
 * Samples a peer connection's stats and turns libwebrtc's running totals into numbers over the
 * interval since the previous sample: what a quality overlay or a QoE report shows, for a viewer
 * (inbound) or a host (outbound), with a judgement of the quality and what limits it.
 *
 * Livestream sessions sample for themselves (see `onStats`); this is for a peer connection set up
 * some other way:
 *
 * ```ts
 * const sampler = new LivestreamStatsSampler(pc);
 * const timer = setInterval(async () => setStats(await sampler.sample()), 2000);
 * ```
 */
export default class LivestreamStatsSampler {
    private readonly pc: RTCPeerConnection;
    private previous: Snapshot | null = null;
    private readonly assessments: Assessment[] = [];
    // The stream's frame rate, as the highest seen over two intervals running (the burst after a
    // stall runs faster for one): a drop from it is lost smoothness, whoever's the fault.
    private peakFps = 0;
    private lastFps = 0;
    private intervals = 0;
    // A frame has been decoded since video last started or resumed; until then there is no
    // picture to freeze.
    private videoStarted = false;

    constructor(pc: RTCPeerConnection) {
        this.pc = pc;
    }

    async sample(hints: LivestreamStatsHints = {}): Promise<LivestreamStats> {
        const report = await this.pc.getStats();
        const byId = new Map<string, Report>();

        report.forEach((entry: any) => {
            byId.set(entry.id, entry);
        });

        const current = { time: Date.now(), byId };
        const previous = this.previous;

        this.previous = current;

        const { stats, signals, framesDecoded } = summarize(current, previous, hints);

        if (hints.videoPaused) {
            this.videoStarted = false;
        } else if (framesDecoded > 0) {
            this.videoStarted = true;
        }

        signals.videoJudged = signals.videoJudged && this.videoStarted;

        if (previous && ++this.intervals > WARM_UP_INTERVALS) {
            const expectedFps = this.expectedFps(signals);

            this.assessments.push(assess(stats, signals, expectedFps));

            if (this.assessments.length > QUALITY_WINDOW) {
                this.assessments.shift();
            }
        }

        // The worst of the window, and the latest reason for it.
        const worst = this.assessments.reduce<Assessment>(
            (acc, assessment) => (assessment.level >= acc.level ? assessment : acc),
            { level: 0, limitation: 'none' }
        );

        return { ...stats, quality: QUALITIES[worst.level], qualityLimitation: worst.limitation };
    }

    /** The frame rate the stream has: the highest seen, 0 when there is no video to judge. */
    private expectedFps(signals: Signals): number {
        const fps = signals.videoJudged ? signals.videoFps : signals.sentFps;

        if (fps === null) {
            return 0;
        }

        this.peakFps = Math.max(this.peakFps, Math.min(fps, this.lastFps));
        this.lastFps = fps;

        return this.peakFps || fps;
    }
}

function summarize(
    current: Snapshot,
    previous: Snapshot | null,
    hints: LivestreamStatsHints
): { stats: Omit<LivestreamStats, 'quality' | 'qualityLimitation'>, signals: Signals, framesDecoded: number } {
    const seconds = previous ? Math.max((current.time - previous.time) / 1000, 0.001) : 0;
    const entries = [ ...current.byId.values() ];
    const before = (entry: Report) => previous?.byId.get(entry.id) ?? {};
    const delta = (entry: Report, field: string) => (entry[field] ?? 0) - (before(entry)[field] ?? 0);
    const kbps = (entry: Report, field: string) => (seconds > 0 ? (delta(entry, field) * 8) / seconds / 1000 : 0);

    const codec = (entry: Report) => {
        const mimeType: string | undefined = current.byId.get(entry.codecId)?.mimeType;

        return mimeType ? mimeType.replace(/^\w+\//, '') : null;
    };

    const bufferMs = (entry: Report) => {
        const emitted = delta(entry, 'jitterBufferEmittedCount');

        return emitted > 0 ? (delta(entry, 'jitterBufferDelay') / emitted) * 1000 : 0;
    };

    const lossPercent = (entry: Report) => {
        const lost = delta(entry, 'packetsLost');
        const total = lost + delta(entry, 'packetsReceived');

        return total > 0 ? Math.max(0, (100 * lost) / total) : 0;
    };

    const remoteLoss = (outbound: Report) => {
        const remote = entries.find(entry => entry.type === 'remote-inbound-rtp' && entry.localId === outbound.id);

        return remote?.fractionLost !== undefined ? remote.fractionLost * 100 : 0;
    };

    // A receiver that never got a packet: the server has no such track (an RTMP source's AAC audio,
    // which a server that does not transcode cannot send over WebRTC, say).
    const receiving = (entry: Report) => entry.type === 'inbound-rtp' && (entry.packetsReceived ?? 0) > 0;
    const inboundVideo = entries.find(entry => receiving(entry) && entry.kind === 'video');
    const inboundAudio = entries.find(entry => receiving(entry) && entry.kind === 'audio');
    const outboundVideo = entries.filter(entry => entry.type === 'outbound-rtp' && entry.kind === 'video');
    const outboundAudio = entries.find(entry => entry.type === 'outbound-rtp' && entry.kind === 'audio');

    // The largest layer being sent, for a simulcast sender.
    const largest = outboundVideo.reduce<Report | undefined>(
        (best, entry) => ((entry.frameWidth ?? 0) > (best?.frameWidth ?? -1) ? entry : best),
        undefined
    );

    const transport = entries.find(entry => entry.type === 'transport' && entry.selectedCandidatePairId);
    const pair = transport
        ? current.byId.get(transport.selectedCandidatePairId)
        : entries.find(entry => entry.type === 'candidate-pair' && entry.nominated && entry.state === 'succeeded');
    const local = pair ? current.byId.get(pair.localCandidateId) : undefined;
    const remote = pair ? current.byId.get(pair.remoteCandidateId) : undefined;

    let video: InboundVideoStats | null = null;
    let decodedInInterval = 0;
    let droppedPercent = 0;

    if (inboundVideo) {
        const decoded = delta(inboundVideo, 'framesDecoded');
        const received = delta(inboundVideo, 'framesReceived');
        const fps = seconds > 0 ? decoded / seconds : inboundVideo.framesPerSecond ?? 0;
        const frozenSeconds = delta(inboundVideo, 'totalFreezesDuration');

        // A freeze counts once it ends; one still going shows as no frames at all.
        const frozenPercent = seconds > 0 && !hints.videoPaused
            ? Math.min(100, decoded === 0 ? 100 : (100 * frozenSeconds) / seconds)
            : 0;

        decodedInInterval = previous ? decoded : inboundVideo.framesDecoded ?? 0;
        droppedPercent = received > 0 ? Math.max(0, (100 * delta(inboundVideo, 'framesDropped')) / received) : 0;
        video = {
            codec: codec(inboundVideo),
            width: inboundVideo.frameWidth ?? 0,
            height: inboundVideo.frameHeight ?? 0,
            fps,
            kbps: kbps(inboundVideo, 'bytesReceived'),
            lossPercent: lossPercent(inboundVideo),
            jitterBufferMs: bufferMs(inboundVideo),
            frozenPercent,
            freezeCount: inboundVideo.freezeCount ?? 0,
            freezeSeconds: inboundVideo.totalFreezesDuration ?? 0,
            framesDropped: inboundVideo.framesDropped ?? 0,
            nackCount: inboundVideo.nackCount ?? 0,
            pliCount: inboundVideo.pliCount ?? 0
        };
    }

    const audio: InboundAudioStats | null = inboundAudio ? {
        codec: codec(inboundAudio),
        kbps: kbps(inboundAudio, 'bytesReceived'),
        lossPercent: lossPercent(inboundAudio),
        jitterBufferMs: bufferMs(inboundAudio),
        concealedPercent: delta(inboundAudio, 'totalSamplesReceived') > 0
            ? (100 * delta(inboundAudio, 'concealedSamples')) / delta(inboundAudio, 'totalSamplesReceived')
            : 0,
        level: inboundAudio.audioLevel ?? 0
    } : null;

    const stats = {
        intervalSeconds: seconds,
        rttMs: pair?.currentRoundTripTime !== undefined ? pair.currentRoundTripTime * 1000 : null,
        availableOutgoingKbps: pair?.availableOutgoingBitrate !== undefined
            ? pair.availableOutgoingBitrate / 1000
            : null,
        availableIncomingKbps: pair?.availableIncomingBitrate !== undefined
            ? pair.availableIncomingBitrate / 1000
            : hints.availableIncomingKbps ?? null,
        route: local && remote ? {
            local: local.candidateType,
            remote: remote.candidateType,
            protocol: local.relayProtocol ?? local.protocol
        } : null,
        inbound: { video, audio },
        outbound: {
            video: largest ? {
                codec: codec(largest),
                width: largest.frameWidth ?? 0,
                height: largest.frameHeight ?? 0,
                fps: largest.framesPerSecond ?? 0,
                kbps: outboundVideo.reduce((sum, entry) => sum + kbps(entry, 'bytesSent'), 0),
                qualityLimitationReason: largest.qualityLimitationReason ?? 'none',
                remoteLossPercent: remoteLoss(largest),
                nackCount: outboundVideo.reduce((sum, entry) => sum + (entry.nackCount ?? 0), 0),
                pliCount: outboundVideo.reduce((sum, entry) => sum + (entry.pliCount ?? 0), 0)
            } : null,
            audio: outboundAudio ? {
                codec: codec(outboundAudio),
                kbps: kbps(outboundAudio, 'bytesSent'),
                remoteLossPercent: remoteLoss(outboundAudio)
            } : null
        }
    };

    const signals: Signals = {
        receivingKbps: (video?.kbps ?? 0) + (audio?.kbps ?? 0),
        lossPercent: Math.max(video?.lossPercent ?? 0, audio?.lossPercent ?? 0),
        audioJitterMs: (inboundAudio?.jitter ?? 0) * 1000,
        linkQuiet: previous !== null && pair !== undefined && delta(pair, 'bytesReceived') === 0,
        concealedPercent: audio ? audio.concealedPercent : null,
        videoJudged: video !== null && !hints.videoPaused,
        videoFps: video?.fps ?? 0,
        videoFrozenPercent: video?.frozenPercent ?? 0,
        videoDroppedPercent: droppedPercent,
        sentFps: largest ? largest.framesPerSecond ?? 0 : null
    };

    return { stats, signals, framesDecoded: decodedInInterval };
}

/** 0 to 3 (excellent to bad): how far `value` has gone past each threshold, lowest first. */
function grade(value: number, thresholds: [ number, number, number ]): number {
    return thresholds.filter(threshold => value >= threshold).length;
}

/** Tracks the worst level noted, and what caused it. */
class Judgement implements Assessment {
    level = 0;
    limitation: LivestreamQualityLimitation = 'none';

    note(level: number, limitation: LivestreamQualityLimitation): void {
        if (level > this.level) {
            this.level = level;
            this.limitation = limitation;
        }
    }
}

function assess(
    stats: Omit<LivestreamStats, 'quality' | 'qualityLimitation'>,
    signals: Signals,
    expectedFps: number
): Assessment {
    const judgement = new Judgement();
    const rtt = stats.rttMs ?? 0;

    // Judged by what the viewer gets, not by bandwidth estimates: those swing by half with nothing
    // wrong, and a stream the connection cannot carry shows soon enough as loss and delay.
    if (stats.inbound.video || stats.inbound.audio) {
        // Packets lost for good, and round trips too long for resends to arrive in time: this
        // device's network.
        judgement.note(grade(signals.lossPercent, [ 1, 5, 15 ]), 'network');
        judgement.note(grade(rtt, [ 350, 700, 1500 ]), 'network');

        // With nothing wrong on the way, missing audio and frames are missing from the stream.
        const network = signals.linkQuiet || signals.lossPercent >= 0.5 || rtt >= 350 || signals.audioJitterMs >= 30;
        const cause = network ? 'network' : 'source';

        if (signals.concealedPercent !== null) {
            judgement.note(grade(signals.concealedPercent, [ 2, 6, 20 ]), cause);
        }

        if (signals.videoJudged) {
            const missing = expectedFps > 0 ? 1 - signals.videoFps / expectedFps : 0;
            const videoCause = signals.videoDroppedPercent >= 10 ? 'device' : cause;

            judgement.note(grade(signals.videoFrozenPercent, [ 1, 10, 40 ]), videoCause);
            judgement.note(grade(missing, [ 0.15, 0.4, 0.75 ]), videoCause);
        }

        return judgement;
    }

    const video = stats.outbound.video;
    const audio = stats.outbound.audio;

    if (!video && !audio) {
        return judgement;
    }

    const remoteLossPercent = Math.max(video?.remoteLossPercent ?? 0, audio?.remoteLossPercent ?? 0);

    judgement.note(grade(remoteLossPercent, [ 1, 5, 15 ]), 'network');
    judgement.note(grade(rtt, [ 350, 700, 1500 ]), 'network');

    if (stats.availableOutgoingKbps !== null) {
        judgement.note(grade(-stats.availableOutgoingKbps, [ -1000, -600, -300 ]), 'network');
    }

    if (video) {
        const limited = video.qualityLimitationReason === 'cpu' ? 'device' : 'network';
        const missing = expectedFps > 0 ? 1 - video.fps / expectedFps : 0;

        if (video.qualityLimitationReason === 'bandwidth' || video.qualityLimitationReason === 'cpu') {
            judgement.note(1, limited);
        }

        judgement.note(grade(missing, [ 0.15, 0.4, 0.75 ]), limited);
    }

    return judgement;
}
