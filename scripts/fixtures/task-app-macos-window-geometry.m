// Real WindowServer lifecycle checks; no Screen Recording or input grant needed.
#import "Display.h"
#include <unistd.h>

static void check(BOOL accepted, NSString *message) {
    if (!accepted) { fprintf(stderr, "%s\n", message.UTF8String); exit(1); }
}

static void waitFor(BOOL (^condition)(void), NSString *message) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:2];
    while (!condition() && deadline.timeIntervalSinceNow > 0) {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny
            untilDate:[NSDate dateWithTimeIntervalSinceNow:0.01] inMode:NSDefaultRunLoopMode dequeue:YES];
        if (event) [NSApp sendEvent:event];
    }
    check(condition(), message);
}

int main(void) {
    @autoreleasepool {
        check(AppSessionActive(), @"Focused-window checks need an unlocked graphical session");
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        [NSApp finishLaunching];
        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120,120,480,320)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        window.sharingType = NSWindowSharingReadOnly;
        window.animationBehavior = NSWindowAnimationBehaviorNone;
        const NSSize originalAppKitSize = window.frame.size;
        [window makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
        AppWindow *target = [AppWindow new];
        target.group = getpgrp();
        target.owner = getpid();
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
        AppInputResult (^inputBounds)(void) = ^{
            return [target inputWindowBounds:&current excluding:nil verifyFocus:YES];
        };
        check([target currentBounds:&current], @"An unchanged window with an inset picture must stay attached");
        check(inputBounds() == AppInputAccepted, @"The uncovered selected window must pass the geometry gate");
        NSRect moved = window.frame;
        moved.origin.x += 40;
        [window setFrame:moved display:YES];
        waitFor(^BOOL{ return [target currentBounds:&current] && current.origin.x != original.origin.x; }, @"Input must receive the moved WindowServer origin without losing capture");
        moved.size.width += 40;
        [window setFrame:moved display:YES];
        waitFor(^BOOL{ return ![target currentBounds:&current]; }, @"A real resize must invalidate capture and input");
        [window setFrame:NSMakeRect(window.frame.origin.x,window.frame.origin.y,originalAppKitSize.width,originalAppKitSize.height) display:YES];
        waitFor(^BOOL{ return [target currentBounds:&current]; }, @"Restoring the window size must restore geometry validation");
        NSRect frame = window.frame;
        NSWindow *chrome = [[NSWindow alloc] initWithContentRect:NSMakeRect(NSMinX(frame)+6,NSMaxY(frame)-26,66,20)
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        chrome.sharingType = NSWindowSharingReadOnly;
        chrome.animationBehavior = NSWindowAnimationBehaviorNone;
        [window addChildWindow:chrome ordered:NSWindowAbove];
        waitFor(^BOOL{ return [target.firstOwnedWindow[(__bridge NSString *)kCGWindowNumber] intValue] == chrome.windowNumber; }, @"Place sharing controls above the primary window");
        check(inputBounds() == AppInputAccepted, @"Sharing controls must allow input to the underlying app");
        [chrome setFrame:NSMakeRect(NSMaxX(frame)-156,NSMaxY(frame)-35,150,28) display:YES];
        waitFor(^BOOL{ return window.isKeyWindow && NSApp.isActive; }, @"The captured window must already have focus");
        check([target.focusedOwnedWindow[(__bridge NSString *)kCGWindowNumber] intValue] == window.windowNumber,
            @"Find the actual shareable focused window through its title-bar control");
        __block CGFloat controlWidth;
        waitFor(^BOOL{
            NSDictionary *row = target.firstOwnedWindow;
            NSDictionary *bounds = row[(__bridge NSString *)kCGWindowBounds];
            controlWidth = [bounds[@"Width"] doubleValue];
            return [row[(__bridge NSString *)kCGWindowNumber] intValue] == chrome.windowNumber && controlWidth > 100;
        }, @"WindowServer must report the resized sharing control");
        NSMutableArray<NSValue *> *occlusions = [NSMutableArray array];
        check([target inputWindowBounds:&current excluding:occlusions verifyFocus:YES] == AppInputAccepted,
            @"A differently positioned sharing control must allow input to the focused window");
        check(occlusions.count == 1 && NSWidth(occlusions[0].rectValue) == controlWidth,
            @"Pointer input must still exclude the sharing control's actual area");
        CGFloat previousX = current.origin.x;
        [window setFrameOrigin:NSMakePoint(NSMinX(frame)+20, NSMinY(frame))];
        waitFor(^BOOL{ return inputBounds() == AppInputAccepted && current.origin.x != previousX; },
            @"Moving the focused window with its sharing control must preserve control");
        frame = window.frame;
        [chrome setFrameOrigin:NSMakePoint(NSMinX(frame)+6,NSMaxY(frame)-66)];
        waitFor(^BOOL{ return inputBounds() == AppInputWindowBlocked; }, @"The same surface outside the title bar must block input");
        [chrome setFrameOrigin:NSMakePoint(NSMinX(frame)-160,NSMaxY(frame)-66)];
        waitFor(^BOOL{ return inputBounds() == AppInputAccepted; }, @"A separate non-key window must leave control on the focused window");
        [window removeChildWindow:chrome];
        [chrome orderOut:nil];
        NSWindow *sheet = [[NSWindow alloc] initWithContentRect:NSMakeRect(160,160,240,160)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        sheet.sharingType = NSWindowSharingNone;
        sheet.animationBehavior = NSWindowAnimationBehaviorNone;
        [sheet orderFrontRegardless];
        waitFor(^BOOL{ return inputBounds() == AppInputWindowBlocked; }, @"A new owned window above the selection must invalidate input");
        check([target currentBounds:&current], @"A covering owned window must not interrupt capture");
        [sheet setFrame:NSMakeRect(NSMinX(frame)-140,NSMinY(frame),120,160) display:YES];
        [sheet makeKeyAndOrderFront:nil];
        waitFor(^BOOL{ return sheet.isKeyWindow && inputBounds() == AppInputWindowBlocked; },
            @"A separate owned window with keyboard focus must block input to the shared window");
        check(target.focusedOwnedWindow == nil, @"A nonshareable focused window must be excluded from handoff");
        sheet.sharingType = NSWindowSharingReadOnly;
        waitFor(^BOOL{ return [target.focusedOwnedWindow[(__bridge NSString *)kCGWindowNumber] intValue] == sheet.windowNumber; },
            @"A shareable focused window can replace the initial target");
        [sheet orderOut:nil];
        [window makeKeyAndOrderFront:nil];
        waitFor(^BOOL{ return inputBounds() == AppInputAccepted; }, @"Closing the covering window must restore input");
        target.owner = 1;
        check(![target currentBounds:&current], @"The captured window must still have its original owner PID");
        target.owner = getpid();
        target.group = 1;
        check(![target currentBounds:&current], @"An unowned window must be rejected");
        check(target.focusedOwnedWindow == nil, @"A foreground window outside the launch group must be excluded from handoff");
        [window orderOut:nil];
        puts("Native window geometry: focused window, sharing control geometry and exclusion, separate windows, dialog, move, resize and ownership verified");
    }
    return 0;
}
