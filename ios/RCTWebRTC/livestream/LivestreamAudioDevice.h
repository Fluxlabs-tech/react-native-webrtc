#import <Foundation/Foundation.h>
#import <TargetConditionals.h>
#import <WebRTC/WebRTC.h>

#import "WRPPlayoutProcessor.h"

// iOS only: the audio session categories it switches between are iOS's. tvOS and macOS keep
// libwebrtc's own audio device.
#if TARGET_OS_IOS

NS_ASSUME_NONNULL_BEGIN

/** What the device runs with, from Info.plist (see LivestreamAudio). */
typedef struct {
    /** Play this far behind live; 0 is WebRTC's own behaviour. */
    double playoutDelayMs;
    double maxPlayoutDelayMs;
    /** The voice leveller is built into the playout path. */
    BOOL leveller;
    double levellerInputGainDb;
    /** The device sets the audio session's category while it plays or records. */
    BOOL manageAudioSession;
} LivestreamAudioDeviceConfig;

/**
 * An `RTCAudioDevice` for livestreams, on RemoteIO rather than the phone-call VoiceProcessingIO.
 *
 * A viewer's remote audio plays under a `.playback` session, through the leveller and the optional
 * playout delay, with the microphone off. A host's microphone is captured through the same unit,
 * under `.playAndRecord` / `.videoRecording`, without the echo cancellation and gain control a call
 * applies: what the host says goes out as it sounds. For two-way audio (co-hosting on a loudspeaker)
 * that means no echo cancellation; set `enabled` to false in the config to get libwebrtc's call audio.
 */
@interface LivestreamAudioDevice : NSObject<RTCAudioDevice>

- (instancetype)initWithConfig:(LivestreamAudioDeviceConfig)config NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

@property(nonatomic, readonly) LivestreamAudioDeviceConfig config;

/** Switch the leveller while playing, e.g. to compare by ear. Re-enabling starts it afresh. */
@property(atomic) BOOL levellerEnabled;

/** The leveller's peaks since the previous call, and resets them. For display only. */
- (WRPPlayoutStats)takeStats;

@end

NS_ASSUME_NONNULL_END

#endif
