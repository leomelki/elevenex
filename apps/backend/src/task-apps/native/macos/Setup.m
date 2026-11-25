#import "Setup.h"
#import "SetupViews.h"
#import <ApplicationServices/ApplicationServices.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

int printAgentPermissions(void) {
    BOOL screen = CGPreflightScreenCaptureAccess();
    if (screen) {
        dispatch_semaphore_t ready = dispatch_semaphore_create(0);
        __block BOOL allowed = NO;
        [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:YES completionHandler:^(SCShareableContent *content, NSError *error) {
            allowed = content != nil && error == nil;
            dispatch_semaphore_signal(ready);
        }];
        if (dispatch_semaphore_wait(ready, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC))) screen = NO;
        else screen = allowed;
    }
    printf("{\"screen\":%s,\"input\":%s}\n", screen ? "true" : "false", AXIsProcessTrusted() ? "true" : "false");
    return 0;
}

@interface AgentPanel : NSPanel
@property(nonatomic, copy) void (^dismissAlternative)(void);
@end
@implementation AgentPanel
- (BOOL)canBecomeKeyWindow { return YES; }
- (void)cancelOperation:(id)sender { if (self.dismissAlternative) self.dismissAlternative(); }
- (BOOL)performKeyEquivalent:(NSEvent *)event {
    if ((event.modifierFlags & NSEventModifierFlagCommand) && [event.charactersIgnoringModifiers isEqualToString:@"w"]) {
        [self performClose:nil]; return YES;
    }
    return [super performKeyEquivalent:event];
}
@end

@interface AgentSetup : NSObject <NSApplicationDelegate, NSWindowDelegate>
@property(nonatomic, strong) AgentSetupStyle *style;
@property(nonatomic, strong) AgentPanel *panel;
@property(nonatomic, strong) NSStackView *stack;
@property(nonatomic, strong) AgentSetupProgress *progress;
@property(nonatomic, strong) NSImageView *completeMark;
@property(nonatomic, strong) NSTextField *titleLabel;
@property(nonatomic, strong) NSTextField *lede;
@property(nonatomic, strong) AgentDragItem *dragItem;
@property(nonatomic, strong) NSStackView *dragSteps;
@property(nonatomic, strong) NSStackView *manualSteps;
@property(nonatomic, strong) NSStackView *pathWell;
@property(nonatomic, strong) NSTextField *pathLabel;
@property(nonatomic, strong) NSButton *pathCopyButton;
@property(nonatomic, strong) NSStackView *summary;
@property(nonatomic, strong) NSTextField *inputSummary;
@property(nonatomic, strong) NSStackView *completionText;
@property(nonatomic, strong) NSStackView *statusGroup;
@property(nonatomic, strong) NSProgressIndicator *spinner;
@property(nonatomic, strong) NSTextField *status;
@property(nonatomic, strong) NSButton *settings;
@property(nonatomic, strong) NSStackView *footer;
@property(nonatomic, strong) NSButton *cancel;
@property(nonatomic, strong) NSButton *alternative;
@property(nonatomic, strong) NSButton *allowInput;
@property(nonatomic, strong) NSButton *done;
@property(nonatomic, strong) NSTimer *timer;
@property(nonatomic, strong) NSTask *check;
@property(nonatomic, strong) NSDate *started;
@property(nonatomic, strong) NSDate *hintUntil;
@property(nonatomic, strong) NSDate *missedUntil;
@property(nonatomic) BOOL screen;
@property(nonatomic) BOOL input;
@property(nonatomic) BOOL skippedInput;
@property(nonatomic) BOOL manual;
@property(nonatomic) BOOL settingsVisible;
@property(nonatomic) BOOL positioning;
@property(nonatomic) BOOL positioned;
@property(nonatomic) BOOL userMoved;
@property(nonatomic) BOOL hasPermissionResult;
@property(nonatomic) BOOL checkFailed;
@property(nonatomic) BOOL paused;
@end

@implementation AgentSetup
- (NSStackView *)column:(NSArray<NSView *> *)views spacing:(CGFloat)spacing {
    NSStackView *stack = [NSStackView stackViewWithViews:views];
    stack.orientation = NSUserInterfaceLayoutOrientationVertical;
    stack.alignment = NSLayoutAttributeLeading;
    stack.spacing = spacing;
    stack.detachesHiddenViews = YES;
    stack.translatesAutoresizingMaskIntoConstraints = NO;
    return stack;
}
- (NSStackView *)numberedSteps:(NSArray<NSString *> *)steps {
    NSMutableArray *rows = [NSMutableArray array];
    for (NSUInteger index=0; index<steps.count; index++) {
        NSTextField *number = [self.style label:[NSString stringWithFormat:@"%lu", (unsigned long)index+1] size:12 weight:NSFontWeightMedium];
        number.textColor = [self.style color:@"ink-muted"];
        [number.widthAnchor constraintEqualToConstant:16].active = YES;
        NSTextField *text = [self.style label:steps[index] size:13 weight:NSFontWeightRegular];
        NSStackView *row = [NSStackView stackViewWithViews:@[number,text]];
        row.alignment = NSLayoutAttributeFirstBaseline;
        row.spacing = 8;
        [rows addObject:row];
    }
    NSStackView *group = [self column:rows spacing:8];
    for (NSView *row in rows) [row.widthAnchor constraintEqualToAnchor:group.widthAnchor].active = YES;
    return group;
}
- (NSView *)summaryRow:(NSString *)name status:(NSTextField *)status {
    NSTextField *label = [self.style label:name size:13 weight:NSFontWeightRegular];
    NSView *spacer = [NSView new];
    [spacer setContentHuggingPriority:1 forOrientation:NSLayoutConstraintOrientationHorizontal];
    NSStackView *row = [NSStackView stackViewWithViews:@[label,spacer,status]];
    row.spacing = 8;
    row.edgeInsets = NSEdgeInsetsMake(8,12,8,12);
    [row.heightAnchor constraintGreaterThanOrEqualToConstant:36].active = YES;
    return row;
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    self.style = [AgentSetupStyle new];
    self.started = NSDate.date;
    self.panel = [[AgentPanel alloc] initWithContentRect:NSMakeRect(0,0,344,430)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskNonactivatingPanel
        backing:NSBackingStoreBuffered defer:NO];
    self.panel.title = @"Elevenex Agent Setup";
    self.panel.titleVisibility = NSWindowTitleHidden;
    self.panel.titlebarAppearsTransparent = YES;
    self.panel.delegate = self;
    self.panel.floatingPanel = YES;
    self.panel.hidesOnDeactivate = NO;
    self.panel.level = NSFloatingWindowLevel;
    self.panel.collectionBehavior = NSWindowCollectionBehaviorMoveToActiveSpace | NSWindowCollectionBehaviorFullScreenAuxiliary;
    self.panel.movableByWindowBackground = YES;
    self.panel.releasedWhenClosed = NO;
    self.panel.backgroundColor = [self.style color:@"surface"];
    NSVisualEffectView *background = [[NSVisualEffectView alloc] initWithFrame:self.panel.contentView.bounds];
    background.material = NSVisualEffectMaterialPopover;
    background.blendingMode = NSVisualEffectBlendingModeBehindWindow;
    background.state = NSVisualEffectStateActive;
    self.panel.contentView = background;

    self.progress = [AgentSetupProgress new];
    self.progress.translatesAutoresizingMaskIntoConstraints = NO;
    self.progress.style = self.style;
    self.progress.accessibilityElement = YES;
    self.progress.accessibilityRole = NSAccessibilityStaticTextRole;
    [self.progress.heightAnchor constraintEqualToConstant:14].active = YES;
    self.completeMark = [NSImageView new];
    self.completeMark.translatesAutoresizingMaskIntoConstraints = NO;
    self.completeMark.image = [[NSImage imageWithSystemSymbolName:@"checkmark.circle" accessibilityDescription:nil]
        imageWithSymbolConfiguration:[NSImageSymbolConfiguration configurationWithPointSize:26 weight:NSFontWeightRegular]];
    self.completeMark.imageAlignment = NSImageAlignLeft;
    self.completeMark.contentTintColor = [self.style color:@"accent"];
    self.completeMark.accessibilityElement = NO;
    [self.completeMark.heightAnchor constraintEqualToConstant:30].active = YES;
    self.titleLabel = [self.style label:@"" size:17 weight:NSFontWeightSemibold];
    self.lede = [self.style label:@"" size:13 weight:NSFontWeightRegular];
    self.lede.textColor = [self.style color:@"ink-muted"];
    NSStackView *heading = [self column:@[self.completeMark,self.titleLabel,self.lede] spacing:6];

    self.dragItem = [AgentDragItem new];
    self.dragItem.translatesAutoresizingMaskIntoConstraints = NO;
    self.dragItem.style = self.style;
    self.dragItem.appURL = NSBundle.mainBundle.bundleURL;
    self.dragItem.icon = [NSWorkspace.sharedWorkspace iconForFile:self.dragItem.appURL.path];
    self.dragItem.accessibilityElement = YES;
    self.dragItem.accessibilityRole = NSAccessibilityButtonRole;
    self.dragItem.accessibilityLabel = @"Elevenex Agent";
    self.dragItem.accessibilityHelp = @"Drag into the permission list in System Settings. Press Return to use the keyboard alternative and copy the app path.";
    [self.dragItem.heightAnchor constraintEqualToConstant:128].active = YES;
    __weak AgentSetup *weakSelf = self;
    self.dragItem.useAlternative = ^{
        AgentSetup *owner = weakSelf;
        if (!owner) return;
        owner.manual = YES;
        [owner render];
        [owner copyPath:nil];
        [owner.panel makeFirstResponder:owner.pathCopyButton];
    };
    self.dragItem.dragEnded = ^(BOOL accepted, BOOL missed) {
        AgentSetup *owner = weakSelf;
        if (accepted) owner.hintUntil = [NSDate dateWithTimeIntervalSinceNow:8];
        owner.missedUntil = missed ? [NSDate dateWithTimeIntervalSinceNow:6] : nil;
        [owner updateStatus];
        [owner refresh];
    };
    self.panel.dismissAlternative = ^{
        AgentSetup *owner = weakSelf;
        if (owner.manual) [owner toggleAlternative:nil];
    };
    self.dragSteps = [self numberedSteps:@[@"", @"Turn on its switch."]];
    self.manualSteps = [self numberedSteps:@[@"", @"Press ⇧⌘G, paste, and press Return.", @"Click Open, then turn on Elevenex Agent."]];
    self.pathLabel = [self.style label:NSBundle.mainBundle.bundlePath size:11.5 weight:NSFontWeightRegular];
    self.pathLabel.font = [NSFont monospacedSystemFontOfSize:11.5 weight:NSFontWeightRegular];
    self.pathLabel.usesSingleLineMode = YES;
    self.pathLabel.lineBreakMode = NSLineBreakByTruncatingMiddle;
    self.pathLabel.toolTip = NSBundle.mainBundle.bundlePath;
    self.pathCopyButton = [self.style button:@"Copy path" target:self action:@selector(copyPath:) primary:NO];
    self.pathWell = [[AgentSetupWell alloc] initWithViews:@[self.pathLabel,self.pathCopyButton] style:self.style spacing:8];
    self.pathWell.edgeInsets = NSEdgeInsetsMake(12,12,12,12);
    [self.pathLabel.widthAnchor constraintEqualToAnchor:self.pathWell.widthAnchor constant:-24].active = YES;

    NSTextField *screenStatus = [self.style label:@"✓ On" size:13 weight:NSFontWeightMedium];
    screenStatus.textColor = [self.style color:@"accent"];
    self.inputSummary = [self.style label:@"" size:13 weight:NSFontWeightMedium];
    self.summary = [[AgentSetupWell alloc] initWithViews:@[[self summaryRow:@"Screen Recording" status:screenStatus], [self summaryRow:@"Keyboard and mouse" status:self.inputSummary]] style:self.style spacing:0];
    for (NSView *row in self.summary.arrangedSubviews) [row.widthAnchor constraintEqualToAnchor:self.summary.widthAnchor].active = YES;
    NSTextField *instruction = [self.style label:@"In Elevenex, choose Check and launch." size:13 weight:NSFontWeightMedium];
    self.completionText = [self column:@[instruction] spacing:6];
    for (NSView *view in self.completionText.arrangedSubviews) [view.widthAnchor constraintEqualToAnchor:self.completionText.widthAnchor].active = YES;

    self.spinner = [NSProgressIndicator new];
    self.spinner.translatesAutoresizingMaskIntoConstraints = NO;
    self.spinner.style = NSProgressIndicatorStyleSpinning;
    self.spinner.controlSize = NSControlSizeSmall;
    self.spinner.displayedWhenStopped = YES;
    [self.spinner.widthAnchor constraintEqualToConstant:16].active = YES;
    [self.spinner.heightAnchor constraintEqualToConstant:16].active = YES;
    self.status = [self.style label:@"Checking permissions…" size:12 weight:NSFontWeightRegular];
    self.status.textColor = [self.style color:@"ink-muted"];
    self.settings = [self.style button:@"Open it" target:self action:@selector(openSettings:) primary:NO];
    self.settings.bordered = NO;
    self.settings.contentTintColor = [self.style color:@"accent"];
    NSStackView *statusRow = [NSStackView stackViewWithViews:@[self.spinner,self.status]];
    statusRow.alignment = NSLayoutAttributeCenterY;
    statusRow.spacing = 8;
    self.statusGroup = [self column:@[statusRow,self.settings] spacing:2];
    [statusRow.widthAnchor constraintEqualToAnchor:self.statusGroup.widthAnchor].active = YES;

    self.cancel = [self.style button:@"Not now" target:self action:@selector(cancel:) primary:NO];
    self.cancel.bordered = NO;
    self.cancel.contentTintColor = [self.style color:@"ink-muted"];
    self.alternative = [self.style button:@"Use + instead" target:self action:@selector(toggleAlternative:) primary:NO];
    self.allowInput = [self.style button:@"Allow keyboard and mouse" target:self action:@selector(allowKeyboard:) primary:NO];
    self.allowInput.bordered = NO;
    self.allowInput.contentTintColor = [self.style color:@"ink-muted"];
    self.done = [self.style button:@"Done" target:self action:@selector(close:) primary:YES];
    NSView *spacer = [NSView new];
    [spacer setContentHuggingPriority:1 forOrientation:NSLayoutConstraintOrientationHorizontal];
    self.footer = [NSStackView stackViewWithViews:@[self.cancel,self.allowInput,spacer,self.alternative,self.done]];
    self.footer.spacing = 8;
    self.footer.detachesHiddenViews = YES;
    NSBox *divider = [NSBox new];
    divider.boxType = NSBoxSeparator;
    self.stack = [self column:@[self.progress,heading,self.dragItem,self.dragSteps,self.manualSteps,self.pathWell,self.summary,self.completionText,self.statusGroup,divider,self.footer] spacing:12];
    [background addSubview:self.stack];
    for (NSView *view in self.stack.arrangedSubviews) [view.widthAnchor constraintEqualToAnchor:self.stack.widthAnchor].active = YES;
    for (NSView *view in heading.arrangedSubviews) [view.widthAnchor constraintEqualToAnchor:heading.widthAnchor].active = YES;
    [NSLayoutConstraint activateConstraints:@[
        [self.stack.leadingAnchor constraintEqualToAnchor:background.leadingAnchor constant:24],
        [self.stack.trailingAnchor constraintEqualToAnchor:background.trailingAnchor constant:-24],
        [self.stack.topAnchor constraintEqualToAnchor:background.topAnchor constant:12],
    ]];
    self.dragItem.nextKeyView = self.alternative;
    self.alternative.nextKeyView = self.cancel;
    self.cancel.nextKeyView = self.dragItem;
    self.pathCopyButton.nextKeyView = self.alternative;
    self.done.nextKeyView = self.allowInput;
    self.allowInput.nextKeyView = self.done;
    [self render];
    [self.panel makeKeyAndOrderFront:nil];
    [self.panel makeFirstResponder:nil];
    [NSApp activateIgnoringOtherApps:YES];
    [self startChecks];
}
- (BOOL)complete { return self.hasPermissionResult && self.screen && (self.input || self.skippedInput); }
- (void)setStep:(NSStackView *)group first:(NSString *)first {
    NSStackView *row = (NSStackView *)group.arrangedSubviews.firstObject;
    NSTextField *label = (NSTextField *)row.arrangedSubviews.lastObject;
    label.stringValue = first;
}
- (void)render {
    BOOL complete = [self complete];
    BOOL audioPane = NSProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 15;
    self.progress.hidden = complete;
    self.progress.secondStep = self.screen;
    self.progress.accessibilityLabel = self.screen ? @"Step 2 of 2, Accessibility, optional" : @"Step 1 of 2, Screen Recording";
    [self.progress setNeedsDisplay:YES];
    self.completeMark.hidden = !complete;
    self.titleLabel.stringValue = complete ? (self.input ? @"Permissions are on" : @"Ready to show apps") : (self.screen ? @"Allow keyboard and mouse" : @"Allow Screen Recording");
    self.lede.stringValue = self.screen ? @"Lets you type and click in shared apps." : @"Elevenex uses it to show this Mac’s apps.";
    self.lede.hidden = complete;
    self.dragItem.hidden = complete || self.manual;
    self.dragSteps.hidden = complete || self.manual;
    [self setStep:self.dragSteps first:self.screen ? @"Drop it in the Accessibility list." : audioPane
        ? @"Drop it in the top list of Screen & System Audio Recording." : @"Drop it in the Screen Recording list."];
    self.manualSteps.hidden = complete || !self.manual;
    [self setStep:self.manualSteps first:(!self.screen && audioPane) ? @"Click + under the top list." : @"Click + under the permission list."];
    self.pathWell.hidden = complete || !self.manual;
    self.summary.hidden = !complete;
    self.inputSummary.stringValue = self.input ? @"✓ On" : @"○ Off · viewing only";
    self.inputSummary.textColor = [self.style color:self.input ? @"accent" : @"ink-muted"];
    self.completionText.hidden = !complete;
    self.statusGroup.hidden = complete;
    self.cancel.hidden = complete;
    self.cancel.title = self.screen ? @"Skip" : @"Not now";
    self.alternative.hidden = complete;
    self.alternative.title = self.manual ? @"Drag instead" : @"Use + instead";
    self.allowInput.hidden = !complete || self.input;
    self.done.hidden = !complete;
    self.done.keyEquivalent = complete ? @"\r" : @"";
    NSResponder *focused = self.panel.firstResponder;
    if ([focused isKindOfClass:NSView.class] && ((NSView *)focused).hiddenOrHasHiddenAncestor)
        [self.panel makeFirstResponder:complete ? self.done : self.alternative];
    if (complete) [self stopChecks];
    [self updateStatus];
    [self positionPanel];
}
- (void)fitWidth:(CGFloat)width {
    NSRect frame = self.panel.frame;
    NSRect content = [self.panel contentRectForFrameRect:frame];
    if (fabs(content.size.width-width) > 0.5) [self.panel setContentSize:NSMakeSize(width,content.size.height)];
    CGFloat labelWidth = width-48;
    BOOL narrowCompletion = width < 300 && [self complete] && !self.input;
    self.footer.orientation = narrowCompletion ? NSUserInterfaceLayoutOrientationVertical : NSUserInterfaceLayoutOrientationHorizontal;
    self.footer.alignment = narrowCompletion ? NSLayoutAttributeTrailing : NSLayoutAttributeCenterY;
    for (NSTextField *label in @[self.titleLabel,self.lede]) label.preferredMaxLayoutWidth = labelWidth;
    self.status.preferredMaxLayoutWidth = labelWidth-24;
    for (NSStackView *group in @[self.dragSteps,self.manualSteps])
        for (NSStackView *row in group.arrangedSubviews) {
            NSTextField *label = (NSTextField *)row.arrangedSubviews.lastObject;
            label.preferredMaxLayoutWidth = labelWidth-24;
        }
    for (NSTextField *label in self.completionText.arrangedSubviews) label.preferredMaxLayoutWidth = labelWidth;
    [self.panel.contentView layoutSubtreeIfNeeded];
    CGFloat height = ceil(self.stack.fittingSize.height)+28;
    [self.panel setContentSize:NSMakeSize(width,height)];
}
- (void)positionPanel {
    self.positioning = YES;
    NSRect original = self.panel.frame;
    CGFloat width = self.userMoved ? [self.panel contentRectForFrameRect:original].size.width : 344;
    [self fitWidth:width];
    NSScreen *screen = NSScreen.mainScreen ?: NSScreen.screens.firstObject;
    NSRect visible = screen.visibleFrame;
    NSRect frame = self.panel.frame;
    frame.origin = NSMakePoint(NSMinX(visible)+16, NSMidY(visible)-frame.size.height/2);
    NSRunningApplication *settings = [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.apple.systempreferences"].firstObject;
    NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,kCGNullWindowID));
    CGRect settingsBounds = CGRectZero;
    for (NSDictionary *row in windows) {
        CGRect bounds;
        if (!settings || [row[(__bridge NSString *)kCGWindowOwnerPID] intValue] != settings.processIdentifier ||
            [row[(__bridge NSString *)kCGWindowLayer] intValue] != 0 ||
            !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)row[(__bridge NSString *)kCGWindowBounds],&bounds)) continue;
        if (bounds.size.width*bounds.size.height > settingsBounds.size.width*settingsBounds.size.height) settingsBounds = bounds;
    }
    self.settingsVisible = settingsBounds.size.width > 0;
    if (self.settingsVisible && !self.userMoved) {
        NSRect settingsFrame = NSRectFromCGRect(settingsBounds);
        settingsFrame.origin.y = NSScreen.screens.firstObject.frame.size.height-CGRectGetMaxY(settingsBounds);
        CGFloat largestIntersection = 0;
        for (NSScreen *candidate in NSScreen.screens) {
            NSRect intersection = NSIntersectionRect(candidate.frame,settingsFrame);
            CGFloat area = intersection.size.width*intersection.size.height;
            if (area > largestIntersection) { visible = candidate.visibleFrame; largestIntersection = area; }
        }
        CGFloat right = NSMaxX(settingsFrame)+16;
        BOOL compact = right+344 > NSMaxX(visible)-8 && NSMinX(settingsFrame)-344-16 < NSMinX(visible)+8;
        if (compact) { [self fitWidth:264]; frame.size = self.panel.frame.size; }
        CGFloat left = NSMinX(settingsFrame)-frame.size.width-16;
        if (right+frame.size.width <= NSMaxX(visible)-8) { frame.origin.x = right; self.dragItem.pointsLeft = YES; }
        else if (left >= NSMinX(visible)+8) { frame.origin.x = left; self.dragItem.pointsLeft = NO; }
        else { frame.origin.x = NSMinX(visible)+8; self.dragItem.pointsLeft = NO; }
        frame.origin.y = MIN(NSMaxY(visible)-frame.size.height-8,MAX(NSMinY(visible)+8,NSMaxY(settingsFrame)-frame.size.height));
    } else if (self.userMoved) {
        frame.origin = NSMakePoint(original.origin.x,NSMaxY(original)-frame.size.height);
    }
    if (!NSEqualRects(self.panel.frame,frame)) [self.panel setFrame:frame display:YES];
    if (self.settingsVisible) self.dragItem.pointsLeft = NSMidX(frame) > CGRectGetMidX(settingsBounds);
    self.positioning = NO;
    self.positioned = YES;
    [self.dragItem setNeedsDisplay:YES];
}
- (void)updateStatus {
    if ([self complete]) return;
    NSString *message;
    BOOL link, missed = NO;
    if (self.checkFailed) { message = @"Couldn’t check permissions."; link = YES; }
    else if (self.paused) { message = @"Still off. Turn it on, then check again."; link = YES; }
    // Transient feedback for a drag released somewhere that did not accept it.
    else if ((missed = self.missedUntil.timeIntervalSinceNow > 0)) { message = @"Release it over the list in System Settings."; link = !self.settingsVisible; }
    else if (!self.settingsVisible) { message = @"System Settings is closed."; link = YES; }
    else if (self.hintUntil.timeIntervalSinceNow > 0) { message = @"If macOS asks, confirm with Touch ID or your password. Checking…"; link = NO; }
    else { message = self.hasPermissionResult ? (self.screen ? @"Waiting for Accessibility…" : @"Waiting for Screen Recording…") : @"Checking permissions…"; link = NO; }
    BOOL changed = ![self.status.stringValue isEqualToString:message];
    self.status.stringValue = message;
    self.settings.hidden = !link;
    self.settings.title = self.checkFailed || self.paused ? @"Check again" : @"Open it";
    self.status.textColor = [self.style color:missed ? @"ink" : @"ink-muted"];
    self.spinner.hidden = link || missed;
    if (link || missed || NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion) [self.spinner stopAnimation:nil];
    else [self.spinner startAnimation:nil];
    if (changed) NSAccessibilityPostNotificationWithUserInfo(self.status,NSAccessibilityAnnouncementRequestedNotification,
        @{NSAccessibilityAnnouncementKey:message,NSAccessibilityPriorityKey:@(NSAccessibilityPriorityMedium)});
}
- (void)startChecks {
    self.paused = NO;
    self.started = NSDate.date;
    if (!self.timer) self.timer = [NSTimer scheduledTimerWithTimeInterval:1 target:self selector:@selector(refresh) userInfo:nil repeats:YES];
    [self refresh];
}
- (void)refresh {
    [self positionPanel];
    [self updateStatus];
    if (self.check || ([self complete] && self.hasPermissionResult)) return;
    if (-self.started.timeIntervalSinceNow > 600) {
        self.paused = YES;
        [self.timer invalidate]; self.timer = nil;
        [self updateStatus];
        return;
    }
    NSTask *task = [NSTask new];
    task.executableURL = NSBundle.mainBundle.executableURL;
    task.arguments = @[@"--permission-status"];
    NSPipe *pipe = [NSPipe pipe];
    task.standardOutput = pipe;
    task.standardError = NSFileHandle.fileHandleWithNullDevice;
    self.check = task;
    if (![task launchAndReturnError:NULL]) { self.check = nil; self.checkFailed = YES; [self updateStatus]; return; }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,4*NSEC_PER_SEC),dispatch_get_main_queue(),^{
        if (self.check == task && task.running) [task terminate];
    });
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY,0),^{
        NSData *data = [pipe.fileHandleForReading readDataToEndOfFile];
        [task waitUntilExit];
        NSDictionary *permissions = data.length < 1024 ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
        dispatch_async(dispatch_get_main_queue(),^{
            if (self.check != task) return;
            self.check = nil;
            if (![permissions isKindOfClass:NSDictionary.class] || task.terminationStatus != 0) {
                self.checkFailed = YES; [self updateStatus]; return;
            }
            BOOL first = !self.hasPermissionResult;
            BOOL screen = [permissions[@"screen"] boolValue];
            BOOL input = [permissions[@"input"] boolValue];
            BOOL changedScreen = screen != self.screen;
            BOOL changed = changedScreen || input != self.input;
            self.hasPermissionResult = YES;
            self.checkFailed = NO;
            self.screen = screen;
            self.input = input;
            if (changedScreen) { self.manual = NO; self.skippedInput = NO; }
            if (first || changed) [self render]; else [self updateStatus];
            if ((first || changedScreen) && ![self complete]) [self openSettings:nil];
        });
    });
}
- (void)openSettings:(id)sender {
    if (self.paused || !self.timer) [self startChecks];
    NSString *pane = self.screen ? @"Privacy_Accessibility" : @"Privacy_ScreenCapture";
    NSURL *url = [NSURL URLWithString:[@"x-apple.systempreferences:com.apple.preference.security?" stringByAppendingString:pane]];
    if (![NSWorkspace.sharedWorkspace openURL:url]) {
        self.status.stringValue = @"Couldn’t open System Settings. Open Privacy & Security manually.";
        self.settings.title = @"Try again";
        self.settings.hidden = NO;
    }
}
- (void)toggleAlternative:(id)sender {
    self.manual = !self.manual;
    self.pathCopyButton.title = @"Copy path";
    [self render];
    [self.panel makeFirstResponder:self.manual ? self.pathCopyButton : self.alternative];
}
- (void)copyPath:(id)sender {
    [NSPasteboard.generalPasteboard clearContents];
    [NSPasteboard.generalPasteboard setString:NSBundle.mainBundle.bundlePath forType:NSPasteboardTypeString];
    self.pathCopyButton.title = @"Copied";
}
- (void)cancel:(id)sender {
    if (!self.screen) { [self close:nil]; return; }
    self.skippedInput = YES;
    self.manual = NO;
    [self render];
    [self.panel makeFirstResponder:self.done];
}
- (void)allowKeyboard:(id)sender {
    self.skippedInput = NO;
    [self render];
    [self startChecks];
    [self openSettings:nil];
}
- (void)close:(id)sender { [self.panel close]; }
- (void)stopChecks {
    [self.timer invalidate]; self.timer = nil;
    if (self.check.running) [self.check terminate];
    self.check = nil;
}
- (void)windowWillClose:(NSNotification *)notification { [self stopChecks]; [NSApp terminate:nil]; }
- (void)windowDidMove:(NSNotification *)notification { if (self.positioned && !self.positioning) self.userMoved = YES; }
- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)visible {
    [self.panel makeKeyAndOrderFront:nil];
    // Settings may have changed while a completed card was left open.
    [self stopChecks];
    self.hasPermissionResult = NO;
    self.skippedInput = NO;
    self.screen = NO;
    self.input = NO;
    [self render];
    [self startChecks];
    return YES;
}
- (void)applicationWillTerminate:(NSNotification *)notification { [self stopChecks]; }
@end

int runAgentSetup(void) {
    [NSApplication sharedApplication];
    __attribute__((objc_precise_lifetime)) AgentSetup *delegate = [AgentSetup new];
    NSApp.delegate = delegate;
    [NSApp run];
    return 0;
}
