#import <UIKit/UIKit.h>

#import <WebRTC/RTCVideoRenderer.h>
#import <WebRTC/RTCVideoTrack.h>
#if TARGET_OS_OSX
#import <WebRTC/RTCMTLNSVideoView.h>
#else
#import <WebRTC/RTCMTLVideoView.h>
#endif

#import "PIPController.h"
#import "RTCVideoViewObjectFit.h"

@class WebRTCModule;

/**
 * An event for JS: RTCVideoViewComponentView emits it through the view's event emitter.
 */
typedef void (^RTCVideoViewEventBlock)(NSDictionary *body);

/**
 * Implements an equivalent of {@code HTMLVideoElement} i.e. Web's video
 * element.
 */
@interface RTCVideoView : UIView<PIPControllerDelegate, RTCVideoViewDelegate>

/**
 * The indicator which determines whether this {@code RTCVideoView} is to mirror
 * the video specified by {@link #videoTrack} during its rendering. Typically,
 * applications choose to mirror the front/user-facing camera.
 */
@property(nonatomic) BOOL mirror;

@property(nonatomic) BOOL pictureInPictureEnabled;

@property(nonatomic) BOOL autoStartPictureInPicture;

@property(nonatomic) BOOL autoStopPictureInPicture;

@property(nonatomic, assign) CGSize pictureInPicturePreferredSize;

@property(nonatomic, copy) RTCVideoViewEventBlock onPictureInPictureChange;

/**
 * In the fashion of
 * https://www.w3.org/TR/html5/embedded-content-0.html#dom-video-videowidth
 * and https://www.w3.org/TR/html5/rendering.html#video-object-fit, resembles
 * the CSS style {@code object-fit}.
 */
@property(nonatomic) RTCVideoViewObjectFit objectFit;

@property(nonatomic, strong) API_AVAILABLE(ios(15.0)) PIPController *pipController;

/**
 * The {@link RRTCVideoRenderer} which implements the actual rendering.
 */
#if TARGET_OS_OSX
@property(nonatomic, readonly) RTCMTLNSVideoView *videoView;
#else
@property(nonatomic, readonly) RTCMTLVideoView *videoView;
#endif

/**
 * The {@link RTCVideoTrack}, if any, which this instance renders.
 */
@property(nonatomic, strong) RTCVideoTrack *videoTrack;

/**
 * Reference to the main WebRTC RN module.
 */
@property(nonatomic, weak) WebRTCModule *module;

@property(nonatomic, copy) RTCVideoViewEventBlock onDimensionsChange;

/**
 * Renders the first video track of the stream with the given react tag, or nothing if nil.
 */
- (void)setStreamURL:(NSString *)streamURL;

/**
 * Adds a view for picture-in-picture to show until the video has a frame.
 */
- (void)insertFallbackView:(UIView *)view;

- (void)startPIPWithParams:(BOOL)shouldApplyParams API_AVAILABLE(ios(15.0));
- (void)stopPIP API_AVAILABLE(ios(15.0));

@end
