#import "LivestreamAudio.h"

#import <TargetConditionals.h>
#import <math.h>
#import <os/log.h>

#if TARGET_OS_IOS
#import "LivestreamAudioDevice.h"
#endif

#if TARGET_OS_IOS

static double LivestreamNumber(NSDictionary *plist, NSString *key, double fallback, double min, double max) {
    id value = plist[key];
    if (![value isKindOfClass:NSNumber.class]) return fallback;
    const double number = [value doubleValue];
    return number < min ? min : (number > max ? max : number);
}

static BOOL LivestreamBool(NSDictionary *plist, NSString *key, BOOL fallback) {
    id value = plist[key];
    return [value isKindOfClass:NSNumber.class] ? [value boolValue] : fallback;
}

static double LivestreamPeakDb(float peak) {
    return peak > 0 ? 20 * log10f(peak) : -120.0;
}

#endif

@implementation LivestreamAudio {
#if TARGET_OS_IOS
    LivestreamAudioDevice *_device;
    BOOL _networkResilience;
#endif
}

+ (instancetype)audioWithInfoPlist:(id)plist {
#if TARGET_OS_IOS
    NSDictionary *config = [plist isKindOfClass:NSDictionary.class] ? plist : @{};
    if (!LivestreamBool(config, @"enabled", YES)) {
        os_log(OS_LOG_DEFAULT, "WebRTCLivestream: disabled in Info.plist; libwebrtc's own audio device stays");
        return nil;
    }
    return [[self alloc] initWithConfig:config];
#else
    return nil;
#endif
}

#if TARGET_OS_IOS

- (instancetype)initWithConfig:(NSDictionary *)plist {
    if (self = [super init]) {
        // 10 s is where libwebrtc stops honouring a playout delay.
        const double delay = LivestreamNumber(plist, @"playoutDelayMs", 0, 0, 10000);
        const LivestreamAudioDeviceConfig config = {
            .playoutDelayMs = delay,
            .maxPlayoutDelayMs = LivestreamNumber(plist, @"maxPlayoutDelayMs", MAX(2500, delay), delay, 10000),
            .leveller = LivestreamBool(plist, @"leveller", YES),
            .levellerInputGainDb = LivestreamNumber(plist, @"levellerInputGainDb", 15, 0, 30),
            .manageAudioSession = LivestreamBool(plist, @"manageAudioSession", YES),
        };
        _device = [[LivestreamAudioDevice alloc] initWithConfig:config];
        _networkResilience = LivestreamBool(plist, @"networkResilience", YES);
    }
    return self;
}

- (id<RTCAudioDevice>)device {
    return _device;
}

- (NSDictionary<NSString *, NSString *> *)fieldTrialsAdding:(NSDictionary<NSString *, NSString *> *)fieldTrials {
    // How a switch between Wi-Fi and cellular gets noticed. WebRTCModule sets it only when it is
    // given no trials at all; a livestream wants it either way.
    NSMutableDictionary<NSString *, NSString *> *trials =
        [@{kRTCFieldTrialUseNWPathMonitor : kRTCFieldTrialEnabledValue} mutableCopy];
    const LivestreamAudioDeviceConfig config = _device.config;
    if (config.playoutDelayMs > 0) {
        // Only alongside the device: libwebrtc can delay only the video, and the device's delay
        // line holds the audio back to match from the first frame. Left to lip sync, the audio
        // would be dragged along at 80 ms a second.
        trials[@"WebRTC-ForcePlayoutDelay"] =
            [NSString stringWithFormat:@"min_ms:%.0f,max_ms:%.0f", config.playoutDelayMs, config.maxPlayoutDelayMs];
    }
    if (_networkResilience) {
        // While packets are being lost, wait a whole round trip for the resend. The default caps
        // the wait at 200 ms, which a mobile network outlasts.
        trials[@"WebRTC-RttMult"] = @"Disabled";
        // A keyframe of a sharp stream arrives as one burst; 256 KB overflows.
        trials[@"WebRTC-ReceiveBufferSize"] = @"size_bytes:1048576";
    }
    // Trials the app sets win.
    if (fieldTrials != nil) [trials addEntriesFromDictionary:fieldTrials];
    return trials;
}

- (NSDictionary *)state {
    const LivestreamAudioDeviceConfig config = _device.config;
    return @{
        @"installed" : @YES,
        @"playing" : @(_device.isPlaying),
        @"recording" : @(_device.isRecording),
        // A BOOL, not the int && gives: JS gets true rather than 1.
        @"levellerEnabled" : @((BOOL)(config.leveller && _device.levellerEnabled)),
        @"config" : @{
            @"playoutDelayMs" : @(config.playoutDelayMs),
            @"maxPlayoutDelayMs" : @(config.maxPlayoutDelayMs),
            @"leveller" : @(config.leveller),
            @"levellerInputGainDb" : @(config.levellerInputGainDb),
            @"manageAudioSession" : @(config.manageAudioSession),
            @"audioFocus" : @NO,
            @"networkResilience" : @(_networkResilience),
        },
    };
}

- (BOOL)setLevellerEnabled:(BOOL)enabled {
    if (!_device.config.leveller) return NO;
    _device.levellerEnabled = enabled;
    return enabled;
}

- (NSDictionary *)takeLevels {
    if (!_device.config.leveller || !_device.isPlaying || !_device.levellerEnabled) return nil;
    const WRPPlayoutStats stats = [_device takeStats];
    return @{
        @"inputPeakDb" : @(LivestreamPeakDb(stats.inputPeak)),
        @"outputPeakDb" : @(LivestreamPeakDb(stats.outputPeak)),
        @"maxReductionDb" : @(stats.maxReductionDb),
    };
}

#else

- (id<RTCAudioDevice>)device {
    return nil;
}

- (NSDictionary<NSString *, NSString *> *)fieldTrialsAdding:(NSDictionary<NSString *, NSString *> *)fieldTrials {
    return fieldTrials ?: @{};
}

- (NSDictionary *)state {
    return @{@"installed" : @NO};
}

- (BOOL)setLevellerEnabled:(BOOL)enabled {
    return NO;
}

- (NSDictionary *)takeLevels {
    return nil;
}

#endif

@end
