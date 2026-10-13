#import "SampleBufferPlaybackView.h"

#import <Accelerate/Accelerate.h>
#import <WebRTC/WebRTC.h>

#import "I420Converter.h"

static vImage_Buffer PlaneBuffer(CVPixelBufferRef pixelBuffer, size_t plane) {
    return (vImage_Buffer){
        .data = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, plane),
        .height = CVPixelBufferGetHeightOfPlane(pixelBuffer, plane),
        .width = CVPixelBufferGetWidthOfPlane(pixelBuffer, plane),
        .rowBytes = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, plane),
    };
}

/**
 * Turns one plane clockwise by `rotation`, then mirrors it if asked: what the view does to the
 * picture. A `wide` plane is NV12's chroma, whose Cb and Cr move together as one 16-bit pixel.
 * vImage does neither in place, so a mirrored quarter turn goes through `scratch`.
 */
static vImage_Error OrientPlane(
    vImage_Buffer src, vImage_Buffer dst, RTCVideoRotation rotation, BOOL mirror, BOOL wide, NSMutableData *scratch) {
    if (rotation == RTCVideoRotation_0) {
        return wide ? vImageHorizontalReflect_Planar16U(&src, &dst, kvImageNoFlags)
                    : vImageHorizontalReflect_Planar8(&src, &dst, kvImageNoFlags);
    }
    if (rotation == RTCVideoRotation_180 && mirror) {
        // Half a turn, mirrored, is upside down.
        return wide ? vImageVerticalReflect_Planar16U(&src, &dst, kvImageNoFlags)
                    : vImageVerticalReflect_Planar8(&src, &dst, kvImageNoFlags);
    }

    uint8_t turn = rotation == RTCVideoRotation_90    ? kRotate90DegreesClockwise
                   : rotation == RTCVideoRotation_180 ? kRotate180DegreesClockwise
                                                      : kRotate270DegreesClockwise;
    vImage_Buffer turned = dst;
    if (mirror) {
        turned.rowBytes = dst.width * (wide ? 2 : 1);
        if (scratch.length < turned.rowBytes * turned.height) {
            scratch.length = turned.rowBytes * turned.height;
        }
        turned.data = scratch.mutableBytes;
    }

    vImage_Error error = wide ? vImageRotate90_Planar16U(&src, &turned, turn, 0, kvImageNoFlags)
                              : vImageRotate90_Planar8(&src, &turned, turn, 0, kvImageNoFlags);
    if (error != kvImageNoError || !mirror) {
        return error;
    }
    return wide ? vImageHorizontalReflect_Planar16U(&turned, &dst, kvImageNoFlags)
                : vImageHorizontalReflect_Planar8(&turned, &dst, kvImageNoFlags);
}

/** Gives a turned copy the colours of its source. Only those: a clean aperture would not turn with it. */
API_AVAILABLE(ios(15.0))
static void CopyColorAttachments(CVPixelBufferRef from, CVPixelBufferRef to) {
    const CFStringRef keys[] = {
        kCVImageBufferYCbCrMatrixKey, kCVImageBufferColorPrimariesKey, kCVImageBufferTransferFunctionKey};
    for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); i++) {
        CVAttachmentMode mode;
        CFTypeRef value = CVBufferCopyAttachment(from, keys[i], &mode);
        if (value) {
            CVBufferSetAttachment(to, keys[i], value, mode);
            CFRelease(value);
        }
    }
}

@implementation SampleBufferPlaybackView {
    // On the thread frames arrive on.
    I420Converter *_i420Converter;
    RTCMutableI420Buffer *_orientedI420;
    CVPixelBufferPoolRef _orientedPool;
    OSType _orientedPoolFormat;
    size_t _orientedPoolWidth;
    size_t _orientedPoolHeight;
    NSMutableData *_scratch;
    CMVideoFormatDescriptionRef _formatDescription;

    // The newest frame for the main thread to enqueue: frames that come faster than it takes them
    // replace one another rather than queue up behind it.
    CMSampleBufferRef _pendingSampleBuffer;
    BOOL _enqueueScheduled;
}

- (instancetype)initWithFrame:(CGRect)frame {
    if (self = [super initWithFrame:frame]) {
        // A sublayer rather than the view's own layer: AVKit takes it into the window.
        _displayLayer = [AVSampleBufferDisplayLayer layer];
        _displayLayer.videoGravity = AVLayerVideoGravityResizeAspect;
        [self.layer addSublayer:_displayLayer];
        _scratch = [NSMutableData data];
        _rendering = YES;
        self.userInteractionEnabled = NO;
    }
    return self;
}

- (void)dealloc {
    [_i420Converter unprepareForAccelerateConversion];
    CVPixelBufferPoolRelease(_orientedPool);
    if (_formatDescription) {
        CFRelease(_formatDescription);
    }
    if (_pendingSampleBuffer) {
        CFRelease(_pendingSampleBuffer);
    }
}

- (void)layoutSubviews {
    [super layoutSubviews];

    // While AVKit has the layer, the window lays it out.
    if (_displayLayer.superlayer == self.layer) {
        [CATransaction begin];
        [CATransaction setDisableActions:YES];
        _displayLayer.frame = self.layer.bounds;
        [CATransaction commit];
    }
}

- (void)setVideoGravity:(AVLayerVideoGravity)videoGravity {
    _displayLayer.videoGravity = videoGravity;
}

- (void)clear {
    @synchronized(self) {
        if (_pendingSampleBuffer) {
            CFRelease(_pendingSampleBuffer);
            _pendingSampleBuffer = NULL;
        }
    }

    if (@available(iOS 17.0, *)) {
        [_displayLayer.sampleBufferRenderer flushWithRemovalOfDisplayedImage:YES completionHandler:nil];
    } else {
        [_displayLayer flushAndRemoveImage];
    }
}

#pragma mark RTCVideoRenderer

- (void)setSize:(CGSize)size {
}

- (void)renderFrame:(nullable RTCVideoFrame *)frame {
    if (!frame || self.paused || !self.rendering) {
        return;
    }

    CVPixelBufferRef pixelBuffer = [self uprightPixelBufferFrom:frame];
    if (!pixelBuffer) {
        return;
    }
    CMSampleBufferRef sampleBuffer = [self sampleBufferWith:pixelBuffer];
    CVPixelBufferRelease(pixelBuffer);
    if (!sampleBuffer) {
        return;
    }

    @synchronized(self) {
        if (_pendingSampleBuffer) {
            CFRelease(_pendingSampleBuffer);
        }
        _pendingSampleBuffer = sampleBuffer;
        if (_enqueueScheduled) {
            return;
        }
        _enqueueScheduled = YES;
    }

    dispatch_async(dispatch_get_main_queue(), ^{
        CMSampleBufferRef next;
        @synchronized(self) {
            next = self->_pendingSampleBuffer;
            self->_pendingSampleBuffer = NULL;
            self->_enqueueScheduled = NO;
        }
        if (next) {
            [self enqueue:next];
            CFRelease(next);
        }
    });
}

- (void)enqueue:(CMSampleBufferRef)sampleBuffer {
    // A failure, or the app's trip to the background, stops decoding until a flush.
    if (@available(iOS 17.0, *)) {
        AVSampleBufferVideoRenderer *renderer = _displayLayer.sampleBufferRenderer;
        if (renderer.status == AVQueuedSampleBufferRenderingStatusFailed || renderer.requiresFlushToResumeDecoding) {
            [renderer flush];
        }
        if (renderer.readyForMoreMediaData) {
            [renderer enqueueSampleBuffer:sampleBuffer];
        }
    } else {
        if (_displayLayer.status == AVQueuedSampleBufferRenderingStatusFailed ||
            _displayLayer.requiresFlushToResumeDecoding) {
            [_displayLayer flush];
        }
        if (_displayLayer.readyForMoreMediaData) {
            [_displayLayer enqueueSampleBuffer:sampleBuffer];
        }
    }
}

#pragma mark Frames

/** The frame upright, and mirrored if the view mirrors it; +1. */
- (CVPixelBufferRef)uprightPixelBufferFrom:(RTCVideoFrame *)frame {
    RTCVideoRotation rotation = frame.rotation;
    BOOL mirror = self.mirror;
    BOOL orient = rotation != RTCVideoRotation_0 || mirror;

    if ([frame.buffer isKindOfClass:[RTCCVPixelBuffer class]]) {
        RTCCVPixelBuffer *buffer = (RTCCVPixelBuffer *)frame.buffer;
        if (!buffer.requiresCropping) {
            CVPixelBufferRef pixelBuffer = buffer.pixelBuffer;
            if (!orient) {
                return CVPixelBufferRetain(pixelBuffer);
            }
            OSType format = CVPixelBufferGetPixelFormatType(pixelBuffer);
            if (format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange ||
                format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange) {
                return [self orientNV12:pixelBuffer rotation:rotation mirror:mirror];
            }
        }
    }

    // Anything else goes through I420: a software decoder's frames, cropped buffers, other formats.
    id<RTCI420Buffer> i420 = [frame.buffer toI420];
    if (orient) {
        i420 = [self orientI420:i420 rotation:rotation mirror:mirror];
    }
    return i420 ? [self pixelBufferFromI420:i420] : NULL;
}

/** A hardware decoder's NV12 frame, turned and mirrored; +1. */
- (CVPixelBufferRef)orientNV12:(CVPixelBufferRef)source rotation:(RTCVideoRotation)rotation mirror:(BOOL)mirror {
    BOOL quarterTurn = rotation == RTCVideoRotation_90 || rotation == RTCVideoRotation_270;
    size_t width = CVPixelBufferGetWidth(source);
    size_t height = CVPixelBufferGetHeight(source);
    CVPixelBufferRef oriented = [self pixelBufferWithFormat:CVPixelBufferGetPixelFormatType(source)
                                                      width:quarterTurn ? height : width
                                                     height:quarterTurn ? width : height];
    if (!oriented) {
        return NULL;
    }

    CVPixelBufferLockBaseAddress(source, kCVPixelBufferLock_ReadOnly);
    CVPixelBufferLockBaseAddress(oriented, 0);
    // The luma, then the chroma's Cb and Cr pairs.
    vImage_Error error = kvImageNoError;
    for (size_t plane = 0; plane < 2 && error == kvImageNoError; plane++) {
        error = OrientPlane(
            PlaneBuffer(source, plane), PlaneBuffer(oriented, plane), rotation, mirror, plane == 1, _scratch);
    }
    CVPixelBufferUnlockBaseAddress(oriented, 0);
    CVPixelBufferUnlockBaseAddress(source, kCVPixelBufferLock_ReadOnly);

    if (error != kvImageNoError) {
        CVPixelBufferRelease(oriented);
        return NULL;
    }
    CopyColorAttachments(source, oriented);
    return oriented;
}

/** An I420 frame turned and mirrored, into a buffer kept for the next frame. */
- (id<RTCI420Buffer>)orientI420:(id<RTCI420Buffer>)source rotation:(RTCVideoRotation)rotation mirror:(BOOL)mirror {
    BOOL quarterTurn = rotation == RTCVideoRotation_90 || rotation == RTCVideoRotation_270;
    int width = quarterTurn ? source.height : source.width;
    int height = quarterTurn ? source.width : source.height;
    if (_orientedI420.width != width || _orientedI420.height != height) {
        _orientedI420 = [[RTCMutableI420Buffer alloc] initWithWidth:width height:height];
    }
    RTCMutableI420Buffer *oriented = _orientedI420;

    vImage_Buffer from[3] = {
        {(void *)source.dataY, source.height, source.width, source.strideY},
        {(void *)source.dataU, source.chromaHeight, source.chromaWidth, source.strideU},
        {(void *)source.dataV, source.chromaHeight, source.chromaWidth, source.strideV},
    };
    vImage_Buffer to[3] = {
        {oriented.mutableDataY, oriented.height, oriented.width, oriented.strideY},
        {oriented.mutableDataU, oriented.chromaHeight, oriented.chromaWidth, oriented.strideU},
        {oriented.mutableDataV, oriented.chromaHeight, oriented.chromaWidth, oriented.strideV},
    };
    for (int plane = 0; plane < 3; plane++) {
        if (OrientPlane(from[plane], to[plane], rotation, mirror, NO, _scratch) != kvImageNoError) {
            return nil;
        }
    }
    return oriented;
}

/** BGRA from I420; +1. */
- (CVPixelBufferRef)pixelBufferFromI420:(id<RTCI420Buffer>)buffer {
    if (!_i420Converter) {
        I420Converter *converter = [[I420Converter alloc] init];
        if ([converter prepareForAccelerateConversion] != kvImageNoError) {
            return NULL;
        }
        _i420Converter = converter;
    }
    return [_i420Converter convertI420ToPixelBuffer:(RTCI420Buffer *)buffer];
}

/** A pixel buffer of this format and size, from a pool made anew when they change; +1. */
- (CVPixelBufferRef)pixelBufferWithFormat:(OSType)format width:(size_t)width height:(size_t)height {
    if (!_orientedPool || _orientedPoolFormat != format || _orientedPoolWidth != width ||
        _orientedPoolHeight != height) {
        CVPixelBufferPoolRelease(_orientedPool);
        _orientedPool = NULL;

        NSDictionary *attributes = @{
            (id)kCVPixelBufferPixelFormatTypeKey : @(format),
            (id)kCVPixelBufferWidthKey : @(width),
            (id)kCVPixelBufferHeightKey : @(height),
            (id)kCVPixelBufferIOSurfacePropertiesKey : @{}
        };
        if (CVPixelBufferPoolCreate(kCFAllocatorDefault, NULL, (__bridge CFDictionaryRef)attributes, &_orientedPool) !=
            kCVReturnSuccess) {
            _orientedPool = NULL;
            return NULL;
        }
        _orientedPoolFormat = format;
        _orientedPoolWidth = width;
        _orientedPoolHeight = height;
    }

    CVPixelBufferRef pixelBuffer = NULL;
    if (CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, _orientedPool, &pixelBuffer) != kCVReturnSuccess) {
        return NULL;
    }
    return pixelBuffer;
}

/** A sample buffer the layer shows as soon as it has it; +1. */
- (CMSampleBufferRef)sampleBufferWith:(CVPixelBufferRef)pixelBuffer {
    if (!_formatDescription || !CMVideoFormatDescriptionMatchesImageBuffer(_formatDescription, pixelBuffer)) {
        if (_formatDescription) {
            CFRelease(_formatDescription);
            _formatDescription = NULL;
        }
        if (CMVideoFormatDescriptionCreateForImageBuffer(kCFAllocatorDefault, pixelBuffer, &_formatDescription) !=
            noErr) {
            _formatDescription = NULL;
            return NULL;
        }
    }

    CMSampleTimingInfo timing = {
        .duration = kCMTimeInvalid,
        .presentationTimeStamp = CMClockGetTime(CMClockGetHostTimeClock()),
        .decodeTimeStamp = kCMTimeInvalid,
    };
    CMSampleBufferRef sampleBuffer = NULL;
    if (CMSampleBufferCreateReadyWithImageBuffer(
            kCFAllocatorDefault, pixelBuffer, _formatDescription, &timing, &sampleBuffer) != noErr) {
        return NULL;
    }

    CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, YES);
    CFMutableDictionaryRef attachment = (CFMutableDictionaryRef)CFArrayGetValueAtIndex(attachments, 0);
    CFDictionarySetValue(attachment, kCMSampleAttachmentKey_DisplayImmediately, kCFBooleanTrue);
    return sampleBuffer;
}

@end
