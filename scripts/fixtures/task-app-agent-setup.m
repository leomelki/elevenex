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
    if ([view.accessibilityLabel isEqualToString:@"Elevenex Agent"]) return view;
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
        [NSTimer scheduledTimerWithTimeInterval:1 repeats:YES block:^(NSTimer *timer) {
            NSWindow *window = NSApp.windows.firstObject;
            if (!window || !window.visible) { [NSApp terminate:nil]; exit(1); }
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
            NSBitmapImageRep *rep = [window.contentView bitmapImageRepForCachingDisplayInRect:window.contentView.bounds];
            [window.contentView cacheDisplayInRect:window.contentView.bounds toBitmapImageRep:rep];
            NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
            BOOL saved = [png writeToFile:output atomically:YES];
            printf("Setup window rendered %gx%g\n", window.contentView.bounds.size.width, window.contentView.bounds.size.height);
            [window close];
            exit(saved ? 0 : 1);
        }];
        return runAgentSetup();
    }
}
