#import "ScreenCapturePickerViewComponentView.h"

#import <React/RCTLog.h>
#if TARGET_OS_IOS
#import <ReplayKit/ReplayKit.h>
#endif

#import <react/renderer/components/RNWebRTCSpec/ComponentDescriptors.h>
#import <react/renderer/components/RNWebRTCSpec/Props.h>
#import <react/renderer/components/RNWebRTCSpec/RCTComponentViewHelpers.h>

using namespace facebook::react;

// The Info.plist key naming the app's broadcast upload extension.
static NSString *const kRTCScreenSharingExtension = @"RTCScreenSharingExtension";

@interface ScreenCapturePickerViewComponentView ()<RCTScreenCapturePickerViewViewProtocol>
@end

@implementation ScreenCapturePickerViewComponentView

+ (ComponentDescriptorProvider)componentDescriptorProvider {
    return concreteComponentDescriptorProvider<ScreenCapturePickerViewComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame {
    if (self = [super initWithFrame:frame]) {
        _props = ScreenCapturePickerViewShadowNode::defaultSharedProps();
#if TARGET_OS_IOS
        RPSystemBroadcastPickerView *picker = [[RPSystemBroadcastPickerView alloc] init];
        picker.preferredExtension = [[NSBundle mainBundle] infoDictionary][kRTCScreenSharingExtension];
        picker.showsMicrophoneButton = false;
        picker.userInteractionEnabled = false;
        self.contentView = picker;
#endif
    }

    return self;
}

- (void)handleCommand:(const NSString *)commandName args:(const NSArray *)args {
    RCTScreenCapturePickerViewHandleCommand(self, commandName, args);
}

// The picker has no API to open it: tap its button.
- (void)show {
#if TARGET_OS_IOS
    UIButton *button = nil;
    for (UIView *subview in self.contentView.subviews) {
        if ([subview isKindOfClass:[UIButton class]]) {
            button = (UIButton *)subview;
        }
    }
    if (button != nil) {
        [button sendActionsForControlEvents:UIControlEventTouchUpInside];
    } else {
        RCTLogError(@"RPSystemBroadcastPickerView button not found");
    }
#endif
}

@end

// For React Native 0.76, as in RTCVideoViewComponentView.mm.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wreturn-type-c-linkage"
extern "C" Class<RCTComponentViewProtocol> ScreenCapturePickerViewCls(void) {
    return ScreenCapturePickerViewComponentView.class;
}
#pragma clang diagnostic pop
