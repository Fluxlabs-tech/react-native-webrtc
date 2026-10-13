#import "CaptureController.h"
#import "VideoEffectProcessor.h"
#import "WebRTCModule.h"

@interface WebRTCModule (RTCMediaStream)

@property(nonatomic, strong) VideoEffectProcessor *videoEffectProcessor;

- (RTCVideoTrack *)createVideoTrackWithCaptureController:
    (CaptureController * (^)(RTCVideoSource *))captureControllerCreator;
- (NSArray *)createMediaStream:(NSArray<RTCMediaStreamTrack *> *)tracks;

/**
 * Silences a stream's remote audio while a paused picture-in-picture window shows it, or lets it
 * play again. A track JS enables or disables meanwhile takes that state when the hold ends. On the
 * worker queue.
 */
- (void)setRemoteAudioOfStream:(NSString *)streamReactTag held:(BOOL)held;

@end