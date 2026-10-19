#import "CaptureController.h"
#import "VideoEffectProcessor.h"
#import "WebRTCModule.h"

@interface WebRTCModule (RTCMediaStream)

@property(nonatomic, strong) VideoEffectProcessor *videoEffectProcessor;

- (RTCVideoTrack *)createVideoTrackWithCaptureController:
    (CaptureController * (^)(RTCVideoSource *))captureControllerCreator;
- (NSArray *)createMediaStream:(NSArray<RTCMediaStreamTrack *> *)tracks;

/**
 * Holds a stream's remote audio silent, or lets go of a hold: a view holds the stream it shows while
 * it is muted, or while its paused picture-in-picture window shows it. Holds count, so the audio
 * plays again once every hold on the stream has let go. A track JS enables or disables meanwhile
 * takes that state when the hold ends. On the worker queue.
 */
- (void)setRemoteAudioOfStream:(NSString *)streamReactTag held:(BOOL)held;

/**
 * Holds a remote audio track while a held stream has it, and lets it play otherwise: for a track
 * that joins a stream after the stream was held. On the worker queue.
 */
- (void)updateHoldOfRemoteAudioTrack:(RTCAudioTrack *)track peerConnectionId:(NSNumber *)pcId;

/** Forgets the held tracks of a peer connection that is going away. On the worker queue. */
- (void)forgetHeldRemoteAudioOfPeerConnection:(NSNumber *)pcId;

@end