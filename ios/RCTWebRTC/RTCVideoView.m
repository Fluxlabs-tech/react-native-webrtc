#import <AVFoundation/AVFoundation.h>
#import <objc/runtime.h>

#import <React/RCTLog.h>

#import <WebRTC/RTCMediaStream.h>
#if TARGET_OS_OSX
#import <WebRTC/RTCMTLNSVideoView.h>
#else
#import <WebRTC/RTCMTLVideoView.h>
#endif
#import <WebRTC/RTCCVPixelBuffer.h>
#import <WebRTC/RTCVideoFrame.h>
#import <WebRTC/RTCVideoTrack.h>

#import "PIPController.h"
#import "RTCVideoView.h"
#import "WebRTCModule+RTCMediaStream.h"
#import "WebRTCModule.h"

@implementation RTCVideoView {
    NSString *_streamURL;
    /** The picture-in-picture window has the video paused, so the stream's remote audio is silent. */
    BOOL _pictureInPicturePaused;
    /** The stream whose remote audio this view holds silent. */
    NSString *_audioHeldStreamURL;
}

@synthesize videoView = _videoView;
@synthesize pipController = _pipController;

/**
 * Tells this view that its window object changed.
 */
- (void)didMoveToWindow {
    // This RTCVideoView strongly retains its videoTrack. The latter strongly
    // retains the former as well though because RTCVideoTrack strongly retains
    // the RTCVideoRenderers added to it. In other words, there is a cycle of
    // strong retainments. In order to break the cycle, and avoid a leak,
    // have this RTCVideoView as the RTCVideoRenderer of its
    // videoTrack only while this view resides in a window.
    RTCVideoTrack *videoTrack = self.videoTrack;

    if (videoTrack) {
        if (self.window) {
            dispatch_async(_module.workerQueue, ^{
                [videoTrack addRenderer:self.videoView];
            });
        } else {
            dispatch_async(_module.workerQueue, ^{
                [videoTrack removeRenderer:self.videoView];
            });
        }
    }

    if (@available(iOS 15.0, *)) {
        [_pipController sourceViewDidMoveToWindow];
    }
}

- (void)dealloc {
    // The picture-in-picture controller goes with the view: left alone, it stays registered with the
    // system after the view is gone. AVKit is main-thread only, and the last hold on a view can be a
    // block on the worker queue.
    if (@available(iOS 15.0, *)) {
        PIPController *pipController = _pipController;
        if (pipController && NSThread.isMainThread) {
            [pipController invalidate];
        } else if (pipController) {
            dispatch_async(dispatch_get_main_queue(), ^{
                [pipController invalidate];
            });
        }
    }

    // The view's hold on the stream's audio ends with the view.
    NSString *held = _audioHeldStreamURL;
    WebRTCModule *module = _module;
    if (held && module) {
        dispatch_async(module.workerQueue, ^{
            [module setRemoteAudioOfStream:held held:NO];
        });
    }
}

/**
 * Initializes and returns a newly allocated view object with the specified
 * frame rectangle.
 *
 * @param frame The frame rectangle for the view, measured in points.
 */
- (instancetype)initWithFrame:(CGRect)frame {
    if (self = [super initWithFrame:frame]) {
#if TARGET_OS_OSX
        RTCMTLNSVideoView *subview = [[RTCMTLNSVideoView alloc] initWithFrame:CGRectZero];
        subview.wantsLayer = true;
        _videoView = subview;
#else
        RTCMTLVideoView *subview = [[RTCMTLVideoView alloc] initWithFrame:CGRectZero];
        _videoView = subview;
#endif
        _objectFit = RTCVideoViewObjectFitCover;
        _autoStartPictureInPicture = YES;
        _autoStopPictureInPicture = YES;
        [self addSubview:self.videoView];
        self.videoView.delegate = self;
    }

    return self;
}

#if TARGET_OS_OSX
- (void)layout {
    [super layout];
#else
- (void)layoutSubviews {
    [super layoutSubviews];
#endif

    CGRect bounds = self.bounds;
    self.videoView.frame = bounds;

    // Without a preferred size the video call's window follows the screen, which turns as the app
    // rotates.
    if (@available(iOS 15.0, *)) {
        _pipController.preferredSize = [self pictureInPictureSize];
    }
}

/**
 * Implements the setter of the {@link #mirror} property of this
 * {@code RTCVideoView}.
 *
 * @param mirror The value to set on the {@code mirror} property of this
 * {@code RTCVideoView}.
 */
- (void)setMirror:(BOOL)mirror {
    if (_mirror != mirror) {
        _mirror = mirror;

        self.videoView.transform = mirror ? CGAffineTransformMakeScale(-1.0, 1.0) : CGAffineTransformIdentity;
        if (@available(iOS 15.0, *)) {
            _pipController.mirror = mirror;
        }
    }
}

- (void)setPictureInPictureKind:(PIPControllerKind)pictureInPictureKind {
    if (_pictureInPictureKind != pictureInPictureKind) {
        _pictureInPictureKind = pictureInPictureKind;
        if (@available(iOS 15.0, *)) {
            // Each kind has a content source, and so a controller, of its own.
            if (_pipController) {
                [self discardPictureInPictureController];
                [self applyPictureInPictureParams];
            }
        }
    }
}

- (void)setPictureInPictureEnabled:(BOOL)pictureInPictureEnabled {
    _pictureInPictureEnabled = pictureInPictureEnabled;
    if (@available(iOS 15.0, *)) {
        [self applyPictureInPictureParams];
    }
}

- (void)setAutoStartPictureInPicture:(BOOL)autoStartPictureInPicture {
    if (_autoStartPictureInPicture != autoStartPictureInPicture) {
        _autoStartPictureInPicture = autoStartPictureInPicture;
        if (@available(iOS 15.0, *)) {
            [self applyPictureInPictureParams];
        }
    }
}

- (void)setAutoStopPictureInPicture:(BOOL)autoStopPictureInPicture {
    if (_autoStopPictureInPicture != autoStopPictureInPicture) {
        _autoStopPictureInPicture = autoStopPictureInPicture;
        if (_autoStartPictureInPicture) {
            if (@available(iOS 15.0, *)) {
                [self applyPictureInPictureParams];
            }
        }
    }
}

- (void)setPictureInPicturePreferredSize:(CGSize)pictureInPicturePreferredSize {
    if (!CGSizeEqualToSize(_pictureInPicturePreferredSize, pictureInPicturePreferredSize)) {
        _pictureInPicturePreferredSize = pictureInPicturePreferredSize;
        if (_autoStartPictureInPicture) {
            if (@available(iOS 15.0, *)) {
                [self applyPictureInPictureParams];
            }
        }
    }
}

- (void)insertFallbackView:(UIView *)view {
    [_pipController insertFallbackView:view];
}

- (void)API_AVAILABLE(ios(15.0))applyPictureInPictureParams {
    if (!_pictureInPictureEnabled) {
        [self discardPictureInPictureController];
        return;
    }

    if (!_pipController) {
        _pipController = [[PIPController alloc] initWithSourceView:self kind:_pictureInPictureKind];
        _pipController.delegate = self;
        _pipController.mirror = _mirror;
        _pipController.objectFit = _objectFit;
        _pipController.videoTrack = _videoTrack;
    }

    _pipController.preferredSize = [self pictureInPictureSize];
    _pipController.startAutomatically = _autoStartPictureInPicture;
    _pipController.stopAutomatically = _autoStopPictureInPicture;
    _pipController.objectFit = _objectFit;
}

- (void)API_AVAILABLE(ios(15.0))discardPictureInPictureController {
    BOOL paused = _pipController.paused;
    [_pipController invalidate];
    _pipController = nil;
    // Nothing is left to play it from: the video plays on.
    if (paused) {
        [self didChangePictureInPicturePlaying:YES];
    }
}

/**
 * The video call window's shape: the preferred size, or without one the screen's, as the app holds
 * it. The player's window takes the video's.
 */
- (CGSize)pictureInPictureSize {
    if (!CGSizeEqualToSize(_pictureInPicturePreferredSize, CGSizeZero)) {
        return _pictureInPicturePreferredSize;
    }
    UIScreen *screen = self.window.windowScene.screen ?: UIScreen.mainScreen;
    return screen.bounds.size;
}

- (void)API_AVAILABLE(ios(15.0))startPIPWithParams:(BOOL)shouldApplyParams {
    if (shouldApplyParams) {
        [self applyPictureInPictureParams];
    }
    [_pipController startPIP];
}

- (void)API_AVAILABLE(ios(15.0))stopPIP {
    [_pipController stopPIP];
}

/**
 * Implements the setter of the {@link #objectFit} property of this
 * {@code RTCVideoView}.
 *
 * @param objectFit The value to set on the {@code objectFit} property of this
 * {@code RTCVideoView}.
 */
- (void)setObjectFit:(RTCVideoViewObjectFit)fit {
    if (_objectFit != fit) {
        _objectFit = fit;

#if !TARGET_OS_OSX
        if (fit == RTCVideoViewObjectFitCover) {
            self.videoView.videoContentMode = UIViewContentModeScaleAspectFill;
        } else {
            self.videoView.videoContentMode = UIViewContentModeScaleAspectFit;
        }
#endif
        if (@available(iOS 15.0, *)) {
            _pipController.objectFit = fit;
        }
    }
}

/**
 * Implements the setter of the {@link #videoTrack} property of this
 * {@code RTCVideoView}.
 *
 * @param videoTrack The value to set on the {@code videoTrack} property of this
 * {@code RTCVideoView}.
 */
- (void)setVideoTrack:(RTCVideoTrack *)videoTrack {
    RTCVideoTrack *oldValue = self.videoTrack;

    if (oldValue != videoTrack) {
        if (oldValue) {
            dispatch_async(_module.workerQueue, ^{
                [oldValue removeRenderer:self.videoView];
            });
        }

        [_pipController setVideoTrack:videoTrack];
        _videoTrack = videoTrack;

        // Clear the videoView by rendering a 2x2 blank frame.
        CVPixelBufferRef pixelBuffer;
        CVReturn err = CVPixelBufferCreate(NULL, 2, 2, kCVPixelFormatType_32BGRA, NULL, &pixelBuffer);
        if (err == kCVReturnSuccess) {
            const int kBytesPerPixel = 4;
            CVPixelBufferLockBaseAddress(pixelBuffer, 0);
            int bufferWidth = (int)CVPixelBufferGetWidth(pixelBuffer);
            int bufferHeight = (int)CVPixelBufferGetHeight(pixelBuffer);
            size_t bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer);
            uint8_t *baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer);

            for (int row = 0; row < bufferHeight; row++) {
                uint8_t *pixel = baseAddress + row * bytesPerRow;
                for (int column = 0; column < bufferWidth; column++) {
                    pixel[0] = 0;  // BGRA, Blue value
                    pixel[1] = 0;  // Green value
                    pixel[2] = 0;  // Red value
                    pixel[3] = 0;  // Alpha value
                    pixel += kBytesPerPixel;
                }
            }

            CVPixelBufferUnlockBaseAddress(pixelBuffer, 0);
            int64_t time = (int64_t)(CFAbsoluteTimeGetCurrent() * 1000000000);
            RTCCVPixelBuffer *buffer = [[RTCCVPixelBuffer alloc] initWithPixelBuffer:pixelBuffer];
            RTCVideoFrame *frame = [[[RTCVideoFrame alloc] initWithBuffer:buffer
                                                                 rotation:RTCVideoRotation_0
                                                              timeStampNs:time] newI420VideoFrame];

            [self.videoView renderFrame:frame];

            CVPixelBufferRelease(pixelBuffer);
        }

        // See "didMoveToWindow" above.
        if (videoTrack && self.window) {
            dispatch_async(_module.workerQueue, ^{
                [videoTrack addRenderer:self.videoView];
            });
        }
    }
}

- (void)setStreamURL:(NSString *)streamURL {
    _streamURL = [streamURL copy];
    // The hold follows whichever stream the view shows.
    [self updateAudioHold];

    if (!streamURL) {
        self.videoTrack = nil;
        return;
    }

    WebRTCModule *module = self.module;
    if (!module) {
        RCTLogWarn(@"WebRTCModule not loaded, cannot render stream %@", streamURL);
        return;
    }

    dispatch_async(module.workerQueue, ^{
        RTCMediaStream *stream = [module streamForReactTag:streamURL];
        NSArray *videoTracks = stream ? stream.videoTracks : @[];
        RTCVideoTrack *videoTrack = [videoTracks firstObject];
        if (!videoTrack) {
            RCTLogWarn(@"No video stream for react tag: %@", streamURL);
        } else {
            dispatch_async(dispatch_get_main_queue(), ^{
                self.videoTrack = videoTrack;
            });
        }
    });
}

- (void)setMuted:(BOOL)muted {
    _muted = muted;
    [self updateAudioHold];
}

/**
 * Silences the stream's remote audio while the view is muted, or while the picture-in-picture window
 * has the video paused, as a player's pause would, and lets it play again after.
 */
- (void)updateAudioHold {
    NSString *streamURL = (_muted || _pictureInPicturePaused) ? _streamURL : nil;
    if (streamURL == _audioHeldStreamURL || [streamURL isEqualToString:_audioHeldStreamURL]) {
        return;
    }

    WebRTCModule *module = self.module;
    NSString *released = _audioHeldStreamURL;
    _audioHeldStreamURL = module ? streamURL : nil;
    if (!module) {
        return;
    }
    dispatch_async(module.workerQueue, ^{
        if (released) {
            [module setRemoteAudioOfStream:released held:NO];
        }
        if (streamURL) {
            [module setRemoteAudioOfStream:streamURL held:YES];
        }
    });
}

#pragma mark PIPControllerDelegate

- (void)didChangePictureInPicture:(BOOL)isInPictureInPicture dismissed:(BOOL)dismissed {
    if (self.onPictureInPictureChange) {
        self.onPictureInPictureChange(
            @{@"isInPictureInPicture" : @(isInPictureInPicture), @"dismissed" : @(dismissed)});
    }
}

- (void)didChangePictureInPicturePlaying:(BOOL)playing {
    _pictureInPicturePaused = !playing;
    [self updateAudioHold];
    if (self.onPictureInPicturePlayingChange) {
        self.onPictureInPicturePlayingChange(@{@"playing" : @(playing)});
    }
}

#pragma mark RTCVideoViewDelegate
- (void)videoView:(id)videoView didChangeVideoSize:(CGSize)size {
    // Capture the callback block to avoid accessing it across threads
    RTCVideoViewEventBlock callback = self.onDimensionsChange;
    if (callback) {
        NSDictionary *eventData = @{@"width" : @(size.width), @"height" : @(size.height)};

        dispatch_async(dispatch_get_main_queue(), ^{
            callback(eventData);
        });
    }
}

@end
