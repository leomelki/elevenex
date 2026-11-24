#import "Display.h"
#import <unistd.h>

static FILE *output;
void setDisplayOutput(FILE *channel) { output = channel; setvbuf(channel, NULL, _IONBF, 0); }
void displayReceipt(uint32_t id, uint8_t flag) {
    uint8_t header[9] = {0};
    uint32_t encoded = CFSwapInt32HostToBig(id);
    memcpy(header + 4, &encoded, 4); header[8] = flag;
    fwrite(header, 1, sizeof(header), output);
}
static BOOL appendNAL(NSMutableData *packet, const uint8_t *bytes, size_t size) {
    static const uint8_t start[] = {0, 0, 0, 1};
    if (!size || size > 3000000 || packet.length + size + 4 > 3000009) return NO;
    [packet appendBytes:start length:sizeof(start)];
    [packet appendBytes:bytes length:size];
    return YES;
}

static void deliver(void *context, void *frame, OSStatus status, VTEncodeInfoFlags flags, CMSampleBufferRef sample) {
    AppEncoder *encoder = (__bridge AppEncoder *)context;
    if (status != noErr) return;
    if (!sample || !CMSampleBufferDataIsReady(sample) || (flags & kVTEncodeInfo_FrameDropped)) return;
    @autoreleasepool {
        CMFormatDescriptionRef format = CMSampleBufferGetFormatDescription(sample);
        CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sample);
        if (!format || !block) return;
        size_t length = CMBlockBufferGetDataLength(block), count = 0;
        int nalSize = 0;
        if (!length || length > 3000000 ||
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, 0, NULL, NULL, &count, &nalSize) != noErr || nalSize != 4 || count > 16) return;
        NSArray *attachments = (__bridge NSArray *)CMSampleBufferGetSampleAttachmentsArray(sample, false);
        BOOL key = ![attachments.firstObject[(__bridge NSString *)kCMSampleAttachmentKey_NotSync] boolValue];
        NSMutableData *packet = [NSMutableData dataWithLength:9];
        if (key) {
            for (size_t i = 0; i < count; i++) {
                const uint8_t *bytes = NULL; size_t size = 0;
                if (CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, i, &bytes, &size, NULL, NULL) != noErr) return;
                if (!appendNAL(packet, bytes, size)) return;
            }
        }
        // VideoToolbox supplies length-prefixed AVC. Convert to Annex B while copying
        // directly from a possibly non-contiguous CMBlockBuffer into one bounded packet.
        for (size_t pos = 0; pos < length;) {
            uint32_t networkLength;
            if (length - pos < 4 || CMBlockBufferCopyDataBytes(block, pos, 4, &networkLength)) return;
            size_t payload = CFSwapInt32BigToHost(networkLength);
            if (!payload || payload > length - pos - 4 || packet.length + payload + 4 > 3000009) return;
            size_t start = packet.length;
            [packet increaseLengthBy:payload + 4];
            uint8_t *out = packet.mutableBytes;
            out[start + 3] = 1;
            if (CMBlockBufferCopyDataBytes(block, pos + 4, payload, out + start + 4)) return;
            pos += payload + 4;
        }
        CMVideoDimensions dimensions = CMVideoFormatDescriptionGetDimensions(format);
        uint32_t size = CFSwapInt32HostToBig((uint32_t)(packet.length - 9));
        uint16_t width = CFSwapInt16HostToBig(dimensions.width), height = CFSwapInt16HostToBig(dimensions.height);
        uint8_t *out = packet.mutableBytes;
        memcpy(out, &size, 4); memcpy(out + 4, &width, 2); memcpy(out + 6, &height, 2); out[8] = key;
        @synchronized(encoder) { if (encoder.failed) fwrite(out, 1, packet.length, output); }
    }
}

@implementation AppEncoder {
    VTCompressionSessionRef _session;
    CVPixelBufferRef _last;
    CFTimeInterval _lastSent;
}
- (BOOL)configureWidth:(int)width height:(int)height {
    if (VTCompressionSessionCreate(NULL, width, height, kCMVideoCodecType_H264, NULL, NULL, NULL,
                                   deliver, (__bridge void *)self, &_session) != noErr) return NO;
    NSDictionary *settings = @{
        (__bridge NSString *)kVTCompressionPropertyKey_RealTime: @YES,
        (__bridge NSString *)kVTCompressionPropertyKey_AllowFrameReordering: @NO,
        (__bridge NSString *)kVTCompressionPropertyKey_ProfileLevel: (__bridge NSString *)kVTProfileLevel_H264_Baseline_4_2,
        (__bridge NSString *)kVTCompressionPropertyKey_AverageBitRate: @6000000,
        (__bridge NSString *)kVTCompressionPropertyKey_ExpectedFrameRate: @30,
        (__bridge NSString *)kVTCompressionPropertyKey_MaxKeyFrameInterval: @30
    };
    return VTSessionSetProperties(_session, (__bridge CFDictionaryRef)settings) == noErr &&
           VTCompressionSessionPrepareToEncodeFrames(_session) == noErr;
}
- (void)encode:(CVPixelBufferRef)image key:(BOOL)key {
    if (!_session) return;
    CMTime time = CMClockGetTime(CMClockGetHostTimeClock());
    NSDictionary *options = key ? @{ (__bridge NSString *)kVTEncodeFrameOptionKey_ForceKeyFrame: @YES } : nil;
    VTEncodeInfoFlags flags;
    if (VTCompressionSessionEncodeFrame(_session, image, time, kCMTimeInvalid, (__bridge CFDictionaryRef)options, NULL, &flags) != noErr) return;
    _lastSent = CFAbsoluteTimeGetCurrent();
}
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeScreen || !CMSampleBufferIsValid(sample)) return;
    NSArray *attachments = (__bridge NSArray *)CMSampleBufferGetSampleAttachmentsArray(sample, false);
    NSNumber *status = attachments.firstObject[SCStreamFrameInfoStatus];
    if (!status || status.integerValue != SCFrameStatusComplete) return;
    CVPixelBufferRef image = CMSampleBufferGetImageBuffer(sample);
    if (!image) return;
    if (_last) CVPixelBufferRelease(_last);
    _last = CVPixelBufferRetain(image);
    [self encode:image key:NO];
}
- (BOOL)encodeTestFrame {
    CVPixelBufferRef image = NULL;
    NSDictionary *attributes = @{(__bridge NSString *)kCVPixelBufferIOSurfacePropertiesKey: @{}};
    if (CVPixelBufferCreate(NULL, 64, 64, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, (__bridge CFDictionaryRef)attributes, &image)) return NO;
    CVPixelBufferLockBaseAddress(image, 0);
    for (size_t plane = 0; plane < CVPixelBufferGetPlaneCount(image); plane++) {
        memset(CVPixelBufferGetBaseAddressOfPlane(image, plane), plane ? 128 : 16, CVPixelBufferGetBytesPerRowOfPlane(image, plane) * CVPixelBufferGetHeightOfPlane(image, plane));
    }
    CVPixelBufferUnlockBaseAddress(image, 0);
    [self encode:image key:YES];
    CVPixelBufferRelease(image);
    return VTCompressionSessionCompleteFrames(_session, kCMTimeInvalid) == noErr;
}
- (void)refresh {
    if (_last && CFAbsoluteTimeGetCurrent() - _lastSent >= 1.0) [self encode:_last key:YES];
}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    dispatch_async(dispatch_get_main_queue(), ^{ if (self.failed) self.failed(); });
}
- (void)disable { @synchronized(self) { self.failed = nil; } }
- (void)finish {
    if (_session) { VTCompressionSessionInvalidate(_session); CFRelease(_session); _session = NULL; }
    if (_last) { CVPixelBufferRelease(_last); _last = NULL; }
}
- (void)dealloc { [self finish]; }
@end
