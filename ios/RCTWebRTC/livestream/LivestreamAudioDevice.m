#import "LivestreamAudioDevice.h"

#if TARGET_OS_IOS

#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <UIKit/UIKit.h>
#import <os/log.h>
#import <stdatomic.h>

/**
 * The format WebRTC renders into and RemoteIO is fed. Fixed rather than tracking
 * the hardware: RemoteIO resamples to whatever the route runs at, and a constant
 * format means libwebrtc never has to rebuild its playout buffer while the render
 * thread is reading it — which it would do on any change to these three.
 */
static const double kSampleRate = 48000.0;
static const NSInteger kChannels = 2;
/** The microphone is captured mono, which is what libwebrtc encodes a voice from. */
static const NSInteger kInputChannels = 1;
static const NSTimeInterval kNominalIOBufferDuration = 0.02;

/** What iOS asks for per render while the screen is locked. */
static const UInt32 kMaxFramesPerSlice = 4096;

static os_log_t LivestreamLog(void) {
    static os_log_t log;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        log = os_log_create("com.fluxlabs.react-native-webrtc", "livestream-audio");
    });
    return log;
}

@interface LivestreamAudioDevice ()

/** libwebrtc's side of the device, from initialization to termination. */
@property(atomic, strong, nullable) id<RTCAudioDeviceDelegate> delegate;

@end

@implementation LivestreamAudioDevice {
    LivestreamAudioDeviceConfig _config;
    RTCAudioDeviceGetPlayoutDataBlock _getPlayoutData;
    RTCAudioDeviceDeliverRecordedDataBlock _deliverRecordedData;
    /** Fills WebRTC's record buffer from the unit's input element; captures nothing, so it never allocates. */
    RTCAudioDeviceRenderRecordedDataBlock _renderInput;
    AudioComponentInstance _unit;
    /** The unit was built with its input element on. Changed only by rebuilding it. */
    BOOL _unitHasInput;
    BOOL _isInitialized;
    BOOL _isPlayoutInitialized;
    BOOL _isRecordingInitialized;
    /**
     * WebRTC wants playout / recording. They stay set across an interruption, which is what brings
     * the unit back. Read on the render thread.
     */
    atomic_bool _isPlaying;
    atomic_bool _isRecording;
    NSArray<id<NSObject>> *_observers;
    WRPPlayoutProcessor _processor;
    /** Set from JS, read on the render thread. */
    atomic_bool _levellerEnabled;
    /** The next render resets the processor before using it. */
    atomic_bool _levellerResetPending;
    /** The playout delay's worth of interleaved audio, oldest at `_delayPos`. NULL for no delay. */
    int16_t *_delayLine;
    size_t _delayFrames;
    size_t _delayPos;
}

- (instancetype)initWithConfig:(LivestreamAudioDeviceConfig)config {
    if (self = [super init]) {
        _config = config;
        atomic_store(&_levellerEnabled, config.leveller);
        _renderInput = ^OSStatus(AudioUnitRenderActionFlags *flags,
                                 const AudioTimeStamp *timestamp,
                                 NSInteger bus,
                                 UInt32 frames,
                                 AudioBufferList *io,
                                 void *renderContext) {
            return AudioUnitRender((AudioUnit)renderContext, flags, timestamp, (UInt32)bus, frames, io);
        };
    }
    return self;
}

- (LivestreamAudioDeviceConfig)config {
    return _config;
}

#pragma mark - Render

/** Swap fresh audio into the delay line, and what went in a playout delay ago out of it. */
static inline void LivestreamDelay(__unsafe_unretained LivestreamAudioDevice *device, int16_t *audio, UInt32 frames) {
    int16_t *line = device->_delayLine;
    const size_t length = device->_delayFrames;
    size_t pos = device->_delayPos;
    for (UInt32 f = 0; f < frames; f++) {
        int16_t *slot = line + pos * kChannels;
        int16_t *sample = audio + f * kChannels;
        for (NSInteger c = 0; c < kChannels; c++) {
            const int16_t held = slot[c];
            slot[c] = sample[c];
            sample[c] = held;
        }
        if (++pos == length) pos = 0;
    }
    device->_delayPos = pos;
}

/** Empty the delay line. Only while no render can be reading it: the unit stopped, or playout off. */
static void LivestreamClearDelay(LivestreamAudioDevice *device) {
    if (device->_delayLine == NULL) return;
    memset(device->_delayLine, 0, device->_delayFrames * kChannels * sizeof(int16_t));
    device->_delayPos = 0;
}

static OSStatus LivestreamRender(void *refCon,
                                 AudioUnitRenderActionFlags *flags,
                                 const AudioTimeStamp *timestamp,
                                 UInt32 bus,
                                 UInt32 frames,
                                 AudioBufferList *io) {
    // Unretained on purpose: the render thread must not retain or release. The
    // device outlives its unit, which is disposed before the device goes away.
    __unsafe_unretained LivestreamAudioDevice *device = (__bridge LivestreamAudioDevice *)refCon;
    __unsafe_unretained RTCAudioDeviceGetPlayoutDataBlock getPlayoutData = device->_getPlayoutData;
    AudioBuffer *buffer = &io->mBuffers[0];

    if (!atomic_load_explicit(&device->_isPlaying, memory_order_acquire) || getPlayoutData == nil) {
        memset(buffer->mData, 0, buffer->mDataByteSize);
        *flags |= kAudioUnitRenderAction_OutputIsSilence;
        return noErr;
    }

    const OSStatus status = getPlayoutData(flags, timestamp, bus, frames, io);
    if (status != noErr || (*flags & kAudioUnitRenderAction_OutputIsSilence)) return status;

    int16_t *samples = (int16_t *)buffer->mData;
    if (device->_config.leveller && atomic_load_explicit(&device->_levellerEnabled, memory_order_relaxed)) {
        if (atomic_exchange_explicit(&device->_levellerResetPending, false, memory_order_acquire)) {
            WRPPlayoutProcessorReset(&device->_processor);
        }
        WRPPlayoutProcessorProcess(&device->_processor, samples, frames);
    }
    if (device->_delayLine != NULL) LivestreamDelay(device, samples, frames);
    return noErr;
}

/** The input element has audio: WebRTC pulls it into its own buffer through `_renderInput`. */
static OSStatus LivestreamInput(void *refCon,
                                AudioUnitRenderActionFlags *flags,
                                const AudioTimeStamp *timestamp,
                                UInt32 bus,
                                UInt32 frames,
                                AudioBufferList *io) {
    __unsafe_unretained LivestreamAudioDevice *device = (__bridge LivestreamAudioDevice *)refCon;
    __unsafe_unretained RTCAudioDeviceDeliverRecordedDataBlock deliver = device->_deliverRecordedData;
    if (!atomic_load_explicit(&device->_isRecording, memory_order_acquire) || deliver == nil) return noErr;
    return deliver(flags, timestamp, bus, frames, NULL, device->_unit, device->_renderInput);
}

#pragma mark - RTCAudioDevice: format

- (double)deviceInputSampleRate {
    return kSampleRate;
}

- (NSTimeInterval)inputIOBufferDuration {
    return kNominalIOBufferDuration;
}

- (NSInteger)inputNumberOfChannels {
    return kInputChannels;
}

/** Mic-to-render time, for libwebrtc's delay estimate. Read live: it moves with the route. */
- (NSTimeInterval)inputLatency {
    AVAudioSession *session = AVAudioSession.sharedInstance;
    return session.inputLatency + session.IOBufferDuration;
}

- (double)deviceOutputSampleRate {
    return kSampleRate;
}

- (NSTimeInterval)outputIOBufferDuration {
    return kNominalIOBufferDuration;
}

- (NSInteger)outputNumberOfChannels {
    return kChannels;
}

/**
 * Render-to-ear time, which libwebrtc uses for lip sync: the delay line plus the
 * route. Read live — AirPods add a couple of hundred milliseconds the built-in
 * speaker does not — and refreshed through `notifyAudioOutputParametersChange`
 * whenever the route moves.
 */
- (NSTimeInterval)outputLatency {
    AVAudioSession *session = AVAudioSession.sharedInstance;
    return _config.playoutDelayMs / 1000.0 + session.outputLatency + session.IOBufferDuration;
}

#pragma mark - RTCAudioDevice: lifecycle

- (BOOL)isInitialized {
    return _isInitialized;
}

- (BOOL)initializeWithDelegate:(id<RTCAudioDeviceDelegate>)delegate {
    self.delegate = delegate;
    _getPlayoutData = delegate.getPlayoutData;
    _deliverRecordedData = delegate.deliverRecordedData;
    WRPPlayoutConfig config = WRPPlayoutConfigDefault();
    config.inputGainDb = (float)_config.levellerInputGainDb;
    WRPPlayoutProcessorInit(&_processor, &config, kSampleRate, (int)kChannels);
    if (_delayLine == NULL && _config.playoutDelayMs > 0) {
        _delayFrames = (size_t)(kSampleRate * _config.playoutDelayMs / 1000);
        _delayLine = calloc(_delayFrames * kChannels, sizeof(int16_t));
        if (_delayLine == NULL) return NO;
    }
    _isInitialized = YES;
    return YES;
}

- (BOOL)terminateDevice {
    atomic_store(&_isPlaying, false);
    atomic_store(&_isRecording, false);
    [self unobserveSession];
    [self disposeUnit];
    _isPlayoutInitialized = NO;
    _isRecordingInitialized = NO;
    // Only once the unit is gone, so no render can still be reading them.
    _getPlayoutData = nil;
    _deliverRecordedData = nil;
    self.delegate = nil;
    _isInitialized = NO;
    return YES;
}

- (void)dealloc {
    [self disposeUnit];
    free(_delayLine);
}

#pragma mark - RTCAudioDevice: playout

- (BOOL)isPlayoutInitialized {
    return _isPlayoutInitialized;
}

- (BOOL)initializePlayout {
    _isPlayoutInitialized = YES;
    return YES;
}

- (BOOL)isPlaying {
    return atomic_load(&_isPlaying);
}

- (BOOL)startPlayout {
    if (atomic_load(&_isPlaying)) return YES;
    // Before playout is on, so a unit already running for the microphone never
    // renders through the processor or the line while they are reset.
    WRPPlayoutProcessorReset(&_processor);
    atomic_store(&_levellerResetPending, false);
    LivestreamClearDelay(self);
    atomic_store_explicit(&_isPlaying, true, memory_order_release);
    [self applyState:@"playout started"];
    return YES;
}

- (BOOL)stopPlayout {
    if (!atomic_load(&_isPlaying)) return YES;
    atomic_store(&_isPlaying, false);
    [self applyState:@"playout stopped"];
    return YES;
}

#pragma mark - RTCAudioDevice: recording

- (BOOL)isRecordingInitialized {
    return _isRecordingInitialized;
}

- (BOOL)initializeRecording {
    _isRecordingInitialized = YES;
    return YES;
}

- (BOOL)isRecording {
    return atomic_load(&_isRecording);
}

- (BOOL)startRecording {
    if (atomic_load(&_isRecording)) return YES;
    atomic_store_explicit(&_isRecording, true, memory_order_release);
    [self applyState:@"recording started"];
    return YES;
}

- (BOOL)stopRecording {
    if (!atomic_load(&_isRecording)) return YES;
    atomic_store(&_isRecording, false);
    [self applyState:@"recording stopped"];
    return YES;
}

#pragma mark - State

/**
 * Brings the unit and the session in line with what WebRTC wants: running while it plays or
 * records, with the input element on only while it records. The input element can only change
 * on a new unit, so going live or off air rebuilds it; that stops the render thread, which
 * libwebrtc is told about first.
 */
- (void)applyState:(NSString *)event {
    const BOOL playing = atomic_load(&_isPlaying);
    const BOOL recording = atomic_load(&_isRecording);

    if (!playing && !recording) {
        [self unobserveSession];
        // Disposed rather than stopped: an idle unit with its input on would keep the microphone
        // indicator lit. The session is left active on purpose: deactivating stops every other
        // audio object in the app, and another player may already be taking over.
        [self disposeUnit];
        os_log(LivestreamLog(), "%{public}@; idle", event);
        return;
    }

    if (_unit && _unitHasInput != recording) {
        [self interruptUnit];
        [self disposeUnit];
    }
    if (!_unit && ![self createUnitWithInput:recording]) return;

    [self activateSession];
    [self observeSession];
    if (![self isUnitRunning]) {
        const OSStatus status = AudioOutputUnitStart(_unit);
        if (status == noErr) {
            [self logRoute:event];
        } else {
            // Most often a phone call holding the session. Reporting failure would leave
            // libwebrtc believing audio is off with nothing to retry it, so keep the intent and
            // let the interruption end, or the app coming back to the foreground, start the unit.
            os_log_error(LivestreamLog(), "%{public}@; start failed (%d), waiting for the session", event, (int)status);
        }
    }
    [self refreshParameters];
}

/** Tell libwebrtc its audio threads are about to stop, while nothing is rendering. */
- (void)interruptUnit {
    if (_unit) AudioOutputUnitStop(_unit);
    if (atomic_load(&_isPlaying)) [self.delegate notifyAudioOutputInterrupted];
    if (_unitHasInput) [self.delegate notifyAudioInputInterrupted];
}

#pragma mark - Audio unit

- (BOOL)createUnitWithInput:(BOOL)input {
    AudioComponentDescription description = {
        .componentType = kAudioUnitType_Output,
        .componentSubType = kAudioUnitSubType_RemoteIO,
        .componentManufacturer = kAudioUnitManufacturer_Apple,
    };
    AudioComponent component = AudioComponentFindNext(NULL, &description);
    if (component == NULL || AudioComponentInstanceNew(component, &_unit) != noErr) {
        os_log_error(LivestreamLog(), "no RemoteIO unit");
        _unit = NULL;
        return NO;
    }

    // RemoteIO's input element is off by default; set explicitly, because an enabled input is
    // what lights the microphone indicator, and a viewer must never see it.
    UInt32 inputFlag = input ? 1 : 0;
    UInt32 on = 1;
    UInt32 off = 0;
    AudioStreamBasicDescription output = {
        .mSampleRate = kSampleRate,
        .mFormatID = kAudioFormatLinearPCM,
        .mFormatFlags = kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
        .mBytesPerPacket = (UInt32)(sizeof(int16_t) * kChannels),
        .mFramesPerPacket = 1,
        .mBytesPerFrame = (UInt32)(sizeof(int16_t) * kChannels),
        .mChannelsPerFrame = (UInt32)kChannels,
        .mBitsPerChannel = 16,
    };
    AudioStreamBasicDescription capture = output;
    capture.mBytesPerPacket = capture.mBytesPerFrame = (UInt32)(sizeof(int16_t) * kInputChannels);
    capture.mChannelsPerFrame = (UInt32)kInputChannels;
    UInt32 maxFrames = kMaxFramesPerSlice;
    AURenderCallbackStruct render = {.inputProc = LivestreamRender, .inputProcRefCon = (__bridge void *)self};
    AURenderCallbackStruct inputCallback = {.inputProc = LivestreamInput, .inputProcRefCon = (__bridge void *)self};

    OSStatus status = AudioUnitSetProperty(
        _unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &inputFlag, sizeof(inputFlag));
    if (status == noErr) {
        status =
            AudioUnitSetProperty(_unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &on, sizeof(on));
    }
    if (status == noErr) {
        status = AudioUnitSetProperty(
            _unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &output, sizeof(output));
    }
    if (status == noErr && input) {
        // What the input element hands over: RemoteIO converts from the route's format.
        status = AudioUnitSetProperty(
            _unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &capture, sizeof(capture));
    }
    if (status == noErr && input) {
        // WebRTC renders the input into its own buffer; RemoteIO need not allocate one.
        status = AudioUnitSetProperty(
            _unit, kAudioUnitProperty_ShouldAllocateBuffer, kAudioUnitScope_Output, 1, &off, sizeof(off));
    }
    if (status == noErr && input) {
        status = AudioUnitSetProperty(_unit,
                                      kAudioOutputUnitProperty_SetInputCallback,
                                      kAudioUnitScope_Global,
                                      1,
                                      &inputCallback,
                                      sizeof(inputCallback));
    }
    if (status == noErr) {
        status = AudioUnitSetProperty(
            _unit, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &maxFrames, sizeof(maxFrames));
    }
    if (status == noErr) {
        status = AudioUnitSetProperty(
            _unit, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &render, sizeof(render));
    }
    if (status == noErr) status = AudioUnitInitialize(_unit);

    if (status != noErr) {
        os_log_error(LivestreamLog(), "RemoteIO setup failed (%d)", (int)status);
        AudioComponentInstanceDispose(_unit);
        _unit = NULL;
        return NO;
    }
    _unitHasInput = input;
    return YES;
}

- (void)disposeUnit {
    if (!_unit) return;
    AudioOutputUnitStop(_unit);
    AudioUnitUninitialize(_unit);
    AudioComponentInstanceDispose(_unit);
    _unit = NULL;
    _unitHasInput = NO;
}

- (BOOL)isUnitRunning {
    if (!_unit) return NO;
    UInt32 running = 0;
    UInt32 size = sizeof(running);
    AudioUnitGetProperty(_unit, kAudioOutputUnitProperty_IsRunning, kAudioUnitScope_Global, 0, &running, &size);
    return running != 0;
}

/**
 * Bring the unit back after the system stopped it. The audio threads can change across a
 * restart, and libwebrtc checks each is always called from one thread, so it is told first —
 * while nothing is rendering.
 */
- (void)restartUnit {
    if (!_unit || !(atomic_load(&_isPlaying) || atomic_load(&_isRecording))) return;
    [self interruptUnit];
    [self activateSession];
    // What the line holds predates the interruption; WebRTC has moved on.
    LivestreamClearDelay(self);
    const OSStatus status = AudioOutputUnitStart(_unit);
    if (status == noErr) {
        [self logRoute:@"resumed"];
    } else {
        os_log_error(LivestreamLog(), "resume failed (%d)", (int)status);
    }
    [self refreshParameters];
}

#pragma mark - Session

- (void)activateSession {
    // Left to the app: it owns the session.
    if (!_config.manageAudioSession) return;
    AVAudioSession *session = AVAudioSession.sharedInstance;
    NSError *error = nil;
    NSString *category;
    NSString *mode;
    AVAudioSessionCategoryOptions options;
    if (atomic_load(&_isRecording)) {
        // A host: the camera's microphone as it sounds, heard back on the loudspeaker or on
        // Bluetooth / AirPlay output rather than the earpiece. No voice processing: this is a
        // broadcast, not a call.
        category = AVAudioSessionCategoryPlayAndRecord;
        mode = AVAudioSessionModeVideoRecording;
        options = AVAudioSessionCategoryOptionDefaultToSpeaker | AVAudioSessionCategoryOptionAllowBluetoothA2DP |
            AVAudioSessionCategoryOptionAllowAirPlay;
    } else {
        // A viewer. Not mixable: a live stream takes the audio the way a video does, so music
        // playing in another app pauses rather than talking over the stream. Also exactly what
        // expo-video sets, so switching between WebRTC and HLS never flips the session.
        category = AVAudioSessionCategoryPlayback;
        mode = AVAudioSessionModeMoviePlayback;
        options = 0;
    }
    const BOOL configured = [session.category isEqualToString:category] && [session.mode isEqualToString:mode] &&
        session.categoryOptions == options;
    if (!configured && ![session setCategory:category mode:mode options:options error:&error]) {
        os_log_error(LivestreamLog(), "setCategory failed: %{public}@", error.localizedDescription);
    }
    // The rate the device runs at, so RemoteIO does not resample on routes that can run at it.
    if (session.preferredSampleRate != kSampleRate) [session setPreferredSampleRate:kSampleRate error:nil];
    if (![session setActive:YES error:&error]) {
        os_log_error(LivestreamLog(), "setActive failed: %{public}@", error.localizedDescription);
    }
}

/** Have libwebrtc re-read the latencies. Nothing else changes, so no buffer is rebuilt. */
- (void)refreshParameters {
    const BOOL recording = _unitHasInput;
    [self onDeviceThread:^(id<RTCAudioDeviceDelegate> delegate) {
        [delegate notifyAudioOutputParametersChange];
        if (recording) [delegate notifyAudioInputParametersChange];
    }];
}

/**
 * Session notifications arrive on whatever thread posted them. The unit is only
 * ever touched from libwebrtc's ADM thread, so every handler hops onto it — and
 * drops the work if the device was terminated in between.
 */
- (void)onDeviceThread:(void (^)(id<RTCAudioDeviceDelegate> delegate))work {
    id<RTCAudioDeviceDelegate> delegate = self.delegate;
    if (delegate == nil) return;
    __weak LivestreamAudioDevice *weakSelf = self;
    [delegate dispatchAsync:^{
        LivestreamAudioDevice *strongSelf = weakSelf;
        if (strongSelf == nil || strongSelf.delegate != delegate) return;
        work(delegate);
    }];
}

- (void)observeSession {
    if (_observers) return;
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    AVAudioSession *session = AVAudioSession.sharedInstance;
    __weak LivestreamAudioDevice *weakSelf = self;

    id interruption =
        [center addObserverForName:AVAudioSessionInterruptionNotification
                            object:session
                             queue:nil
                        usingBlock:^(NSNotification *note) {
                            const NSUInteger type =
                                [note.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue];
                            [weakSelf onDeviceThread:^(id<RTCAudioDeviceDelegate> delegate) {
                                LivestreamAudioDevice *device = weakSelf;
                                if (type == AVAudioSessionInterruptionTypeBegan) {
                                    os_log(LivestreamLog(), "interrupted");
                                    [delegate notifyAudioOutputInterrupted];
                                    if (device->_unitHasInput) [delegate notifyAudioInputInterrupted];
                                } else {
                                    // Resumed whether or not iOS says `shouldResume`: this is live,
                                    // and a viewer back from a call expects the stream, a host the
                                    // broadcast, not silence.
                                    [device restartUnit];
                                }
                            }];
                        }];

    id reset = [center addObserverForName:AVAudioSessionMediaServicesWereResetNotification
                                   object:session
                                    queue:nil
                               usingBlock:^(NSNotification *note) {
                                   [weakSelf onDeviceThread:^(id<RTCAudioDeviceDelegate> delegate) {
                                       LivestreamAudioDevice *device = weakSelf;
                                       // Every audio object is dead after a reset.
                                       os_log(LivestreamLog(), "media services reset");
                                       const BOOL input = device->_unitHasInput;
                                       [device disposeUnit];
                                       if ([device createUnitWithInput:input]) [device restartUnit];
                                   }];
                               }];

    id route = [center addObserverForName:AVAudioSessionRouteChangeNotification
                                   object:session
                                    queue:nil
                               usingBlock:^(NSNotification *note) {
                                   [weakSelf onDeviceThread:^(id<RTCAudioDeviceDelegate> delegate) {
                                       LivestreamAudioDevice *device = weakSelf;
                                       [device logRoute:@"route changed"];
                                       [delegate notifyAudioOutputParametersChange];
                                       if (device->_unitHasInput) [delegate notifyAudioInputParametersChange];
                                   }];
                               }];

    // iOS does not always post the end of an interruption. Coming back to the
    // foreground is the backstop: a unit that should be running but is not gets
    // started again.
    id active = [center addObserverForName:UIApplicationDidBecomeActiveNotification
                                    object:nil
                                     queue:nil
                                usingBlock:^(NSNotification *note) {
                                    [weakSelf onDeviceThread:^(id<RTCAudioDeviceDelegate> delegate) {
                                        LivestreamAudioDevice *device = weakSelf;
                                        if (![device isUnitRunning]) [device restartUnit];
                                    }];
                                }];

    _observers = @[ interruption, reset, route, active ];
}

- (void)unobserveSession {
    for (id observer in _observers) [NSNotificationCenter.defaultCenter removeObserver:observer];
    _observers = nil;
}

#pragma mark - Logging

- (void)logRoute:(NSString *)event {
    AVAudioSession *session = AVAudioSession.sharedInstance;
    NSString *inputs = [[session.currentRoute.inputs valueForKey:@"portType"] componentsJoinedByString:@","];
    NSString *outputs = [[session.currentRoute.outputs valueForKey:@"portType"] componentsJoinedByString:@","];
    os_log(LivestreamLog(),
           "%{public}@: in %{public}@, out %{public}@, %.0f Hz, io %.1f ms, latency %.1f ms, delay %.0f ms, category "
           "%{public}@/%{public}@",
           event,
           _unitHasInput ? inputs : @"off",
           outputs,
           session.sampleRate,
           session.IOBufferDuration * 1000,
           session.outputLatency * 1000,
           _config.playoutDelayMs,
           session.category,
           session.mode);
}

#pragma mark - Leveller

- (BOOL)levellerEnabled {
    return atomic_load(&_levellerEnabled);
}

- (void)setLevellerEnabled:(BOOL)enabled {
    // Re-enabling starts from a clean state: the gain it last held belongs to
    // audio that has long since played.
    if (enabled && !atomic_load(&_levellerEnabled)) atomic_store(&_levellerResetPending, true);
    atomic_store(&_levellerEnabled, enabled);
}

- (WRPPlayoutStats)takeStats {
    return WRPPlayoutProcessorTakeStats(&_processor);
}

@end

#endif
