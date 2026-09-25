import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import {
  RTCView,
  WHEPClient,
  livestreamAudio,
  type LivestreamQualityLimitation,
  type LivestreamState,
  type LivestreamStats,
  type LivestreamViewer,
  type MediaStream,
} from 'react-native-webrtc';

import type { StreamLink } from '../App';
import { AntMediaPlayer } from './antMedia';
import { DEFAULTS, ICE_SERVERS } from './config';
import { Button, Card, Field, Meter, Segmented, Stats, StatusLine, Toggle, styles } from './ui';
import { usePlayoutLevels } from './usePlayoutLevels';

type Source = 'whep' | 'ant-media';

const SOURCES: { value: Source; label: string }[] = [
  { value: 'whep', label: 'WHEP' },
  { value: 'ant-media', label: 'Ant Media' },
];

/** Ant Media plays over a WebSocket; anything else is a WHEP endpoint. */
const sourceOf = (url: string): Source => (/^wss?:\/\//i.test(url) ? 'ant-media' : 'whep');

/**
 * A viewer. Plays whatever the server has, however the host published it: WHIP from the Go live
 * tab, or RTMP / SRT from an encoder or another app. From a WHEP endpoint, or from Ant Media over
 * its WebSocket signalling (see antMedia.ts: the library's LivestreamViewer with Ant Media's
 * signalling on top).
 */
export default function WatchScreen({ link }: { link: StreamLink | null }) {
  const [source, setSource] = useState<Source>(DEFAULTS.whepUrl || !DEFAULTS.antMediaUrl ? 'whep' : 'ant-media');
  const [url, setUrl] = useState(DEFAULTS.whepUrl);
  const [signalingUrl, setSignalingUrl] = useState(DEFAULTS.antMediaUrl);
  const [streamId, setStreamId] = useState(DEFAULTS.streamId);
  const [token, setToken] = useState(DEFAULTS.token);
  const [fallback, setFallback] = useState(true);
  const [status, setStatus] = useState<{ state: LivestreamState; reason?: string }>({ state: 'idle' });
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [stats, setStats] = useState<LivestreamStats | null>(null);
  const [audioOnly, setAudioOnly] = useState(false);
  const [aspectRatio, setAspectRatio] = useState(16 / 9);
  const [leveller, setLeveller] = useState(livestreamAudio.levellerEnabled);
  const [playing, setPlaying] = useState(false);
  const session = useRef<LivestreamViewer | null>(null);

  const levels = usePlayoutLevels(stream !== null);
  const audio = livestreamAudio.config;

  useEffect(() => () => session.current?.stop(), []);

  // The screen stays on while watching, as in any video player.
  useEffect(() => {
    if (!playing) return;
    activateKeepAwakeAsync('watch').catch(() => {});
    return () => {
      deactivateKeepAwake('watch').catch(() => {});
    };
  }, [playing]);

  // A stream opened from a link: play it, in place of whatever plays.
  useEffect(() => {
    if (!link) return;
    session.current?.stop();
    if (link.stop || !link.url) return stop();
    const kind = sourceOf(link.url);
    setSource(kind);
    if (kind === 'whep') setUrl(link.url);
    else setSignalingUrl(link.url);
    if (link.streamId) setStreamId(link.streamId);
    if (link.token) setToken(link.token);
    if (link.fallback !== undefined) setFallback(link.fallback);
    play(link);
  }, [link?.id]);

  const play = (linked?: StreamLink) => {
    const kind: Source = linked?.url ? sourceOf(linked.url) : source;
    const auth = (linked?.token ?? token).trim() || undefined;
    const audioOnlyFallback = linked?.fallback ?? fallback;
    const options = {
      iceServers: ICE_SERVERS,
      audioOnlyFallback,
      onStream: setStream,
      onStateChange: (next: LivestreamState, reason?: string) => {
        setStatus({ state: next, reason });
        if (next !== 'connected') setStats(null);
        if (next === 'offline' || next === 'reconnecting' || next === 'failed') setStream(null);
        if (next === 'failed') setPlaying(false);
      },
      onStats: setStats,
      onAudioOnlyChange: setAudioOnly,
    };
    let next: LivestreamViewer;
    if (kind === 'whep') {
      const whepUrl = (linked?.url ?? url).trim();
      if (!whepUrl) return setStatus({ state: 'idle', reason: 'enter a WHEP URL' });
      next = new WHEPClient({ url: whepUrl, token: auth, ...options });
    } else {
      const wsUrl = (linked?.url ?? signalingUrl).trim();
      const id = (linked?.streamId ?? streamId).trim();
      if (!wsUrl || !id) return setStatus({ state: 'idle', reason: 'enter the signalling URL and a stream ID' });
      next = new AntMediaPlayer({ url: wsUrl, streamId: id, token: auth, ...options });
    }
    session.current = next;
    setAudioOnly(false);
    setPlaying(true);
    next.start();
  };

  const stop = () => {
    session.current?.stop();
    session.current = null;
    setPlaying(false);
    setStream(null);
    setStats(null);
    setAudioOnly(false);
  };

  const toggleLeveller = (enabled: boolean) => {
    livestreamAudio.levellerEnabled = enabled;
    setLeveller(livestreamAudio.levellerEnabled);
  };

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 32 }} keyboardShouldPersistTaps="handled">
      {/* Portrait streams letterboxed at 3:4, so the controls stay on screen. */}
      <View style={[styles.video, { aspectRatio: Math.max(aspectRatio, 3 / 4) }]}>
        {stream ? (
          <RTCView
            style={{ flex: 1 }}
            streamURL={stream.toURL()}
            objectFit="contain"
            pictureInPictureEnabled
            autoStartPictureInPicture
            onDimensionsChange={({ width, height }) => width > 0 && height > 0 && setAspectRatio(width / height)}
          />
        ) : null}
        {!stream || audioOnly ? (
          <View style={styles.videoOverlay}>
            <Text style={styles.videoOverlayText}>
              {audioOnly ? 'Weak connection: audio only.\nThe video comes back when it can.' : placeholder(status.state)}
            </Text>
          </View>
        ) : null}
      </View>

      <Card>
        <StatusLine state={status.state} reason={status.reason} />
        {stats ? <Text style={styles.hint}>{qualityLine(stats)}</Text> : null}
        <Segmented options={SOURCES} value={source} onChange={setSource} disabled={playing} />
        {source === 'whep' ? (
          <Field
            label="WHEP URL"
            value={url}
            onChangeText={setUrl}
            placeholder="http://192.168.1.10:8889/live/whep"
            editable={!playing}
          />
        ) : (
          <>
            <Field
              label="Signalling URL"
              value={signalingUrl}
              onChangeText={setSignalingUrl}
              placeholder="wss://host:5443/live/websocket"
              editable={!playing}
            />
            <Field label="Stream ID" value={streamId} onChangeText={setStreamId} editable={!playing} />
          </>
        )}
        <Field label="Token (optional)" value={token} onChangeText={setToken} editable={!playing} secure />
        <Toggle label="Audio only on a weak connection" value={fallback} onChange={setFallback} />
        <View style={styles.buttons}>
          {playing ? <Button title="Stop" kind="secondary" onPress={stop} /> : <Button title="Watch" onPress={() => play()} />}
        </View>
      </Card>

      <Card title="Audio">
        {audio ? (
          <>
            <Toggle label="Voice leveller" value={leveller} onChange={toggleLeveller} />
            {levels ? (
              <>
                <Meter label="In" db={levels.inputPeakDb} />
                <Meter label="Out" db={levels.outputPeakDb} />
                <Text style={styles.hint}>Gain reduction {levels.maxReductionDb.toFixed(1)} dB</Text>
              </>
            ) : null}
            <Text style={styles.hint}>
              Livestream audio · {audio.playoutDelayMs > 0 ? `${audio.playoutDelayMs} ms behind live` : 'no playout delay'}
              {' · '}leveller +{audio.levellerInputGainDb} dB
              {audio.networkResilience ? ' · network resilience' : ''}
            </Text>
          </>
        ) : (
          <Text style={styles.hint}>Livestream audio is off: libwebrtc's call audio.</Text>
        )}
      </Card>

      {stats ? (
        <Card title="Stream">
          <Stats items={viewerStats(stats)} />
        </Card>
      ) : null}
    </ScrollView>
  );
}

function placeholder(state: LivestreamState): string {
  switch (state) {
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      return 'Waiting for video…';
    case 'offline':
      return 'Not live yet';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'failed':
      return 'Could not play';
    default:
      return 'Enter a stream and press Watch';
  }
}

const LIMITATIONS: Record<LivestreamQualityLimitation, string> = {
  none: '',
  network: 'your connection',
  source: "the host's stream",
  device: 'this phone',
};

function qualityLine(stats: LivestreamStats): string {
  const quality = stats.quality[0].toUpperCase() + stats.quality.slice(1);
  const limitation = LIMITATIONS[stats.qualityLimitation];
  return `Quality: ${quality}${limitation ? `, held back by ${limitation}` : ''}`;
}

function viewerStats(stats: LivestreamStats): [string, string][] {
  const { video, audio } = stats.inbound;
  const items: [string, string][] = [];
  if (video) {
    items.push(
      ['Video', `${video.width}×${video.height} · ${Math.round(video.fps)} fps`],
      ['Video codec', `${video.codec ?? '—'} · ${Math.round(video.kbps)} kbps`],
      ['Video buffer', `${Math.round(video.jitterBufferMs)} ms`],
      ['Video loss', `${video.lossPercent.toFixed(1)} %`],
      ['Frozen', `${Math.round(video.frozenPercent)} % · ${video.freezeCount} freezes, ${video.freezeSeconds.toFixed(1)} s`],
      ['Resends asked', `${video.nackCount} · ${video.pliCount} keyframes`]
    );
  } else {
    items.push(['Video', 'none']);
  }
  if (audio) {
    items.push(
      ['Audio', `${audio.codec ?? '—'} · ${Math.round(audio.kbps)} kbps`],
      ['Audio buffer', `${Math.round(audio.jitterBufferMs)} ms`],
      ['Audio loss', `${audio.lossPercent.toFixed(1)} %`],
      ['Concealed', `${audio.concealedPercent.toFixed(1)} %`]
    );
  } else {
    items.push(['Audio', 'none']);
  }
  items.push(
    ['Downlink estimate', stats.availableIncomingKbps !== null ? `${Math.round(stats.availableIncomingKbps)} kbps` : '—'],
    ['Round trip', stats.rttMs !== null ? `${Math.round(stats.rttMs)} ms` : '—'],
    ['Route', stats.route ? `${stats.route.local} → ${stats.route.remote} · ${stats.route.protocol}` : '—']
  );
  return items;
}
