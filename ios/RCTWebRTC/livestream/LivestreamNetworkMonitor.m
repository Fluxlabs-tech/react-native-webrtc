#import "LivestreamNetworkMonitor.h"

#if TARGET_OS_IOS || TARGET_OS_TV
#import <Network/Network.h>
#endif

@interface LivestreamNetworkMonitor ()
@property(atomic, copy, readwrite, nullable) NSDictionary *state;
@end

#if TARGET_OS_IOS || TARGET_OS_TV

/**
 * What identifies the network: its interfaces and gateways. Another Wi-Fi network keeps the
 * interface but not the gateway.
 */
static NSString *PathSignature(nw_path_t path) {
    NSMutableArray<NSString *> *parts = [NSMutableArray array];
    nw_path_enumerate_interfaces(path, ^bool(nw_interface_t interface) {
        [parts addObject:[NSString stringWithFormat:@"%s#%u",
                                                    nw_interface_get_name(interface),
                                                    nw_interface_get_index(interface)]];
        return true;
    });
    if (@available(iOS 13.0, tvOS 13.0, *)) {
        nw_path_enumerate_gateways(path, ^bool(nw_endpoint_t gateway) {
            char *address = nw_endpoint_copy_address_string(gateway);
            if (address != NULL) {
                [parts addObject:@(address)];
                free(address);
            }
            return true;
        });
    }
    return [parts componentsJoinedByString:@","];
}

@implementation LivestreamNetworkMonitor {
    dispatch_queue_t _queue;
    void (^_onChange)(NSDictionary *);
    // On _queue.
    nw_path_monitor_t _monitor;
    NSString *_signature;
    NSInteger _networkId;
}

- (instancetype)initWithChangeHandler:(void (^)(NSDictionary *))onChange {
    if (self = [super init]) {
        _queue = dispatch_queue_create("com.fluxlabs.webrtc.livestream-network", DISPATCH_QUEUE_SERIAL);
        _onChange = [onChange copy];
    }
    return self;
}

- (void)dealloc {
    if (_monitor != nil) {
        nw_path_monitor_cancel(_monitor);
    }
}

- (void)start {
    dispatch_async(_queue, ^{
        if (self->_monitor != nil) {
            return;
        }
        nw_path_monitor_t monitor = nw_path_monitor_create();
        nw_path_monitor_set_queue(monitor, self->_queue);
        __weak LivestreamNetworkMonitor *weakSelf = self;
        nw_path_monitor_set_update_handler(monitor, ^(nw_path_t path) {
            [weakSelf update:path];
        });
        self->_monitor = monitor;
        nw_path_monitor_start(monitor);
    });
}

- (void)stop {
    dispatch_async(_queue, ^{
        if (self->_monitor == nil) {
            return;
        }
        nw_path_monitor_cancel(self->_monitor);
        self->_monitor = nil;
        self->_signature = nil;
        self.state = nil;
    });
}

// On _queue.
- (void)update:(nw_path_t)path {
    if (_monitor == nil) {
        return;
    }

    BOOL online = nw_path_get_status(path) == nw_path_status_satisfied;
    NSString *type = @"other";
    if (!online) {
        type = @"none";
    } else if (nw_path_uses_interface_type(path, nw_interface_type_wifi)) {
        type = @"wifi";
    } else if (nw_path_uses_interface_type(path, nw_interface_type_cellular)) {
        type = @"cellular";
    } else if (nw_path_uses_interface_type(path, nw_interface_type_wired)) {
        type = @"ethernet";
    }

    BOOL constrained = NO;
    if (@available(iOS 13.0, tvOS 13.0, *)) {
        constrained = nw_path_is_constrained(path);
    }

    // A new id for each network, so a move between two of the same type still shows.
    NSString *signature = online ? PathSignature(path) : @"";
    if (online && ![signature isEqualToString:_signature]) {
        _networkId++;
    }
    _signature = signature;

    NSDictionary *state = @{
        @"online" : @(online),
        @"type" : type,
        @"expensive" : @(online && nw_path_is_expensive(path)),
        @"constrained" : @(online && constrained),
        @"id" : @(_networkId)
    };
    if ([state isEqualToDictionary:self.state]) {
        return;
    }
    self.state = state;
    _onChange(state);
}

@end

#else

// No path monitor here: the state stays unknown, and sessions go by their own timers.
@implementation LivestreamNetworkMonitor

- (instancetype)initWithChangeHandler:(void (^)(NSDictionary *))onChange {
    return [super init];
}

- (void)start {
}

- (void)stop {
}

@end

#endif
