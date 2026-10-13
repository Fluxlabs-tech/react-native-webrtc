#import <AVKit/AVKit.h>
#import <UIKit/UIKit.h>
#import <WebRTC/RTCVideoTrack.h>

#import "RTCVideoViewObjectFit.h"

/** The system window picture-in-picture shows the video in. */
typedef NS_ENUM(NSInteger, PIPControllerKind) {
    /**
     * The system player's, as for live video: a LIVE badge and bar, stop and play, and the buttons
     * to close it and to return to the app; skipping is greyed out. It takes the video's shape.
     */
    PIPControllerKindPlayback,
    /** The video call's, without controls, in the preferred size's shape. Apple meant it for a call. */
    PIPControllerKindVideoCall,
};

@protocol PIPControllerDelegate<NSObject>
/**
 * Picture-in-picture started or stopped. `dismissed`: it stopped because the viewer closed the
 * window, with the app in the background, rather than returning to the app.
 */
- (void)didChangePictureInPicture:(BOOL)isInPictureInPicture dismissed:(BOOL)dismissed;
@optional
/**
 * The player's window stopped or played the video: the viewer pressed its button, closed it, or
 * came back to the app.
 */
- (void)didChangePictureInPicturePlaying:(BOOL)playing;
@end

API_AVAILABLE(ios(15.0))
@interface PIPController : NSObject<AVPictureInPictureControllerDelegate>

@property(nonatomic, readonly) PIPControllerKind kind;
@property(nonatomic, weak) UIView *sourceView;
@property(nonatomic, strong) RTCVideoTrack *videoTrack;

@property(nonatomic, assign) BOOL startAutomatically;
@property(nonatomic, assign) BOOL stopAutomatically;
@property(nonatomic, assign) CGSize preferredSize;
/** The player's window mirrors the video as the view does. */
@property(nonatomic, assign) BOOL mirror;
/** The player's window has paused the video. */
@property(nonatomic, readonly) BOOL paused;

@property(nonatomic, weak) id<PIPControllerDelegate> delegate;

/** Whether any view's picture-in-picture is showing. Safe to call from any thread. */
+ (BOOL)isAnyPictureInPictureActive;

/**
 * For the player's window, the video goes in a view of its own at the back of `sourceView`, for
 * as long as this controller lives.
 */
- (instancetype)initWithSourceView:(UIView *)sourceView kind:(PIPControllerKind)kind;
- (void)togglePIP;
- (void)startPIP;
- (void)stopPIP;
- (void)insertFallbackView:(UIView *)subview;
- (void)setObjectFit:(RTCVideoViewObjectFit)fit;
/** The source view moved to or from a window. */
- (void)sourceViewDidMoveToWindow;

@end
