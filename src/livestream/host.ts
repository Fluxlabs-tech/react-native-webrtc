import { MediaTrackConstraints } from '../Constraints';
import MediaStream from '../MediaStream';
import RTCPeerConnection from '../RTCPeerConnection';
import RTCRtpSender from '../RTCRtpSender';
import RTCRtpTransceiver from '../RTCRtpTransceiver';

import { removeHeaderExtension, setOpusParameters, setVideoParameters } from './sdp';

/**
 * Microphone constraints for a host going live, for `getUserMedia({ audio })`.
 *
 * Echo cancellation is off in both: it exists for calls, where the other side's voice comes out
 * of the loudspeaker, and it colours a voice that has nothing to cancel.
 *
 * - `voice`: noise suppression and automatic gain control, for a host talking in a shop, a market
 *   or the street.
 * - `studio`: no processing at all, for music, or a good microphone in a quiet room.
 */
export const LIVESTREAM_HOST_AUDIO_CONSTRAINTS: Record<'voice' | 'studio', MediaTrackConstraints> = {
    voice: {
        autoGainControl: true,
        echoCancellation: false,
        noiseSuppression: true
    },
    studio: {
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false,
        // libwebrtc's own: keeps the low end a studio microphone picks up.
        googHighpassFilter: false
    } as MediaTrackConstraints
};

export type LivestreamVideoCodec = 'H264' | 'VP8' | 'VP9' | 'AV1';

export type LivestreamVideoOptions = {
    /**
     * The codec to send. Default H264, in packetization mode 1, Constrained Baseline preferred:
     * phones encode it in hardware, so an hour-long stream does not heat the phone, every decoder
     * plays it, and RTMP and HLS outputs carry it without transcoding.
     *
     * Offered alone: servers choose by their own preference rather than the offer's order, so
     * offering others lets the server pick one of them. `null` offers every codec libwebrtc has,
     * for the server to choose.
     */
    codec?: LivestreamVideoCodec | null;
    /** Default 2500, for 720p. */
    maxBitrateKbps?: number;
    /**
     * The bitrate to start at, ramping up from there as bandwidth allows. libwebrtc starts at 300,
     * a blurry first few seconds. Default 1000.
     */
    startBitrateKbps?: number;
    /** Default 30. */
    maxFramerate?: number;
    /**
     * What gives when bandwidth or the CPU cannot keep up: frame rate (`maintain-resolution`),
     * resolution (`maintain-framerate`), or some of each. Default `balanced`.
     */
    degradationPreference?: 'balanced' | 'maintain-framerate' | 'maintain-resolution';
    /**
     * Send the video at full, half and quarter resolution, for a server that forwards each viewer
     * the one its network can take. Only for servers that support simulcast. Default false.
     */
    simulcast?: boolean;
};

export type LivestreamAudioOptions = {
    /** Opus bitrate. Default 64: clear speech with room for music. */
    maxBitrateKbps?: number;
    /** Send stereo, from a stereo source. Default false. */
    stereo?: boolean;
    /** Send nothing through silence. Saves bandwidth, but background sound cuts in and out. Default false. */
    dtx?: boolean;
};

export type LivestreamPublishOptions = {
    video?: LivestreamVideoOptions;
    audio?: LivestreamAudioOptions;
};

const DEFAULT_VIDEO: Required<Omit<LivestreamVideoOptions, 'simulcast'>> = {
    codec: 'H264',
    maxBitrateKbps: 2500,
    startBitrateKbps: 1000,
    maxFramerate: 30,
    degradationPreference: 'balanced'
};
const DEFAULT_AUDIO_KBPS = 64;

/** Video orientation as an RTP header extension, rather than applied to the frames. */
const VIDEO_ORIENTATION_URI = 'urn:3gpp:video-orientation';

function videoOptions(options: LivestreamPublishOptions) {
    return { ...DEFAULT_VIDEO, ...options.video };
}

/**
 * The tuning WHIPClient publishes with, for a host on any other signalling (a server's own
 * WebSocket protocol, say):
 *
 *   1. `addLivestreamTracks(pc, stream, options)` before creating the offer
 *   2. `tuneLivestreamOffer(offer.sdp)` before setting it
 *   3. `tuneLivestreamAnswer(answer.sdp, options)` before setting the server's answer
 *   4. `applyLivestreamSenderParameters(videoSender, options)` once connected
 *
 * Adds the stream's tracks send-only, video with the preferred codec first and the bitrate and
 * frame rate caps. Returns the video sender, for step 4.
 */
export function addLivestreamTracks(
    pc: RTCPeerConnection,
    stream: MediaStream,
    options: LivestreamPublishOptions = {}
): { videoSender: RTCRtpSender | null } {
    const video = videoOptions(options);
    const audioKbps = options.audio?.maxBitrateKbps ?? DEFAULT_AUDIO_KBPS;
    let videoSender: RTCRtpSender | null = null;

    for (const track of stream.getTracks()) {
        if (track.kind === 'video') {
            const transceiver = pc.addTransceiver(track, {
                direction: 'sendonly',
                streams: [ stream ],
                sendEncodings: videoEncodings(video)
            });

            restrictCodec(transceiver, video.codec);
            videoSender = transceiver.sender;
        } else {
            pc.addTransceiver(track, {
                direction: 'sendonly',
                streams: [ stream ],
                sendEncodings: [ { active: true, maxBitrate: audioKbps * 1000 } ]
            });
        }
    }

    return { videoSender };
}

/**
 * The offer a host sends. Leaves out video orientation as a header extension, so frames are
 * rotated before encoding and the stream plays upright in any player, HLS and RTMP outputs
 * included, not only in WebRTC ones.
 */
export function tuneLivestreamOffer(sdp: string): string {
    return removeHeaderExtension(sdp, VIDEO_ORIENTATION_URI);
}

/**
 * The answer a host is given: the encoders follow its parameters. Opus at a music-capable bitrate
 * without discontinuous transmission, and video starting at `startBitrateKbps`.
 */
export function tuneLivestreamAnswer(sdp: string, options: LivestreamPublishOptions = {}): string {
    const audio = options.audio ?? {};
    const stereo = audio.stereo ? 1 : 0;

    return setVideoParameters(
        setOpusParameters(sdp, {
            maxaveragebitrate: (audio.maxBitrateKbps ?? DEFAULT_AUDIO_KBPS) * 1000,
            stereo,
            'sprop-stereo': stereo,
            usedtx: audio.dtx ? 1 : 0,
            useinbandfec: 1
        }),
        { 'x-google-start-bitrate': videoOptions(options).startBitrateKbps }
    );
}

/** Sets what gives when the video cannot keep up, once the sender is negotiated. */
export async function applyLivestreamSenderParameters(
    videoSender: RTCRtpSender,
    options: LivestreamPublishOptions = {}
): Promise<void> {
    const parameters = videoSender.getParameters();
    const preference = videoOptions(options).degradationPreference;

    if (parameters.degradationPreference === preference) {
        return;
    }

    parameters.degradationPreference = preference;
    await videoSender.setParameters(parameters);
}

function videoEncodings(video: ReturnType<typeof videoOptions>) {
    const { maxBitrateKbps, maxFramerate, simulcast } = video;
    const full = { active: true, maxBitrate: maxBitrateKbps * 1000, maxFramerate };

    if (!simulcast) {
        return [ full ];
    }

    // Lowest first, as simulcast layers are listed.
    return [
        { ...full, rid: 'q', scaleResolutionDownBy: 4, maxBitrate: Math.round(maxBitrateKbps * 60) },
        { ...full, rid: 'h', scaleResolutionDownBy: 2, maxBitrate: Math.round(maxBitrateKbps * 200) },
        { ...full, rid: 'f' }
    ];
}

type CodecCapability = { mimeType: string, sdpFmtpLine?: string };

/**
 * Offers `codec` alone, with retransmission; all of libwebrtc's codecs if it lacks it.
 *
 * H.264 goes in packetization mode 1 only. In mode 0 each NAL unit must fit one RTP packet, so the
 * encoder cuts every frame into dozens of slices: worse compression, and more NAL units per frame
 * than some servers accept (mediamtx drops frames past 50, keyframes included, and viewers never
 * see a picture). Constrained Baseline comes first, which every H.264 decoder plays.
 */
function restrictCodec(transceiver: RTCRtpTransceiver, codec: LivestreamVideoCodec | null): void {
    if (codec === null) {
        return;
    }

    const mimeType = `video/${codec}`.toLowerCase();

    // The capabilities as native returns them: setCodecPreferences matches them field by field.
    const { codecs } = RTCRtpSender.getCapabilities('video') as unknown as { codecs: CodecCapability[] };
    const fmtp = (entry: CodecCapability, key: string) =>
        new RegExp(`(?:^|;)\\s*${key}=([^;]*)`).exec(entry.sdpFmtpLine ?? '')?.[1];
    let chosen = codecs.filter(entry => entry.mimeType.toLowerCase() === mimeType);

    if (codec === 'H264') {
        const baseline = (entry: CodecCapability) => ((fmtp(entry, 'profile-level-id') ?? '').startsWith('42') ? 0 : 1);

        chosen = chosen
            .filter(entry => fmtp(entry, 'packetization-mode') === '1')
            .sort((a, b) => baseline(a) - baseline(b));
    }

    if (chosen.length === 0) {
        return;
    }

    // Retransmission, which servers take up or leave out. Not RED or FEC: overhead that servers
    // mostly do not forward.
    const rtx = codecs.filter(entry => entry.mimeType.toLowerCase() === 'video/rtx');

    transceiver.setCodecPreferences([ ...chosen, ...rtx ] as any);
}
