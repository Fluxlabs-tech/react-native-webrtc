import type { LivestreamQuality, LivestreamQualityLimitation, LivestreamStats } from './LivestreamStats';

/** Of a number over time, weighted by how long it held: the middle, and the 95th percentile. */
export type LivestreamPercentiles = { p50: number, p95: number };

export type LivestreamWatchVideoSummary = {
    /** Seconds there was a picture. */
    seconds: number;
    codec: string | null;
    /** The height watched at the middle of the time, and the lowest. */
    medianHeight: number;
    minHeight: number;
    /** While the picture moved. */
    medianFps: number;
    /** Averages over time. */
    kbps: number;
    lossPercent: number;
    droppedPercent: number;
    /** How long frames waited to be shown: how far behind their arrival the picture plays. */
    jitterBufferMs: LivestreamPercentiles;
    /** Short stops: a frame far later than the ones before it. */
    freezes: number;
    /**
     * Long stops: no frames for seconds. Counts a stop the connection ended before the picture
     * moved again, and one still going.
     */
    stalls: number;
    /** How long the picture stood still, freezes and stalls together. */
    stillSeconds: number;
    /** Share of the time with a picture that it stood still. */
    stillPercent: number;
};

export type LivestreamWatchAudioSummary = {
    /** Seconds audio arrived. */
    seconds: number;
    codec: string | null;
    /** Averages over time. */
    kbps: number;
    lossPercent: number;
    /** Share of samples libwebrtc made up for. */
    concealedPercent: number;
    jitterBufferMs: LivestreamPercentiles;
    /** Seconds with gaps a listener hears: 6% of samples or more made up for. */
    gapSeconds: number;
};

/** A whole watch, over every connection it took. */
export type LivestreamWatchSummary = {
    /** Seconds of stats added up: the time connected. */
    seconds: number;
    /** Seconds at each quality. */
    quality: Record<LivestreamQuality, number>;
    /** What held quality back for longest over its poor and bad seconds; `none` when there were none. */
    qualityLimitation: LivestreamQualityLimitation;
    rttMs: LivestreamPercentiles | null;
    /** Some of the time went through a TURN relay. */
    relayed: boolean;
    /** The transport used longest, `udp` or `tcp`; null before there was a route. */
    transport: string | null;
    video: LivestreamWatchVideoSummary | null;
    audio: LivestreamWatchAudioSummary | null;
};

/** Share of samples made up for at which a listener hears gaps: where the quality judgement turns `poor`. */
const AUDIO_GAP_CONCEALED_PERCENT = 6;

/** A number over time, each value weighted by the seconds it held. */
class Distribution {
    private readonly values: number[] = [];
    private readonly weights: number[] = [];
    private total = 0;
    private weighted = 0;

    add(value: number, seconds: number): void {
        if (!(seconds > 0) || !Number.isFinite(value)) {
            return;
        }

        this.values.push(value);
        this.weights.push(seconds);
        this.total += seconds;
        this.weighted += value * seconds;
    }

    get empty(): boolean {
        return this.total === 0;
    }

    mean(): number {
        return this.total > 0 ? this.weighted / this.total : 0;
    }

    min(): number {
        return this.values.reduce((lowest, value) => Math.min(lowest, value), this.values[0] ?? 0);
    }

    /** The value held at or under for `fraction` of the time. */
    percentile(fraction: number): number {
        if (this.total === 0) {
            return 0;
        }

        const order = this.values.map((_, index) => index).sort((a, b) => this.values[a] - this.values[b]);
        const target = fraction * this.total;
        let reached = 0;

        for (const index of order) {
            reached += this.weights[index];

            if (reached >= target) {
                return this.values[index];
            }
        }

        return this.values[order[order.length - 1]];
    }

    percentiles(): LivestreamPercentiles {
        return { p50: this.percentile(0.5), p95: this.percentile(0.95) };
    }
}

/** Seconds by name, for what held longest. */
class Tally<K extends string> {
    private readonly seconds = new Map<K, number>();

    add(key: K, seconds: number): void {
        this.seconds.set(key, (this.seconds.get(key) ?? 0) + seconds);
    }

    longest(): K | null {
        let best: K | null = null;
        let bestSeconds = 0;

        this.seconds.forEach((seconds, key) => {
            if (seconds > bestSeconds) {
                best = key;
                bestSeconds = seconds;
            }
        });

        return best;
    }
}

/**
 * Adds up the stats of a whole watch into one QoE report: how long the picture stood still and how
 * often, the resolution and delay it played at, how the audio held up, and the network under it.
 * One report can follow a watch across reconnects: it takes each interval's numbers, never a
 * connection's running totals, so a new peer connection starting from zero is nothing to it.
 *
 * ```ts
 * const report = new LivestreamWatchReport();
 * const viewer = new WHEPClient({ url, onStats: stats => report.add(stats) });
 * // As the viewer leaves:
 * sendQoe(report.summary());
 * ```
 *
 * For a peer connection set up by hand, add what a `LivestreamStatsSampler` returns, leaving out
 * its first sample, which only sets the baseline.
 */
export default class LivestreamWatchReport {
    private seconds = 0;
    private readonly quality: Record<LivestreamQuality, number> = { excellent: 0, good: 0, poor: 0, bad: 0 };
    private readonly limitations = new Tally<LivestreamQualityLimitation>();
    private readonly rtt = new Distribution();
    private relayed = false;
    private readonly transports = new Tally<string>();

    private videoSeconds = 0;
    private videoCodec: string | null = null;
    private readonly height = new Distribution();
    private readonly fps = new Distribution();
    private readonly videoKbps = new Distribution();
    private readonly videoLoss = new Distribution();
    private readonly dropped = new Distribution();
    private readonly videoBuffer = new Distribution();
    private freezes = 0;
    private stalls = 0;
    private stillSeconds = 0;
    // The intervals of a stop still going: libwebrtc measures a stop once it ends.
    private stopping = 0;

    private audioSeconds = 0;
    private audioCodec: string | null = null;
    private readonly audioKbps = new Distribution();
    private readonly audioLoss = new Distribution();
    private readonly concealed = new Distribution();
    private readonly audioBuffer = new Distribution();
    private audioGapSeconds = 0;

    /** One interval's stats. A sampler's first sample, which covers no interval, is ignored. */
    add(stats: LivestreamStats): void {
        const seconds = stats.intervalSeconds;

        if (!(seconds > 0)) {
            return;
        }

        this.seconds += seconds;
        this.quality[stats.quality] += seconds;

        if ((stats.quality === 'poor' || stats.quality === 'bad') && stats.qualityLimitation !== 'none') {
            this.limitations.add(stats.qualityLimitation, seconds);
        }

        if (stats.rttMs !== null) {
            this.rtt.add(stats.rttMs, seconds);
        }

        if (stats.route) {
            if (stats.route.local === 'relay' || stats.route.remote === 'relay') {
                this.relayed = true;
            }

            this.transports.add(stats.route.protocol, seconds);
        }

        this.addVideo(stats.inbound.video, seconds);
        this.addAudio(stats.inbound.audio, seconds);
    }

    summary(): LivestreamWatchSummary {
        // A stop still going counts as it stands.
        const stalls = this.stalls + (this.stopping > 0 ? 1 : 0);
        const stillSeconds = this.stillSeconds + this.stopping;

        return {
            seconds: this.seconds,
            quality: { ...this.quality },
            qualityLimitation: this.limitations.longest() ?? 'none',
            rttMs: this.rtt.empty ? null : this.rtt.percentiles(),
            relayed: this.relayed,
            transport: this.transports.longest(),
            video: this.videoSeconds > 0 ? {
                seconds: this.videoSeconds,
                codec: this.videoCodec,
                medianHeight: this.height.percentile(0.5),
                minHeight: this.height.min(),
                medianFps: this.fps.percentile(0.5),
                kbps: this.videoKbps.mean(),
                lossPercent: this.videoLoss.mean(),
                droppedPercent: this.dropped.mean(),
                jitterBufferMs: this.videoBuffer.percentiles(),
                freezes: this.freezes,
                stalls,
                stillSeconds,
                stillPercent: Math.min(100, (100 * stillSeconds) / this.videoSeconds)
            } : null,
            audio: this.audioSeconds > 0 ? {
                seconds: this.audioSeconds,
                codec: this.audioCodec,
                kbps: this.audioKbps.mean(),
                lossPercent: this.audioLoss.mean(),
                concealedPercent: this.concealed.mean(),
                jitterBufferMs: this.audioBuffer.percentiles(),
                gapSeconds: this.audioGapSeconds
            } : null
        };
    }

    private addVideo(video: LivestreamStats['inbound']['video'], seconds: number): void {
        const still = video !== null && video.started && video.fps === 0;

        if (video && video.freezesEnded + video.pausesEnded > 0) {
            // The stop running through the intervals before is among these, measured.
            this.freezes += video.freezesEnded;
            this.stalls += video.pausesEnded;
            this.stillSeconds += video.stoppedSeconds;
            this.stopping = 0;
        }

        if (still) {
            this.stopping += seconds;
        } else if (this.stopping > 0) {
            // The picture is back, or a new connection is starting, and the stop never ended: the
            // connection it was on went first. As long as it was sampled.
            this.stalls += 1;
            this.stillSeconds += this.stopping;
            this.stopping = 0;
        }

        if (!video?.started) {
            return;
        }

        this.videoSeconds += seconds;
        this.videoCodec = video.codec ?? this.videoCodec;
        this.height.add(video.height, seconds);
        this.videoKbps.add(video.kbps, seconds);
        this.videoLoss.add(video.lossPercent, seconds);
        this.dropped.add(video.droppedPercent, seconds);

        if (!still) {
            this.fps.add(video.fps, seconds);
            this.videoBuffer.add(video.jitterBufferMs, seconds);
        }
    }

    private addAudio(audio: LivestreamStats['inbound']['audio'], seconds: number): void {
        if (!audio || audio.kbps === 0) {
            return;
        }

        this.audioSeconds += seconds;
        this.audioCodec = audio.codec ?? this.audioCodec;
        this.audioKbps.add(audio.kbps, seconds);
        this.audioLoss.add(audio.lossPercent, seconds);
        this.concealed.add(audio.concealedPercent, seconds);
        this.audioBuffer.add(audio.jitterBufferMs, seconds);

        if (audio.concealedPercent >= AUDIO_GAP_CONCEALED_PERCENT) {
            this.audioGapSeconds += seconds;
        }
    }
}
