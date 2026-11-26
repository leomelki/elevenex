#import <AppKit/AppKit.h>
#include <math.h>

@interface TaskAppTitleSurface : NSPanel
@end
@implementation TaskAppTitleSurface
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

@interface TaskAppTestView : NSView
@end
@implementation TaskAppTestView
- (BOOL)acceptsFirstResponder { return YES; }
- (void)drawRect:(NSRect)dirty {
    [[NSColor systemBlueColor] setFill];
    NSRectFill(dirty);
}
- (void)mouseDown:(NSEvent *)event {
    [self.window makeFirstResponder:self];
    NSPoint point = event.locationInWindow;
    NSSize frame = self.window.frame.size;
    if (fabs(point.x - frame.width / 2) <= 3 && fabs(point.y - frame.height / 2) <= 3) {
        puts("clicked"); fflush(stdout);
    }
}
- (void)mouseDragged:(NSEvent *)event {
    puts("dragged"); fflush(stdout);
}
- (void)mouseUp:(NSEvent *)event {
    puts("released"); fflush(stdout);
}
- (void)scrollWheel:(NSEvent *)event {
    if (event.hasPreciseScrollingDeltas && event.scrollingDeltaX == -17 && event.scrollingDeltaY == -41) {
        puts("scrolled"); fflush(stdout);
    }
}
- (void)keyDown:(NSEvent *)event {
    NSWindow *window = self.window;
    if (event.keyCode == 53 && window.parentWindow) {
        NSWindow *parent = window.parentWindow;
        [parent removeChildWindow:window];
        [window orderOut:nil];
        [parent makeKeyAndOrderFront:nil];
        puts("shareable-dialog-closed"); fflush(stdout);
    }
    if ([event.characters isEqual:@"é"]) { puts("text-received"); fflush(stdout); }
    if ([event.charactersIgnoringModifiers isEqual:@"a"]) { puts("typed"); fflush(stdout); }
    if ([event.charactersIgnoringModifiers isEqual:@"c"]) {
        NSRect frame = window.frame;
        NSWindow *dialog = [[NSWindow alloc] initWithContentRect:NSMakeRect(NSMinX(frame)+50, NSMinY(frame)+60, 240, 160)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        dialog.title = @"Shareable task app test dialog";
        dialog.sharingType = NSWindowSharingReadOnly;
        dialog.animationBehavior = NSWindowAnimationBehaviorNone;
        dialog.contentView = [[TaskAppTestView alloc] initWithFrame:dialog.contentView.frame];
        [window addChildWindow:dialog ordered:NSWindowAbove];
        [dialog makeKeyAndOrderFront:nil];
        [dialog makeFirstResponder:dialog.contentView];
        puts("shareable-dialog-open"); fflush(stdout);
    }
    if ([event.charactersIgnoringModifiers isEqual:@"b"]) {
        NSWindow *parent = self.window;
        NSWindow *dialog = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 280, 150)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        dialog.title = @"Task app input test dialog";
        dialog.sharingType = NSWindowSharingNone;
        dialog.animationBehavior = NSWindowAnimationBehaviorNone;
        [parent beginSheet:dialog completionHandler:^(NSModalResponse response) {
            [dialog orderOut:nil];
            puts("dialog-closed"); fflush(stdout);
        }];
        puts("dialog-open"); fflush(stdout);
        [NSTimer scheduledTimerWithTimeInterval:4 repeats:NO block:^(NSTimer *timer) {
            [parent endSheet:dialog];
        }];
    }
}
@end
int main(int argc, char **argv) {
    @autoreleasepool {
        BOOL competingApp = argc == 2 && !strcmp(argv[1], "--competing-app");
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        [NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidBecomeActiveNotification
            object:NSApp queue:nil usingBlock:^(NSNotification *notification) {
                puts(competingApp ? "competing-app-activated" : "activated");
                fflush(stdout);
            }];
        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 120, 480, 320)
            styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
        window.title = competingApp ? @"Elevenex input test competing app" : @"Elevenex capture and input test";
        window.animationBehavior = NSWindowAnimationBehaviorNone;
        window.contentView = [[TaskAppTestView alloc] initWithFrame:window.contentView.frame];
        [window makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
        // Simulate the separate AppKit screen-sharing title controls on hosts
        // where attaching ScreenCaptureKit does not create them automatically.
        NSRect frame = window.frame;
        NSPanel *surface = [[TaskAppTitleSurface alloc] initWithContentRect:NSMakeRect(NSMinX(frame) + 6, NSMaxY(frame) - 26, 66, 20)
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        surface.level = NSNormalWindowLevel;
        surface.sharingType = NSWindowSharingReadOnly;
        surface.backgroundColor = NSColor.systemGrayColor;
        surface.ignoresMouseEvents = YES;
        [window addChildWindow:surface ordered:NSWindowAbove];
        [NSApp run];
    }
    return 0;
}
