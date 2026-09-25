#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>

#import <React/RCTBridgeModule.h>
#import <React/RCTConvert.h>

#import <WebRTC/WebRTC.h>

static NSString *const kEventPeerConnectionSignalingStateChanged = @"peerConnectionSignalingStateChanged";
static NSString *const kEventPeerConnectionStateChanged = @"peerConnectionStateChanged";
static NSString *const kEventPeerConnectionOnRenegotiationNeeded = @"peerConnectionOnRenegotiationNeeded";
static NSString *const kEventPeerConnectionIceConnectionChanged = @"peerConnectionIceConnectionChanged";
static NSString *const kEventPeerConnectionIceGatheringChanged = @"peerConnectionIceGatheringChanged";
static NSString *const kEventPeerConnectionGotICECandidate = @"peerConnectionGotICECandidate";
static NSString *const kEventPeerConnectionDidOpenDataChannel = @"peerConnectionDidOpenDataChannel";
static NSString *const kEventDataChannelDidChangeBufferedAmount = @"dataChannelDidChangeBufferedAmount";
static NSString *const kEventDataChannelStateChanged = @"dataChannelStateChanged";
static NSString *const kEventDataChannelReceiveMessage = @"dataChannelReceiveMessage";
static NSString *const kEventMediaStreamTrackMuteChanged = @"mediaStreamTrackMuteChanged";
static NSString *const kEventMediaStreamTrackEnded = @"mediaStreamTrackEnded";
static NSString *const kEventPeerConnectionOnRemoveTrack = @"peerConnectionOnRemoveTrack";
static NSString *const kEventPeerConnectionOnTrack = @"peerConnectionOnTrack";
static NSString *const kEventLivestreamNetworkChanged = @"livestreamNetworkChanged";

@class LivestreamAudio;
@class LivestreamNetworkMonitor;

@interface WebRTCModule : NSObject<RCTBridgeModule>

@property(nonatomic, strong) dispatch_queue_t workerQueue;

@property(nonatomic, strong) RTCPeerConnectionFactory *peerConnectionFactory;
@property(nonatomic, strong) id<RTCVideoDecoderFactory> decoderFactory;
@property(nonatomic, strong) id<RTCVideoEncoderFactory> encoderFactory;

/**
 * The livestream audio device the factory was built with; nil when the app set its own
 * `audioDevice` on WebRTCModuleOptions, Info.plist turned it off, or not on iOS.
 */
@property(nonatomic, strong, readonly) LivestreamAudio *livestreamAudio;

/** Follows the device's network while livestream sessions or the app listen; created on first use. */
@property(atomic, strong) LivestreamNetworkMonitor *livestreamNetworkMonitor;

@property(nonatomic, strong) NSMutableDictionary<NSNumber *, RTCPeerConnection *> *peerConnections;
@property(nonatomic, strong) NSMutableDictionary<NSString *, RTCMediaStream *> *localStreams;
@property(nonatomic, strong) NSMutableDictionary<NSString *, RTCMediaStreamTrack *> *localTracks;

- (RTCMediaStream *)streamForReactTag:(NSString *)reactTag;

/**
 * Emits one of the events above to JS, with an NSDictionary body.
 */
- (void)sendEventWithName:(NSString *)eventName body:(id)body;

/**
 * The module instance currently loaded, if any. The new architecture's component views have no
 * bridge to ask for it.
 */
+ (WebRTCModule *)currentModule;

@end
