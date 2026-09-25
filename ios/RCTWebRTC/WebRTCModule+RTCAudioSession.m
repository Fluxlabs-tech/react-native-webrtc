#import <objc/runtime.h>

#import <React/RCTBridgeModule.h>

#import "WebRTCModule.h"

@implementation WebRTCModule (RTCAudioSession)

- (void)audioSessionDidActivate {
    [[RTCAudioSession sharedInstance] audioSessionDidActivate:[AVAudioSession sharedInstance]];
}

- (void)audioSessionDidDeactivate {
    [[RTCAudioSession sharedInstance] audioSessionDidDeactivate:[AVAudioSession sharedInstance]];
}

@end
