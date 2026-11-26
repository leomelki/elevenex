#import "Display.h"
#import <ApplicationServices/ApplicationServices.h>
#import <unistd.h>
#import <libproc.h>

BOOL AppSessionActive(void) {
    NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
    return session && [session[(__bridge NSString *)kCGSessionOnConsoleKey] boolValue] &&
        [session[(__bridge NSString *)kCGSessionUserIDKey] unsignedIntValue] == geteuid() &&
        ![session[@"CGSSessionScreenIsLocked"] boolValue];
}

BOOL ownsAppProcess(pid_t group, pid_t owner) {
    if (group <= 1 || owner <= 1) return NO;
    struct proc_bsdinfo info = {0};
    int length = proc_pidinfo(owner, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
    return length == sizeof(info) && info.pbi_pid == (uint32_t)owner &&
        info.pbi_pgid == (uint32_t)group && info.pbi_uid == geteuid() && info.pbi_ruid == geteuid();
}

static NSDictionary *physicalKeys(void) {
    static NSDictionary *keys;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        // Physical ANSI positions are stable across layouts. Committed text uses Unicode.
        keys = @{@"KeyA":@0,@"KeyS":@1,@"KeyD":@2,@"KeyF":@3,@"KeyH":@4,@"KeyG":@5,@"KeyZ":@6,
                 @"KeyX":@7,@"KeyC":@8,@"KeyV":@9,@"KeyB":@11,@"KeyQ":@12,@"KeyW":@13,@"KeyE":@14,
                 @"KeyR":@15,@"KeyY":@16,@"KeyT":@17,@"Digit1":@18,@"Digit2":@19,@"Digit3":@20,
                 @"Digit4":@21,@"Digit6":@22,@"Digit5":@23,@"Equal":@24,@"Digit9":@25,@"Digit7":@26,
                 @"Minus":@27,@"Digit8":@28,@"Digit0":@29,@"BracketRight":@30,@"KeyO":@31,@"KeyU":@32,
                 @"BracketLeft":@33,@"KeyI":@34,@"KeyP":@35,@"Enter":@36,@"KeyL":@37,@"KeyJ":@38,
                 @"Quote":@39,@"KeyK":@40,@"Semicolon":@41,@"Backslash":@42,@"Comma":@43,@"Slash":@44,
                 @"KeyN":@45,@"KeyM":@46,@"Period":@47,@"Tab":@48,@"Space":@49,@"Backquote":@50,
                 @"Backspace":@51,@"Escape":@53,@"MetaRight":@54,@"MetaLeft":@55,@"ShiftLeft":@56,
                 @"AltLeft":@58,@"ControlLeft":@59,@"ShiftRight":@60,@"AltRight":@61,@"ControlRight":@62,
                 @"Home":@115,@"PageUp":@116,@"Delete":@117,@"End":@119,@"PageDown":@121,
                 @"ArrowLeft":@123,@"ArrowRight":@124,@"ArrowDown":@125,@"ArrowUp":@126,
                 @"F1":@122,@"F2":@120,@"F3":@99,@"F4":@118,@"F5":@96,@"F6":@97,@"F7":@98,
                 @"F8":@100,@"F9":@101,@"F10":@109,@"F11":@103,@"F12":@111};
    });
    return keys;
}

@implementation AppWindow {
    NSMutableSet<NSNumber *> *_keys;
    NSMutableSet<NSNumber *> *_buttons;
    CGPoint _lastPoint;
}
- (instancetype)init {
    if ((self = [super init])) { _keys = [NSMutableSet set]; _buttons = [NSMutableSet set]; }
    return self;
}
- (NSDictionary *)firstOwnedWindow {
    // After selection only inspect this window and those above it for a newly
    // active owned sheet or top-level window. Background windows cannot receive input.
    CGWindowListOption options = kCGWindowListExcludeDesktopElements | (self.window ?
        kCGWindowListOptionOnScreenAboveWindow | kCGWindowListOptionIncludingWindow : kCGWindowListOptionOnScreenOnly);
    NSArray *rows = CFBridgingRelease(CGWindowListCopyWindowInfo(options, self.window));
    for (NSDictionary *row in rows) {
        pid_t owner = [row[(__bridge NSString *)kCGWindowOwnerPID] intValue];
        if (!ownsAppProcess(self.group, owner) || [row[(__bridge NSString *)kCGWindowLayer] integerValue] != 0) continue;
        CGRect rect;
        if (CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)row[(__bridge NSString *)kCGWindowBounds], &rect) &&
            rect.size.width >= 16 && rect.size.height >= 16) return row;
    }
    return nil;
}
- (BOOL)currentBounds:(CGRect *)bounds {
    // Capture is tied to its selected window, independently of occluding app
    // windows or AppKit's separate title-bar control windows.
    NSArray *rows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow | kCGWindowListExcludeDesktopElements, self.window));
    for (NSDictionary *row in rows) {
        if ([row[(__bridge NSString *)kCGWindowNumber] unsignedIntValue] != self.window ||
            ![row[(__bridge NSString *)kCGWindowIsOnscreen] boolValue] ||
            !ownsAppProcess(self.group, [row[(__bridge NSString *)kCGWindowOwnerPID] intValue])) continue;
        return CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)row[(__bridge NSString *)kCGWindowBounds], bounds) &&
            CGSizeEqualToSize(bounds->size, self.windowBounds.size);
    }
    return NO;
}
- (BOOL)currentInputBounds:(CGRect *)bounds {
    NSDictionary *front = self.firstOwnedWindow;
    return front && [front[(__bridge NSString *)kCGWindowNumber] unsignedIntValue] == self.window &&
        [self currentBounds:bounds];
}
- (CGEventFlags)flags {
    CGEventFlags flags = 0;
    if ([_keys containsObject:@55] || [_keys containsObject:@54]) flags |= kCGEventFlagMaskCommand;
    if ([_keys containsObject:@56] || [_keys containsObject:@60]) flags |= kCGEventFlagMaskShift;
    if ([_keys containsObject:@58] || [_keys containsObject:@61]) flags |= kCGEventFlagMaskAlternate;
    if ([_keys containsObject:@59] || [_keys containsObject:@62]) flags |= kCGEventFlagMaskControl;
    return flags;
}
- (BOOL)post:(CGEventRef)event {
    if (!event) return NO;
    // Always direct to the currently owned process. Never inject into the system event tap.
    BOOL owned = ownsAppProcess(self.group, self.owner);
    if (owned) {
        CGEventSetFlags(event, self.flags);
        CGEventPostToPid(self.owner, event);
    }
    CFRelease(event);
    return owned;
}
- (BOOL)mouse:(CGEventType)type button:(CGMouseButton)button {
    CGEventRef event = CGEventCreateMouseEvent(NULL, type, _lastPoint, button);
    if (!event) return NO;
    CGEventSetIntegerValueField(event, kCGMouseEventWindowUnderMousePointer, self.window);
    CGEventSetIntegerValueField(event, kCGMouseEventClickState, 1);
    return [self post:event];
}
- (void)releaseInput {
    for (NSNumber *key in _keys.allObjects) {
        [_keys removeObject:key];
        [self post:CGEventCreateKeyboardEvent(NULL, key.unsignedShortValue, false)];
    }
    for (NSNumber *button in _buttons.allObjects) {
        CGMouseButton b = button.unsignedIntValue;
        [self mouse:b == kCGMouseButtonLeft ? kCGEventLeftMouseUp : b == kCGMouseButtonRight ? kCGEventRightMouseUp : kCGEventOtherMouseUp button:b];
    }
    [_buttons removeAllObjects];
}
- (BOOL)input:(NSDictionary *)input {
    NSString *kind = input[@"kind"];
    if ([kind isEqual:@"release"]) { [self releaseInput]; return YES; }
    if (!AXIsProcessTrusted() || !CGPreflightScreenCaptureAccess() || !AppSessionActive() ||
        NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != self.owner) { [self releaseInput]; return NO; }
    CGRect bounds;
    if (![self currentInputBounds:&bounds]) { [self releaseInput]; return NO; }
    if ([kind isEqual:@"key"]) {
        NSNumber *key = physicalKeys()[input[@"code"]];
        if (!key) return NO;
        BOOL down = [input[@"down"] boolValue];
        if (down) [_keys addObject:key]; else [_keys removeObject:key];
        return [self post:CGEventCreateKeyboardEvent(NULL, key.unsignedShortValue, down)];
    }
    if ([kind isEqual:@"text"]) {
        NSString *text = input[@"text"];
        if (![text isKindOfClass:NSString.class] || !text.length || text.length > 256) return NO;
        UniChar chars[256];
        [text getCharacters:chars range:NSMakeRange(0, text.length)];
        for (int down = 1; down >= 0; down--) {
            CGEventRef event = CGEventCreateKeyboardEvent(NULL, 0, down);
            if (!event) return NO;
            CGEventKeyboardSetUnicodeString(event, text.length, chars);
            if (![self post:event]) return NO;
        }
        return YES;
    }
    CGFloat x = [input[@"x"] doubleValue], y = [input[@"y"] doubleValue];
    if (x < 0 || y < 0 || x >= self.width || y >= self.height) return NO;
    // The captured picture excludes any WindowServer border. Preserve that
    // inset and follow moves without treating them as a resize.
    _lastPoint = CGPointMake(bounds.origin.x + self.bounds.origin.x - self.windowBounds.origin.x + x * self.bounds.size.width / self.width,
                             bounds.origin.y + self.bounds.origin.y - self.windowBounds.origin.y + y * self.bounds.size.height / self.height);
    if ([kind isEqual:@"wheel"]) {
        CGEventRef event = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 2, -[input[@"deltaY"] intValue], -[input[@"deltaX"] intValue]);
        if (!event) return NO;
        CGEventSetLocation(event, _lastPoint);
        return [self post:event];
    }
    if ([kind isEqual:@"move"]) {
        if ([_buttons containsObject:@0]) return [self mouse:kCGEventLeftMouseDragged button:kCGMouseButtonLeft];
        if ([_buttons containsObject:@1]) return [self mouse:kCGEventRightMouseDragged button:kCGMouseButtonRight];
        if ([_buttons containsObject:@2]) return [self mouse:kCGEventOtherMouseDragged button:kCGMouseButtonCenter];
        return [self mouse:kCGEventMouseMoved button:kCGMouseButtonLeft];
    }
    BOOL down = [kind isEqual:@"down"];
    if (!down && ![kind isEqual:@"up"]) return NO;
    NSInteger dom = [input[@"button"] integerValue];
    if (dom < 0 || dom > 2) return NO;
    CGMouseButton b = dom == 0 ? kCGMouseButtonLeft : dom == 1 ? kCGMouseButtonCenter : kCGMouseButtonRight;
    if (down) [_buttons addObject:@(b)]; else [_buttons removeObject:@(b)];
    CGEventType type = b == kCGMouseButtonLeft ? (down ? kCGEventLeftMouseDown : kCGEventLeftMouseUp) :
        b == kCGMouseButtonRight ? (down ? kCGEventRightMouseDown : kCGEventRightMouseUp) : (down ? kCGEventOtherMouseDown : kCGEventOtherMouseUp);
    return [self mouse:type button:b];
}
@end
