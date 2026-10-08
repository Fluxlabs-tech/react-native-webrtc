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

// Closes and disposes every peer connection, as JS does one at a time. Call on the worker queue.
- (void)closeAllPeerConnections;

@end
