// Isolated AppKit UI fixture. Production never reads these test state files.
#import <AppKit/AppKit.h>
#import "Setup.h"
#import "SetupViews.h"

static NSButton *buttonNamed(NSView *view, NSString *title) {
    if (view.hidden) return nil;
    if ([view isKindOfClass:NSButton.class] && [((NSButton *)view).title isEqualToString:title]) return (NSButton *)view;
    for (NSView *child in view.subviews) {
        NSButton *button = buttonNamed(child,title);
        if (button) return button;
    }
    return nil;
}

static BOOL containsText(NSView *view, NSString *text) {
    if (view.hidden) return NO;
    if ([view isKindOfClass:NSTextField.class] && [((NSTextField *)view).stringValue isEqualToString:text]) return YES;
    for (NSView *child in view.subviews) if (containsText(child,text)) return YES;
    return NO;
}

static BOOL controlsFit(NSView *view, NSView *content) {
    if (view.hidden) return YES;
    if ([view isKindOfClass:NSButton.class] || [view isKindOfClass:NSTextField.class]) {
        NSRect rect = [view convertRect:view.bounds toView:content];
        if (!NSContainsRect(NSInsetRect(content.bounds,-1,-1),rect)) return NO;
    }
    for (NSView *child in view.subviews) if (!controlsFit(child,content)) return NO;
    return YES;
}

static NSView *dragItem(NSView *view) {
    if (view.hidden) return nil;
    if ([view isKindOfClass:AgentDragItem.class]) return view;
    for (NSView *child in view.subviews) {
        NSView *item = dragItem(child);
        if (item) return item;
    }
    return nil;
}

int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc == 2 && !strcmp(argv[1], "--permission-status")) {
            NSString *path = NSProcessInfo.processInfo.environment[@"ELEVENEX_AGENT_FIXTURE_STATE"];
            NSData *state = [NSData dataWithContentsOfFile:path];
            if (state) fwrite(state.bytes, 1, state.length, stdout);
            return state ? 0 : 1;
        }
        if (argc == 3 && (!strcmp(argv[1],"--hold-setup") || !strcmp(argv[1],"--hold-capture"))) {
            [NSApplication sharedApplication];
            [NSApp setActivationPolicy:!strcmp(argv[1],"--hold-setup") ? NSApplicationActivationPolicyRegular : NSApplicationActivationPolicyAccessory];
            dispatch_async(dispatch_get_main_queue(), ^{
                [[NSString stringWithFormat:@"%d",NSProcessInfo.processInfo.processIdentifier] writeToFile:@(argv[2]) atomically:YES encoding:NSUTF8StringEncoding error:NULL];
            });
            [NSTimer scheduledTimerWithTimeInterval:60 repeats:NO block:^(NSTimer *timer) { [NSApp terminate:nil]; }];
            [NSApp run];
            return 0;
        }
        if (argc != 3 && argc != 4) return 2;
        NSString *output = @(argv[1]);
        NSString *action = argc == 4 ? @(argv[3]) : @"";
        BOOL dark = !strcmp(argv[2], "dark");
        [NSApplication sharedApplication];
        NSApp.appearance = [NSAppearance appearanceNamed:dark ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
        if ([action isEqualToString:@"transition"]) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 2), dispatch_get_main_queue(), ^{
                NSString *path = NSProcessInfo.processInfo.environment[@"ELEVENEX_AGENT_FIXTURE_STATE"];
                [@"{\"screen\":true,\"input\":false}" writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:NULL];
            });
        }
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:7];
        __block BOOL reopened = NO;
        __block NSUInteger resetCount = 0;
        __block NSUInteger repairStep = 0;
        __block NSTask *resetTask = nil;
        __block BOOL compact = NO;
        BOOL repair = [action hasPrefix:@"reset-"];
        [NSTimer scheduledTimerWithTimeInterval:1 repeats:YES block:^(NSTimer *timer) {
            NSWindow *window = NSApp.windows.firstObject;
            if (!window || !window.visible) { [NSApp terminate:nil]; exit(1); }
            if (repair) {
                if ([action hasSuffix:@"-compact"] && !compact) {
                    compact = YES;
                    NSRect frame = window.frame;
                    frame.origin.x += 1;
                    [window setFrame:frame display:YES];
                    [window setContentSize:NSMakeSize(264,window.contentView.bounds.size.height)];
                    return;
                }
                if (repairStep == 0) {
                    NSButton *help = buttonNamed(window.contentView,@"Already enabled?");
                    if (!help) { if (deadline.timeIntervalSinceNow > 0) return; exit(1); }
                    // Merely polling or opening help must never clear a permission.
                    if (resetCount != 0) exit(1);
                    [help performClick:nil];
                    NSButton *reset = buttonNamed(window.contentView,@"Reset Accessibility");
                    if (!reset || resetCount != 0 || window.firstResponder != reset) exit(1);
                    if ([action isEqualToString:@"reset-help"]) repairStep = 2;
                    else {
                        [reset performClick:nil];
                        if (resetCount != 1) exit(1);
                        repairStep = 1;
                        if (![action isEqualToString:@"reset-busy"] && ![action isEqualToString:@"reset-close"] && ![action isEqualToString:@"reset-reopen"]) return;
                        if (!resetTask.running || reset.enabled || buttonNamed(window.contentView,@"Skip").enabled) exit(1);
                        if ([action isEqualToString:@"reset-reopen"]) {
                            [NSApp.delegate applicationShouldHandleReopen:NSApp hasVisibleWindows:YES];
                            repairStep = 4;
                            return;
                        }
                    }
                } else if (repairStep == 1) {
                    BOOL failure = [action hasPrefix:@"reset-failure"] || [action isEqualToString:@"reset-launch-failure"] ||
                        [action isEqualToString:@"reset-timeout"] || ([action isEqualToString:@"reset-retry"] && resetCount == 1);
                    NSString *message = failure
                        ? @"macOS couldn’t reset the entry. In Accessibility, select Elevenex Agent and click − to remove it. Add it again using the steps above, then turn on its switch."
                        : @"Entry cleared. Add Elevenex Agent to Accessibility again using the steps above, then turn on its switch.";
                    if (!containsText(window.contentView,message)) {
                        if (deadline.timeIntervalSinceNow > 0) return;
                        fprintf(stderr,"Repair did not settle: %s\n", action.UTF8String); exit(1);
                    }
                    NSButton *reset = buttonNamed(window.contentView,@"Reset Accessibility");
                    if (!reset.enabled || resetTask.running || buttonNamed(window.contentView,@"Done")) exit(1);
                    if ([action isEqualToString:@"reset-retry"] && resetCount == 1) {
                        [reset performClick:nil];
                        if (resetCount != 2) exit(1);
                        return;
                    }
                    if ([action isEqualToString:@"reset-then-enabled"]) {
                        NSString *path = NSProcessInfo.processInfo.environment[@"ELEVENEX_AGENT_FIXTURE_STATE"];
                        [@"{\"screen\":true,\"input\":true}" writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:NULL];
                        repairStep = 3;
                        return;
                    }
                    repairStep = 2;
                } else if (repairStep == 3) {
                    if (!containsText(window.contentView,@"Permissions are on")) {
                        if (deadline.timeIntervalSinceNow > 0) return;
                        exit(1);
                    }
                    if (buttonNamed(window.contentView,@"Reset Accessibility") || buttonNamed(window.contentView,@"Already enabled?") ||
                        !buttonNamed(window.contentView,@"Done")) exit(1);
                    repairStep = 2;
                }
                if (repairStep == 4) {
                    if (resetTask.running || !containsText(window.contentView,@"macOS may remember an older Elevenex Agent. Reset only its Accessibility permission, then add it again.")) {
                        if (deadline.timeIntervalSinceNow > 0) return;
                        exit(1);
                    }
                    if (!buttonNamed(window.contentView,@"Reset Accessibility").enabled) exit(1);
                    repairStep = 2;
                }
            } else if (buttonNamed(window.contentView,@"Reset Accessibility") || resetCount) exit(1);
            if ([action isEqualToString:@"transition"] && !containsText(window.contentView,@"Allow keyboard and mouse")) {
                if (deadline.timeIntervalSinceNow > 0) return;
                exit(1);
            }
            if ([action isEqualToString:@"reopen"]) {
                if (!reopened && containsText(window.contentView,@"Permissions are on")) {
                    NSString *path = NSProcessInfo.processInfo.environment[@"ELEVENEX_AGENT_FIXTURE_STATE"];
                    [@"{\"screen\":false,\"input\":false}" writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:NULL];
                    reopened = YES;
                    [NSApp.delegate applicationShouldHandleReopen:NSApp hasVisibleWindows:YES];
                    return;
                }
                if (!reopened || !containsText(window.contentView,@"Allow Screen Recording")) {
                    if (deadline.timeIntervalSinceNow > 0) return;
                    exit(1);
                }
            }
            [timer invalidate];
            NSView *item = dragItem(window.contentView);
            if (item && (item.mouseDownCanMoveWindow || ![item acceptsFirstMouse:nil])) {
                fprintf(stderr,"The drag source must work from the inactive panel without moving the window\n");
                exit(1);
            }
            if ([action isEqualToString:@"missed-drop"]) {
                AgentDragItem *drag = (AgentDragItem *)item;
                if (![drag isKindOfClass:AgentDragItem.class] || !drag.dragEnded) exit(1);
                drag.dragEnded(NO, NO);
                if (containsText(window.contentView,@"Release it over the list in System Settings.")) exit(1);
                drag.dragEnded(NO, YES);
                if (!containsText(window.contentView,@"Release it over the list in System Settings.")) exit(1);
            } else if ([action isEqualToString:@"plus"] || [action isEqualToString:@"escape-alternative"]) {
                NSButton *alternative = buttonNamed(window.contentView,@"Use + instead");
                if (!alternative) exit(1);
                [alternative performClick:nil];
                if (!buttonNamed(window.contentView,@"Copy path") || !buttonNamed(window.contentView,@"Drag instead") ||
                    !containsText(window.contentView,NSBundle.mainBundle.bundlePath)) exit(1);
                if ([action isEqualToString:@"escape-alternative"]) {
                    [window cancelOperation:nil];
                    if (buttonNamed(window.contentView,@"Copy path") || !buttonNamed(window.contentView,@"Use + instead")) exit(1);
                }
            } else if ([action isEqualToString:@"viewing-only"] || [action isEqualToString:@"resume-input"]) {
                NSButton *skip = buttonNamed(window.contentView,@"Skip");
                if (!skip) exit(1);
                [skip performClick:nil];
                NSButton *done = buttonNamed(window.contentView,@"Done");
                NSButton *allow = buttonNamed(window.contentView,@"Allow keyboard and mouse");
                if (!done || ![done.keyEquivalent isEqualToString:@"\r"] || !allow ||
                    !containsText(window.contentView,@"Ready to show apps")) exit(1);
                if ([action isEqualToString:@"resume-input"]) {
                    [allow performClick:nil];
                    if (!buttonNamed(window.contentView,@"Skip") || !containsText(window.contentView,@"Allow keyboard and mouse")) exit(1);
                }
            }
            [window.contentView layoutSubtreeIfNeeded];
            if (!controlsFit(window.contentView,window.contentView)) {
                fprintf(stderr,"A visible setup control is outside the panel\n");
                exit(1);
            }
            if (compact && window.contentView.bounds.size.width > 264) exit(1);
            NSBitmapImageRep *rep = [window.contentView bitmapImageRepForCachingDisplayInRect:window.contentView.bounds];
            [window.contentView cacheDisplayInRect:window.contentView.bounds toBitmapImageRep:rep];
            NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
            BOOL saved = [png writeToFile:output atomically:YES];
            printf("Setup window rendered %gx%g\n", window.contentView.bounds.size.width, window.contentView.bounds.size.height);
            if ([action isEqualToString:@"reset-close"] || [action isEqualToString:@"reset-busy"]) printf("RESET_CHILD_PID=%d\n",resetTask.processIdentifier);
            fflush(stdout);
            [window close];
            exit(saved ? 0 : 1);
        }];
        return runAgentSetup(^{
            resetCount++;
            resetTask = [NSTask new];
            NSString *executable = @"/usr/bin/true";
            if ([action hasPrefix:@"reset-failure"] || ([action isEqualToString:@"reset-retry"] && resetCount == 1)) executable = @"/usr/bin/false";
            if ([action isEqualToString:@"reset-launch-failure"]) executable = @"/no/such/elevenex-reset-test";
            if ([action isEqualToString:@"reset-busy"] || [action isEqualToString:@"reset-close"] || [action isEqualToString:@"reset-timeout"] || [action isEqualToString:@"reset-reopen"]) {
                executable = @"/bin/sleep";
                resetTask.arguments = @[@"30"];
            }
            resetTask.executableURL = [NSURL fileURLWithPath:executable];
            return resetTask;
        });
    }
}
