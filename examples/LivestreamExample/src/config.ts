import type { RTCIceServer } from 'react-native-webrtc';

/**
 * Starting values for the fields, so a test server need not be typed on the phone. Set them in a
 * gitignored `.env.local` (see `.env.example`); Expo inlines them when it bundles, so restart
 * Metro after a change.
 */
export const DEFAULTS = {
  whepUrl: process.env.EXPO_PUBLIC_WHEP_URL ?? '',
  whipUrl: process.env.EXPO_PUBLIC_WHIP_URL ?? '',
  antMediaUrl: process.env.EXPO_PUBLIC_ANT_MEDIA_URL ?? '',
  streamId: process.env.EXPO_PUBLIC_STREAM_ID ?? '',
  token: process.env.EXPO_PUBLIC_TOKEN ?? '',
};

const iceServer = process.env.EXPO_PUBLIC_ICE_SERVER;

/** None by default: a server on a public address needs none. */
export const ICE_SERVERS: RTCIceServer[] = iceServer ? [{ urls: iceServer }] : [];
