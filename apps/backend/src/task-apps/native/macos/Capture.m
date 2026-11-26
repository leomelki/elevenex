#import "Capture.h"
#import "Display.h"
#import <ApplicationServices/ApplicationServices.h>
#include <fcntl.h>
#include <signal.h>
#include <unistd.h>
#include <math.h>

CGSize appCaptureSize(CGSize window, CGFloat pixelScale) {
    if (!isfinite(window.width) || !isfinite(window.height) || !isfinite(pixelScale) ||
        window.width <= 0 || window.height <= 0 || pixelScale <= 0) return CGSizeZero;
    // The wire advertises H.264 Baseline 4.2. Axis limits alone allow
    // 1920x1440, which exceeds that profile's frame macroblock budget and makes
    // VideoToolbox refuse ordinary Retina windows (e.g. 1440x959 at scale 2).
    CGFloat scale = MIN(pixelScale,MIN(1920.0/window.width,1440.0/window.height));
    scale = MIN(scale,sqrt((1920.0*1080.0)/(window.width*window.height)));
    return CGSizeMake(MAX(16,(int)(scale*window.width)&~1),MAX(16,(int)(scale*window.height)&~1));
}

static uint8_t captureFailure(NSError *error, uint8_t fallback) {
    if ([error.domain isEqualToString:SCStreamErrorDomain]) {
        if (error.code == SCStreamErrorUserStopped) return 26;
        if (error.code == SCStreamErrorUserDeclined) return 21;
    }
    return CGPreflightScreenCaptureAccess() ? fallback : 21;
}

static SCWindow *matchShareableWindow(SCShareableContent *content, NSDictionary *row) {
    pid_t owner = [row[(__bridge NSString *)kCGWindowOwnerPID] intValue];
    CGWindowID number = [row[(__bridge NSString *)kCGWindowNumber] unsignedIntValue];
    if (!number) return nil;
    for (SCWindow *window in content.windows) {
        if (window.windowID == number && window.owningApplication.processID == owner && window.windowLayer == 0) return window;
    }
    return nil;
}

static BOOL shareableWindowBounds(SCWindow *window, CGRect *bounds) {
    NSArray *rows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, window.windowID));
    NSDictionary *row = rows.firstObject;
    return [row[(__bridge NSString *)kCGWindowNumber] unsignedIntValue] == window.windowID &&
        [row[(__bridge NSString *)kCGWindowOwnerPID] intValue] == window.owningApplication.processID &&
        appWindowShareable(row) && [row[(__bridge NSString *)kCGWindowIsOnscreen] boolValue] &&
        CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)row[(__bridge NSString *)kCGWindowBounds], bounds);
}

@interface AppDisplay : NSObject
@property(nonatomic, strong) AppWindow *target;
@property(nonatomic, strong) AppEncoder *encoder;
@property(nonatomic, strong) SCStream *stream;
@property(nonatomic, strong) dispatch_queue_t frames;
@property(nonatomic) BOOL selecting;
@property(nonatomic) BOOL active;
@property(nonatomic) NSUInteger generation;
@property(nonatomic) CFTimeInterval deadline;
@property(nonatomic) CFTimeInterval nextWindowProbe;
@end

@implementation AppDisplay
- (void)end:(uint8_t)reason {
    self.active = NO;
    self.selecting = NO;
    self.generation++;
    [self.target releaseInput];
    AppEncoder *retiring = self.encoder;
    [retiring disable];
    if (self.stream) {
        // Keep the output alive through ScreenCaptureKit cancellation and retire
        // VideoToolbox after the last sample handler on its serial frame queue.
        [self.stream stopCaptureWithCompletionHandler:^(NSError *error) {
            dispatch_async(self.frames, ^{ [retiring finish]; });
        }];
    }
    self.stream = nil;
    self.encoder = nil;
    self.target.window = 0;
    self.target.owner = 0;
    if (reason) displayReceipt(0, reason);
}
- (void)tick {
    if (!self.active) return;
    if (!AppSessionActive()) { [self end:20]; return; }
    if (!CGPreflightScreenCaptureAccess()) { [self end:21]; return; }
    if (kill(-self.target.group, 0) != 0) { [self end:23]; return; }
    if (self.stream) {
        CGRect bounds;
        BOOL frontmost = self.target.frontmost;
        AppInputResult input = [self.target inputWindowBounds:&bounds excluding:nil verifyFocus:frontmost && AXIsProcessTrusted()];
        if (input == AppInputUnavailable && ![self.target currentBounds:&bounds]) { [self end:23]; return; }
        if (!frontmost || input != AppInputAccepted) {
            if (self.target.hasHeldInput) [self.target releaseInput];
            [self lookForWindowSwitch];
        }
        // Capture the owner on the main queue. A queued refresh can run after
        // the view has been closed or a replacement encoder has been created.
        AppEncoder *currentEncoder = self.encoder;
        dispatch_async(self.frames, ^{ [currentEncoder refresh]; });
        return;
    }
    NSDictionary *row = self.target.firstOwnedWindow;
    if (!row) { if (CFAbsoluteTimeGetCurrent() > self.deadline) [self end:22]; return; }
    if (self.selecting) return;
    self.selecting = YES;
    NSUInteger generation = self.generation;
    [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:YES completionHandler:^(SCShareableContent *content, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (!self.active || generation != self.generation) return;
            self.selecting = NO;
            if (!content) { [self end:captureFailure(error, 24)]; return; }
            // A verified key window takes priority over the largest window.
            // This lets a new watch follow a normal, shareable dialog.
            NSDictionary *focused = AXIsProcessTrusted() ? self.target.focusedOwnedWindow : nil;
            SCWindow *preferred = matchShareableWindow(content, focused);
            SCWindow *window = nil;
            CGRect windowBounds;
            for (SCWindow *candidate in content.windows) {
                if (candidate.frame.size.width < 16 || candidate.frame.size.height < 16 || candidate.windowLayer != 0 || !ownsAppProcess(self.target.group, candidate.owningApplication.processID)) continue;
                if (candidate != preferred && window && candidate.frame.size.width * candidate.frame.size.height <= window.frame.size.width * window.frame.size.height) continue;
                CGRect bounds;
                if (!shareableWindowBounds(candidate, &bounds)) continue;
                window = candidate;
                windowBounds = bounds;
                if (window == preferred) break;
            }
            if (window) {
                pid_t owner = window.owningApplication.processID;
                CGWindowID selected = window.windowID;
                self.target.window = selected;
                self.target.owner = owner;
                self.target.windowBounds = windowBounds;
                self.target.bounds = window.frame;
                SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
                CGSize size = appCaptureSize(window.frame.size,filter.pointPixelScale);
                self.target.width = (size_t)size.width;
                self.target.height = (size_t)size.height;
                SCStreamConfiguration *config = [SCStreamConfiguration new];
                config.width = self.target.width;
                config.height = self.target.height;
                config.queueDepth = 3;
                config.minimumFrameInterval = CMTimeMake(1, 30);
                config.showsCursor = YES;
                config.ignoreShadowsSingleWindow = YES;
                config.capturesAudio = NO;
                config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange;
                self.encoder = [AppEncoder new];
                __weak AppDisplay *weakSelf = self;
                self.encoder.failed = ^(NSError *error) {
                    if (generation == weakSelf.generation) [weakSelf end:captureFailure(error, 23)];
                };
                if (![self.encoder configureWidth:(int)config.width height:(int)config.height]) { [self end:24]; return; }
                self.stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:self.encoder];
                NSError *streamError = nil;
                if (![self.stream addStreamOutput:self.encoder type:SCStreamOutputTypeScreen sampleHandlerQueue:self.frames error:&streamError]) { [self end:24]; return; }
                [self.stream startCaptureWithCompletionHandler:^(NSError *failure) {
                    if (failure) dispatch_async(dispatch_get_main_queue(), ^{
                        if (generation == self.generation) [self end:captureFailure(failure, 24)];
                    });
                }];
                return;
            }
            if (CFAbsoluteTimeGetCurrent() > self.deadline) [self end:22];
        });
    }];
}
- (void)lookForWindowSwitch {
    CFTimeInterval now = NSProcessInfo.processInfo.systemUptime;
    if (self.selecting || now < self.nextWindowProbe || !AXIsProcessTrusted()) return;
    self.nextWindowProbe = now + 1;
    NSDictionary *focused = self.target.focusedOwnedWindow;
    CGWindowID window = [focused[(__bridge NSString *)kCGWindowNumber] unsignedIntValue];
    if (!window || window == self.target.window) return;
    self.selecting = YES;
    NSUInteger generation = self.generation;
    [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:YES completionHandler:^(SCShareableContent *content, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (!self.active || generation != self.generation) return;
            self.selecting = NO;
            if (!matchShareableWindow(content, focused) || !AXIsProcessTrusted() || !AppSessionActive()) return;
            NSDictionary *current = self.target.focusedOwnedWindow;
            if ([current[(__bridge NSString *)kCGWindowNumber] unsignedIntValue] == window &&
                [current[(__bridge NSString *)kCGWindowOwnerPID] isEqual:focused[(__bridge NSString *)kCGWindowOwnerPID]]) {
                // Retire the old input lease. A fresh watch selects this
                // window and the viewer must paint its frame before control.
                [self end:23];
            }
        });
    }];
}
@end

int runAppCapture(pid_t group, int displayDescriptor, int owner) {
    signal(SIGPIPE,SIG_IGN);
    FILE *viewer = fdopen(dup(displayDescriptor), "rb");
    FILE *output = fdopen(dup(displayDescriptor), "wb");
    if (!viewer || !output) return 2;
    fcntl(fileno(viewer), F_SETFD, FD_CLOEXEC);
    fcntl(fileno(output), F_SETFD, FD_CLOEXEC);
    setDisplayOutput(output);
    AppDisplay *display = [AppDisplay new];
    display.target = [AppWindow new];
    display.target.group = group;
    display.frames = dispatch_queue_create("com.elevenex.app-display.frames", DISPATCH_QUEUE_SERIAL);
    // The native supervisor minted this group. A desktop helper receives it
    // only from the authenticated instance of this executable that owns it.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        char line[8193];
        while (fgets(line, sizeof(line), viewer)) { @autoreleasepool {
            size_t length = strlen(line);
            if (!length || line[length - 1] != '\n') break;
            NSData *bytes = [NSData dataWithBytes:line length:length];
            NSDictionary *message = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:NULL];
            if (![message isKindOfClass:NSDictionary.class] || ![message[@"id"] isKindOfClass:NSNumber.class]) break;
            dispatch_sync(dispatch_get_main_queue(), ^{
                uint32_t id = [message[@"id"] unsignedIntValue];
                if ([message[@"kind"] isEqual:@"watch"]) {
                    [display end:0];
                    display.active = YES;
                    display.deadline = CFAbsoluteTimeGetCurrent() + 120;
                    displayReceipt(id, 1);
                    [display tick];
                } else if ([message[@"kind"] isEqual:@"unwatch"]) {
                    [display end:0];
                    displayReceipt(id, 1);
                } else {
                    AppInputResult result = [message[@"kind"] isEqual:@"release"] || display.active
                        ? [display.target input:message] : AppInputUnavailable;
                    if (result != AppInputActivationRequested) { displayReceipt(id, result); return; }
                    // The frontmost app changes asynchronously. Give macOS one
                    // bounded turn to confirm focus and never replay the click.
                    NSUInteger generation = display.generation;
                    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 200 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
                        CGRect bounds;
                        AppInputResult receipt = AppInputUnavailable;
                        if (generation == display.generation && AppSessionActive()) {
                            receipt = display.target.frontmost
                                ? [display.target inputWindowBounds:&bounds excluding:nil verifyFocus:YES]
                                : AppInputNeedsForeground;
                        }
                        displayReceipt(id, receipt);
                    });
                }
            });
        }}
        dispatch_async(dispatch_get_main_queue(), ^{ [display end:0]; });
    });
    dispatch_source_t clock = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
    dispatch_source_set_timer(clock, DISPATCH_TIME_NOW, NSEC_PER_SEC / 2, 10 * NSEC_PER_MSEC);
    dispatch_source_set_event_handler(clock, ^{ @autoreleasepool { [display tick]; } });
    dispatch_resume(clock);
    if (owner >= 0) {
        dispatch_source_t connection = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ,owner,0,dispatch_get_main_queue());
        dispatch_source_set_event_handler(connection, ^{
            [display end:0];
            dispatch_source_cancel(connection);
            close(owner);
            _exit(0);
        });
        dispatch_resume(connection);
    }
    dispatch_main();
    return 0;
}

