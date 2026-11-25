#import "Display.h"
#import <ApplicationServices/ApplicationServices.h>
#import <signal.h>
#import <fcntl.h>
#import <unistd.h>

static uint8_t captureFailure(NSError *error) {
    BOOL denied = [error.domain isEqualToString:SCStreamErrorDomain] && error.code == SCStreamErrorUserDeclined;
    return denied || !CGPreflightScreenCaptureAccess() ? 21 : 24;
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
    NSDictionary *row = self.target.firstOwnedWindow;
    if (!row && !self.stream) { if (CFAbsoluteTimeGetCurrent() > self.deadline) [self end:22]; return; }
    CGWindowID selected = [row[(__bridge NSString *)kCGWindowNumber] unsignedIntValue];
    if (self.stream) {
        CGRect bounds;
        if (!row || selected != self.target.window ||
            !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)row[(__bridge NSString *)kCGWindowBounds], &bounds) ||
            !CGSizeEqualToSize(bounds.size, self.target.bounds.size)) { [self end:23]; return; }
        if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != self.target.owner) [self.target releaseInput];
        // Capture the owner on the main queue. A queued refresh can run after
        // the view has been closed or a replacement encoder has been created.
        AppEncoder *currentEncoder = self.encoder;
        dispatch_async(self.frames, ^{ [currentEncoder refresh]; });
        return;
    }
    if (self.selecting) return;
    self.selecting = YES;
    NSUInteger generation = self.generation;
    [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:YES completionHandler:^(SCShareableContent *content, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (!self.active || generation != self.generation) return;
            self.selecting = NO;
            if (!content) { [self end:captureFailure(error)]; return; }
            for (SCWindow *window in content.windows) {
                pid_t owner = window.owningApplication.processID;
                if (window.windowID != selected || !ownsAppProcess(self.target.group, owner)) continue;
                self.target.window = selected;
                self.target.owner = owner;
                self.target.bounds = window.frame;
                SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
                CGFloat scale = MIN(filter.pointPixelScale, MIN(1920.0 / window.frame.size.width, 1440.0 / window.frame.size.height));
                self.target.width = MAX(16, (int)(scale * window.frame.size.width) & ~1);
                self.target.height = MAX(16, (int)(scale * window.frame.size.height) & ~1);
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
                self.encoder.failed = ^{ if (generation == weakSelf.generation) [weakSelf end:23]; };
                if (![self.encoder configureWidth:(int)config.width height:(int)config.height]) { [self end:24]; return; }
                self.stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:self.encoder];
                NSError *streamError = nil;
                if (![self.stream addStreamOutput:self.encoder type:SCStreamOutputTypeScreen sampleHandlerQueue:self.frames error:&streamError]) { [self end:24]; return; }
                [self.stream startCaptureWithCompletionHandler:^(NSError *failure) {
                    if (failure) dispatch_async(dispatch_get_main_queue(), ^{
                        if (generation == self.generation) [self end:captureFailure(failure)];
                    });
                }];
                return;
            }
            if (CFAbsoluteTimeGetCurrent() > self.deadline) [self end:22];
        });
    }];
}
@end

int main(int argc, char *argv[]) {
    @autoreleasepool {
        if (argc == 2 && !strcmp(argv[1], "--self-test")) {
            setDisplayOutput(stdout);
            AppEncoder *encoder = [AppEncoder new];
            encoder.failed = ^{};
            return [encoder configureWidth:64 height:64] && [encoder encodeTestFrame] ? 0 : 24;
        }
        if (argc == 2 && !strcmp(argv[1], "--authorize")) {
            CGRequestScreenCaptureAccess();
            NSDictionary *options = @{ (__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES };
            return AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options) && CGPreflightScreenCaptureAccess() ? 0 : 21;
        }
        if (argc == 2 && (!strcmp(argv[1], "--screen-settings") || !strcmp(argv[1], "--accessibility-settings"))) {
            if (!AppSessionActive()) return 20;
            BOOL screen = !strcmp(argv[1], "--screen-settings");
            NSString *pane = screen ? @"Privacy_ScreenCapture" : @"Privacy_Accessibility";
            NSURL *url = [NSURL URLWithString:[@"x-apple.systempreferences:com.apple.preference.security?" stringByAppendingString:pane]];
            if (![NSWorkspace.sharedWorkspace openURL:url]) return 24;
            // Request only the selected permission, so the helper is listed even on first use.
            if (screen && !CGPreflightScreenCaptureAccess()) CGRequestScreenCaptureAccess();
            if (!screen && !AXIsProcessTrusted()) {
                NSDictionary *options = @{ (__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES };
                AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
            }
            return 0;
        }
        if (argc == 2 && !strcmp(argv[1], "--check")) {
            if (!AppSessionActive()) return 20;
            return CGPreflightScreenCaptureAccess() ? 0 : 21;
        }
        if (argc < 3 || strcmp(argv[1], "--launch")) return 2;
        FILE *viewer = fdopen(dup(4), "rb");
        FILE *output = fdopen(dup(4), "wb");
        if (!viewer || !output) return 2;
        fcntl(fileno(viewer), F_SETFD, FD_CLOEXEC);
        fcntl(fileno(output), F_SETFD, FD_CLOEXEC);
        setDisplayOutput(output);
        pid_t group = launchOwnedGroup(argv + 2);
        if (group <= 0) return 2;
        AppDisplay *display = [AppDisplay new];
        display.target = [AppWindow new];
        display.target.group = group;
        display.frames = dispatch_queue_create("com.elevenex.app-display.frames", DISPATCH_QUEUE_SERIAL);
        // fd4 is an inherited private channel, closed in the launched app. Capture and
        // input always target the child group minted above, never a supplied PID.
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
                        BOOL accepted = display.active && [display.target input:message];
                        uint8_t result = accepted ? 1 : !AXIsProcessTrusted() ? 2 :
                            NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != display.target.owner ? 3 : 0;
                        displayReceipt(id, result);
                    }
                });
            }}
            dispatch_async(dispatch_get_main_queue(), ^{ [display end:0]; });
        });
        dispatch_source_t clock = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
        dispatch_source_set_timer(clock, DISPATCH_TIME_NOW, NSEC_PER_SEC / 2, 10 * NSEC_PER_MSEC);
        dispatch_source_set_event_handler(clock, ^{ @autoreleasepool { [display tick]; } });
        dispatch_resume(clock);
        dispatch_main();
        return 0;
    }
}
