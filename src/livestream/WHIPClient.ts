import MediaStream from '../MediaStream';
import RTCIceCandidate from '../RTCIceCandidate';
import RTCPeerConnection from '../RTCPeerConnection';
import RTCRtpSender from '../RTCRtpSender';

import LivestreamSession, { type LivestreamSessionOptions } from './LivestreamSession';
import {
    type LivestreamPublishOptions,
    addLivestreamTracks,
    applyLivestreamSenderParameters,
    tuneLivestreamAnswer,
    tuneLivestreamOffer
} from './host';
import HttpSignalling, { defaultRefusal, type HttpSignallingOptions } from './http';

export type WHIPClientOptions = LivestreamSessionOptions & HttpSignallingOptions & LivestreamPublishOptions & {
    /** What to publish: the camera and microphone from getUserMedia. The app keeps owning it. */
    stream: MediaStream;
};

/**
 * Publishes a livestream to a WHIP endpoint (RFC 9725): what a host goes live with.
 *
 * Tuned for broadcast rather than calls: hardware H.264, a higher starting bitrate, Opus at a
 * music-capable bitrate without discontinuous transmission, and frames rotated before encoding,
 * so the stream plays upright in any player, HLS and RTMP outputs included. For the microphone,
 * see LIVESTREAM_HOST_AUDIO_CONSTRAINTS; for other signalling, addLivestreamTracks.
 *
 * Viewers need nothing from it: the players play a stream published this way or any other.
 *
 * ```ts
 * const stream = await mediaDevices.getUserMedia({
 *     audio: LIVESTREAM_HOST_AUDIO_CONSTRAINTS.voice,
 *     video: { facingMode: 'user', width: 1280, height: 720, frameRate: 30 },
 * });
 * const publisher = new WHIPClient({ url, token, stream, onStateChange: setStatus });
 * publisher.start();
 * ```
 */
export default class WHIPClient extends LivestreamSession {
    private readonly host: WHIPClientOptions;
    private readonly http: HttpSignalling;
    private videoSender: RTCRtpSender | null = null;

    constructor(options: WHIPClientOptions) {
        super(options);
        this.host = options;
        this.http = new HttpSignalling(options, 'WHIP');
    }

    protected get protocol(): string {
        return 'WHIP';
    }

    protected async negotiate(current: () => boolean): Promise<void> {
        const pc = this.createPeerConnection(current);

        this.videoSender = addLivestreamTracks(pc, this.host.stream, this.host).videoSender;

        const refusal = await this.http.negotiate(pc, current, {
            offer: tuneLivestreamOffer,
            answer: sdp => tuneLivestreamAnswer(sdp, this.host)
        });

        if (refusal && current()) {
            // 404: no such endpoint. 409: still publishing from the session this one replaces,
            // which the server times out: retried.
            this.refuse(refusal.status === 404 ? 'failed' : defaultRefusal(refusal.status), refusal.reason);
        }
    }

    protected onLocalCandidate(pc: RTCPeerConnection, candidate: RTCIceCandidate): void {
        this.http.addCandidate(pc, candidate);
    }

    protected onConnected(): void {
        if (this.videoSender) {
            applyLivestreamSenderParameters(this.videoSender, this.host).catch(() => undefined);
        }
    }

    protected onTeardown(): void {
        this.videoSender = null;
        this.http.close();
    }
}
