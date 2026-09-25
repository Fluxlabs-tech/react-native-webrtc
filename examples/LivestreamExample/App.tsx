import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import GoLiveScreen from './src/GoLiveScreen';
import WatchScreen from './src/WatchScreen';
import { Segmented, colors } from './src/ui';

type Tab = 'watch' | 'live';

const TABS: { value: Tab; label: string }[] = [
  { value: 'watch', label: 'Watch' },
  { value: 'live', label: 'Go live' },
];

/**
 * A stream to open, from a link:
 *
 * - `webrtclivestream://watch?url=<WHEP URL>`
 * - `webrtclivestream://watch?url=<Ant Media WebSocket URL>&stream=<stream ID>`
 * - `webrtclivestream://live?url=<WHIP URL>`
 *
 * With `&token=` for either, `&fallback=0|1` for the audio-only fallback, and `…://watch?stop=1`
 * to stop.
 */
export type StreamLink = {
  url?: string;
  streamId?: string;
  token?: string;
  fallback?: boolean;
  stop?: boolean;
  id: number;
};

function parseLink(link: string | null): { tab: Tab; stream: StreamLink } | null {
  const match = link ? /^webrtclivestream:\/\/(watch|live)\?(.*)$/.exec(link) : null;
  if (!match) return null;
  const params = new Map(
    match[2].split('&').map((pair) => {
      const [key, value = ''] = pair.split('=');
      return [key, decodeURIComponent(value)] as const;
    })
  );
  const url = params.get('url');
  const stop = params.get('stop') === '1';
  if (!url && !stop) return null;
  const fallback = params.get('fallback');
  return {
    tab: match[1] === 'watch' ? 'watch' : 'live',
    stream: {
      url,
      streamId: params.get('stream'),
      token: params.get('token'),
      fallback: fallback === undefined ? undefined : fallback === '1',
      stop,
      id: Date.now(),
    },
  };
}

/**
 * A livestream viewer and host on react-native-webrtc. One tab at a time: the other stops, so a
 * phone never plays its own microphone back into itself.
 */
export default function App() {
  const [tab, setTab] = useState<Tab>('watch');
  // For the tab it opened; dropped when the user changes tabs, so it is not opened again.
  const [link, setLink] = useState<StreamLink | null>(null);

  const changeTab = (next: Tab) => {
    setLink(null);
    setTab(next);
  };

  useEffect(() => {
    const open = (url: string | null) => {
      const parsed = parseLink(url);
      if (!parsed) return;
      setTab(parsed.tab);
      setLink(parsed.stream);
    };
    Linking.getInitialURL().then(open);
    const subscription = Linking.addEventListener('url', ({ url }) => open(url));
    return () => subscription.remove();
  }, []);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['top', 'left', 'right']}>
        <StatusBar style="dark" />
        <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 10 }}>
          <Text style={{ fontSize: 22, fontWeight: '700', color: colors.text }}>Livestream</Text>
          <Segmented options={TABS} value={tab} onChange={changeTab} />
        </View>
        {tab === 'watch' ? <WatchScreen link={link} /> : <GoLiveScreen link={link} />}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
