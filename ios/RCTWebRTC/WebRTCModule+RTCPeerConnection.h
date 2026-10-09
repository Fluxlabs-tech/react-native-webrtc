#import <WebRTC/RTCPeerConnection.h>
#import "DataChannelWrapper.h"
#import "WebRTCModule.h"

@interface RTCPeerConnection (React)

@property(nonatomic, strong) NSNumber *reactTag;
@property(nonatomic, strong) NSMutableDictionary<NSString *, DataChannelWrapper *> *dataChannels;
@property(nonatomic, strong) NSMutableDictionary<NSString *, RTCMediaStream *> *remoteStreams;
@property(nonatomic, strong) NSMutableDictionary<NSString *, RTCMediaStreamTrack *> *remoteTracks;
@property(nonatomic, weak) id webRTCModule;

@end

@interface WebRTCModule (RTCPeerConnection)<RTCPeerConnectionDelegate>

+ (RTCCertificate *)getCertificate:(NSString *)certId;

// Close, and dispose of, every peer connection, as JS does one at a time. On the worker queue, with
// the dispose in a block of its own, behind the delegate blocks the closes queued: one run after the
// dispose would add back what it removes, such as a track's mute timer. -dealloc, which has no
// blocks to wait for, calls both in a row.
- (void)closeAllPeerConnections;
- (void)disposeAllPeerConnections;

@end
