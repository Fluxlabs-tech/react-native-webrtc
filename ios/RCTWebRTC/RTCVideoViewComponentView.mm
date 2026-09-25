#import "RTCVideoViewComponentView.h"

#import <react/renderer/components/RNWebRTCSpec/ComponentDescriptors.h>
#import <react/renderer/components/RNWebRTCSpec/EventEmitters.h>
#import <react/renderer/components/RNWebRTCSpec/Props.h>
#import <react/renderer/components/RNWebRTCSpec/RCTComponentViewHelpers.h>

#import "RTCVideoView.h"
#import "WebRTCModule.h"

using namespace facebook::react;

@interface RTCVideoViewComponentView ()<RCTRTCVideoViewViewProtocol>
@end

@implementation RTCVideoViewComponentView {
    RTCVideoView *_videoView;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider {
    return concreteComponentDescriptorProvider<RTCVideoViewComponentDescriptor>();
}

// A view holds a video track and maybe a picture-in-picture controller; a new one is simpler than
// resetting a used one.
+ (BOOL)shouldBeRecycled {
    return NO;
}

- (instancetype)initWithFrame:(CGRect)frame {
    if (self = [super initWithFrame:frame]) {
        _props = RTCVideoViewShadowNode::defaultSharedProps();
        [self createVideoView];
    }

    return self;
}

- (void)createVideoView {
    _videoView = [[RTCVideoView alloc] initWithFrame:self.bounds];
    _videoView.module = [WebRTCModule currentModule];
    _videoView.clipsToBounds = YES;

    __weak RTCVideoViewComponentView *weakSelf = self;
    _videoView.onDimensionsChange = ^(NSDictionary *body) {
        [weakSelf emitDimensionsChange:body];
    };
    _videoView.onPictureInPictureChange = ^(NSDictionary *body) {
        [weakSelf emitPictureInPictureChange:body];
    };

    self.contentView = _videoView;
}

- (void)updateProps:(const Props::Shared &)props oldProps:(const Props::Shared &)oldProps {
    const auto &oldViewProps = *std::static_pointer_cast<const RTCVideoViewProps>(_props);
    const auto &newViewProps = *std::static_pointer_cast<const RTCVideoViewProps>(props);

    if (oldViewProps.mirror != newViewProps.mirror) {
        _videoView.mirror = newViewProps.mirror;
    }

    if (oldViewProps.objectFit != newViewProps.objectFit) {
        // Unset is cover, RTCView's default; anything but cover is contain, as on the old architecture.
        BOOL cover = newViewProps.objectFit.empty() || newViewProps.objectFit == "cover";
        _videoView.objectFit = cover ? RTCVideoViewObjectFitCover : RTCVideoViewObjectFitContain;
    }

    if (oldViewProps.pictureInPictureEnabled != newViewProps.pictureInPictureEnabled) {
        _videoView.pictureInPictureEnabled = newViewProps.pictureInPictureEnabled;
    }

    if (oldViewProps.autoStartPictureInPicture != newViewProps.autoStartPictureInPicture) {
        _videoView.autoStartPictureInPicture = newViewProps.autoStartPictureInPicture;
    }

    if (oldViewProps.autoStopPictureInPicture != newViewProps.autoStopPictureInPicture) {
        _videoView.autoStopPictureInPicture = newViewProps.autoStopPictureInPicture;
    }

    const auto &oldSize = oldViewProps.pictureInPicturePreferredSize;
    const auto &newSize = newViewProps.pictureInPicturePreferredSize;
    if (oldSize.width != newSize.width || oldSize.height != newSize.height) {
        _videoView.pictureInPicturePreferredSize = CGSizeMake(newSize.width, newSize.height);
    }

    if (oldViewProps.streamURL != newViewProps.streamURL) {
        NSString *streamURL =
            newViewProps.streamURL.empty() ? nil : [NSString stringWithUTF8String:newViewProps.streamURL.c_str()];
        [_videoView setStreamURL:streamURL];
    }

    [super updateProps:props oldProps:oldProps];
}

// Children are the fallback views picture-in-picture shows (RTCPIPView's iosPIP.fallbackView).
- (void)mountChildComponentView:(UIView<RCTComponentViewProtocol> *)childComponentView index:(NSInteger)index {
    [_videoView insertFallbackView:childComponentView];
}

- (void)unmountChildComponentView:(UIView<RCTComponentViewProtocol> *)childComponentView index:(NSInteger)index {
    [childComponentView removeFromSuperview];
}

#pragma mark - Events

- (void)emitDimensionsChange:(NSDictionary *)body {
    if (!_eventEmitter) {
        return;
    }

    std::static_pointer_cast<const RTCVideoViewEventEmitter>(_eventEmitter)
        ->onDimensionsChange(RTCVideoViewEventEmitter::OnDimensionsChange{[body[@"width"] intValue],
                                                                            [body[@"height"] intValue]});
}

- (void)emitPictureInPictureChange:(NSDictionary *)body {
    if (!_eventEmitter) {
        return;
    }

    // iOS reports no dismissal; see RTCView's onPictureInPictureChange.
    std::static_pointer_cast<const RTCVideoViewEventEmitter>(_eventEmitter)
        ->onPictureInPictureChange(
            RTCVideoViewEventEmitter::OnPictureInPictureChange{[body[@"isInPictureInPicture"] boolValue], false});
}

#pragma mark - Commands

- (void)handleCommand:(const NSString *)commandName args:(const NSArray *)args {
    RCTRTCVideoViewHandleCommand(self, commandName, args);
}

- (void)startPictureInPicture {
    if (@available(iOS 15.0, *)) {
        [_videoView startPIPWithParams:YES];
    }
}

- (void)stopPictureInPicture {
    if (@available(iOS 15.0, *)) {
        [_videoView stopPIP];
    }
}

- (void)startIOSPIP {
    if (@available(iOS 15.0, *)) {
        [_videoView startPIPWithParams:NO];
    }
}

- (void)stopIOSPIP {
    if (@available(iOS 15.0, *)) {
        [_videoView stopPIP];
    }
}

@end

// React Native 0.76 looks the view class up with this function, declared extern "C" by its generated
// RCTThirdPartyFabricComponentsProvider.h. Later versions use the codegenConfig's
// ios.componentProvider instead.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wreturn-type-c-linkage"
extern "C" Class<RCTComponentViewProtocol> RTCVideoViewCls(void) {
    return RTCVideoViewComponentView.class;
}
#pragma clang diagnostic pop
