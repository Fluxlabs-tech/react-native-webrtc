
#import <AVFoundation/AVFoundation.h>

#import "WebRTCModule.h"

static NSString *const PERMISSION_DENIED = @"denied";
static NSString *const PERMISSION_GRANTED = @"granted";
static NSString *const PERMISSION_PROMPT = @"prompt";

@implementation WebRTCModule (Permissions)

- (AVMediaType)avMediaType:(NSString *)mediaType {
    if ([mediaType isEqualToString:@"microphone"]) {
        return AVMediaTypeAudio;
    } else if ([mediaType isEqualToString:@"camera"]) {
        return AVMediaTypeVideo;
    } else {
        return nil;
    }
}

- (void)checkPermission:(NSString *)mediaType
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject {
#if TARGET_OS_TV
    resolve(@"tvOS is not supported");
    return;
#else
    AVMediaType mediaType_ = [self avMediaType:mediaType];

    if (mediaType_ == nil) {
        reject(@"invalid_type", @"Invalid media type", nil);
        return;
    }
    AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:mediaType_];
    switch (status) {
        case AVAuthorizationStatusAuthorized:
            resolve(PERMISSION_GRANTED);
            break;

        case AVAuthorizationStatusNotDetermined:
            resolve(PERMISSION_PROMPT);
            break;

        default:
            resolve(PERMISSION_DENIED);
            break;
    }
#endif
}

- (void)requestPermission:(NSString *)mediaType
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject {
#if TARGET_OS_TV
    resolve(@"tvOS is not supported");
    return;
#else
    AVMediaType mediaType_ = [self avMediaType:mediaType];

    if (mediaType_ == nil) {
        reject(@"invalid_type", @"Invalid media type", nil);
        return;
    }

    [AVCaptureDevice requestAccessForMediaType:mediaType_
                             completionHandler:^(BOOL granted) {
                                 resolve(@(granted));
                             }];
#endif
}

@end
