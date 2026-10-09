#if !TARGET_OS_OSX
#import <AVKit/AVKit.h>
#import <UIKit/UIKit.h>
#endif

#if !TARGET_OS_OSX
#import "PIPController.h"
#endif

#import <objc/runtime.h>

#import <React/RCTInvalidating.h>
#import <React/RCTLog.h>
#import <React/RCTUtils.h>
#import <RNWebRTCSpec/RNWebRTCSpec.h>

#import "WebRTCModule+Livestream.h"
#import "WebRTCModule+RTCPeerConnection.h"
#import "WebRTCModule.h"
#import "WebRTCModuleOptions.h"
#import "livestream/LivestreamAudio.h"

// The class adopts RCTTurboModule rather than the NativeWebRTCModuleSpec protocol: the exported
// methods live in the categories, in their own files, where the compiler cannot match them
// against the spec. WebRTCModuleCheckSpec() does that instead, in debug builds.
@interface WebRTCModule ()<RCTTurboModule, RCTInvalidating>

// For WebRTCModuleSpecJSI below, which the event emitter callback calls into.
- (void)setEventEmitterCallbackOwner:(const void *)owner;
- (void)clearEventEmitterCallbackOwnedBy:(const void *)owner;

@end

namespace {

// The TurboModule. React frees it once it has invalidated the module, but waits only 10 s for
// -invalidate to have its turn on the worker queue: so when it goes, the callback into it goes too.
class WebRTCModuleSpecJSI final : public facebook::react::NativeWebRTCModuleSpecJSI {
   public:
    explicit WebRTCModuleSpecJSI(const facebook::react::ObjCTurboModule::InitParams &params)
        : NativeWebRTCModuleSpecJSI(params) {
        // NativeWebRTCModuleSpecJSI has just set the callback.
        [(WebRTCModule *)instance_ setEventEmitterCallbackOwner:this];
    }

    ~WebRTCModuleSpecJSI() override { [(WebRTCModule *)instance_ clearEventEmitterCallbackOwnedBy:this]; }
};

}  // namespace

// Weak: a reload replaces the module, and the old one must still deallocate.
static __weak WebRTCModule *gCurrentModule;

// The events src/NativeWebRTCModule.ts declares. The TurboModule has an emitter for each of these
// names only, and emitting any other one would crash.
static NSSet<NSString *> *WebRTCModuleEvents(void) {
    static NSSet<NSString *> *events;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        events = [NSSet setWithArray:@[
            kEventPeerConnectionSignalingStateChanged,
            kEventPeerConnectionStateChanged,
            kEventPeerConnectionOnRenegotiationNeeded,
            kEventPeerConnectionIceConnectionChanged,
            kEventPeerConnectionIceGatheringChanged,
            kEventPeerConnectionGotICECandidate,
            kEventPeerConnectionDidOpenDataChannel,
            kEventDataChannelDidChangeBufferedAmount,
            kEventDataChannelStateChanged,
            kEventDataChannelReceiveMessage,
            kEventMediaStreamTrackMuteChanged,
            kEventMediaStreamTrackEnded,
            kEventPeerConnectionOnRemoveTrack,
            kEventPeerConnectionOnTrack,
            kEventLivestreamNetworkChanged
        ]];
    });
    return events;
}

@implementation WebRTCModule {
    // Set by the TurboModule when JS first loads it; emits the spec's events to JS. Codegen's
    // NativeWebRTCModuleSpecBase holds the same, but subclassing it would make every file that
    // imports WebRTCModule.h Objective-C++.
    // It calls into the TurboModule, which React frees after it has invalidated the module: an
    // event sent after that is a use-after-free. So -invalidate clears it, and so does the
    // TurboModule as it goes, should -invalidate not have run by then. Guarded by
    // @synchronized(self), as is the TurboModule it calls into, _eventEmitterCallbackOwner.
    facebook::react::EventEmitterCallback _eventEmitterCallback;
    const void *_eventEmitterCallbackOwner;
}

+ (WebRTCModule *)currentModule {
    return gCurrentModule;
}

+ (BOOL)requiresMainQueueSetup {
    return NO;
}

- (void)dealloc {
    [_localTracks removeAllObjects];
    _localTracks = nil;
    [_localStreams removeAllObjects];
    _localStreams = nil;

    // Done already, unless the module goes without -invalidate.
    [self closeAllPeerConnections];
    [self disposeAllPeerConnections];

    _peerConnectionFactory = nil;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        WebRTCModuleOptions *options = [WebRTCModuleOptions sharedInstance];
        id<RTCAudioDevice> audioDevice = options.audioDevice;
        id<RTCVideoDecoderFactory> decoderFactory = options.videoDecoderFactory;
        id<RTCVideoEncoderFactory> encoderFactory = options.videoEncoderFactory;
        NSDictionary *fieldTrials = options.fieldTrials;
        RTCLoggingSeverity loggingSeverity = options.loggingSeverity;

        // Livestream audio, unless the app brings its own device. A device per module rather than
        // one for the process: after a reload, the old factory terminating its device must not
        // stop the new one's.
        if (audioDevice == nil) {
            _livestreamAudio =
                [LivestreamAudio audioWithInfoPlist:[NSBundle.mainBundle objectForInfoDictionaryKey:@"WebRTCLivestream"]];
            if (_livestreamAudio != nil) {
                audioDevice = _livestreamAudio.device;
                fieldTrials = [_livestreamAudio fieldTrialsAdding:fieldTrials];
            }
        }

        // Initialize field trials.
        if (fieldTrials == nil) {
            // Fix for dual-sim connectivity:
            // https://bugs.chromium.org/p/webrtc/issues/detail?id=10966
            fieldTrials = @{kRTCFieldTrialUseNWPathMonitor : kRTCFieldTrialEnabledValue};
        }
        RTCInitFieldTrialDictionary(fieldTrials);

        // Initialize logging.
        RTCSetMinDebugLogLevel(loggingSeverity);

        if (encoderFactory == nil) {
            encoderFactory = [[RTCDefaultVideoEncoderFactory alloc] init];
        }
        if (decoderFactory == nil) {
            decoderFactory = [[RTCDefaultVideoDecoderFactory alloc] init];
        }
        _encoderFactory = encoderFactory;
        _decoderFactory = decoderFactory;

        RCTLogInfo(@"Using video encoder factory: %@", NSStringFromClass([encoderFactory class]));
        RCTLogInfo(@"Using video decoder factory: %@", NSStringFromClass([decoderFactory class]));

        _peerConnectionFactory = [[RTCPeerConnectionFactory alloc] initWithEncoderFactory:encoderFactory
                                                                           decoderFactory:decoderFactory
                                                                              audioDevice:audioDevice];

        _peerConnections = [NSMutableDictionary new];
        _localStreams = [NSMutableDictionary new];
        _localTracks = [NSMutableDictionary new];

        dispatch_queue_attr_t attributes =
            dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INITIATED, -1);
        _workerQueue = dispatch_queue_create("WebRTCModule.queue", attributes);

        gCurrentModule = self;
    }

    return self;
}

- (RTCMediaStream *)streamForReactTag:(NSString *)reactTag {
    RTCMediaStream *stream = _localStreams[reactTag];
    if (!stream) {
        for (NSNumber *peerConnectionId in _peerConnections) {
            RTCPeerConnection *peerConnection = _peerConnections[peerConnectionId];
            stream = peerConnection.remoteStreams[reactTag];
            if (stream) {
                break;
            }
        }
    }
    return stream;
}

RCT_EXPORT_MODULE();

- (dispatch_queue_t)methodQueue {
    return _workerQueue;
}

// Picture-in-picture here is the video-call kind, AVPictureInPictureVideoCallViewController,
// which needs iOS 15.
// For the moment the app is backgrounded: AppState says "background" whether or not a
// picture-in-picture window is showing the video.
- (NSNumber *)isInPictureInPicture {
#if TARGET_OS_OSX
    return @NO;
#else
    if (@available(iOS 15.0, *)) {
        return @([PIPController isAnyPictureInPictureActive]);
    }
    return @NO;
#endif
}

- (void)isPictureInPictureSupported:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
#if TARGET_OS_OSX
    resolve(@NO);
#else
    if (@available(iOS 15.0, *)) {
        resolve(@([AVPictureInPictureController isPictureInPictureSupported]));
    } else {
        resolve(@NO);
    }
#endif
}

#if DEBUG
// Logs each spec method the module lacks or declares with other types: a TurboModule calls it by
// selector with the spec's argument types, so a mismatch fails only when that method is called.
static void WebRTCModuleCheckSpec(Class moduleClass) {
    unsigned int count = 0;
    struct objc_method_description *specMethods =
        protocol_copyMethodDescriptionList(@protocol(NativeWebRTCModuleSpec), YES, YES, &count);

    for (unsigned int i = 0; i < count; i++) {
        NSString *name = NSStringFromSelector(specMethods[i].name);
        Method method = class_getInstanceMethod(moduleClass, specMethods[i].name);
        if (method == NULL) {
            RCTLogError(@"WebRTCModule does not implement %@ from its spec", name);
            continue;
        }

        NSMethodSignature *expected = [NSMethodSignature signatureWithObjCTypes:specMethods[i].types];
        NSMethodSignature *actual = [NSMethodSignature signatureWithObjCTypes:method_getTypeEncoding(method)];
        BOOL matches = expected.numberOfArguments == actual.numberOfArguments &&
            strcmp(expected.methodReturnType, actual.methodReturnType) == 0;
        for (NSUInteger arg = 2; matches && arg < expected.numberOfArguments; arg++) {
            matches = strcmp([expected getArgumentTypeAtIndex:arg], [actual getArgumentTypeAtIndex:arg]) == 0;
        }
        if (!matches) {
            RCTLogError(@"WebRTCModule declares %@ with types other than its spec's", name);
        }
    }

    free(specMethods);
}
#endif

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
#if DEBUG
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        WebRTCModuleCheckSpec([WebRTCModule class]);
    });
#endif
    return std::make_shared<WebRTCModuleSpecJSI>(params);
}

- (void)setEventEmitterCallback:(EventEmitterCallbackWrapper *)eventEmitterCallbackWrapper {
    @synchronized(self) {
        _eventEmitterCallback = std::move(eventEmitterCallbackWrapper->_eventEmitterCallback);
        _eventEmitterCallbackOwner = nullptr;
    }
}

- (void)setEventEmitterCallbackOwner:(const void *)owner {
    @synchronized(self) {
        _eventEmitterCallbackOwner = owner;
    }
}

// Only the callback into the TurboModule that goes: a module instance an app keeps across a
// reload may have the next one's by then.
- (void)clearEventEmitterCallbackOwnedBy:(const void *)owner {
    @synchronized(self) {
        if (_eventEmitterCallbackOwner == owner) {
            _eventEmitterCallback = nullptr;
            _eventEmitterCallbackOwner = nullptr;
        }
    }
}

- (void)sendEventWithName:(NSString *)eventName body:(id)body {
    if (![WebRTCModuleEvents() containsObject:eventName]) {
        RCTLogError(@"WebRTCModule: %@ is not an event of the spec", eventName);
        return;
    }
    @synchronized(self) {
        if (_eventEmitterCallback) {
            _eventEmitterCallback(std::string(eventName.UTF8String), body);
        }
    }
}

// On the worker queue, the module's method queue.
- (void)invalidate {
    @synchronized(self) {
        _eventEmitterCallback = nullptr;
        _eventEmitterCallbackOwner = nullptr;
    }
    [self livestreamNetworkStop];
    // The JS that would close these is gone. Left open, they would go on receiving the stream
    // until the module deallocates.
    [self closeAllPeerConnections];
    dispatch_async(_workerQueue, ^{
        [self disposeAllPeerConnections];
    });
}

@end
