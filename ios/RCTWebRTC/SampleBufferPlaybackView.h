#import <AVFoundation/AVFoundation.h>
#import <UIKit/UIKit.h>
#import <WebRTC/RTCVideoRenderer.h>

/**
 * The video for the system player's picture-in-picture window: an AVSampleBufferDisplayLayer that
 * AVKit takes into the window. In the app it lies under the view's own renderer and takes each
 * frame, so the window opens on the current picture.
 *
 * AVKit takes the layer without its transform and shapes the window to the frames, so the frames
 * go in upright and mirrored as the view shows them.
 */
API_AVAILABLE(ios(15.0))
@interface SampleBufferPlaybackView : UIView<RTCVideoRenderer>

@property(nonatomic, readonly) AVSampleBufferDisplayLayer *displayLayer;

/** Mirror the picture, as the view does. */
@property(atomic, assign) BOOL mirror;

/** Hold the last frame. */
@property(atomic, assign) BOOL paused;

/** Take frames: off in the background without a window, where the layer only fails them. */
@property(atomic, assign) BOOL rendering;

- (void)setVideoGravity:(AVLayerVideoGravity)videoGravity;

/** Shows nothing until the next frame. */
- (void)clear;

@end
