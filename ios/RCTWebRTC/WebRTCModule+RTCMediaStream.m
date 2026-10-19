#import <objc/runtime.h>

#import <WebRTC/RTCCameraVideoCapturer.h>
#import <WebRTC/RTCMediaConstraints.h>
#import <WebRTC/RTCMediaStreamTrack.h>
#import <WebRTC/RTCVideoTrack.h>

#import "RTCMediaStreamTrack+React.h"
#import "WebRTCModule+RTCMediaStream.h"
#import "WebRTCModule+RTCPeerConnection.h"
#import "WebRTCModuleOptions.h"

#import "ProcessorProvider.h"
#import "ScreenCaptureController.h"
#import "ScreenCapturer.h"
#import "TrackCapturerEventsEmitter.h"
#import "VideoCaptureController.h"

/** A held remote audio track's key. Track IDs come from the remote side, so two peer connections can share one. */
static NSString *HeldAudioKey(NSNumber *pcId, NSString *trackId) {
    return [NSString stringWithFormat:@"%@/%@", pcId, trackId];
}

/** Whether the stream has the audio track. By ID: the wrappers WebRTC hands out for a track differ. */
static BOOL StreamHasAudioTrack(RTCMediaStream *stream, NSString *trackId) {
    for (RTCAudioTrack *track in stream.audioTracks) {
        if ([track.trackId isEqualToString:trackId]) {
            return YES;
        }
    }
    return NO;
}

@implementation WebRTCModule (RTCMediaStream)

- (VideoEffectProcessor *)videoEffectProcessor {
    return objc_getAssociatedObject(self, _cmd);
}

- (void)setVideoEffectProcessor:(VideoEffectProcessor *)videoEffectProcessor {
    objc_setAssociatedObject(
        self, @selector(videoEffectProcessor), videoEffectProcessor, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}

#pragma mark - getUserMedia

/**
 * Initializes a new {@link RTCAudioTrack} which satisfies the given constraints.
 *
 * @param constraints The {@code MediaStreamConstraints} which the new
 * {@code RTCAudioTrack} instance is to satisfy.
 */
- (RTCAudioTrack *)createAudioTrack:(NSDictionary *)constraints {
    // The audio constraints as libwebrtc reads them: string values under its own names
    // (googEchoCancellation and the like), which src/RTCUtil.ts maps the standard ones to. They
    // set the audio processing the track is sent with.
    NSMutableDictionary<NSString *, NSString *> *mandatory = [NSMutableDictionary dictionary];
    id audio = constraints[@"audio"];
    if ([audio isKindOfClass:[NSDictionary class]]) {
        [audio enumerateKeysAndObjectsUsingBlock:^(id key, id value, BOOL *stop) {
            if (![key isKindOfClass:[NSString class]]) {
                return;
            }
            if ([value isKindOfClass:[NSString class]]) {
                mandatory[key] = value;
            } else if ([value isKindOfClass:[NSNumber class]] &&
                       CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) {
                mandatory[key] = [value boolValue] ? @"true" : @"false";
            }
        }];
    }
    RTCMediaConstraints *mediaConstraints = [[RTCMediaConstraints alloc] initWithMandatoryConstraints:mandatory
                                                                                  optionalConstraints:nil];
    RTCAudioSource *audioSource = [self.peerConnectionFactory audioSourceWithConstraints:mediaConstraints];

    NSString *trackId = [[NSUUID UUID] UUIDString];
    RTCAudioTrack *audioTrack = [self.peerConnectionFactory audioTrackWithSource:audioSource trackId:trackId];
    return audioTrack;
}
/**
 * Initializes a new {@link RTCVideoTrack} with the given capture controller
 */
- (RTCVideoTrack *)createVideoTrackWithCaptureController:
    (CaptureController * (^)(RTCVideoSource *))captureControllerCreator {
#if TARGET_OS_TV
    return nil;
#else

    RTCVideoSource *videoSource = [self.peerConnectionFactory videoSource];

    NSString *trackUUID = [[NSUUID UUID] UUIDString];
    RTCVideoTrack *videoTrack = [self.peerConnectionFactory videoTrackWithSource:videoSource trackId:trackUUID];

    CaptureController *captureController = captureControllerCreator(videoSource);
    videoTrack.captureController = captureController;
    [captureController startCapture];

    return videoTrack;
#endif
}
/**
 * Initializes a new {@link RTCMediaTrack} with the given tracks.
 *
 * @return An array with the mediaStreamId in index 0, and track infos in index 1.
 */
- (NSArray *)createMediaStream:(NSArray<RTCMediaStreamTrack *> *)tracks {
#if TARGET_OS_TV
    return nil;
#else
    NSString *mediaStreamId = [[NSUUID UUID] UUIDString];
    RTCMediaStream *mediaStream = [self.peerConnectionFactory mediaStreamWithStreamId:mediaStreamId];
    NSMutableArray<NSDictionary *> *trackInfos = [NSMutableArray array];

    for (RTCMediaStreamTrack *track in tracks) {
        if ([track.kind isEqualToString:@"audio"]) {
            [mediaStream addAudioTrack:(RTCAudioTrack *)track];
        } else if ([track.kind isEqualToString:@"video"]) {
            [mediaStream addVideoTrack:(RTCVideoTrack *)track];
        }

        NSString *trackId = track.trackId;

        self.localTracks[trackId] = track;

        NSDictionary *settings = @{};
        if ([track.kind isEqualToString:@"video"]) {
            RTCVideoTrack *videoTrack = (RTCVideoTrack *)track;
            if ([videoTrack.captureController isKindOfClass:[CaptureController class]]) {
                settings = [videoTrack.captureController getSettings];
            }
        } else if ([track.kind isEqualToString:@"audio"]) {
            settings = @{
                @"deviceId" : @"audio",
                @"groupId" : @"",
            };
        }

        [trackInfos addObject:@{
            @"enabled" : @(track.isEnabled),
            @"id" : trackId,
            @"kind" : track.kind,
            @"readyState" : @"live",
            @"remote" : @(NO),
            @"settings" : settings
        }];
    }

    self.localStreams[mediaStreamId] = mediaStream;
    return @[ mediaStreamId, trackInfos ];
#endif
}

/**
 * Initializes a new {@link RTCVideoTrack} which satisfies the given constraints.
 */
- (RTCVideoTrack *)createVideoTrack:(NSDictionary *)constraints {
#if TARGET_OS_TV
    return nil;
#else
    RTCVideoSource *videoSource = [self.peerConnectionFactory videoSource];

    NSString *trackUUID = [[NSUUID UUID] UUIDString];
    RTCVideoTrack *videoTrack = [self.peerConnectionFactory videoTrackWithSource:videoSource trackId:trackUUID];

    BOOL hasRuntimeVideoDevice = YES;
#if TARGET_IPHONE_SIMULATOR
    // On simulator, a runtime-provided video source may exist (e.g. virtual camera),
    // so only skip camera capture setup when no runtime video device is available.
    hasRuntimeVideoDevice = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo] != nil;
#endif

    if (hasRuntimeVideoDevice) {
        RTCCameraVideoCapturer *videoCapturer = [[RTCCameraVideoCapturer alloc] initWithDelegate:videoSource];
        VideoCaptureController *videoCaptureController =
            [[VideoCaptureController alloc] initWithCapturer:videoCapturer andConstraints:constraints[@"video"]];
        videoCaptureController.enableMultitaskingCameraAccess =
            [WebRTCModuleOptions sharedInstance].enableMultitaskingCameraAccess;
        videoTrack.captureController = videoCaptureController;
        [videoCaptureController startCapture];
    }

    return videoTrack;
#endif
}

- (RTCVideoTrack *)createScreenCaptureVideoTrack {
#if TARGET_IPHONE_SIMULATOR || TARGET_OS_OSX || TARGET_OS_TV
    return nil;
#endif

    RTCVideoSource *videoSource = [self.peerConnectionFactory videoSourceForScreenCast:YES];

    NSString *trackUUID = [[NSUUID UUID] UUIDString];
    RTCVideoTrack *videoTrack = [self.peerConnectionFactory videoTrackWithSource:videoSource trackId:trackUUID];

    ScreenCapturer *screenCapturer = [[ScreenCapturer alloc] initWithDelegate:videoSource];
    ScreenCaptureController *screenCaptureController =
        [[ScreenCaptureController alloc] initWithCapturer:screenCapturer];

    TrackCapturerEventsEmitter *emitter = [[TrackCapturerEventsEmitter alloc] initWith:trackUUID webRTCModule:self];
    screenCaptureController.eventsDelegate = emitter;
    videoTrack.captureController = screenCaptureController;
    [screenCaptureController startCapture];

    return videoTrack;
}

- (void)getDisplayMedia:(NSDictionary *)constraints
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject {
#if TARGET_OS_TV
    reject(@"unsupported_platform", @"tvOS is not supported", nil);
    return;
#else

    RTCVideoTrack *videoTrack = [self createScreenCaptureVideoTrack];

    if (videoTrack == nil) {
        reject(@"DOMException", @"AbortError", nil);
        return;
    }

    NSString *mediaStreamId = [[NSUUID UUID] UUIDString];
    RTCMediaStream *mediaStream = [self.peerConnectionFactory mediaStreamWithStreamId:mediaStreamId];
    [mediaStream addVideoTrack:videoTrack];

    NSString *trackId = videoTrack.trackId;
    self.localTracks[trackId] = videoTrack;

    NSDictionary *trackInfo = @{
        @"enabled" : @(videoTrack.isEnabled),
        @"id" : videoTrack.trackId,
        @"kind" : videoTrack.kind,
        @"readyState" : @"live",
        @"remote" : @(NO)
    };

    self.localStreams[mediaStreamId] = mediaStream;
    resolve(@{@"streamId" : mediaStreamId, @"track" : trackInfo});
#endif
}

/**
 * Implements {@code getUserMedia}. Note that at this point constraints have
 * been normalized and permissions have been granted. The constraints only
 * contain keys for which permissions have already been granted, that is,
 * if audio permission was not granted, there will be no "audio" key in
 * the constraints dictionary.
 */
- (void)getUserMedia:(NSDictionary *)constraints
     successCallback:(RCTResponseSenderBlock)successCallback
       errorCallback:(RCTResponseSenderBlock)errorCallback {
#if TARGET_OS_TV
    errorCallback(@[ @"PlatformNotSupported", @"getUserMedia is not supported on tvOS." ]);
    return;
#else
    RTCAudioTrack *audioTrack = nil;
    RTCVideoTrack *videoTrack = nil;

    if (constraints[@"audio"]) {
        audioTrack = [self createAudioTrack:constraints];
    }
    if (constraints[@"video"]) {
        videoTrack = [self createVideoTrack:constraints];
    }

    if (audioTrack == nil && videoTrack == nil) {
        // Fail with DOMException with name AbortError as per:
        // https://www.w3.org/TR/mediacapture-streams/#dom-mediadevices-getusermedia
        errorCallback(@[ @"DOMException", @"AbortError" ]);
        return;
    }

    NSString *mediaStreamId = [[NSUUID UUID] UUIDString];
    RTCMediaStream *mediaStream = [self.peerConnectionFactory mediaStreamWithStreamId:mediaStreamId];
    NSMutableArray *tracks = [NSMutableArray array];
    NSMutableArray *tmp = [NSMutableArray array];
    if (audioTrack)
        [tmp addObject:audioTrack];
    if (videoTrack)
        [tmp addObject:videoTrack];

    for (RTCMediaStreamTrack *track in tmp) {
        if ([track.kind isEqualToString:@"audio"]) {
            [mediaStream addAudioTrack:(RTCAudioTrack *)track];
        } else if ([track.kind isEqualToString:@"video"]) {
            [mediaStream addVideoTrack:(RTCVideoTrack *)track];
        }

        NSString *trackId = track.trackId;

        self.localTracks[trackId] = track;

        NSDictionary *settings = @{};
        if ([track.kind isEqualToString:@"video"]) {
            RTCVideoTrack *videoTrack = (RTCVideoTrack *)track;
            if ([videoTrack.captureController isKindOfClass:[CaptureController class]]) {
                settings = [videoTrack.captureController getSettings];
            }
        } else if ([track.kind isEqualToString:@"audio"]) {
            settings = @{
                @"deviceId" : @"audio",
                @"groupId" : @"",
            };
        }

        [tracks addObject:@{
            @"enabled" : @(track.isEnabled),
            @"id" : trackId,
            @"kind" : track.kind,
            @"readyState" : @"live",
            @"remote" : @(NO),
            @"settings" : settings
        }];
    }

    self.localStreams[mediaStreamId] = mediaStream;
    successCallback(@[ mediaStreamId, tracks ]);
#endif
}

#pragma mark - Other stream related APIs

- (void)enumerateDevices:(RCTResponseSenderBlock)callback {
#if TARGET_OS_TV
    callback(@[]);
#else
    NSMutableArray *devices = [NSMutableArray array];
    NSMutableArray *deviceTypes = [NSMutableArray array];
    [deviceTypes addObjectsFromArray:@[
        AVCaptureDeviceTypeBuiltInWideAngleCamera,
        AVCaptureDeviceTypeBuiltInUltraWideCamera,
        AVCaptureDeviceTypeBuiltInTelephotoCamera,
        AVCaptureDeviceTypeBuiltInDualCamera,
        AVCaptureDeviceTypeBuiltInDualWideCamera,
        AVCaptureDeviceTypeBuiltInTripleCamera
    ]];
    if (@available(macos 14.0, ios 17.0, tvos 17.0, *)) {
        [deviceTypes addObject:AVCaptureDeviceTypeExternal];
    }
    AVCaptureDeviceDiscoverySession *videoDevicesSession =
        [AVCaptureDeviceDiscoverySession discoverySessionWithDeviceTypes:deviceTypes
                                                               mediaType:AVMediaTypeVideo
                                                                position:AVCaptureDevicePositionUnspecified];
    for (AVCaptureDevice *device in videoDevicesSession.devices) {
        if (device.uniqueID == nil) {
            continue;
        }
        NSString *position = @"unknown";
        if (device.position == AVCaptureDevicePositionBack) {
            position = @"environment";
        } else if (device.position == AVCaptureDevicePositionFront) {
            position = @"front";
        }
        NSString *label = @"Unknown video device";
        if (device.localizedName != nil) {
            label = device.localizedName;
        }

        [devices addObject:@{
            @"facing" : position,
            @"deviceId" : device.uniqueID,
            @"groupId" : @"",
            @"label" : label,
            @"kind" : @"videoinput",
        }];
    }

    AVCaptureDeviceDiscoverySession *audioDevicesSession =
        [AVCaptureDeviceDiscoverySession discoverySessionWithDeviceTypes:@[ AVCaptureDeviceTypeBuiltInMicrophone ]
                                                               mediaType:AVMediaTypeAudio
                                                                position:AVCaptureDevicePositionUnspecified];
    for (AVCaptureDevice *device in audioDevicesSession.devices) {
        if (device.uniqueID == nil) {
            continue;
        }
        NSString *label = @"Unknown audio device";
        if (device.localizedName != nil) {
            label = device.localizedName;
        }
        [devices addObject:@{
            @"deviceId" : device.uniqueID,
            @"groupId" : @"",
            @"label" : label,
            @"kind" : @"audioinput",
        }];
    }
    callback(@[ devices ]);
#endif
}

- (void)mediaStreamCreate:(nonnull NSString *)streamID {
    RTCMediaStream *mediaStream = [self.peerConnectionFactory mediaStreamWithStreamId:streamID];
    self.localStreams[streamID] = mediaStream;
}

- (void)mediaStreamAddTrack:(nonnull NSString *)streamID
                       pcId:(NSInteger)peerConnectionId
                    trackId:(nonnull NSString *)trackID {
    NSNumber *pcId = @(peerConnectionId);
    RTCMediaStream *mediaStream = self.localStreams[streamID];
    if (mediaStream == nil) {
        return;
    }

    RTCMediaStreamTrack *track = [self trackForId:trackID pcId:pcId];
    if (track == nil) {
        return;
    }

    if ([track.kind isEqualToString:@"audio"]) {
        [mediaStream addAudioTrack:(RTCAudioTrack *)track];
    } else if ([track.kind isEqualToString:@"video"]) {
        [mediaStream addVideoTrack:(RTCVideoTrack *)track];
    }
}

- (void)mediaStreamRemoveTrack:(nonnull NSString *)streamID
                          pcId:(NSInteger)peerConnectionId
                       trackId:(nonnull NSString *)trackID {
    NSNumber *pcId = @(peerConnectionId);
    RTCMediaStream *mediaStream = self.localStreams[streamID];
    if (mediaStream == nil) {
        return;
    }

    RTCMediaStreamTrack *track = [self trackForId:trackID pcId:pcId];
    if (track == nil) {
        return;
    }

    if ([track.kind isEqualToString:@"audio"]) {
        [mediaStream removeAudioTrack:(RTCAudioTrack *)track];
    } else if ([track.kind isEqualToString:@"video"]) {
        [mediaStream removeVideoTrack:(RTCVideoTrack *)track];
    }
}

- (void)mediaStreamRelease:(nonnull NSString *)streamID {
    RTCMediaStream *stream = self.localStreams[streamID];
    if (stream) {
        [self.localStreams removeObjectForKey:streamID];
    }
}

- (void)mediaStreamTrackRelease:(nonnull NSString *)trackID {
#if TARGET_OS_TV
    return;
#else

    RTCMediaStreamTrack *track = self.localTracks[trackID];
    if (track) {
        track.isEnabled = NO;
        [track.captureController stopCapture];
        [self.localTracks removeObjectForKey:trackID];
    }
#endif
}

- (void)mediaStreamTrackSetEnabled:(NSInteger)peerConnectionId
                           trackId:(nonnull NSString *)trackID
                           enabled:(BOOL)enabled {
    NSNumber *pcId = @(peerConnectionId);
    RTCMediaStreamTrack *track = [self trackForId:trackID pcId:pcId];
    if (track == nil) {
        return;
    }

    NSMutableDictionary<NSString *, NSNumber *> *heldAudio = [self heldRemoteAudio];
    NSString *heldKey = HeldAudioKey(pcId, trackID);
    if (heldAudio[heldKey]) {
        // A hold keeps the track silent: it takes this state when the hold ends.
        heldAudio[heldKey] = @(enabled);
        return;
    }

    track.isEnabled = enabled;
#if !TARGET_OS_TV
    if (track.captureController) {  // It could be a remote track!
        if (enabled) {
            [track.captureController startCapture];
        } else {
            [track.captureController stopCapture];
        }
    }
#endif
}

- (void)mediaStreamTrackApplyConstraints:(nonnull NSString *)trackID
                             constraints:(NSDictionary *)constraints
                                 resolve:(RCTPromiseResolveBlock)resolve
                                  reject:(RCTPromiseRejectBlock)reject {
#if TARGET_OS_TV
    reject(@"unsupported_platform", @"tvOS is not supported", nil);
    return;
#else
    RTCMediaStreamTrack *track = self.localTracks[trackID];
    if (track) {
        if ([track.kind isEqualToString:@"video"]) {
            RTCVideoTrack *videoTrack = (RTCVideoTrack *)track;
            if ([videoTrack.captureController isKindOfClass:[CaptureController class]]) {
                CaptureController *vcc = (CaptureController *)videoTrack.captureController;
                NSError *error = nil;
                [vcc applyConstraints:constraints error:&error];
                if (error) {
                    reject(@"E_INVALID", error.localizedDescription, error);
                } else {
                    resolve([vcc getSettings]);
                }
            }
        } else {
            RCTLogWarn(@"mediaStreamTrackApplyConstraints() track is not video");
            reject(@"E_INVALID", @"Can't apply constraints on audio tracks", nil);
        }
    } else {
        RCTLogWarn(@"mediaStreamTrackApplyConstraints() track is null");
        reject(@"E_INVALID", @"Could not get track", nil);
    }
#endif
}

- (void)mediaStreamTrackSetVolume:(NSInteger)peerConnectionId
                          trackId:(nonnull NSString *)trackID
                           volume:(double)volume {
    NSNumber *pcId = @(peerConnectionId);
    RTCMediaStreamTrack *track = [self trackForId:trackID pcId:pcId];
    if (track && [track.kind isEqualToString:@"audio"]) {
        RTCAudioTrack *audioTrack = (RTCAudioTrack *)track;
        audioTrack.source.volume = volume;
    }
}

- (void)mediaStreamTrackSetVideoEffects:(nonnull NSString *)trackID names:(nonnull NSArray<NSString *> *)names {
    RTCMediaStreamTrack *track = self.localTracks[trackID];
    if (track == nil) {
        return;
    }

    RTCVideoTrack *videoTrack = (RTCVideoTrack *)track;
    RTCVideoSource *videoSource = videoTrack.source;

    NSMutableArray *processors = [[NSMutableArray alloc] init];
    for (NSString *name in names) {
        NSObject<VideoFrameProcessorDelegate> *processor = [ProcessorProvider getProcessor:name];
        if (processor != nil) {
            [processors addObject:processor];
        }
    }

    self.videoEffectProcessor = [[VideoEffectProcessor alloc] initWithProcessors:processors videoSource:videoSource];

    VideoCaptureController *vcc = (VideoCaptureController *)videoTrack.captureController;
    RTCVideoCapturer *capturer = vcc.capturer;

    capturer.delegate = self.videoEffectProcessor;
}

#pragma mark - Remote audio holds

/** Remote audio tracks held silent, keyed by HeldAudioKey: whether each is enabled when the hold ends. */
- (NSMutableDictionary<NSString *, NSNumber *> *)heldRemoteAudio {
    NSMutableDictionary *heldAudio = objc_getAssociatedObject(self, _cmd);
    if (!heldAudio) {
        heldAudio = [NSMutableDictionary new];
        objc_setAssociatedObject(self, _cmd, heldAudio, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    return heldAudio;
}

/** How many holds each stream's remote audio has, keyed by the stream's react tag. */
- (NSMutableDictionary<NSString *, NSNumber *> *)remoteAudioHolds {
    NSMutableDictionary *holds = objc_getAssociatedObject(self, _cmd);
    if (!holds) {
        holds = [NSMutableDictionary new];
        objc_setAssociatedObject(self, _cmd, holds, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    return holds;
}

- (void)setRemoteAudioOfStream:(NSString *)streamReactTag held:(BOOL)held {
    NSMutableDictionary<NSString *, NSNumber *> *holds = [self remoteAudioHolds];
    NSUInteger count = holds[streamReactTag].unsignedIntegerValue;
    if (held) {
        holds[streamReactTag] = @(count + 1);
    } else if (count > 1) {
        holds[streamReactTag] = @(count - 1);
    } else {
        [holds removeObjectForKey:streamReactTag];
    }

    // Only the first hold and the last release change what plays.
    if (held ? count > 0 : count != 1) {
        return;
    }

    for (NSNumber *pcId in self.peerConnections) {
        RTCMediaStream *stream = self.peerConnections[pcId].remoteStreams[streamReactTag];
        for (RTCAudioTrack *track in stream.audioTracks) {
            [self updateHoldOfRemoteAudioTrack:track peerConnectionId:pcId];
        }
    }
}

- (void)updateHoldOfRemoteAudioTrack:(RTCAudioTrack *)track peerConnectionId:(NSNumber *)pcId {
    // Held while any held stream of its peer connection has it: a track can be in more than one.
    NSDictionary<NSString *, RTCMediaStream *> *streams = self.peerConnections[pcId].remoteStreams;
    BOOL held = NO;
    for (NSString *streamReactTag in [self remoteAudioHolds]) {
        if (StreamHasAudioTrack(streams[streamReactTag], track.trackId)) {
            held = YES;
            break;
        }
    }

    NSMutableDictionary<NSString *, NSNumber *> *heldAudio = [self heldRemoteAudio];
    NSString *key = HeldAudioKey(pcId, track.trackId);
    NSNumber *enabledAfterHold = heldAudio[key];
    if (held && !enabledAfterHold) {
        heldAudio[key] = @(track.isEnabled);
        track.isEnabled = NO;
    } else if (!held && enabledAfterHold) {
        [heldAudio removeObjectForKey:key];
        track.isEnabled = enabledAfterHold.boolValue;
    }
}

- (void)forgetHeldRemoteAudioOfPeerConnection:(NSNumber *)pcId {
    NSString *prefix = HeldAudioKey(pcId, @"");
    NSMutableDictionary<NSString *, NSNumber *> *heldAudio = [self heldRemoteAudio];
    for (NSString *key in heldAudio.allKeys) {
        if ([key hasPrefix:prefix]) {
            [heldAudio removeObjectForKey:key];
        }
    }
}

#pragma mark - Helpers

- (RTCMediaStreamTrack *)trackForId:(nonnull NSString *)trackId pcId:(nonnull NSNumber *)pcId {
    if ([pcId isEqualToNumber:[NSNumber numberWithInt:-1]]) {
        return self.localTracks[trackId];
    }

    RTCPeerConnection *peerConnection = self.peerConnections[pcId];
    if (peerConnection == nil) {
        return nil;
    }

    return peerConnection.remoteTracks[trackId];
}

@end
