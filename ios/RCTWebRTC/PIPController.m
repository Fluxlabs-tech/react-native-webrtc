#import "PIPController.h"
#import <AVKit/AVKit.h>
#import "SampleBufferPlaybackView.h"
#import "SampleBufferVideoCallView.h"

@interface PIPController ()<AVPictureInPictureSampleBufferPlaybackDelegate>

@property(nonatomic, strong) AVPictureInPictureControllerContentSource *contentSource;
@property(nonatomic, strong) AVPictureInPictureController *pipController;

// The video call's window: a view controller with the video, or the fallback view until there is one.
@property(nonatomic, strong) AVPictureInPictureVideoCallViewController *pipCallViewController;
@property(nonatomic, strong) SampleBufferVideoCallView *sampleView;
// The player's window: the layer AVKit takes into it.
@property(nonatomic, strong) SampleBufferPlaybackView *playbackView;

@property(nonnull, nonatomic, strong) UIView *fallbackView;

/** Mirrors pictureInPictureActive, which is main-thread state, for reads from other threads. */
@property(atomic, assign) BOOL pictureInPictureActive;

@end

@implementation PIPController {
    BOOL _inBackground;
    /** Between the window's willStart and its didStart or failure. */
    BOOL _starting;
    /** AVKit asked for the app's interface back: the window is stopping for a return to the app. */
    BOOL _restoring;
    /** The app is stopping the window. */
    BOOL _stopping;
    /** The app wants the window to start as it leaves; offered only while the view is on screen. */
    BOOL _startAutomaticallyRequested;
    /** Discarded: offers, shows and draws nothing again. */
    BOOL _invalidated;
    /** startFloating is in effect, until stopFloating. */
    BOOL _floatingRequested;
    /** The player's view is in the app's window, lent there for startFloating. */
    BOOL _playbackViewLent;
}

/** Every live controller, held weakly, for isAnyPictureInPictureActive. */
static NSHashTable<PIPController *> *PIPControllerInstances(void) {
    static NSHashTable *instances;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        instances = [NSHashTable weakObjectsHashTable];
    });
    return instances;
}

+ (BOOL)isAnyPictureInPictureActive {
    NSHashTable<PIPController *> *instances = PIPControllerInstances();
    @synchronized(instances) {
        for (PIPController *controller in instances) {
            if (controller.pictureInPictureActive) {
                return YES;
            }
        }
    }
    return NO;
}

- (instancetype)initWithSourceView:(UIView *)sourceView kind:(PIPControllerKind)kind {
    if (self = [super init]) {
        _kind = kind;
        self.sourceView = sourceView;

        NSHashTable<PIPController *> *instances = PIPControllerInstances();
        @synchronized(instances) {
            [instances addObject:self];
        }

        _fallbackView = [[UIView alloc] initWithFrame:CGRectZero];
        _fallbackView.translatesAutoresizingMaskIntoConstraints = false;
        _inBackground = UIApplication.sharedApplication.applicationState == UIApplicationStateBackground;

        if (kind == PIPControllerKindVideoCall) {
            SampleBufferVideoCallView *subview = [[SampleBufferVideoCallView alloc] initWithFrame:CGRectZero];
            _sampleView = subview;
            _sampleView.translatesAutoresizingMaskIntoConstraints = false;
            _pipCallViewController = [[AVPictureInPictureVideoCallViewController alloc] init];

            [self addToCallViewController:_fallbackView];

            _contentSource = [[AVPictureInPictureControllerContentSource alloc]
                initWithActiveVideoCallSourceView:sourceView
                            contentViewController:_pipCallViewController];
        } else {
            _playbackView = [[SampleBufferPlaybackView alloc] initWithFrame:sourceView.bounds];
            _playbackView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
            [sourceView insertSubview:_playbackView atIndex:0];

            _contentSource = [[AVPictureInPictureControllerContentSource alloc]
                initWithSampleBufferDisplayLayer:_playbackView.displayLayer
                                playbackDelegate:self];
        }

        _pipController = [[AVPictureInPictureController alloc] initWithContentSource:_contentSource];
        // Live: there is nothing to skip through or scrub, so the window greys its skip buttons out.
        _pipController.requiresLinearPlayback = kind == PIPControllerKindPlayback;
        _pipController.delegate = self;
        _startAutomaticallyRequested = YES;
        [self updateStartAutomatically];

        [_pipController addObserver:self
                         forKeyPath:@"pictureInPictureActive"
                            options:NSKeyValueObservingOptionInitial | NSKeyValueObservingOptionNew
                            context:nil];

        NSNotificationCenter *center = [NSNotificationCenter defaultCenter];
        [center addObserver:self
                   selector:@selector(applicationWillEnterForeground:)
                       name:UIApplicationWillEnterForegroundNotification
                     object:nil];
        [center addObserver:self
                   selector:@selector(applicationDidEnterBackground:)
                       name:UIApplicationDidEnterBackgroundNotification
                     object:nil];
    }

    return self;
}

- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary *)change
                       context:(void *)context {
    if ([keyPath isEqualToString:@"pictureInPictureActive"]) {
        BOOL active = [change[NSKeyValueChangeNewKey] boolValue];
        _sampleView.shouldRender = active;
        self.pictureInPictureActive = active;
        [self updateRendering];
    }
}

- (void)applicationDidEnterBackground:(NSNotification *)notification {
    _inBackground = YES;
    [self updateRendering];
}

- (void)applicationWillEnterForeground:(NSNotification *)notification {
    _inBackground = NO;
    [self updateRendering];

    // Closing the window paused the video; back in the app, it plays.
    if (!_pipController.isPictureInPictureActive) {
        [self setPaused:NO];
    }

    if (_stopAutomatically) {
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 0.5 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            [self stopPIP];
        });
    }
}

- (void)sourceViewDidMoveToWindow {
    [self updatePlaybackViewPlacement];
    [self updateRendering];
    [self updateStartAutomatically];
}

/**
 * The player's layer takes frames while the app shows the view, so the window opens on the current
 * picture, and while the window shows or opens. In the background without the window, the layer
 * would only fail them.
 */
- (void)updateRendering {
    _playbackView.rendering = _starting || _pipController.isPictureInPictureActive ||
                              (!_inBackground && (self.sourceView.window != nil || _playbackViewLent));
}

/**
 * Only a view on screen offers to start the window as the app leaves. AVKit does not notice the view
 * going, so a controller that outlives it stays registered with the system, still offering; and with
 * more than one of an app's controllers offering, iOS starts none (SpringBoard's "ShouldAutoPiP: NO").
 */
- (void)updateStartAutomatically {
    BOOL offer = !_invalidated && (_startAutomaticallyRequested || _floatingRequested) &&
                 (self.sourceView.window != nil || _playbackViewLent);
    if (_pipController.canStartPictureInPictureAutomaticallyFromInline != offer) {
        _pipController.canStartPictureInPictureAutomaticallyFromInline = offer;
    }
}

- (void)addToCallViewController:(UIView *)view {
    [_pipCallViewController.view addSubview:view];
    NSArray *constraints = @[
        [view.leadingAnchor constraintEqualToAnchor:_pipCallViewController.view.leadingAnchor],
        [view.trailingAnchor constraintEqualToAnchor:_pipCallViewController.view.trailingAnchor],
        [view.topAnchor constraintEqualToAnchor:_pipCallViewController.view.topAnchor],
        [view.bottomAnchor constraintEqualToAnchor:_pipCallViewController.view.bottomAnchor]
    ];
    [NSLayoutConstraint activateConstraints:constraints];
}

/** What draws the track: the video call's view, or the player's layer. */
- (id<RTCVideoRenderer>)renderer {
    if (_sampleView) {
        return _sampleView;
    }
    return _playbackView;
}

- (void)setVideoTrack:(RTCVideoTrack *)videoTrack {
    if (_invalidated || _videoTrack == videoTrack) {
        return;
    }

    [_videoTrack removeRenderer:self.renderer];
    _videoTrack = videoTrack;
    [videoTrack addRenderer:self.renderer];

    if (_kind == PIPControllerKindPlayback) {
        if (!videoTrack) {
            [_playbackView clear];
        }
        // Whether there is anything to play.
        [_pipController invalidatePlaybackState];
        return;
    }

    if (_videoTrack) {
        if (!_sampleView.superview) {
            [self addToCallViewController:_sampleView];
        }
        if (_fallbackView.superview) {
            [_fallbackView removeFromSuperview];
        }
    } else {
        if (!_fallbackView.superview) {
            [self addToCallViewController:_fallbackView];
        }
        if (_sampleView.superview) {
            [_sampleView removeFromSuperview];
        }
    }
}

- (void)insertFallbackView:(UIView *)view {
    [self.fallbackView addSubview:view];
}

- (void)setObjectFit:(RTCVideoViewObjectFit)fit {
    AVLayerVideoGravity gravity =
        fit == RTCVideoViewObjectFitCover ? AVLayerVideoGravityResizeAspectFill : AVLayerVideoGravityResizeAspect;
    self.sampleView.sampleBufferLayer.videoGravity = gravity;
    [self.playbackView setVideoGravity:gravity];
}

- (void)setMirror:(BOOL)mirror {
    _mirror = mirror;
    _playbackView.mirror = mirror;
}

- (CGSize)preferredSize {
    return _pipCallViewController.preferredContentSize;
}

- (void)setPreferredSize:(CGSize)size {
    if (!CGSizeEqualToSize(size, _pipCallViewController.preferredContentSize)) {
        _pipCallViewController.preferredContentSize = size;
        [_sampleView requestScaleRecalculation];
    }
}

- (BOOL)startAutomatically {
    return _startAutomaticallyRequested;
}

- (void)setStartAutomatically:(BOOL)value {
    _startAutomaticallyRequested = value;
    [self updateStartAutomatically];
}

- (void)togglePIP {
    if (_pipController.isPictureInPictureActive) {
        [self stopPIP];
    } else {
        [self startPIP];
    }
}

- (void)startPIP {
    if (_pipController.isPictureInPicturePossible) {
        [_pipController startPictureInPicture];
    }
}

- (void)stopPIP {
    if (_pipController.isPictureInPictureActive) {
        _stopping = YES;
        [_pipController stopPictureInPicture];
    }
}

- (void)startFloating {
    if (_invalidated || _floatingRequested) {
        return;
    }
    _floatingRequested = YES;
    [self updatePlaybackViewPlacement];
    [self updateRendering];
    [self updateStartAutomatically];
}

- (void)stopFloating {
    if (!_floatingRequested) {
        return;
    }
    _floatingRequested = NO;
    // A window still up when the app is done with it closes, as on Android; its didStop puts the
    // layer back.
    [self stopPIP];
    [self updatePlaybackViewPlacement];
    [self updateRendering];
    [self updateStartAutomatically];
}

/**
 * While startFloating is in effect and this view is off screen, the player's view goes in the app's
 * window, behind everything there: the system starts a window as the app leaves only from a layer
 * in one, and calls to start one from the app itself fail while the layer is out of sight. Never
 * while a window has the layer.
 */
- (void)updatePlaybackViewPlacement {
    if (_starting || _pipController.isPictureInPictureActive) {
        return;
    }
    BOOL lend = _floatingRequested && !_invalidated && _kind == PIPControllerKindPlayback &&
                self.sourceView.window == nil;
    if (lend) {
        [self lendPlaybackView];
    } else {
        [self returnPlaybackView];
    }
}

/** The app's window in front, where the player's view goes while its own view is off screen. */
- (UIWindow *)appWindow {
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if (scene.activationState != UISceneActivationStateForegroundActive ||
            ![scene isKindOfClass:UIWindowScene.class]) {
            continue;
        }
        UIWindowScene *windowScene = (UIWindowScene *)scene;
        if (windowScene.keyWindow) {
            return windowScene.keyWindow;
        }
        for (UIWindow *window in windowScene.windows) {
            if (window.isKeyWindow) {
                return window;
            }
        }
    }
    return nil;
}

/**
 * Behind everything in the window and as big as it, as the live was: the system starts its window
 * only from a layer that fills the screen, and grows it out of there.
 */
- (void)lendPlaybackView {
    UIWindow *window = [self appWindow];
    if (_playbackViewLent || !window) {
        return;
    }
    _playbackViewLent = YES;
    _playbackView.frame = window.bounds;
    [window insertSubview:_playbackView atIndex:0];
}

- (void)returnPlaybackView {
    if (!_playbackViewLent) {
        return;
    }
    _playbackViewLent = NO;
    UIView *sourceView = self.sourceView;
    if (sourceView) {
        _playbackView.frame = sourceView.bounds;
        [sourceView insertSubview:_playbackView atIndex:0];
    } else {
        [_playbackView removeFromSuperview];
    }
}

- (void)setPaused:(BOOL)paused {
    if (_paused == paused) {
        return;
    }

    _paused = paused;
    _playbackView.paused = paused;
    [_pipController invalidatePlaybackState];
    if ([self.delegate respondsToSelector:@selector(didChangePictureInPicturePlaying:)]) {
        [self.delegate didChangePictureInPicturePlaying:!paused];
    }
}

- (void)invalidate {
    if (_invalidated) {
        return;
    }
    _invalidated = YES;
    _floatingRequested = NO;
    _playbackViewLent = NO;

    // Withdrawn first: the system may go on holding this controller, but no longer counts it.
    _pipController.canStartPictureInPictureAutomaticallyFromInline = NO;
    if (_pipController.isPictureInPictureActive) {
        _stopping = YES;
        [_pipController stopPictureInPicture];
    }
    _pipController.delegate = nil;
    [_pipController removeObserver:self forKeyPath:@"pictureInPictureActive"];
    [[NSNotificationCenter defaultCenter] removeObserver:self];
    self.pictureInPictureActive = NO;

    [_videoTrack removeRenderer:self.renderer];
    _videoTrack = nil;
    // The layer goes back out of AVKit, which would otherwise keep it for as long as it keeps the
    // controller.
    _pipController.contentSource = nil;
    [_playbackView removeFromSuperview];
}

- (void)dealloc {
    [self invalidate];
}

#pragma mark AVPictureInPictureControllerDelegate

- (void)pictureInPictureControllerWillStartPictureInPicture:(AVPictureInPictureController *)pictureInPictureController {
    _starting = YES;
    _restoring = NO;
    _stopping = NO;
    [self updateRendering];
}

- (void)pictureInPictureControllerDidStartPictureInPicture:(AVPictureInPictureController *)pictureInPictureController {
    _starting = NO;
    [self updateRendering];
    [self.delegate didChangePictureInPicture:YES dismissed:NO];
}

- (void)pictureInPictureController:(AVPictureInPictureController *)pictureInPictureController
    failedToStartPictureInPictureWithError:(NSError *)error {
    _starting = NO;
    [self updatePlaybackViewPlacement];
    [self updateRendering];
    [self updateStartAutomatically];
    NSLog(@"Picture-in-picture failed to start: %@", error.localizedDescription);
}

- (void)pictureInPictureControllerDidStopPictureInPicture:(AVPictureInPictureController *)pictureInPictureController {
    // The viewer closed the window, rather than returning to the app or the app stopping it.
    BOOL dismissed = _inBackground && !_restoring && !_stopping;
    _restoring = NO;
    _stopping = NO;
    [self updatePlaybackViewPlacement];
    [self updateRendering];
    [self updateStartAutomatically];
    // AVKit gives the layer back as it took it; the view may have changed size meanwhile.
    [_playbackView setNeedsLayout];

    [self.delegate didChangePictureInPicture:NO dismissed:dismissed];
    if (_kind == PIPControllerKindPlayback) {
        // As with the system's own players: closing the window pauses the video, returning to the
        // app plays it.
        [self setPaused:dismissed];
    }
}

- (void)pictureInPictureController:(AVPictureInPictureController *)pictureInPictureController
    restoreUserInterfaceForPictureInPictureStopWithCompletionHandler:(void (^)(BOOL restored))completionHandler {
    _restoring = YES;
    // The view never left the app: there is nothing to put back.
    completionHandler(YES);
}

#pragma mark AVPictureInPictureSampleBufferPlaybackDelegate

- (void)pictureInPictureController:(AVPictureInPictureController *)pictureInPictureController setPlaying:(BOOL)playing {
    [self setPaused:!playing];
}

- (CMTimeRange)pictureInPictureControllerTimeRangeForPlayback:(AVPictureInPictureController *)controller {
    // Live, which the window shows as such. Without a video there is nothing to play, unless the
    // window already shows.
    if (_videoTrack || self.pictureInPictureActive) {
        return CMTimeRangeMake(kCMTimeNegativeInfinity, kCMTimePositiveInfinity);
    }
    return kCMTimeRangeInvalid;
}

- (BOOL)pictureInPictureControllerIsPlaybackPaused:(AVPictureInPictureController *)pictureInPictureController {
    return _paused;
}

- (void)pictureInPictureController:(AVPictureInPictureController *)pictureInPictureController
         didTransitionToRenderSize:(CMVideoDimensions)newRenderSize {
}

- (void)pictureInPictureController:(AVPictureInPictureController *)pictureInPictureController
                    skipByInterval:(CMTime)skipInterval
                 completionHandler:(void (^)(void))completionHandler {
    // Live: there is nowhere to skip to.
    completionHandler();
}

@end
