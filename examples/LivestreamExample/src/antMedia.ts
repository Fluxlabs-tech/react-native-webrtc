import {
  LivestreamViewer,
  RTCIceCandidate,
  RTCSessionDescription,
  removeHeaderExtension,
  setOpusParameters,
  type LivestreamStatsHints,
  type LivestreamViewerOptions,
  type RTCPeerConnection,
} from 'react-native-webrtc';

export type AntMediaPlayerOptions = LivestreamViewerOptions & {
  /** The server's WebSocket signalling URL: `wss://<host>:5443/<app>/websocket`. */
  url: string;
  /** The broadcast to play. */
  streamId: string;
  /** A play token, for a server that checks them (one-time or JWT). */
  token?: string;
  /** Longest wait for the WebSocket to open, in ms. Default 10000. */
  requestTimeoutMs?: number;
};

type Message = {
  command?: string;
  definition?: string;
  streamId?: string;
  type?: string;
  sdp?: string;
  label?: number | string;
  id?: string;
  candidate?: string;
  targetBitrate?: number | string;
};

/** One connection's part of the play session. */
type Attempt = {
  current: () => boolean;
  pc: RTCPeerConnection | null;
  remoteDescriptionSet: boolean;
  // The server's candidates that came before its offer.
  remoteCandidates: RTCIceCandidate[];
  // This side's candidates go once the answer has: the server can add them only then.
  answered: boolean;
  localCandidates: RTCIceCandidate[];
  // The server may have a play session for this connection, to stop.
  playing: boolean;
};

/** Ant Media closes a socket that goes quiet. */
const PING_INTERVAL_MS = 3000;
/** Nothing from the server for this long: the socket is dead, whether or not the OS has noticed. */
const SILENCE_TIMEOUT_MS = 10000;
/** The server reported on the stream this recently: its side of the session is alive. */
const SERVER_ALIVE_MS = 12000;
/** Longest a stall is put down to the publisher while the server is alive, before a new connection. */
const MAX_PUBLISHER_STALL_MS = 20000;
/** Ant Media's own SDK takes this out of every offer it plays. */
const VIDEO_ORIENTATION_URI = 'urn:3gpp:video-orientation';

/** Refusals retrying cannot change. */
const FATAL_ERRORS = new Set([
  'unauthorized_access',
  'noStreamNameSpecified',
  'invalidStreamName',
  'not_allowed_unregistered_streams',
  'no_codec_enabled_in_the_server',
  'license_suspended_please_renew_license',
]);
/** Nothing to play yet: ask again. */
const OFFLINE_ERRORS = new Set(['no_stream_exist', 'stream_not_active_or_expired']);

/**
 * Plays from Ant Media Server over its WebSocket signalling: Ant Media takes WHIP for publishing,
 * but plays WebRTC only this way. The signalling is all that is here; reconnecting, following the
 * network, stats and quality, and the audio-only fallback come from the library's LivestreamViewer.
 *
 * The server makes the offer: this asks to play, answers (asking for stereo Opus), and trades
 * candidates. The socket stays open between connections, so while the stream has not started it
 * asks again every `offlineDelayMs` without reconnecting. Ant Media's bandwidth measurements go
 * into the stats, and tell a stalled publisher (which the server still reports on) from a broken
 * connection. The audio-only fallback asks the server to stop sending video, with no new
 * connection.
 */
export class AntMediaPlayer extends LivestreamViewer {
  private readonly player: AntMediaPlayerOptions;
  private ws: WebSocket | null = null;
  private opening: { ws: WebSocket; promise: Promise<WebSocket>; cancel: () => void } | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeard = 0;
  private attempt: Attempt | null = null;
  private measurement: { at: number; targetBitrate: number } | null = null;

  constructor(options: AntMediaPlayerOptions) {
    super(options);
    this.player = options;
  }

  protected get protocol(): string {
    return 'Ant Media';
  }

  protected async negotiate(current: () => boolean): Promise<void> {
    const ws = await this.socket();
    if (!current()) return;
    this.attempt = {
      current,
      pc: null,
      remoteDescriptionSet: false,
      remoteCandidates: [],
      answered: false,
      localCandidates: [],
      playing: true,
    };
    this.measurement = null;
    this.send(ws, { command: 'play', streamId: this.player.streamId, token: this.player.token ?? '' });
  }

  protected onLocalCandidate(_pc: RTCPeerConnection, candidate: RTCIceCandidate): void {
    const attempt = this.attempt;
    if (attempt && !attempt.answered) attempt.localCandidates.push(candidate);
    else this.sendCandidate(candidate);
  }

  protected onTeardown(): void {
    super.onTeardown();
    const attempt = this.attempt;
    this.attempt = null;
    this.measurement = null;
    if (attempt?.playing) this.send(this.ws, { command: 'stop', streamId: this.player.streamId });
  }

  protected closeSignalling(): void {
    this.closeSocket();
  }

  protected statsHints(): LivestreamStatsHints {
    const measurement = this.measurement;
    const recent = measurement !== null && Date.now() - measurement.at < SERVER_ALIVE_MS;
    return {
      ...super.statsHints(),
      availableIncomingKbps: recent && measurement.targetBitrate > 0 ? measurement.targetBitrate / 1000 : null,
    };
  }

  protected onStall(): void {
    const measurement = this.measurement;
    const serverAlive = measurement !== null && Date.now() - measurement.at < SERVER_ALIVE_MS;
    // The server still reports on the stream: the publisher stalled, and a new connection would
    // find the same. Ant Media says when the publisher is gone for good.
    if (serverAlive && this.stalledMs < MAX_PUBLISHER_STALL_MS) return;
    super.onStall();
  }

  /** Ant Media stops or resumes sending this viewer the video, on the same connection. */
  protected setVideoReceiving(receiving: boolean): void {
    if (!this.attempt?.playing) return;
    const { streamId } = this.player;
    this.send(this.ws, { command: 'toggleVideo', streamId, trackId: streamId, enabled: receiving });
  }

  private async handle(message: Message): Promise<void> {
    const attempt = this.attempt;
    if (!attempt || !attempt.current()) return;
    if (message.streamId !== undefined && message.streamId !== this.player.streamId) return;
    switch (message.command) {
      case 'takeConfiguration':
        if (message.type === 'offer' && message.sdp) await this.takeOffer(attempt, message.sdp);
        return;
      case 'takeCandidate':
        await this.takeCandidate(attempt, message);
        return;
      case 'notification':
        this.onNotification(attempt, message);
        return;
      case 'error':
        this.onServerError(attempt, message.definition ?? 'unknown error');
        return;
      case 'stop':
        attempt.playing = false;
        this.reconnect('stopped by the server', 'offline');
        return;
    }
  }

  private async takeOffer(attempt: Attempt, sdp: string): Promise<void> {
    // Again for a renegotiation, on the same peer connection.
    const pc = attempt.pc ?? this.createPeerConnection(attempt.current);
    attempt.pc = pc;
    await pc.setRemoteDescription(
      new RTCSessionDescription({ type: 'offer', sdp: removeHeaderExtension(sdp, VIDEO_ORIENTATION_URI) })
    );
    if (!attempt.current()) return;
    attempt.remoteDescriptionSet = true;
    for (const candidate of attempt.remoteCandidates.splice(0)) {
      await pc.addIceCandidate(candidate).catch(() => undefined);
    }
    const answer = await pc.createAnswer();
    // stereo=1 in the answer is what has the decoder play stereo.
    const local = setOpusParameters(answer.sdp, { stereo: 1 });
    await pc.setLocalDescription(new RTCSessionDescription({ type: 'answer', sdp: local }));
    if (!attempt.current()) return;
    this.send(this.ws, { command: 'takeConfiguration', streamId: this.player.streamId, type: 'answer', sdp: local });
    attempt.answered = true;
    for (const candidate of attempt.localCandidates.splice(0)) this.sendCandidate(candidate);
  }

  private async takeCandidate(attempt: Attempt, message: Message): Promise<void> {
    if (!message.candidate) return;
    const candidate = new RTCIceCandidate({
      candidate: message.candidate,
      sdpMid: message.id ?? null,
      sdpMLineIndex: message.label !== undefined ? Number(message.label) : null,
    });
    if (attempt.pc && attempt.remoteDescriptionSet) await attempt.pc.addIceCandidate(candidate).catch(() => undefined);
    else attempt.remoteCandidates.push(candidate);
  }

  private sendCandidate(candidate: RTCIceCandidate): void {
    this.send(this.ws, {
      command: 'takeCandidate',
      streamId: this.player.streamId,
      label: candidate.sdpMLineIndex,
      id: candidate.sdpMid,
      candidate: candidate.candidate,
    });
  }

  private onNotification(attempt: Attempt, message: Message): void {
    switch (message.definition) {
      case 'play_started':
        // A new connection while the fallback has the video off.
        if (!this.receivesVideo && this.viewer.video !== false) this.setVideoReceiving(false);
        break;
      case 'play_finished':
        attempt.playing = false;
        this.reconnect('the stream ended', 'offline');
        break;
      case 'bitrateMeasurement':
        this.measurement = { at: Date.now(), targetBitrate: Number(message.targetBitrate) || 0 };
        break;
      case 'no_stream_exist':
        // Some versions say it as a notification.
        this.onServerError(attempt, message.definition);
        break;
    }
  }

  private onServerError(attempt: Attempt, definition: string): void {
    const reason = `Ant Media: ${definition}`;
    if (definition === 'already_playing') {
      // A play of this socket's that the server still counts: stopped on the way to a new one.
      attempt.playing = true;
      this.reconnect(reason);
      return;
    }
    attempt.playing = false;
    if (FATAL_ERRORS.has(definition)) this.refuse('failed', reason);
    else this.refuse(OFFLINE_ERRORS.has(definition) ? 'offline' : 'reconnecting', reason);
  }

  /** The open socket, or a new one. */
  private socket(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    if (this.opening) return this.opening.promise;
    this.closeSocket();

    const ws = new WebSocket(withEdgeTarget(this.player.url));
    let cancel = () => {};
    const promise = new Promise<WebSocket>((resolve, reject) => {
      const timer = setTimeout(() => fail('the WebSocket did not open'), this.player.requestTimeoutMs ?? 10000);
      const fail = (reason: string) => {
        clearTimeout(timer);
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        ws.close();
        if (this.opening?.ws === ws) this.opening = null;
        reject(new Error(reason));
      };
      ws.onopen = () => {
        clearTimeout(timer);
        this.opening = null;
        this.ws = ws;
        ws.onerror = () => this.socketLost(ws, 'WebSocket error');
        ws.onclose = () => this.socketLost(ws, 'WebSocket closed');
        this.startPing(ws);
        resolve(ws);
      };
      ws.onmessage = (event) => this.receive(ws, event.data);
      ws.onerror = () => fail('WebSocket error');
      ws.onclose = () => fail('WebSocket closed');
      cancel = () => fail('WebSocket closed');
    });
    this.opening = { ws, promise, cancel };
    return promise;
  }

  private receive(ws: WebSocket, data: unknown): void {
    if (ws !== this.ws) return;
    this.lastHeard = Date.now();
    let message: Message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    this.handle(message).catch((error) => {
      if (this.attempt?.current()) this.reconnect(`Ant Media error: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private startPing(ws: WebSocket): void {
    this.lastHeard = Date.now();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastHeard > SILENCE_TIMEOUT_MS) this.socketLost(ws, 'the server stopped answering');
      else this.send(ws, { command: 'ping' });
    }, PING_INTERVAL_MS);
  }

  private socketLost(ws: WebSocket, reason: string): void {
    if (ws !== this.ws) return;
    this.closeSocket();
    // Ant Media ends a socket's play sessions with it.
    if (!this.active) return;
    if (this.attempt) this.attempt.playing = false;
    this.reconnect(reason);
  }

  private send(ws: WebSocket | null, message: object): void {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  private closeSocket(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const ws = this.ws;
    const opening = this.opening;
    this.ws = null;
    this.opening = null;
    opening?.cancel();
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      ws.close();
    }
  }
}

/**
 * An Ant Media cluster routes a socket by `target`, and a player belongs on an edge; Ant Media's
 * SDK adds it to every player's URL that names none. A single server ignores it.
 */
function withEdgeTarget(url: string): string {
  if (/[?&]target=(origin|edge)(&|$)/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}target=edge`;
}
