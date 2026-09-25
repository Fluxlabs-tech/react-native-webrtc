import { Platform, TurboModuleRegistry } from 'react-native';
import type { TurboModule } from 'react-native';
import type { EventEmitter, Int32, UnsafeObject } from 'react-native/Libraries/Types/CodegenTypes';

/**
 * The TurboModule's interface, read by React Native's codegen.
 *
 * Peer connection ids are Int32. Objects cross as UnsafeObject (NSDictionary / ReadableMap), shaped
 * by the native side. Methods returning a value (not a Promise) are synchronous.
 */
export interface Spec extends TurboModule {
    // Events: EventEmitter.ts subscribes to each once and re-emits it in JS.
    readonly peerConnectionSignalingStateChanged: EventEmitter<UnsafeObject>;
    readonly peerConnectionStateChanged: EventEmitter<UnsafeObject>;
    readonly peerConnectionOnRenegotiationNeeded: EventEmitter<UnsafeObject>;
    readonly peerConnectionIceConnectionChanged: EventEmitter<UnsafeObject>;
    readonly peerConnectionIceGatheringChanged: EventEmitter<UnsafeObject>;
    readonly peerConnectionGotICECandidate: EventEmitter<UnsafeObject>;
    readonly peerConnectionDidOpenDataChannel: EventEmitter<UnsafeObject>;
    readonly peerConnectionOnRemoveTrack: EventEmitter<UnsafeObject>;
    readonly peerConnectionOnTrack: EventEmitter<UnsafeObject>;
    readonly dataChannelStateChanged: EventEmitter<UnsafeObject>;
    readonly dataChannelReceiveMessage: EventEmitter<UnsafeObject>;
    readonly dataChannelDidChangeBufferedAmount: EventEmitter<UnsafeObject>;
    readonly mediaStreamTrackMuteChanged: EventEmitter<UnsafeObject>;
    readonly mediaStreamTrackEnded: EventEmitter<UnsafeObject>;
    readonly livestreamNetworkChanged: EventEmitter<UnsafeObject>;

    // Picture-in-picture.
    isInPictureInPicture(): boolean;
    isPictureInPictureSupported(): Promise<boolean>;

    // Livestream audio: the audio device the peer connection factory was built with. See
    // livestream/LivestreamAudio.ts.
    livestreamAudioState(): UnsafeObject;
    livestreamAudioSetLevellerEnabled(enabled: boolean): boolean;
    livestreamAudioTakeLevels(): UnsafeObject | null;

    // The device's network, followed while livestream sessions or the app listen. See
    // livestream/LivestreamNetwork.ts.
    livestreamNetworkStart(): void;
    livestreamNetworkStop(): void;
    livestreamNetworkState(): UnsafeObject | null;

    // Permissions and audio session, iOS only.
    checkPermission(mediaType: string): Promise<string>;
    requestPermission(mediaType: string): Promise<boolean>;
    audioSessionDidActivate(): void;
    audioSessionDidDeactivate(): void;

    // RTCPeerConnection.
    peerConnectionInit(configuration: UnsafeObject | null, objectID: Int32): boolean;
    peerConnectionSetConfiguration(configuration: UnsafeObject, objectID: Int32): void;
    peerConnectionCreateOffer(pcId: Int32, options: UnsafeObject): Promise<UnsafeObject>;
    peerConnectionCreateAnswer(pcId: Int32, options: UnsafeObject): Promise<UnsafeObject>;
    peerConnectionSetLocalDescription(pcId: Int32, desc: UnsafeObject | null): Promise<UnsafeObject>;
    peerConnectionSetRemoteDescription(pcId: Int32, desc: UnsafeObject): Promise<UnsafeObject>;
    peerConnectionAddICECandidate(pcId: Int32, candidate: UnsafeObject): Promise<UnsafeObject>;
    peerConnectionGetStats(pcId: Int32): Promise<string>;
    peerConnectionClose(pcId: Int32): void;
    peerConnectionDispose(pcId: Int32): void;
    peerConnectionRestartIce(pcId: Int32): void;
    peerConnectionAddTrack(pcId: Int32, trackId: string, options: UnsafeObject): UnsafeObject | null;
    peerConnectionAddTransceiver(pcId: Int32, options: UnsafeObject): UnsafeObject | null;
    peerConnectionRemoveTrack(pcId: Int32, senderId: string): boolean;
    generateCertificate(options: UnsafeObject): Promise<UnsafeObject>;

    // RTCRtpSender, RTCRtpReceiver and RTCRtpTransceiver.
    senderGetCapabilities(kind: string): UnsafeObject;
    receiverGetCapabilities(kind: string): UnsafeObject;
    senderGetStats(pcId: Int32, senderId: string): Promise<string>;
    receiverGetStats(pcId: Int32, receiverId: string): Promise<string>;
    senderReplaceTrack(pcId: Int32, senderId: string, trackId: string | null): Promise<boolean>;
    senderSetParameters(pcId: Int32, senderId: string, options: UnsafeObject): Promise<UnsafeObject>;
    transceiverSetDirection(pcId: Int32, senderId: string, direction: string): Promise<boolean>;
    transceiverStop(pcId: Int32, senderId: string): Promise<boolean>;
    transceiverSetCodecPreferences(pcId: Int32, senderId: string, codecPreferences: UnsafeObject[]): boolean;

    // RTCDataChannel.
    createDataChannel(pcId: Int32, label: string, config: UnsafeObject | null): UnsafeObject | null;
    dataChannelClose(pcId: Int32, reactTag: string): void;
    dataChannelDispose(pcId: Int32, reactTag: string): void;
    dataChannelSend(pcId: Int32, reactTag: string, data: string, type: string): void;

    // MediaStream, MediaStreamTrack and devices. A track's pcId is -1 for local tracks.
    getUserMedia(
        constraints: UnsafeObject,
        successCallback: (streamId: string, tracks: UnsafeObject[]) => void,
        errorCallback: (type: string, message: string) => void
    ): void;
    getDisplayMedia(constraints: UnsafeObject): Promise<UnsafeObject>;
    enumerateDevices(callback: (devices: UnsafeObject[]) => void): void;
    mediaStreamCreate(streamId: string): void;
    mediaStreamAddTrack(streamId: string, pcId: Int32, trackId: string): void;
    mediaStreamRemoveTrack(streamId: string, pcId: Int32, trackId: string): void;
    mediaStreamRelease(streamId: string): void;
    mediaStreamTrackRelease(trackId: string): void;
    mediaStreamTrackSetEnabled(pcId: Int32, trackId: string, enabled: boolean): void;
    mediaStreamTrackApplyConstraints(trackId: string, constraints: UnsafeObject): Promise<UnsafeObject>;
    mediaStreamTrackSetVolume(pcId: Int32, trackId: string, volume: number): void;
    mediaStreamTrackSetVideoEffects(trackId: string, names: string[]): void;
}

declare const global: { RN$Bridgeless?: boolean; __turboModuleProxy?: unknown };

// The New Architecture runs bridgeless, or on older setups loads TurboModules through
// __turboModuleProxy. On the old architecture the module would load through the bridge, where its
// events cannot reach JS: say so instead of failing later.
if (global.RN$Bridgeless !== true && !global.__turboModuleProxy) {
    throw new Error('react-native-webrtc needs the New Architecture (React Native 0.76 or later).');
}

const WebRTCModule = TurboModuleRegistry.get<Spec>('WebRTCModule');

if (WebRTCModule === null) {
    throw new Error(`WebRTC native module not found.\n${Platform.OS === 'ios' ?
        'Try executing the "pod install" command inside your projects ios folder.' :
        'Try executing the "npm install" command inside your projects folder.'
    }`);
}

// Object results are any to the JS code, as every result was before this spec; arguments keep the
// spec's types.
type LooseResult<T> = T extends Promise<infer R> ? Promise<LooseResult<R>> : T extends object ? any : T;
type LooseModule<T> = {
    [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => LooseResult<R> : T[K];
};

export default WebRTCModule as LooseModule<Spec>;
