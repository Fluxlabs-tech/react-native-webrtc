#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * Follows the device's network with Network.framework's path monitor, for livestream sessions:
 * whether there is a route, over what, whether it costs or the user asked to save data, and when
 * the device moves to another network (a new `id`). Hands each change to `onChange`, on its own
 * queue, as { online, type, expensive, constrained, id }.
 */
@interface LivestreamNetworkMonitor : NSObject

- (instancetype)initWithChangeHandler:(void (^)(NSDictionary *state))onChange NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

/** The latest state; nil until the first path is known, and after `stop`. */
@property(atomic, copy, readonly, nullable) NSDictionary *state;

- (void)start;
- (void)stop;

@end

NS_ASSUME_NONNULL_END
