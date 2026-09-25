import { EmitterSubscription } from 'react-native';
// @ts-ignore
import EventEmitter from 'react-native/Libraries/vendor/emitter/EventEmitter';

import WebRTCModule from './NativeWebRTCModule';

// Each of these is an event emitter of the TurboModule (see NativeWebRTCModule.ts). They are
// listened to once, and re-emitted on a JS-only emitter.
const NATIVE_EVENTS = [
    'peerConnectionSignalingStateChanged',
    'peerConnectionStateChanged',
    'peerConnectionOnRenegotiationNeeded',
    'peerConnectionIceConnectionChanged',
    'peerConnectionIceGatheringChanged',
    'peerConnectionGotICECandidate',
    'peerConnectionDidOpenDataChannel',
    'peerConnectionOnRemoveTrack',
    'peerConnectionOnTrack',
    'dataChannelStateChanged',
    'dataChannelReceiveMessage',
    'dataChannelDidChangeBufferedAmount',
    'mediaStreamTrackMuteChanged',
    'mediaStreamTrackEnded',
    'livestreamNetworkChanged',
] as const;

type NativeEvent = typeof NATIVE_EVENTS[number];

const eventEmitter = new EventEmitter();

export function setupNativeEvents() {
    for (const eventName of NATIVE_EVENTS) {
        WebRTCModule[eventName](event => {
            eventEmitter.emit(eventName, event);
        });
    }
}

type EventHandler = (event: unknown) => void;
type Listener = unknown;

const _subscriptions: Map<Listener, EmitterSubscription[]> = new Map();

export function addListener(listener: Listener, eventName: string, eventHandler: EventHandler): void {
    if (!NATIVE_EVENTS.includes(eventName as NativeEvent)) {
        throw new Error(`Invalid event: ${eventName}`);
    }

    if (!_subscriptions.has(listener)) {
        _subscriptions.set(listener, []);
    }

    _subscriptions.get(listener)?.push(eventEmitter.addListener(eventName, eventHandler));
}

export function removeListener(listener: Listener): void {
    _subscriptions.get(listener)?.forEach(sub => {
        sub.remove();
    });

    _subscriptions.delete(listener);
}
