import RTCIceCandidate from '../RTCIceCandidate';
import RTCPeerConnection, { type RTCConfiguration, type RTCIceServer } from '../RTCPeerConnection';

import livestreamNetwork, { type LivestreamNetworkState } from './LivestreamNetwork';
import LivestreamStatsSampler, { type LivestreamStats, type LivestreamStatsHints } from './LivestreamStats';

/**
 * Where a livestream session is:
 *
 * - `connecting`: setting up after `start()`.
 * - `connected`: the peer connection is up.
 * - `offline`: the server has nothing to play yet. Asking again.
 * - `reconnecting`: the connection failed or went quiet, or there is no network. Retrying.
 * - `failed`: the server refused the session, or retrying is off.
 * - `stopped`: after `stop()`.
 */
export type LivestreamState = 'idle' | 'connecting' | 'connected' | 'offline' | 'reconnecting' | 'failed' | 'stopped';

export type LivestreamReconnectOptions = {
    /** Wait before the first retry, doubled for each retry after it. Default 1000. */
    initialDelayMs?: number;
    /** Longest wait between retries. Default 10000. */
    maxDelayMs?: number;
    /** Wait between asks while the server has nothing to play (`offline`). Default 2000. */
    offlineDelayMs?: number;
};

export type LivestreamSessionOptions = {
    /**
     * STUN and TURN servers. Default none: the device reaches out to the server, which answers on
     * the same path, so a server on a public address needs none. A network that blocks UDP needs
     * TURN.
     */
    iceServers?: RTCIceServer[];
    /** Anything else for the peer connection, over the session's own settings. */
    configuration?: RTCConfiguration;
    /** Retry after a failure, waiting longer each time. false: stop at `failed` instead. */
    reconnect?: LivestreamReconnectOptions | false;
    /** Reconnect when ICE stays disconnected this long, in ms. Default 8000; 2000 just after the network changed. */
    disconnectedTimeoutMs?: number;
    /** How often stats are sampled while connected, in ms. Default 2000. */
    statsIntervalMs?: number;
    onStateChange?: (state: LivestreamState, reason?: string) => void;
    /** Stats over each interval while connected, with the quality and what limits it. */
    onStats?: (stats: LivestreamStats) => void;
};

/** How to treat a server's refusal. */
export type RefusalHandling = 'offline' | 'reconnecting' | 'failed';

const DEFAULT_RECONNECT = { initialDelayMs: 1000, maxDelayMs: 10000, offlineDelayMs: 2000 };
const DEFAULT_DISCONNECTED_TIMEOUT_MS = 8000;
const DEFAULT_STATS_INTERVAL_MS = 2000;

/** ICE disconnected just after the network changed: the old route is gone, so waiting is pointless. */
const NETWORK_CHANGED_DISCONNECTED_TIMEOUT_MS = 2000;

/** How long after a network change a disconnect counts as caused by it. */
const NETWORK_CHANGE_WINDOW_MS = 10000;

/**
 * One livestream session, kept up until `stop()`, over whatever signalling a subclass speaks.
 *
 * A session that fails or stays disconnected is replaced, with a growing, jittered wait between
 * attempts, so many clients do not return to a server in step. It follows the device's network:
 * with none, it waits instead of using up attempts, and it connects again as soon as one is back
 * or the device moves to another, rather than when a backoff runs out. ICE keeps gathering as
 * networks come and go, so where the server takes new candidates a phone moving between Wi-Fi and
 * cellular carries on without a new session.
 *
 * While connected it samples stats, for `onStats` and its own checks.
 */
export default abstract class LivestreamSession {
    protected readonly options: LivestreamSessionOptions;

    private _state: LivestreamState = 'idle';
    private _pc: RTCPeerConnection | null = null;
    private _stats: LivestreamStats | null = null;
    private stopped = true;
    // Bumped whenever a connection is set up or torn down, so work still under way for an old one
    // can tell and drop out.
    private generation = 0;
    private failures = 0;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private disconnectedTimer: ReturnType<typeof setTimeout> | null = null;
    private statsTimer: ReturnType<typeof setInterval> | null = null;
    private network: LivestreamNetworkState | null = null;
    private networkChangedAt = 0;
    private stopFollowingNetwork: (() => void) | null = null;

    protected constructor(options: LivestreamSessionOptions) {
        this.options = options;
    }

    get state(): LivestreamState {
        return this._state;
    }

    /** The current peer connection, for `getStats()` and the like. Replaced on reconnecting. */
    get peerConnection(): RTCPeerConnection | null {
        return this._pc;
    }

    /** The stats of the latest interval while connected. */
    get stats(): LivestreamStats | null {
        return this._stats;
    }

    start(): void {
        if (!this.stopped) {
            return;
        }

        this.stopped = false;
        this.failures = 0;
        this.followNetwork();
        this.setState('connecting');
        void this.connect();
    }

    stop(): void {
        if (this.stopped) {
            return;
        }

        this.stopped = true;
        this.clearRetry();
        this.teardown();
        this.closeSignalling();
        this.unfollowNetwork();
        this.setState('stopped');
    }

    /** What the protocol calls itself in reasons. */
    protected abstract get protocol(): string;

    /**
     * Sets up one connection: signalling, and the peer connection, created with
     * `createPeerConnection()` when the protocol needs it. Throwing reconnects; a refusal goes to
     * `refuse()`. `current()` turns false once the connection is torn down.
     */
    protected abstract negotiate(current: () => boolean): Promise<void>;

    /** Peer connection settings of the session's kind, under the app's `configuration`. */
    protected defaultConfiguration(): RTCConfiguration {
        return {};
    }

    /** A new peer connection, before negotiation. */
    protected onPeerConnection?(pc: RTCPeerConnection): void;

    /** An ICE candidate of this side's. */
    protected onLocalCandidate?(pc: RTCPeerConnection, candidate: RTCIceCandidate): void;

    /** The peer connection reached `connected`; again after each recovery. */
    protected onConnected?(pc: RTCPeerConnection): void;

    /** What the stats sampler cannot see for itself. */
    protected statsHints(): LivestreamStatsHints {
        return {};
    }

    /** Each interval's stats while connected, before `onStats`. */
    protected onStatsSample?(stats: LivestreamStats, pc: RTCPeerConnection): void;

    /** The device moved to another network, or back online, while the session runs. */
    protected onNetworkChange?(state: LivestreamNetworkState): void;

    /**
     * The connection is being torn down, its peer connection (if it got one) about to close: end
     * this connection's session with the server.
     */
    protected onTeardown?(pc: RTCPeerConnection | null): void;

    /** `stop()`: close whatever signalling outlives a connection, a WebSocket say. */
    protected closeSignalling(): void {
        // Nothing, for request-response signalling.
    }

    protected get active(): boolean {
        return !this.stopped;
    }

    protected createPeerConnection(current: () => boolean): RTCPeerConnection {
        const pc = new RTCPeerConnection({
            iceServers: this.options.iceServers ?? [],
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
            continualGatheringPolicy: 'gather_continually',
            ...this.defaultConfiguration(),
            ...this.options.configuration
        });

        this._pc = pc;
        this.watch(pc, current);
        this.onPeerConnection?.(pc);

        return pc;
    }

    /** Gives up on the current connection and sets up another, after a wait. */
    protected reconnect(reason: string, state: 'offline' | 'reconnecting' = 'reconnecting'): void {
        if (this.stopped) {
            return;
        }

        this.teardown();

        if (this.options.reconnect === false) {
            this.giveUp(reason);

            return;
        }

        this.setState(state, reason);
        this.clearRetry();

        // No network: the next attempt waits for one (see onNetwork).
        if (this.network?.online === false) {
            return;
        }

        const { initialDelayMs, maxDelayMs, offlineDelayMs } = { ...DEFAULT_RECONNECT, ...this.options.reconnect };

        // Nothing to play is no failure: ask again at an even pace.
        const wait = state === 'offline' ? offlineDelayMs : Math.min(maxDelayMs, initialDelayMs * 2 ** this.failures++);

        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            void this.connect();
        }, wait * (0.8 + Math.random() * 0.4));
    }

    /** Replaces the connection at once, for a change of what it carries rather than a failure. */
    protected restart(reason: string): void {
        if (this.stopped) {
            return;
        }

        this.teardown();
        this.clearRetry();
        this.setState('connecting', reason);
        void this.connect();
    }

    /** The server refused the session. */
    protected refuse(handling: RefusalHandling, reason: string): void {
        if (handling === 'failed') {
            this.giveUp(reason);
        } else {
            this.reconnect(reason, handling);
        }
    }

    protected isCurrent(pc: RTCPeerConnection): boolean {
        return !this.stopped && pc === this._pc;
    }

    private setState(state: LivestreamState, reason?: string): void {
        this._state = state;
        this.options.onStateChange?.(state, reason);
    }

    private giveUp(reason: string): void {
        this.stopped = true;
        this.clearRetry();
        this.teardown();
        this.closeSignalling();
        this.unfollowNetwork();
        this.setState('failed', reason);
    }

    private async connect(): Promise<void> {
        if (this.stopped) {
            return;
        }

        // No network: wait for one (see onNetwork).
        if (this.network?.online === false) {
            if (this._state !== 'reconnecting' && this._state !== 'offline') {
                this.setState('reconnecting', 'no network');
            }

            return;
        }

        const generation = ++this.generation;
        const current = () => generation === this.generation && !this.stopped;

        try {
            await this.negotiate(current);
        } catch (error) {
            if (current()) {
                this.reconnect(`${this.protocol} error: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    private watch(pc: RTCPeerConnection, current: () => boolean): void {
        pc.addEventListener('connectionstatechange', () => {
            if (!current()) {
                return;
            }

            if (pc.connectionState === 'connected') {
                this.failures = 0;
                this.setState('connected');
                this.onConnected?.(pc);
                this.sampleStats(pc);
            } else if (pc.connectionState === 'failed') {
                this.reconnect('connection failed');
            }
        });

        pc.addEventListener('iceconnectionstatechange', () => {
            if (!current()) {
                return;
            }

            switch (pc.iceConnectionState) {
                case 'disconnected':
                    // Often a blip ICE rides out by itself; hardly worth waiting for if the
                    // network just changed under it.
                    if (!this.disconnectedTimer) {
                        const timeout = Date.now() - this.networkChangedAt < NETWORK_CHANGE_WINDOW_MS
                            ? NETWORK_CHANGED_DISCONNECTED_TIMEOUT_MS
                            : this.options.disconnectedTimeoutMs ?? DEFAULT_DISCONNECTED_TIMEOUT_MS;

                        this.disconnectedTimer = setTimeout(() => {
                            this.disconnectedTimer = null;

                            if (current()) {
                                this.reconnect('ICE disconnected');
                            }
                        }, timeout);
                    }

                    break;
                case 'failed':
                    this.reconnect('ICE failed');
                    break;
                case 'connected':
                case 'completed':
                    this.clearDisconnected();
                    break;
            }
        });

        pc.addEventListener('icecandidate', event => {
            const { candidate } = event as unknown as { candidate: RTCIceCandidate | null };

            if (current() && candidate) {
                this.onLocalCandidate?.(pc, candidate);
            }
        });
    }

    private sampleStats(pc: RTCPeerConnection): void {
        if (this.statsTimer) {
            return;
        }

        const sampler = new LivestreamStatsSampler(pc);
        let sampling = false;

        const sample = async () => {
            if (sampling) {
                return;
            }

            sampling = true;

            try {
                const stats = await sampler.sample(this.statsHints());

                // The first sample only sets the baseline.
                if (!this.isCurrent(pc) || stats.intervalSeconds === 0) {
                    return;
                }

                this._stats = stats;
                this.onStatsSample?.(stats, pc);

                if (this.isCurrent(pc)) {
                    this.options.onStats?.(stats);
                }
            } catch {
                // Closed under it.
            } finally {
                sampling = false;
            }
        };

        void sample();
        this.statsTimer = setInterval(sample, this.options.statsIntervalMs ?? DEFAULT_STATS_INTERVAL_MS);
    }

    private followNetwork(): void {
        this.stopFollowingNetwork = livestreamNetwork.addListener(state => this.onNetwork(state));
        this.network = livestreamNetwork.state;
    }

    private unfollowNetwork(): void {
        this.stopFollowingNetwork?.();
        this.stopFollowingNetwork = null;
        this.network = null;
    }

    private onNetwork(next: LivestreamNetworkState): void {
        const previous = this.network;

        this.network = next;

        if (this.stopped || !previous) {
            return;
        }

        if (!next.online) {
            // Attempts would only fail: hold the next one until there is a network. A connection
            // that is up rides out a short drop, or times out by itself.
            this.clearRetry();

            return;
        }

        if (previous.online && previous.id === next.id) {
            return;
        }

        this.networkChangedAt = Date.now();
        this.onNetworkChange?.(next);

        if (this._state !== 'connected') {
            // Back online, or on another network, while not playing: try now, rather than when the
            // backoff runs out. An attempt under way went out over the old network, and may hang
            // until it times out, a WebSocket with it: dropped, for a new one.
            this.clearRetry();
            this.failures = 0;
            this.teardown();
            this.closeSignalling();
            void this.connect();

            return;
        }

        const pc = this._pc;

        if (pc && (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed')) {
            this.reconnect('network changed');
        }
    }

    private teardown(): void {
        this.generation++;
        this.clearDisconnected();

        if (this.statsTimer) {
            clearInterval(this.statsTimer);
            this.statsTimer = null;
        }

        const pc = this._pc;

        this._pc = null;
        this._stats = null;
        this.onTeardown?.(pc);
        pc?.close();
    }

    private clearRetry(): void {
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }

    private clearDisconnected(): void {
        if (this.disconnectedTimer) {
            clearTimeout(this.disconnectedTimer);
            this.disconnectedTimer = null;
        }
    }
}
