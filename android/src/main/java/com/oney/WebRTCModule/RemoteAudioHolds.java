package com.oney.WebRTCModule;

import android.util.SparseArray;

import org.webrtc.AudioTrack;
import org.webrtc.MediaStream;
import org.webrtc.MediaStreamTrack;

import java.util.HashMap;
import java.util.Map;

/**
 * Remote audio held silent: a view holds the stream it shows while it is muted. Holds count, so a
 * stream's audio plays again once every hold on it has let go. An audio track that joins a held
 * stream is held with it, and a track JS enables or disables meanwhile takes that state when the
 * hold ends. Only used on the WebRTC executor.
 */
final class RemoteAudioHolds {
    private final SparseArray<PeerConnectionObserver> peerConnectionObservers;

    /** How many holds each stream's remote audio has, by the stream's react tag. */
    private final Map<String, Integer> streamHolds = new HashMap<>();

    /** Remote audio tracks held silent, by {@link #key}: whether each is enabled when the hold ends. */
    private final Map<String, Boolean> enabledAfterHold = new HashMap<>();

    RemoteAudioHolds(SparseArray<PeerConnectionObserver> peerConnectionObservers) {
        this.peerConnectionObservers = peerConnectionObservers;
    }

    /** Adds a hold on the stream's remote audio, or lets go of one. */
    void setHeld(String streamReactTag, boolean held) {
        int count = streamHolds.getOrDefault(streamReactTag, 0);
        if (held) {
            streamHolds.put(streamReactTag, count + 1);
        } else if (count > 1) {
            streamHolds.put(streamReactTag, count - 1);
        } else {
            streamHolds.remove(streamReactTag);
        }

        // Only the first hold and the last release change what plays.
        if (held ? count > 0 : count != 1) {
            return;
        }

        for (int i = 0, size = peerConnectionObservers.size(); i < size; i++) {
            PeerConnectionObserver pco = peerConnectionObservers.valueAt(i);
            MediaStream stream = pco.remoteStreams.get(streamReactTag);
            if (stream == null) {
                continue;
            }
            for (AudioTrack track : stream.audioTracks) {
                update(peerConnectionObservers.keyAt(i), pco, track);
            }
        }
    }

    /** Holds a remote track that joins a held stream, if it is audio. */
    void onTrackAdded(int pcId, PeerConnectionObserver pco, MediaStreamTrack track) {
        if (track instanceof AudioTrack) {
            update(pcId, pco, (AudioTrack) track);
        }
    }

    /**
     * Keeps the state JS sets on a held track for when its hold ends.
     *
     * @return Whether the track is held, so the state has to wait.
     */
    boolean setEnabledAfterHold(int pcId, MediaStreamTrack track, boolean enabled) {
        String key = key(pcId, track.id());
        if (!enabledAfterHold.containsKey(key)) {
            return false;
        }
        enabledAfterHold.put(key, enabled);
        return true;
    }

    /** Forgets the held tracks of a peer connection that is going away. */
    void forget(int pcId) {
        String prefix = key(pcId, "");
        enabledAfterHold.keySet().removeIf(key -> key.startsWith(prefix));
    }

    /** Holds the track while a held stream of its peer connection has it, and lets it play otherwise. */
    private void update(int pcId, PeerConnectionObserver pco, AudioTrack track) {
        String trackId = track.id();

        // A track can be in more than one stream.
        boolean held = false;
        for (String streamReactTag : streamHolds.keySet()) {
            MediaStream stream = pco.remoteStreams.get(streamReactTag);
            if (stream != null && hasAudioTrack(stream, trackId)) {
                held = true;
                break;
            }
        }

        String key = key(pcId, trackId);
        Boolean enabled = enabledAfterHold.get(key);
        if (held && enabled == null) {
            enabledAfterHold.put(key, track.enabled());
            track.setEnabled(false);
        } else if (!held && enabled != null) {
            enabledAfterHold.remove(key);
            track.setEnabled(enabled);
        }
    }

    private static boolean hasAudioTrack(MediaStream stream, String trackId) {
        for (AudioTrack track : stream.audioTracks) {
            if (track.id().equals(trackId)) {
                return true;
            }
        }
        return false;
    }

    /** Track IDs come from the remote side, so two peer connections can share one. */
    private static String key(int pcId, String trackId) {
        return pcId + "/" + trackId;
    }
}
