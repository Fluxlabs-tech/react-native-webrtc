import { useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, Text, View } from 'react-native';
import {
  LIVESTREAM_HOST_AUDIO_CONSTRAINTS,
  RTCView,
  WHIPClient,
  livestreamAudio,
  mediaDevices,
  type LivestreamPublishOptions,
  type LivestreamState,
  type LivestreamStats,
  type MediaStream,
} from 'react-native-webrtc';

import type { StreamLink } from '../App';
import { DEFAULTS, ICE_SERVERS } from './config';
import { Button, Card, Field, Segmented, Stats, StatusLine, Toggle, styles } from './ui';

type Microphone = keyof typeof LIVESTREAM_HOST_AUDIO_CONSTRAINTS;
type Quality = 'high' | 'medium' | 'low';

const MICROPHONES: { value: Microphone; label: string }[] = [
  { value: 'voice', label: 'Voice' },
  { value: 'studio', label: 'Studio' },
];

const QUALITIES: { value: Quality; label: string }[] = [
  { value: 'high', label: '2.5 Mbps' },
  { value: 'medium', label: '1.2 Mbps' },
  { value: 'low', label: '600 kbps' },
];

const BITRATES: Record<Quality, number> = { high: 2500, medium: 1200, low: 600 };

/**
 * A host: camera and microphone, published over WHIP, to any server that takes it (Ant Media's is
 * `https://<host>:5443/<app>/whip/<stream ID>`).
 */
export default function GoLiveScreen({ link }: { link: StreamLink | null }) {
  const [url, setUrl] = useState(DEFAULTS.whipUrl);
  const [token, setToken] = useState(DEFAULTS.token);
  const [microphone, setMicrophone] = useState<Microphone>('voice');
  const [quality, setQuality] = useState<Quality>('high');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [live, setLive] = useState(false);
  const [status, setStatus] = useState<{ state: LivestreamState; reason?: string }>({ state: 'idle' });
  const [stats, setStats] = useState<LivestreamStats | null>(null);
  const session = useRef<WHIPClient | null>(null);
  const pendingLink = useRef<StreamLink | null>(null);

  const audio = livestreamAudio.config;

  // The camera and microphone, again when the microphone preset changes: audio processing is
  // fixed when the track is created.
  useEffect(() => {
    let cancelled = false;
    let acquired: MediaStream | null = null;
    const audioConstraints = LIVESTREAM_HOST_AUDIO_CONSTRAINTS[microphone];

    (async () => {
      setCaptureError(null);
      // Without a camera (the iOS simulator), the microphone alone. getUserMedia would otherwise
      // give a video track that never has a frame, and servers drop a publisher whose tracks stay
      // silent.
      const devices = (await mediaDevices.enumerateDevices().catch(() => [])) as { kind: string }[];
      const hasCamera = devices.some((device) => device.kind === 'videoinput');
      try {
        acquired = await mediaDevices.getUserMedia({
          audio: audioConstraints,
          video: hasCamera ? { facingMode: 'user', width: 1280, height: 720, frameRate: 30 } : false,
        });
      } catch (error) {
        setCaptureError(`No camera or microphone: ${String(error)}`);
        return;
      }
      if (!hasCamera) setCaptureError('No camera: publishing audio only.');
      if (cancelled) {
        acquired.release();
        return;
      }
      setFacing('user');
      setMicOn(true);
      setCameraOn(true);
      setStream(acquired);
    })();

    return () => {
      cancelled = true;
      acquired?.release();
      setStream(null);
    };
  }, [microphone]);

  useEffect(() => () => session.current?.stop(), []);

  // A stream opened from a link: go live to it once the camera is up.
  useEffect(() => {
    if (!link?.url) return;
    pendingLink.current = link;
    setUrl(link.url);
    if (link.token) setToken(link.token);
  }, [link?.id]);

  useEffect(() => {
    const linked = pendingLink.current;
    if (!stream || !linked) return;
    pendingLink.current = null;
    // In place of a stream already live.
    session.current?.stop();
    goLive(linked);
  }, [stream, link?.id]);

  const videoTrack = stream?.getVideoTracks()[0];
  const audioTrack = stream?.getAudioTracks()[0];

  const goLive = (linked?: StreamLink) => {
    if (!stream) return;
    const whipUrl = (linked?.url ?? url).trim();
    const auth = (linked?.token ?? token).trim() || undefined;
    const publish: LivestreamPublishOptions = { video: { maxBitrateKbps: BITRATES[quality] } };
    if (!whipUrl) return setStatus({ state: 'idle', reason: 'enter a WHIP URL' });
    const next = new WHIPClient({
      url: whipUrl,
      token: auth,
      iceServers: ICE_SERVERS,
      stream,
      ...publish,
      onStateChange: (state: LivestreamState, reason?: string) => {
        setStatus({ state, reason });
        if (state !== 'connected') setStats(null);
        if (state === 'failed') setLive(false);
      },
      onStats: setStats,
    });
    session.current = next;
    setLive(true);
    next.start();
  };

  const end = () => {
    session.current?.stop();
    session.current = null;
    setLive(false);
    setStats(null);
  };

  const flipCamera = () => {
    if (!videoTrack) return;
    const next = facing === 'user' ? 'environment' : 'user';
    videoTrack
      .applyConstraints({ facingMode: next })
      .then(() => setFacing(next))
      .catch(() => {});
  };

  const toggleMic = (on: boolean) => {
    if (audioTrack) audioTrack.enabled = on;
    setMicOn(on);
  };

  const toggleCamera = (on: boolean) => {
    // Disabled, a video track sends black frames: the stream carries on.
    if (videoTrack) videoTrack.enabled = on;
    setCameraOn(on);
  };

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 32 }} keyboardShouldPersistTaps="handled">
      <View style={[styles.video, { aspectRatio: 3 / 4 }]}>
        {stream && videoTrack ? (
          <RTCView style={{ flex: 1 }} streamURL={stream.toURL()} objectFit="cover" mirror={facing === 'user'} />
        ) : (
          <View style={styles.videoOverlay}>
            <Text style={styles.videoOverlayText}>{captureError ?? 'Starting the camera…'}</Text>
          </View>
        )}
      </View>

      <Card>
        <StatusLine state={status.state} reason={status.reason} />
        <Field
          label="WHIP URL"
          value={url}
          onChangeText={setUrl}
          placeholder="https://host:5443/live/whip/stream1"
          editable={!live}
        />
        <Field label="Token (optional)" value={token} onChangeText={setToken} editable={!live} secure />
        <View style={styles.buttons}>
          {live ? (
            <Button title="End stream" kind="secondary" onPress={end} />
          ) : (
            <Button title="Go live" onPress={() => goLive()} disabled={!stream} />
          )}
        </View>
      </Card>

      <Card title="Camera and microphone">
        <View style={styles.buttons}>
          <Button title="Flip camera" kind="secondary" onPress={flipCamera} disabled={!videoTrack} />
        </View>
        <Toggle label="Microphone" value={micOn} onChange={toggleMic} />
        <Toggle label="Camera" value={cameraOn} onChange={toggleCamera} />
        <Text style={styles.label}>Microphone processing</Text>
        <Segmented options={MICROPHONES} value={microphone} onChange={setMicrophone} disabled={live} />
        <Text style={styles.hint}>
          {microphone === 'voice'
            ? 'Noise suppression and gain control, no echo cancellation: a host talking.'
            : 'No processing: music, or a good microphone in a quiet room.'}
        </Text>
        <Text style={styles.label}>Video bitrate</Text>
        <Segmented options={QUALITIES} value={quality} onChange={setQuality} disabled={live} />
        <Text style={styles.hint}>
          {audio
            ? `Livestream audio: the microphone as it sounds${
                Platform.OS === 'android' ? `, from the ${audio.audioSource ?? 'mic'} source` : ''
              }.`
            : "Livestream audio is off: libwebrtc's call audio, with echo cancellation."}
        </Text>
      </Card>

      {stats ? (
        <Card title="Outgoing">
          <Stats items={hostStats(stats)} />
        </Card>
      ) : null}
    </ScrollView>
  );
}

function hostStats(stats: LivestreamStats): [string, string][] {
  const { video, audio } = stats.outbound;
  const items: [string, string][] = [['Quality', `${stats.quality} · ${stats.qualityLimitation}`]];
  if (video) {
    items.push(
      ['Video', `${video.width}×${video.height} · ${Math.round(video.fps)} fps`],
      ['Video codec', `${video.codec ?? '—'} · ${Math.round(video.kbps)} kbps`],
      ['Limited by', video.qualityLimitationReason],
      ['Lost at server', `${video.remoteLossPercent.toFixed(1)} %`],
      ['Resends asked', `${video.nackCount} · ${video.pliCount} keyframes`]
    );
  }
  if (audio) {
    items.push(['Audio', `${audio.codec ?? '—'} · ${Math.round(audio.kbps)} kbps`]);
  }
  items.push(
    ['Bandwidth', stats.availableOutgoingKbps !== null ? `${Math.round(stats.availableOutgoingKbps)} kbps` : '—'],
    ['Round trip', stats.rttMs !== null ? `${Math.round(stats.rttMs)} ms` : '—'],
    ['Route', stats.route ? `${stats.route.local} → ${stats.route.remote} · ${stats.route.protocol}` : '—']
  );
  return items;
}
