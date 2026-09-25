import { setupNativeEvents } from './EventEmitter';
import Logger from './Logger';
import mediaDevices from './MediaDevices';
import MediaStream from './MediaStream';
import MediaStreamTrack, { type MediaTrackSettings } from './MediaStreamTrack';
import MediaStreamTrackEvent from './MediaStreamTrackEvent';
import WebRTCModule from './NativeWebRTCModule';
import permissions from './Permissions';
import RTCAudioSession from './RTCAudioSession';
import RTCCertificate from './RTCCertificate';
import RTCErrorEvent from './RTCErrorEvent';
import RTCIceCandidate from './RTCIceCandidate';
import RTCPIPView, { startIOSPIP, stopIOSPIP, type RTCIOSPIPOptions } from './RTCPIPView';
import RTCPeerConnection, { type RTCConfiguration, type RTCIceServer } from './RTCPeerConnection';
import RTCRtpEncodingParameters, { type RTCRtpEncodingParametersInit } from './RTCRtpEncodingParameters';
import RTCRtpReceiver from './RTCRtpReceiver';
import RTCRtpSendParameters, { type RTCRtpSendParametersInit } from './RTCRtpSendParameters';
import RTCRtpSender from './RTCRtpSender';
import RTCRtpTransceiver from './RTCRtpTransceiver';
import RTCSessionDescription from './RTCSessionDescription';
import RTCView, { type RTCVideoViewProps } from './RTCView';
import ScreenCapturePickerView from './ScreenCapturePickerView';
import {
    LIVESTREAM_HOST_AUDIO_CONSTRAINTS,
    LIVESTREAM_VIEWER_CONFIGURATION,
    LivestreamSession,
    LivestreamStatsSampler,
    LivestreamViewer,
    WHEPClient,
    WHIPClient,
    addLivestreamTracks,
    addOpusNack,
    applyLivestreamSenderParameters,
    livestreamAudio,
    livestreamNetwork,
    removeHeaderExtension,
    setOpusParameters,
    setVideoParameters,
    tuneLivestreamAnswer,
    tuneLivestreamOffer,
    type HttpSignallingOptions,
    type InboundAudioStats,
    type InboundVideoStats,
    type LivestreamAudioConfig,
    type LivestreamAudioLevels,
    type LivestreamAudioOptions,
    type LivestreamNetworkState,
    type LivestreamNetworkType,
    type LivestreamPublishOptions,
    type LivestreamQuality,
    type LivestreamQualityLimitation,
    type LivestreamReconnectOptions,
    type LivestreamSessionOptions,
    type LivestreamState,
    type LivestreamStats,
    type LivestreamStatsHints,
    type LivestreamVideoCodec,
    type LivestreamVideoOptions,
    type LivestreamViewerOptions,
    type OutboundAudioStats,
    type OutboundVideoStats,
    type RefusalHandling,
    type WHEPClientOptions,
    type WHIPClientOptions
} from './livestream';

Logger.enable(`${Logger.ROOT_PREFIX}:*`);

// Add listeners for the native events early, since they are added asynchronously.
setupNativeEvents();

export {
    RTCIceCandidate,
    RTCPeerConnection,
    RTCSessionDescription,
    RTCCertificate,
    RTCView,
    RTCPIPView,
    ScreenCapturePickerView,
    RTCRtpEncodingParameters,
    RTCRtpTransceiver,
    RTCRtpReceiver,
    RTCRtpSender,
    RTCRtpSendParameters,
    RTCErrorEvent,
    RTCAudioSession,
    MediaStream,
    MediaStreamTrack,
    type MediaTrackSettings,
    type RTCRtpEncodingParametersInit,
    type RTCRtpSendParametersInit,
    type RTCVideoViewProps,
    type RTCIOSPIPOptions,
    isInPictureInPicture,
    isPictureInPictureSupported,
    mediaDevices,
    permissions,
    registerGlobals,
    startIOSPIP,
    stopIOSPIP,
    type RTCConfiguration,
    type RTCIceServer,

    // Livestreaming.
    LIVESTREAM_HOST_AUDIO_CONSTRAINTS,
    LIVESTREAM_VIEWER_CONFIGURATION,
    LivestreamSession,
    LivestreamStatsSampler,
    LivestreamViewer,
    WHEPClient,
    WHIPClient,
    addLivestreamTracks,
    addOpusNack,
    applyLivestreamSenderParameters,
    livestreamAudio,
    livestreamNetwork,
    removeHeaderExtension,
    setOpusParameters,
    setVideoParameters,
    tuneLivestreamAnswer,
    tuneLivestreamOffer,
    type HttpSignallingOptions,
    type InboundAudioStats,
    type InboundVideoStats,
    type LivestreamAudioConfig,
    type LivestreamAudioLevels,
    type LivestreamAudioOptions,
    type LivestreamNetworkState,
    type LivestreamNetworkType,
    type LivestreamPublishOptions,
    type LivestreamQuality,
    type LivestreamQualityLimitation,
    type LivestreamReconnectOptions,
    type LivestreamSessionOptions,
    type LivestreamState,
    type LivestreamStats,
    type LivestreamStatsHints,
    type LivestreamVideoCodec,
    type LivestreamVideoOptions,
    type LivestreamViewerOptions,
    type OutboundAudioStats,
    type OutboundVideoStats,
    type RefusalHandling,
    type WHEPClientOptions,
    type WHIPClientOptions,
};

declare const global: any;

/**
 * Whether Picture-in-Picture can start right now. Android: the device supports it and the user
 * has not turned it off for this app in Settings. iOS: iOS 15 or later on a device that supports it.
 */
function isPictureInPictureSupported(): Promise<boolean> {
    // Absent from native builds older than this JS, which an over-the-air update can reach.
    if (typeof WebRTCModule.isPictureInPictureSupported !== 'function') {
        return Promise.resolve(false);
    }

    return WebRTCModule.isPictureInPictureSupported();
}

/**
 * Whether a Picture-in-Picture window is showing right now. Synchronous, for the moment the app
 * goes to the background: AppState then reports "background" whether or not the video is still
 * on screen in Picture-in-Picture, and the view's onPictureInPictureChange can arrive after it.
 */
function isInPictureInPicture(): boolean {
    if (typeof WebRTCModule.isInPictureInPicture !== 'function') {
        return false;
    }

    return WebRTCModule.isInPictureInPicture();
}

function registerGlobals(): void {
    // Should not happen. React Native has a global navigator object.
    if (typeof global.navigator !== 'object') {
        throw new Error('navigator is not an object');
    }

    if (!global.navigator.mediaDevices) {
        global.navigator.mediaDevices = {};
    }

    global.navigator.mediaDevices.getUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
    global.navigator.mediaDevices.getDisplayMedia = mediaDevices.getDisplayMedia.bind(mediaDevices);
    global.navigator.mediaDevices.enumerateDevices = mediaDevices.enumerateDevices.bind(mediaDevices);

    global.RTCIceCandidate = RTCIceCandidate;
    global.RTCCertificate = RTCCertificate;
    global.RTCPeerConnection = RTCPeerConnection;
    global.RTCSessionDescription = RTCSessionDescription;
    global.MediaStream = MediaStream;
    global.MediaStreamTrack = MediaStreamTrack;
    global.MediaStreamTrackEvent = MediaStreamTrackEvent;
    global.RTCRtpTransceiver = RTCRtpTransceiver;
    global.RTCRtpReceiver = RTCRtpReceiver;
    global.RTCRtpSender = RTCRtpSender;
    global.RTCErrorEvent = RTCErrorEvent;
}
