#import <Foundation/Foundation.h>
#import <WebRTC/WebRTC.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * Livestream audio: an audio device that plays remote audio as media and captures a host's
 * microphone as it sounds, with the field trials a livestream plays best with. WebRTCModule
 * builds its peer connection factory with it unless the app set its own `audioDevice` on
 * WebRTCModuleOptions.
 *
 * Configured by the `WebRTCLivestream` dictionary in Info.plist, which the Expo config plugin
 * writes. Every entry is optional:
 *
 * - `enabled` (true): false keeps libwebrtc's call audio (VoiceProcessingIO), with echo
 *   cancellation, for apps whose audio goes both ways.
 * - `playoutDelayMs` (0; up to 10000): play remote audio and video this far behind live, in step.
 * - `maxPlayoutDelayMs` (the larger of 2500 and `playoutDelayMs`): how far video may drift behind
 *   under jitter.
 * - `leveller` (true), `levellerInputGainDb` (15; 0 to 30): the voice leveller on remote audio.
 * - `manageAudioSession` (true): set the audio session's category while playing or recording.
 * - `networkResilience` (true): wait a whole round trip for resent packets, and a socket buffer
 *   that holds a sharp keyframe.
 *
 * iOS only; elsewhere `audioWithInfoPlist:` returns nil and libwebrtc's own device stays.
 */
@interface LivestreamAudio : NSObject

/** Livestream audio as `plist`, the Info.plist dictionary, configures it; nil where it is off. */
+ (nullable instancetype)audioWithInfoPlist:(nullable id)plist;

- (instancetype)init NS_UNAVAILABLE;

/** For the peer connection factory. */
@property(nonatomic, readonly) id<RTCAudioDevice> device;

/** The app's `fieldTrials` plus the ones livestream audio needs. The app's win. */
- (NSDictionary<NSString *, NSString *> *)fieldTrialsAdding:(nullable NSDictionary<NSString *, NSString *> *)fieldTrials;

/** The config, and whether audio is playing and recording: `livestreamAudioState()` in JS. */
- (NSDictionary *)state;

/** Switch the leveller while playing; returns whether it is on. A no-op when the config leaves it out. */
- (BOOL)setLevellerEnabled:(BOOL)enabled;

/** The leveller's peaks since the previous call; nil while nothing plays through it. */
- (nullable NSDictionary *)takeLevels;

@end

NS_ASSUME_NONNULL_END
