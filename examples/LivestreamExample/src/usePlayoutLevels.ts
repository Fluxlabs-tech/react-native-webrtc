import { useEffect, useState } from 'react';
import { livestreamAudio, type LivestreamAudioLevels } from 'react-native-webrtc';

const INTERVAL_MS = 250;

/**
 * The leveller's peaks, a few times a second while `active`. Stays null on Android, whose effect
 * has no metering.
 */
export function usePlayoutLevels(active: boolean): LivestreamAudioLevels | null {
  const [levels, setLevels] = useState<LivestreamAudioLevels | null>(null);

  useEffect(() => {
    setLevels(null);
    if (!active || !livestreamAudio.isInstalled) return;
    const timer = setInterval(() => {
      const next = livestreamAudio.takeLevels();
      if (next) setLevels(next);
    }, INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active]);

  return levels;
}
