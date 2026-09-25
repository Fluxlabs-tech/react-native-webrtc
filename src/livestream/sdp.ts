/**
 * Edits a livestream makes to the SDP libwebrtc offers and servers answer. Each takes an SDP and
 * returns it changed; lines it has no business with pass through untouched.
 */

type SdpParameters = Record<string, string | number | null>;

const EOL = '\r\n';

/** Codecs that carry no media of their own: parameters meant for a video codec skip them. */
const NON_MEDIA_CODECS = [ 'rtx', 'red', 'ulpfec', 'flexfec-03' ];

function splitLines(sdp: string): string[] {
    const lines = sdp.split(/\r?\n/);

    if (lines[lines.length - 1] === '') {
        lines.pop();
    }

    return lines;
}

function joinLines(lines: string[]): string {
    return lines.join(EOL) + EOL;
}

/** Payload types whose rtpmap `matches` (codec name, case-insensitive), within `kind` m-sections. */
function payloadTypes(lines: string[], matches: (codec: string) => boolean, kind?: string): Set<string> {
    const types = new Set<string>();
    let section = '';

    for (const line of lines) {
        if (line.startsWith('m=')) {
            section = line.slice(2, line.indexOf(' '));
            continue;
        }

        const rtpmap = /^a=rtpmap:(\d+) ([^/]+)\//.exec(line);

        if (rtpmap && (!kind || section === kind) && matches(rtpmap[2].toLowerCase())) {
            types.add(rtpmap[1]);
        }
    }

    return types;
}

/** `key=value;…` with `parameters` set over it; `null` removes one. Keeps the existing order. */
function mergeParameters(fmtp: string, parameters: SdpParameters): string {
    const entries: [string, string][] = [];

    for (const pair of fmtp.split(';')) {
        const trimmed = pair.trim();

        if (trimmed) {
            const equals = trimmed.indexOf('=');

            entries.push(equals < 0 ? [ trimmed, '' ] : [ trimmed.slice(0, equals), trimmed.slice(equals + 1) ]);
        }
    }

    for (const [ key, value ] of Object.entries(parameters)) {
        const index = entries.findIndex(([ existing ]) => existing.toLowerCase() === key.toLowerCase());

        if (value === null) {
            if (index >= 0) {
                entries.splice(index, 1);
            }
        } else if (index >= 0) {
            entries[index][1] = String(value);
        } else {
            entries.push([ key, String(value) ]);
        }
    }

    return entries.map(([ key, value ]) => (value === '' ? key : `${key}=${value}`)).join(';');
}

function setParameters(sdp: string, types: Set<string>, parameters: SdpParameters): string {
    const lines = splitLines(sdp);
    const withFmtp = new Set<string>();

    for (const line of lines) {
        const fmtp = /^a=fmtp:(\d+) /.exec(line);

        if (fmtp) {
            withFmtp.add(fmtp[1]);
        }
    }

    const result: string[] = [];

    for (const line of lines) {
        const fmtp = /^a=fmtp:(\d+) (.*)$/.exec(line);

        if (fmtp && types.has(fmtp[1])) {
            result.push(`a=fmtp:${fmtp[1]} ${mergeParameters(fmtp[2], parameters)}`);
            continue;
        }

        result.push(line);

        // A payload type without an fmtp line gets one after its rtpmap.
        const rtpmap = /^a=rtpmap:(\d+) /.exec(line);

        if (rtpmap && types.has(rtpmap[1]) && !withFmtp.has(rtpmap[1])) {
            const merged = mergeParameters('', parameters);

            if (merged) {
                result.push(`a=fmtp:${rtpmap[1]} ${merged}`);
            }
        }
    }

    return joinLines(result);
}

/**
 * Sets Opus's fmtp parameters. Which side's parameters count depends on the direction: `stereo` in
 * a peer's own description asks for stereo to be sent to it, so a viewer puts it in its offer; a
 * sender's encoder follows the parameters in the description it receives, so a host sets
 * `maxaveragebitrate` and the like in the answer it is given.
 */
export function setOpusParameters(sdp: string, parameters: SdpParameters): string {
    return setParameters(sdp, payloadTypes(splitLines(sdp), codec => codec === 'opus', 'audio'), parameters);
}

/**
 * Sets fmtp parameters on every video codec in the SDP, such as libwebrtc's
 * `x-google-start-bitrate` (kbps), which the sender reads from the description it receives.
 */
export function setVideoParameters(sdp: string, parameters: SdpParameters): string {
    const types = payloadTypes(splitLines(sdp), codec => !NON_MEDIA_CODECS.includes(codec), 'video');

    return setParameters(sdp, types, parameters);
}

/**
 * Asks for lost Opus packets to be resent (NACK). libwebrtc supports it for audio but offers it
 * only for video. Servers that do not resend audio leave it out of their answer, which turns it
 * off again, so it is safe to offer.
 */
export function addOpusNack(sdp: string): string {
    const lines = splitLines(sdp);
    const types = payloadTypes(lines, codec => codec === 'opus', 'audio');
    const done = new Set([ ...types ].filter(type => lines.includes(`a=rtcp-fb:${type} nack`)));
    const result: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        result.push(lines[i]);

        const own = /^a=(?:rtpmap|fmtp|rtcp-fb):(\d+) /.exec(lines[i]);

        if (!own || !types.has(own[1]) || done.has(own[1])) {
            continue;
        }

        // After the last of the payload type's lines.
        const next = /^a=(?:rtpmap|fmtp|rtcp-fb):(\d+) /.exec(lines[i + 1] ?? '');

        if (!next || next[1] !== own[1]) {
            result.push(`a=rtcp-fb:${own[1]} nack`);
            done.add(own[1]);
        }
    }

    return joinLines(result);
}

/** Removes an RTP header extension, by URI, so that it is not negotiated. */
export function removeHeaderExtension(sdp: string, uri: string): string {
    const pattern = new RegExp(`^a=extmap:\\d+(?:/\\w+)? ${uri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: |$)`);

    return joinLines(splitLines(sdp).filter(line => !pattern.test(line)));
}
