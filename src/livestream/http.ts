import RTCIceCandidate from '../RTCIceCandidate';
import RTCPeerConnection, { type RTCIceServer } from '../RTCPeerConnection';
import RTCSessionDescription from '../RTCSessionDescription';

import { type RefusalHandling } from './LivestreamSession';

export type HttpSignallingOptions = {
    /** The WHIP or WHEP endpoint the offer is posted to. */
    url: string;
    /** Sent as `Authorization: Bearer <token>`. */
    token?: string;
    /** Sent with every request. */
    headers?: Record<string, string>;
    /** Longest wait for local ICE candidates before posting the offer, in ms. Default 1000. */
    iceGatheringTimeoutMs?: number;
    /** Longest wait for the server to answer an HTTP request, in ms. Default 10000. */
    requestTimeoutMs?: number;
};

/** The server turned the offer down. */
export type HttpRefusal = { status: number, reason: string };

const DEFAULT_GATHERING_TIMEOUT_MS = 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

/** Candidates found after the offer went out are sent together, this long after the first. */
const CANDIDATE_BATCH_MS = 50;

/** How to treat a refusal no protocol has its own meaning for. */
export function defaultRefusal(status: number): RefusalHandling {
    // Wrong request, or the credentials: retrying cannot help.
    if ([ 400, 401, 403, 405, 415 ].includes(status)) {
        return 'failed';
    }

    return 'reconnecting';
}

/**
 * WHIP and WHEP signalling (RFC 9725 and its WHEP counterpart), for one connection at a time:
 *
 *   1. offer, and wait briefly for ICE candidates
 *   2. POST the offer (`application/sdp`): 201 with the answer, and the session's URL in `Location`
 *   3. candidates found later go to that URL in PATCH requests, if the server takes them
 *   4. DELETE the URL to end the session
 *
 * The offer goes out once ICE has found a route beyond the local network or finished, rather than
 * after every candidate: the device reaches out to the server, and the server learns its address
 * from that, so later candidates are needed only by a server behind NAT, and reach it by PATCH.
 */
export default class HttpSignalling {
    private readonly options: HttpSignallingOptions & { iceServers?: RTCIceServer[] };
    private readonly protocol: string;
    private resourceUrl: string | null = null;
    private etag: string | null = null;
    private trickle = false;
    private offerSent = false;
    private pendingCandidates: RTCIceCandidate[] = [];
    private candidateTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(options: HttpSignallingOptions & { iceServers?: RTCIceServer[] }, protocol: string) {
        this.options = options;
        this.protocol = protocol;
    }

    /**
     * Offers, posts the offer, and sets the answer. Resolves with the refusal if the server turned
     * the offer down, and null otherwise, including when `current()` turned false on the way.
     */
    async negotiate(
        pc: RTCPeerConnection,
        current: () => boolean,
        munge: { offer?: (sdp: string) => string, answer?: (sdp: string) => string } = {}
    ): Promise<HttpRefusal | null> {
        const offer = await pc.createOffer({});

        await pc.setLocalDescription(new RTCSessionDescription({
            type: 'offer',
            sdp: munge.offer ? munge.offer(offer.sdp) : offer.sdp
        }));
        await gathered(
            pc,
            (this.options.iceServers?.length ?? 0) > 0,
            this.options.iceGatheringTimeoutMs ?? DEFAULT_GATHERING_TIMEOUT_MS
        );

        if (!current()) {
            return null;
        }

        this.offerSent = true;

        const response = await this.request(this.options.url, {
            method: 'POST',
            headers: this.headers('application/sdp'),
            body: pc.localDescription?.sdp ?? ''
        });

        if (!current()) {
            return null;
        }

        if (response.status !== 201 && response.status !== 200) {
            const text = describeError(await response.text().catch(() => ''));

            return {
                status: response.status,
                reason: `${this.protocol} ${response.status}${text ? `: ${text}` : ''}`
            };
        }

        const location = response.headers.get('Location');

        this.resourceUrl = location ? resolveUrl(this.options.url, location) : null;
        this.etag = response.headers.get('ETag');
        this.trickle = /application\/trickle-ice-sdpfrag/i.test(response.headers.get('Accept-Patch') ?? '');

        const answer = await response.text();

        if (!current()) {
            return null;
        }

        await pc.setRemoteDescription(new RTCSessionDescription({
            type: 'answer',
            sdp: munge.answer ? munge.answer(answer) : answer
        }));
        this.sendCandidates(pc);

        return null;
    }

    /** A candidate found after the offer went out, for a server that takes them. */
    addCandidate(pc: RTCPeerConnection, candidate: RTCIceCandidate): void {
        if (!this.offerSent) {
            return;
        }

        this.pendingCandidates.push(candidate);

        if (!this.candidateTimer) {
            this.candidateTimer = setTimeout(() => {
                this.candidateTimer = null;
                this.sendCandidates(pc);
            }, CANDIDATE_BATCH_MS);
        }
    }

    /** Ends the server's session, if there is one. */
    close(): void {
        if (this.candidateTimer) {
            clearTimeout(this.candidateTimer);
            this.candidateTimer = null;
        }

        const resourceUrl = this.resourceUrl;

        this.resourceUrl = null;
        this.etag = null;
        this.trickle = false;
        this.offerSent = false;
        this.pendingCandidates = [];

        // Best effort: a server that never hears it times the session out.
        if (resourceUrl) {
            this.request(resourceUrl, { method: 'DELETE', headers: this.headers() }).catch(() => undefined);
        }
    }

    private headers(contentType?: string): Record<string, string> {
        return {
            ...this.options.headers,
            ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
            ...(contentType ? { 'Content-Type': contentType } : {})
        };
    }

    private async request(url: string, init: RequestInit): Promise<Response> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

        try {
            return await fetch(url, { ...init, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    private sendCandidates(pc: RTCPeerConnection): void {
        if (!this.resourceUrl || this.pendingCandidates.length === 0) {
            return;
        }

        const candidates = this.pendingCandidates.splice(0);

        if (!this.trickle) {
            return;
        }

        const body = sdpFragment(pc.localDescription?.sdp ?? '', candidates);

        if (!body) {
            return;
        }

        this.request(this.resourceUrl, {
            method: 'PATCH',
            headers: {
                ...this.headers('application/trickle-ice-sdpfrag'),
                ...(this.etag ? { 'If-Match': this.etag } : {})
            },
            body
        }).catch(() => undefined);
    }
}

/** With no STUN or TURN server, the offer goes out once host candidates stop coming for this long. */
const HOST_CANDIDATES_QUIET_MS = 100;

/**
 * Waits until the offer holds what the server needs: a candidate beyond the local network, if
 * there are STUN or TURN servers to find one, or else the host candidates. Gathering never reports
 * `complete` while it gathers continually, so this watches the candidates themselves.
 */
function gathered(pc: RTCPeerConnection, hasIceServers: boolean, timeoutMs: number): Promise<void> {
    const beyondLocal = / typ (?:srflx|relay)/;

    return new Promise(resolve => {
        let quietTimer: ReturnType<typeof setTimeout> | null = null;

        const timer = setTimeout(() => done(), timeoutMs);

        const settle = () => {
            if (quietTimer) {
                clearTimeout(quietTimer);
            }

            quietTimer = setTimeout(() => done(), HOST_CANDIDATES_QUIET_MS);
        };

        const onGatheringState = () => {
            if (pc.iceGatheringState === 'complete') {
                done();
            }
        };

        const onCandidate = (event: unknown) => {
            const { candidate } = event as { candidate: RTCIceCandidate | null };

            if (!candidate) {
                return;
            }

            if (!hasIceServers) {
                settle();
            } else if (beyondLocal.test(candidate.candidate)) {
                done();
            }
        };

        const done = () => {
            clearTimeout(timer);

            if (quietTimer) {
                clearTimeout(quietTimer);
            }

            pc.removeEventListener('icegatheringstatechange', onGatheringState);
            pc.removeEventListener('icecandidate', onCandidate);
            resolve();
        };

        pc.addEventListener('icegatheringstatechange', onGatheringState);
        pc.addEventListener('icecandidate', onCandidate);

        // Candidates can arrive before the offer is set, and are already in it.
        const sdp = pc.localDescription?.sdp ?? '';

        if (pc.iceGatheringState === 'complete' || (hasIceServers && beyondLocal.test(sdp))) {
            done();
        } else if (!hasIceServers && /^a=candidate:/m.test(sdp)) {
            settle();
        }
    });
}

/** Candidates as an SDP fragment (RFC 8840), for a trickle ICE PATCH. */
function sdpFragment(localSdp: string, candidates: RTCIceCandidate[]): string | null {
    const ufrag = /^a=ice-ufrag:(\S+)/m.exec(localSdp)?.[1];
    const pwd = /^a=ice-pwd:(\S+)/m.exec(localSdp)?.[1];

    if (!ufrag || !pwd) {
        return null;
    }

    // The media kind of each m-section, by its mid.
    const kinds = new Map<string, string>();
    let kind = '';

    for (const line of localSdp.split(/\r?\n/)) {
        if (line.startsWith('m=')) {
            kind = line.slice(2, line.indexOf(' '));
        } else if (line.startsWith('a=mid:')) {
            kinds.set(line.slice(6), kind);
        }
    }

    const lines = [ `a=ice-ufrag:${ufrag}`, `a=ice-pwd:${pwd}` ];
    const byMid = new Map<string, RTCIceCandidate[]>();

    for (const candidate of candidates) {
        const mid = candidate.sdpMid ?? [ ...kinds.keys() ][candidate.sdpMLineIndex ?? 0] ?? '0';

        byMid.set(mid, [ ...(byMid.get(mid) ?? []), candidate ]);
    }

    for (const [ mid, midCandidates ] of byMid) {
        lines.push(`m=${kinds.get(mid) || 'audio'} 9 UDP/TLS/RTP/SAVPF 0`, `a=mid:${mid}`);

        for (const candidate of midCandidates) {
            lines.push(`a=${candidate.candidate}`);
        }
    }

    return lines.join('\r\n') + '\r\n';
}

/** What a refusal's body says: the message of a JSON error body, as servers send, or the text. */
function describeError(body: string): string {
    try {
        const json = JSON.parse(body);
        const message = json?.error ?? json?.message ?? json?.reason;

        if (typeof message === 'string') {
            return message;
        }
    } catch {
        // Not JSON.
    }

    return body.trim().slice(0, 200);
}

/** `Location` may be relative to the endpoint, which React Native's `URL` cannot resolve. */
function resolveUrl(base: string, location: string): string {
    if (/^https?:\/\//i.test(location)) {
        return location;
    }

    const origin = /^https?:\/\/[^/]+/i.exec(base)?.[0] ?? '';

    if (location.startsWith('/')) {
        return origin + location;
    }

    return base.replace(/[^/]*$/, '') + location;
}
