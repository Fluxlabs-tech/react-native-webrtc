#import "WebRTCModule.h"
#import "livestream/LivestreamAudio.h"
#import "livestream/LivestreamNetworkMonitor.h"

@implementation WebRTCModule (Livestream)

- (NSDictionary *)livestreamAudioState {
    return self.livestreamAudio != nil ? [self.livestreamAudio state] : @{@"installed" : @NO};
}

- (NSNumber *)livestreamAudioSetLevellerEnabled:(BOOL)enabled {
    return @([self.livestreamAudio setLevellerEnabled:enabled]);
}

- (NSDictionary *)livestreamAudioTakeLevels {
    return [self.livestreamAudio takeLevels];
}

- (void)livestreamNetworkStart {
    if (self.livestreamNetworkMonitor == nil) {
        __weak WebRTCModule *weakSelf = self;
        self.livestreamNetworkMonitor = [[LivestreamNetworkMonitor alloc] initWithChangeHandler:^(NSDictionary *state) {
            [weakSelf sendEventWithName:kEventLivestreamNetworkChanged body:state];
        }];
    }
    [self.livestreamNetworkMonitor start];
}

- (void)livestreamNetworkStop {
    [self.livestreamNetworkMonitor stop];
}

- (NSDictionary *)livestreamNetworkState {
    return self.livestreamNetworkMonitor.state;
}

@end
