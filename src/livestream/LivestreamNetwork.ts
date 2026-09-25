import { addListener, removeListener } from '../EventEmitter';
import WebRTCModule from '../NativeWebRTCModule';

/** What carries the device's traffic; `none` while offline. */
export type LivestreamNetworkType = 'wifi' | 'cellular' | 'ethernet' | 'other' | 'none';

export type LivestreamNetworkState = {
    /** There is a route out: an interface that is up. */
    online: boolean;
    type: LivestreamNetworkType;
    /** Metered: cellular, or a phone's hotspot. */
    expensive: boolean;
    /** The user asked to save data: Low Data Mode on iOS, Data Saver on Android. */
    constrained: boolean;
    /** Changes whenever the device moves to another network, of the same type or not. */
    id: number;
};

type Listener = (state: LivestreamNetworkState) => void;

const listeners = new Set<Listener>();

// Owns the native event subscription, for EventEmitter.
const subscriber = {};

let latest: LivestreamNetworkState | null = null;

function normalize(value: any): LivestreamNetworkState | null {
    if (!value || typeof value.online !== 'boolean') {
        return null;
    }

    return {
        online: value.online,
        type: value.type ?? 'other',
        expensive: Boolean(value.expensive),
        constrained: Boolean(value.constrained),
        id: Number(value.id ?? 0)
    };
}

function read(): LivestreamNetworkState | null {
    try {
        return normalize(WebRTCModule.livestreamNetworkState());
    } catch {
        return null;
    }
}

function onNativeChange(event: unknown): void {
    const state = normalize(event);

    if (!state) {
        return;
    }

    latest = state;

    for (const listener of [ ...listeners ]) {
        listener(state);
    }
}

/**
 * The device's network, as livestream sessions follow it: while offline they wait for a network
 * rather than use up retries, and they connect again the moment one is back, or when the device
 * moves to another. Also for an app's own use: an offline banner, or a lower quality on a metered
 * or constrained network.
 *
 * Followed only while something listens.
 */
const livestreamNetwork = {
    /** The latest state; null until the platform has reported one, and while nothing listens. */
    get state(): LivestreamNetworkState | null {
        return latest;
    },

    /** Calls `listener` on each change. Returns the function that stops it. */
    addListener(listener: Listener): () => void {
        if (listeners.size === 0) {
            addListener(subscriber, 'livestreamNetworkChanged', onNativeChange);
            WebRTCModule.livestreamNetworkStart();
            latest = read();
        }

        listeners.add(listener);

        return () => {
            if (!listeners.delete(listener) || listeners.size > 0) {
                return;
            }

            WebRTCModule.livestreamNetworkStop();
            removeListener(subscriber);
            latest = null;
        };
    }
};

export default livestreamNetwork;
