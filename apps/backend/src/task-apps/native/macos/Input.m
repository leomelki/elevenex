#import "Display.h"
#import <ApplicationServices/ApplicationServices.h>
#include <math.h>
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

static BOOL windowRect(NSDictionary *row, CGRect *bounds) {
    return CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)row[(__bridge NSString *)kCGWindowBounds], bounds);
}

BOOL appWindowShareable(NSDictionary *row) {
    NSInteger sharing = [row[(__bridge NSString *)kCGWindowSharingState] integerValue];
    return sharing == kCGWindowSharingReadOnly || sharing == kCGWindowSharingReadWrite;
}

static BOOL sharingTitleBarSurface(CGRect window, CGRect surface) {
    // macOS 26 places a 66×20 sharing control six points inside the
    // captured window's upper-left corner. WindowServer can report it as
    // read-only to a capture-authorized process and redact that value to others.
    // Restrict the exception to the observed geometry within the same owner.
    return CGRectContainsRect(window, surface) &&
        fabs(surface.origin.x - window.origin.x - 6) <= 1 && fabs(surface.origin.y - window.origin.y - 6) <= 1 &&
        fabs(surface.size.width - 66) <= 1 && fabs(surface.size.height - 20) <= 1;
}

static BOOL readFocusedWindowBounds(pid_t owner, CGRect *bounds) {
    AXUIElementRef application = AXUIElementCreateApplication(owner);
    if (!application) return NO;
    CFTypeRef rawWindow = NULL;
    AXError result = AXUIElementSetMessagingTimeout(application, 0.05f);
    if (result == kAXErrorSuccess) result = AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute, &rawWindow);
    CFRelease(application);
    id windowValue = CFBridgingRelease(rawWindow);
    if (result != kAXErrorSuccess || !windowValue ||
        CFGetTypeID((__bridge CFTypeRef)windowValue) != AXUIElementGetTypeID()) return NO;

    AXUIElementRef window = (__bridge AXUIElementRef)windowValue;
    NSArray *attributes = @[(__bridge NSString *)kAXPositionAttribute, (__bridge NSString *)kAXSizeAttribute];
    CFArrayRef rawValues = NULL;
    result = AXUIElementSetMessagingTimeout(window, 0.05f);
    if (result == kAXErrorSuccess) result = AXUIElementCopyMultipleAttributeValues(window,
        (__bridge CFArrayRef)attributes, kAXCopyMultipleAttributeOptionStopOnError, &rawValues);
    NSArray *values = CFBridgingRelease(rawValues);
    return result == kAXErrorSuccess && values.count == 2 &&
        CFGetTypeID((__bridge CFTypeRef)values[0]) == AXValueGetTypeID() &&
        CFGetTypeID((__bridge CFTypeRef)values[1]) == AXValueGetTypeID() &&
        AXValueGetValue((__bridge AXValueRef)values[0], kAXValueCGPointType, &bounds->origin) &&
        AXValueGetValue((__bridge AXValueRef)values[1], kAXValueCGSizeType, &bounds->size);
}

static CGMouseButton appMouseButton(NSInteger button) {
    return button == 0 ? kCGMouseButtonLeft : button == 1 ? kCGMouseButtonCenter : kCGMouseButtonRight;
}

@implementation AppWindow {
    NSMutableSet<NSNumber *> *_keys;
    NSMutableSet<NSNumber *> *_buttons;
    NSPoint _lastWindowPoint;
}
- (instancetype)init {
    if ((self = [super init])) { _keys = [NSMutableSet set]; _buttons = [NSMutableSet set]; }
    return self;
}
- (NSDictionary *)firstOwnedWindow {
    CGWindowListOption options = kCGWindowListExcludeDesktopElements | kCGWindowListOptionOnScreenOnly;
    NSArray *rows = CFBridgingRelease(CGWindowListCopyWindowInfo(options, kCGNullWindowID));
    for (NSDictionary *row in rows) {
        pid_t owner = [row[(__bridge NSString *)kCGWindowOwnerPID] intValue];
        if ([row[(__bridge NSString *)kCGWindowLayer] integerValue] != 0 || !ownsAppProcess(self.group, owner)) continue;
        CGRect rect;
        if (windowRect(row, &rect) && rect.size.width >= 16 && rect.size.height >= 16) return row;
    }
    return nil;
}
- (NSDictionary *)focusedOwnedWindow {
    pid_t owner = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    CGRect focus;
    if (!ownsAppProcess(self.group, owner) || !readFocusedWindowBounds(owner, &focus)) return nil;
    if (focus.size.width < 16 || focus.size.height < 16) return nil;
    CGWindowListOption options = kCGWindowListExcludeDesktopElements | kCGWindowListOptionOnScreenOnly;
    NSArray *rows = CFBridgingRelease(CGWindowListCopyWindowInfo(options, kCGNullWindowID));
    NSDictionary *match = nil;
    for (NSDictionary *row in rows) {
        if ([row[(__bridge NSString *)kCGWindowOwnerPID] intValue] != owner ||
            [row[(__bridge NSString *)kCGWindowLayer] integerValue] != 0) continue;
        CGRect bounds;
        if (!windowRect(row, &bounds) || !CGRectEqualToRect(bounds, focus)) continue;
        if (match) return nil;
        match = row;
    }
    return appWindowShareable(match) ? match : nil;
}
- (BOOL)validateWindow:(NSDictionary *)row bounds:(CGRect *)bounds {
    return [row[(__bridge NSString *)kCGWindowNumber] unsignedIntValue] == self.window &&
        [row[(__bridge NSString *)kCGWindowIsOnscreen] boolValue] &&
        [row[(__bridge NSString *)kCGWindowOwnerPID] intValue] == self.owner &&
        appWindowShareable(row) &&
        ownsAppProcess(self.group, self.owner) && windowRect(row, bounds) &&
        CGSizeEqualToSize(bounds->size, self.windowBounds.size);
}
- (BOOL)currentBounds:(CGRect *)bounds {
    // Capture is tied to its selected window, independently of occluding app
    // windows or AppKit's separate title-bar control windows.
    NSArray *rows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow | kCGWindowListExcludeDesktopElements, self.window));
    return [self validateWindow:rows.firstObject bounds:bounds];
}
- (AppInputResult)inputWindowBounds:(CGRect *)bounds excluding:(NSMutableArray<NSValue *> *)occlusions
    verifyFocus:(BOOL)verifyFocus {
    // Read the target and its overlays from the same WindowServer snapshot so
    // a move cannot leave them measured at different screen positions.
    CGWindowListOption options = kCGWindowListOptionOnScreenAboveWindow | kCGWindowListOptionIncludingWindow |
        kCGWindowListExcludeDesktopElements;
    NSArray<NSDictionary *> *rows = CFBridgingRelease(CGWindowListCopyWindowInfo(options, self.window));
    if (!rows.count) return AppInputUnavailable;
    NSUInteger targetIndex = [rows indexOfObjectPassingTest:^BOOL(NSDictionary *row, NSUInteger index, BOOL *stop) {
        return [row[(__bridge NSString *)kCGWindowNumber] unsignedIntValue] == self.window;
    }];
    if (targetIndex == NSNotFound || ![self validateWindow:rows[targetIndex] bounds:bounds]) return AppInputUnavailable;

    // Unfamiliar shallow title-bar overlaps require matching Accessibility
    // focus. Dialogs over the content block input.
    CGFloat titleBarDepth = MIN(48.0, bounds->size.height / 3);
    CGRect titleBar = CGRectMake(bounds->origin.x, bounds->origin.y, bounds->size.width, titleBarDepth);
    BOOL ambiguousFocus = NO;
    for (NSUInteger index = 0; index < targetIndex; index++) {
        NSDictionary *row = rows[index];
        if ([row[(__bridge NSString *)kCGWindowLayer] integerValue] != 0) continue;
        pid_t owner = [row[(__bridge NSString *)kCGWindowOwnerPID] intValue];
        if (owner != self.owner && !ownsAppProcess(self.group, owner)) continue;
        CGRect surface;
        if (!windowRect(row, &surface)) return AppInputWindowBlocked;
        if (surface.size.width < 16 || surface.size.height < 16) continue;
        if (owner != self.owner) return AppInputWindowBlocked;
        CGRect overlap = CGRectIntersection(*bounds, surface);
        if (CGRectIsEmpty(overlap)) {
            ambiguousFocus = YES;
            continue;
        }
        if (!sharingTitleBarSurface(*bounds, surface)) {
            if (surface.size.height > titleBarDepth || !CGRectContainsRect(titleBar, overlap)) return AppInputWindowBlocked;
            ambiguousFocus = YES;
        }
        [occlusions addObject:[NSValue valueWithRect:NSRectFromCGRect(overlap)]];
    }
    CGRect focus;
    if (verifyFocus && ambiguousFocus && (!readFocusedWindowBounds(self.owner, &focus) || !CGRectEqualToRect(focus, *bounds)))
        return AppInputWindowBlocked;
    return AppInputAccepted;
}
- (BOOL)isFrontmost {
    return self.owner > 1 && NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == self.owner;
}
- (BOOL)requestActivation {
    if (!ownsAppProcess(self.group, self.owner)) return NO;
    AXUIElementRef application = AXUIElementCreateApplication(self.owner);
    if (!application) return NO;
    // AppKit activation can be ignored when the helper is in the background.
    // Use the existing Accessibility grant and bound the native call in case
    // the owned app is unresponsive.
    BOOL requested = AXUIElementSetMessagingTimeout(application, 0.15f) == kAXErrorSuccess &&
        AXUIElementSetAttributeValue(application, kAXFrontmostAttribute, kCFBooleanTrue) == kAXErrorSuccess;
    CFRelease(application);
    return requested;
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
- (CGEventRef)windowMouseEvent:(NSEventType)type {
    // A screen-position CGEvent can reach the app with window number zero.
    // Start with an AppKit event to carry the verified window through Quartz.
    // The target window belongs to another process, so AppKit flips the
    // factory point against the primary screen. Compensate so the transmitted
    // point is window-relative. CGEventSetLocation would discard that point.
    NSScreen *primary = NSScreen.screens.firstObject;
    if (!primary) return NULL;
    NSPoint location = NSMakePoint(_lastWindowPoint.x, primary.frame.size.height - _lastWindowPoint.y);
    BOOL released = type == NSEventTypeMouseMoved || type == NSEventTypeLeftMouseUp ||
        type == NSEventTypeRightMouseUp || type == NSEventTypeOtherMouseUp;
    NSEvent *mouse = [NSEvent mouseEventWithType:type location:location
        modifierFlags:(NSEventModifierFlags)self.flags timestamp:NSProcessInfo.processInfo.systemUptime
        windowNumber:self.window context:nil eventNumber:0 clickCount:1 pressure:released ? 0 : 1];
    CGEventRef event = mouse.CGEvent;
    if (!event) return NULL;
    CFRetain(event);
    CGEventSetIntegerValueField(event, kCGMouseEventWindowUnderMousePointer, self.window);
    CGEventSetIntegerValueField(event, kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent, self.window);
    return event;
}
- (BOOL)mouse:(NSEventType)type button:(CGMouseButton)button {
    CGEventRef event = [self windowMouseEvent:type];
    if (!event) return NO;
    CGEventSetIntegerValueField(event, kCGMouseEventButtonNumber, button);
    return [self post:event];
}
- (BOOL)scroll:(NSDictionary *)input {
    CGEventRef wheel = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 2,
        -[input[@"deltaY"] intValue], -[input[@"deltaX"] intValue]);
    if (!wheel) return NO;
    CGEventRef event = [self windowMouseEvent:NSEventTypeMouseMoved];
    if (!event) { CFRelease(wheel); return NO; }
    // AppKit's mouse factory has no scroll constructor. Keep its window
    // routing and copy Quartz's pixel, line and fixed-point scroll distances.
    CGEventSetType(event, kCGEventScrollWheel);
    const CGEventField fields[] = {
        kCGScrollWheelEventDeltaAxis1, kCGScrollWheelEventDeltaAxis2,
        kCGScrollWheelEventFixedPtDeltaAxis1, kCGScrollWheelEventFixedPtDeltaAxis2,
        kCGScrollWheelEventPointDeltaAxis1, kCGScrollWheelEventPointDeltaAxis2,
        kCGScrollWheelEventIsContinuous,
    };
    for (size_t i = 0; i < sizeof(fields) / sizeof(fields[0]); i++)
        CGEventSetDoubleValueField(event, fields[i], CGEventGetDoubleValueField(wheel, fields[i]));
    CFRelease(wheel);
    return [self post:event];
}
- (BOOL)hasHeldInput {
    return _keys.count || _buttons.count;
}
- (void)releaseInput {
    for (NSNumber *key in _keys.allObjects) {
        [_keys removeObject:key];
        [self post:CGEventCreateKeyboardEvent(NULL, key.unsignedShortValue, false)];
    }
    for (NSNumber *button in _buttons.allObjects) {
        CGMouseButton b = button.unsignedIntValue;
        [self mouse:b == kCGMouseButtonLeft ? NSEventTypeLeftMouseUp : b == kCGMouseButtonRight ? NSEventTypeRightMouseUp : NSEventTypeOtherMouseUp button:b];
    }
    [_buttons removeAllObjects];
}
- (AppInputResult)input:(NSDictionary *)input {
    NSString *kind = input[@"kind"];
    if ([kind isEqual:@"release"]) { [self releaseInput]; return AppInputAccepted; }
    if (!AXIsProcessTrusted()) { [self releaseInput]; return AppInputNeedsAccessibility; }
    if (!CGPreflightScreenCaptureAccess() || !AppSessionActive()) { [self releaseInput]; return AppInputUnavailable; }
    NSInteger button = [input[@"button"] integerValue];
    // A focus-only click or a button released after focus loss leaves no
    // mouse-down event for this mouse-up to match.
    if ([kind isEqual:@"up"] && button >= 0 && button <= 2 && ![_buttons containsObject:@(appMouseButton(button))])
        return AppInputAccepted;
    CGRect bounds;
    NSMutableArray<NSValue *> *occlusions = [NSMutableArray array];
    BOOL wasFrontmost = self.frontmost;
    AppInputResult target = [self inputWindowBounds:&bounds excluding:occlusions verifyFocus:wasFrontmost];
    if (target != AppInputAccepted) { [self releaseInput]; return target; }
    if (!wasFrontmost || !self.frontmost) {
        [self releaseInput];
        pid_t foreground = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
        if (foreground != self.owner && ownsAppProcess(self.group, foreground)) return AppInputWindowBlocked;
        if (![kind isEqual:@"down"] || button != 0) return AppInputNeedsForeground;
        if (![self inputPoint:NULL forInput:input bounds:bounds chrome:occlusions]) return AppInputUnavailable;
        // Activation can take until the next run-loop turn. Use this click
        // for focus only and verify foreground again before posting input.
        return [self requestActivation] ? AppInputActivationRequested : AppInputNeedsForeground;
    }
    if ([self postInput:input bounds:bounds chrome:occlusions]) return AppInputAccepted;
    [self releaseInput];
    return AppInputUnavailable;
}
- (BOOL)inputPoint:(NSPoint *)windowPoint forInput:(NSDictionary *)input bounds:(CGRect)bounds chrome:(NSArray<NSValue *> *)chrome {
    CGFloat x = [input[@"x"] doubleValue], y = [input[@"y"] doubleValue];
    if (x < 0 || y < 0 || x >= self.width || y >= self.height) return NO;
    // The captured picture excludes any WindowServer border. Preserve that
    // inset and follow moves without treating them as a resize.
    CGPoint point = CGPointMake(bounds.origin.x + self.bounds.origin.x - self.windowBounds.origin.x + x * self.bounds.size.width / self.width,
                             bounds.origin.y + self.bounds.origin.y - self.windowBounds.origin.y + y * self.bounds.size.height / self.height);
    if (!CGRectContainsPoint(bounds, point)) return NO;
    for (NSValue *value in chrome) if (CGRectContainsPoint(NSRectToCGRect(value.rectValue), point)) return NO;
    if (windowPoint) *windowPoint = NSMakePoint(point.x - CGRectGetMinX(bounds), point.y - CGRectGetMinY(bounds));
    return YES;
}
- (BOOL)postInput:(NSDictionary *)input bounds:(CGRect)bounds chrome:(NSArray<NSValue *> *)chrome {
    NSString *kind = input[@"kind"];
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
    if (![self inputPoint:&_lastWindowPoint forInput:input bounds:bounds chrome:chrome]) return NO;
    if ([kind isEqual:@"wheel"]) return [self scroll:input];
    if ([kind isEqual:@"move"]) {
        if ([_buttons containsObject:@0]) return [self mouse:NSEventTypeLeftMouseDragged button:kCGMouseButtonLeft];
        if ([_buttons containsObject:@1]) return [self mouse:NSEventTypeRightMouseDragged button:kCGMouseButtonRight];
        if ([_buttons containsObject:@2]) return [self mouse:NSEventTypeOtherMouseDragged button:kCGMouseButtonCenter];
        return [self mouse:NSEventTypeMouseMoved button:kCGMouseButtonLeft];
    }
    BOOL down = [kind isEqual:@"down"];
    if (!down && ![kind isEqual:@"up"]) return NO;
    NSInteger dom = [input[@"button"] integerValue];
    if (dom < 0 || dom > 2) return NO;
    CGMouseButton b = appMouseButton(dom);
    if (down) [_buttons addObject:@(b)]; else [_buttons removeObject:@(b)];
    NSEventType type = b == kCGMouseButtonLeft ? (down ? NSEventTypeLeftMouseDown : NSEventTypeLeftMouseUp) :
        b == kCGMouseButtonRight ? (down ? NSEventTypeRightMouseDown : NSEventTypeRightMouseUp) : (down ? NSEventTypeOtherMouseDown : NSEventTypeOtherMouseUp);
    return [self mouse:type button:b];
}
@end
