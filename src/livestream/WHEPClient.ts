import RTCIceCandidate from '../RTCIceCandidate';
import RTCPeerConnection from '../RTCPeerConnection';

import LivestreamViewer, { type LivestreamViewerOptions } from './LivestreamViewer';
import HttpSignalling, { defaultRefusal, type HttpSignallingOptions } from './http';
import { addOpusNack, setOpusParameters } from './sdp';

export type WHEPClientOptions = LivestreamViewerOptions & HttpSignallingOptions;

/**
 * Plays a livestream from a WHEP endpoint (the IETF's WebRTC playback protocol, which mediamtx,
 * SRS, OvenMediaEngine, Janus, Cloudflare Stream, Dolby/Millicast, Wowza and Red5 speak). For a
 * server that plays over signalling of its own, see LivestreamViewer.
 *
 * It takes the stream as the server has it, however it was published: WHIP from this library,
 * RTMP or SRT from an encoder, H.264 or VP8, mono or stereo, with or without audio. So it offers
 * every codec libwebrtc decodes, asks for stereo Opus (mono plays as mono), and offers to have
 * lost audio resent. And it never relies on the publisher for a keyframe: a server cannot ask an
 * RTMP encoder for one, so a lost frame is recovered by resending, with the playout delay giving
 * the resend time to arrive.
 *
 * ```ts
 * const player = new WHEPClient({
 *     url: 'https://media.example.com/live/show/whep',
 *     onStream: stream => setStreamURL(stream.toURL()),
 *     onStateChange: (state, reason) => setStatus(state),
 *     onStats: stats => setQuality(stats.quality),
 * });
 * player.start();
 * // …
 * player.stop();
 * ```
 */
export default class WHEPClient extends LivestreamViewer {
    private readonly http: HttpSignalling;

    constructor(options: WHEPClientOptions) {
        super(options);
        this.http = new HttpSignalling(options, 'WHEP');
    }

    protected get protocol(): string {
        return 'WHEP';
    }

    protected async negotiate(current: () => boolean): Promise<void> {
        const pc = this.createPeerConnection(current);

        this.addReceivers(pc);

        const refusal = await this.http.negotiate(pc, current, {
            // stereo=1 in the offer is what asks for stereo; the playout path is stereo on both platforms.
            offer: sdp => addOpusNack(setOpusParameters(sdp, { stereo: 1 }))
        });

        if (refusal && current()) {
            // 404: nobody publishing at the URL yet. 409: the stream is between publishers.
            const offline = refusal.status === 404 || refusal.status === 409;

            this.refuse(offline ? 'offline' : defaultRefusal(refusal.status), refusal.reason);
        }
    }

    protected onLocalCandidate(pc: RTCPeerConnection, candidate: RTCIceCandidate): void {
        this.http.addCandidate(pc, candidate);
    }

    protected onTeardown(): void {
        super.onTeardown();
        this.http.close();
    }

    /** WHEP cannot change a session's media: a new session, with or without the video. */
    protected setVideoReceiving(receiving: boolean): void {
        this.restart(receiving ? 'trying the video again' : 'audio only');
    }
}
