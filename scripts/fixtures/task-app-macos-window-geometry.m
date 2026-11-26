// Real WindowServer lifecycle checks; no Screen Recording or input grant needed.
#import "Display.h"
#include <unistd.h>

static void check(BOOL accepted, NSString *message) {
    if (!accepted) { fprintf(stderr, "%s\n", message.UTF8String); exit(1); }
}

static void waitFor(BOOL (^condition)(void), NSString *message) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:2];
    while (!condition() && deadline.timeIntervalSinceNow > 0)
        [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    check(condition(), message);
}

int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120,120,480,320)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        window.animationBehavior = NSWindowAnimationBehaviorNone;
        [window orderFrontRegardless];
        AppWindow *target = [AppWindow new];
        target.group = getpgrp();
        target.window = (CGWindowID)window.windowNumber;
        waitFor(^BOOL{ return [target.firstOwnedWindow[(__bridge NSString *)kCGWindowNumber] unsignedIntValue] == target.window; }, @"Select the owned test window");
        NSDictionary *row = target.firstOwnedWindow;
        CGRect original;
        check(CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)row[(__bridge NSString *)kCGWindowBounds], &original), @"Read WindowServer frame");
        target.windowBounds = original;
        // Reproduce the observed border difference between WindowServer and
        // ScreenCaptureKit without asking for capture permissions in a test.
        target.bounds = CGRectInset(original,1,1);
        __block CGRect current;
        check([target currentBounds:&current], @"An unchanged window with an inset picture must stay attached");
        NSRect moved = window.frame;
        moved.origin.x += 40;
        [window setFrame:moved display:YES];
        waitFor(^BOOL{ return [target currentBounds:&current] && current.origin.x != original.origin.x; }, @"Input must receive the moved WindowServer origin without losing capture");
        moved.size.width += 40;
        [window setFrame:moved display:YES];
        waitFor(^BOOL{ return ![target currentBounds:&current]; }, @"A real resize must invalidate capture and input");
        [window setFrame:NSMakeRect(window.frame.origin.x,window.frame.origin.y,original.size.width,original.size.height) display:YES];
        waitFor(^BOOL{ return [target currentBounds:&current]; }, @"Restoring the window size must restore geometry validation");
        NSWindow *sheet = [[NSWindow alloc] initWithContentRect:NSMakeRect(160,160,240,160)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        sheet.animationBehavior = NSWindowAnimationBehaviorNone;
        [sheet orderFrontRegardless];
        waitFor(^BOOL{ return ![target currentBounds:&current]; }, @"A new owned window above the selection must invalidate input");
        [sheet orderOut:nil];
        waitFor(^BOOL{ return [target currentBounds:&current]; }, @"Closing the covering window must restore selection");
        target.group = 1;
        check(![target currentBounds:&current], @"An unowned window must be rejected");
        [window orderOut:nil];
        puts("Native window geometry: border inset, move, resize, covering window and ownership verified");
    }
    return 0;
}
