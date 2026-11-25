#import "SetupViews.h"

@interface AgentSetupStyle ()
@property(nonatomic, strong) NSDictionary *palette;
@end

@interface AgentPrimaryButton : NSButton
@property(nonatomic, strong) AgentSetupStyle *style;
@end
@implementation AgentPrimaryButton
- (void)drawRect:(NSRect)dirty {
    NSRect rect = NSInsetRect(self.bounds,1,1);
    NSColor *accent = [self.style color:@"accent"];
    if (self.highlighted) accent = [accent colorWithAlphaComponent:0.8];
    if (!self.enabled) accent = [accent colorWithAlphaComponent:0.45];
    [accent setFill];
    [[NSBezierPath bezierPathWithRoundedRect:rect xRadius:7 yRadius:7] fill];
    NSDictionary *attributes = @{NSFontAttributeName:[NSFont systemFontOfSize:13 weight:NSFontWeightMedium],
        NSForegroundColorAttributeName:[self.style color:@"on-accent"]};
    NSSize size = [self.title sizeWithAttributes:attributes];
    [self.title drawAtPoint:NSMakePoint((self.bounds.size.width-size.width)/2,(self.bounds.size.height-size.height)/2) withAttributes:attributes];
}
- (void)drawFocusRingMask {
    [[NSBezierPath bezierPathWithRoundedRect:NSInsetRect(self.bounds,1,1) xRadius:7 yRadius:7] fill];
}
- (NSRect)focusRingMaskBounds { return self.bounds; }
- (void)viewDidChangeEffectiveAppearance { [super viewDidChangeEffectiveAppearance]; [self setNeedsDisplay:YES]; }
@end

@implementation AgentSetupStyle
- (instancetype)init {
    self = [super init];
    if (self) {
        NSURL *url = [NSBundle.mainBundle URLForResource:@"AgentTheme" withExtension:@"json"];
        NSData *data = url ? [NSData dataWithContentsOfURL:url] : nil;
        _palette = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : @{};
    }
    return self;
}
- (NSColor *)color:(NSString *)token {
    NSDictionary *palette = self.palette;
    return [NSColor colorWithName:token dynamicProvider:^NSColor *(NSAppearance *appearance) {
        BOOL dark = [[appearance bestMatchFromAppearancesWithNames:@[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]] isEqualToString:NSAppearanceNameDarkAqua];
        NSString *hex = palette[dark ? @"dark" : @"light"][token];
        if (hex.length != 7) return NSColor.labelColor;
        unsigned int rgb = 0;
        [[NSScanner scannerWithString:[hex substringFromIndex:1]] scanHexInt:&rgb];
        return [NSColor colorWithSRGBRed:((rgb >> 16) & 255)/255.0 green:((rgb >> 8) & 255)/255.0 blue:(rgb & 255)/255.0 alpha:1];
    }];
}
- (NSTextField *)label:(NSString *)text size:(CGFloat)size weight:(NSFontWeight)weight {
    NSTextField *label = [NSTextField wrappingLabelWithString:text];
    label.font = [NSFont systemFontOfSize:size weight:weight];
    label.textColor = [self color:@"ink"];
    label.translatesAutoresizingMaskIntoConstraints = NO;
    label.selectable = YES;
    [label setContentHuggingPriority:NSLayoutPriorityRequired forOrientation:NSLayoutConstraintOrientationVertical];
    [label setContentCompressionResistancePriority:NSLayoutPriorityRequired forOrientation:NSLayoutConstraintOrientationVertical];
    return label;
}
- (NSButton *)button:(NSString *)title target:(id)target action:(SEL)action primary:(BOOL)primary {
    NSButton *button;
    if (primary) {
        AgentPrimaryButton *filled = [[AgentPrimaryButton alloc] initWithFrame:NSZeroRect];
        filled.style = self;
        filled.title = title;
        filled.target = target;
        filled.action = action;
        [filled setButtonType:NSButtonTypeMomentaryPushIn];
        button = filled;
    } else button = [NSButton buttonWithTitle:title target:target action:action];
    button.bezelStyle = NSBezelStyleRounded;
    button.font = [NSFont systemFontOfSize:13];
    button.translatesAutoresizingMaskIntoConstraints = NO;
    if (primary) {
        button.bezelColor = [self color:@"accent"];
        button.contentTintColor = [self color:@"on-accent"];
    }
    return button;
}
@end

@interface AgentSetupWell ()
@property(nonatomic, strong) AgentSetupStyle *style;
@end
@implementation AgentSetupWell
- (instancetype)initWithViews:(NSArray<NSView *> *)views style:(AgentSetupStyle *)style spacing:(CGFloat)spacing {
    self = [super initWithFrame:NSZeroRect];
    if (self) {
        _style = style;
        self.orientation = NSUserInterfaceLayoutOrientationVertical;
        self.alignment = NSLayoutAttributeLeading;
        self.spacing = spacing;
        self.translatesAutoresizingMaskIntoConstraints = NO;
        for (NSView *view in views) [self addArrangedSubview:view];
    }
    return self;
}
- (void)drawRect:(NSRect)dirty {
    [[self.style color:@"surface-sunken"] setFill];
    [[NSBezierPath bezierPathWithRoundedRect:self.bounds xRadius:7 yRadius:7] fill];
}
- (void)viewDidChangeEffectiveAppearance { [super viewDidChangeEffectiveAppearance]; [self setNeedsDisplay:YES]; }
@end

// The tile shows only the thing to pick up: the app icon, with a dashed arrow
// running off the tile edge toward the real System Settings window (the panel
// docks beside it). No destination is drawn in the tile, because anything that
// looks like a drop zone here would invite drops that cannot work. Until the
// first drag, a faded copy of the icon periodically glides out along the arrow
// and leaves the tile. Reduced motion shows the static picture.
static const NSTimeInterval AgentDemoInterval = 3.2;
static const NSTimeInterval AgentDemoDuration = 1.1;

@interface AgentDragItem ()
@property(nonatomic) BOOL dragging;
@property(nonatomic) BOOL hovered;
@property(nonatomic) BOOL demonstrated;
@property(nonatomic) CGFloat ghost;
@property(nonatomic, strong) NSDate *ghostStart;
@property(nonatomic, strong) NSTimer *demoTimer;
@property(nonatomic, strong) NSTimer *frameTimer;
@property(nonatomic, strong) NSTrackingArea *hoverArea;
@property(nonatomic) NSPoint dragOrigin;
@end
@implementation AgentDragItem
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
- (BOOL)mouseDownCanMoveWindow { return NO; }
- (BOOL)isOpaque { return NO; }
- (void)dealloc { [_demoTimer invalidate]; [_frameTimer invalidate]; }
- (CGFloat)iconSize { return self.bounds.size.width < 240 ? 56 : 64; }
- (NSRect)iconRectAt:(CGFloat)centerX size:(CGFloat)size {
    CGFloat top = 40, available = self.bounds.size.height-16-top;
    return NSMakeRect(round(centerX-size/2), round(top+(available-size)/2), size, size);
}
- (NSRect)sourceRect {
    return [self iconRectAt:self.bounds.size.width * (self.pointsLeft ? 0.72 : 0.28) size:self.iconSize];
}
- (void)drawLabel:(NSString *)text centerX:(CGFloat)x attributes:(NSDictionary *)attributes {
    CGFloat width = MIN([text sizeWithAttributes:attributes].width, self.bounds.size.width/2-8);
    [text drawWithRect:NSMakeRect(round(x-width/2), 16, width, 16)
        options:NSStringDrawingUsesLineFragmentOrigin|NSStringDrawingTruncatesLastVisibleLine attributes:attributes context:nil];
}
- (void)drawRect:(NSRect)dirty {
    NSRect tile = NSInsetRect(self.bounds, 1, 2);
    NSBezierPath *shape = [NSBezierPath bezierPathWithRoundedRect:tile xRadius:11 yRadius:11];
    [NSGraphicsContext saveGraphicsState];
    NSShadow *shadow = [NSShadow new];
    shadow.shadowOffset = NSMakeSize(0, -1);
    shadow.shadowBlurRadius = 3;
    shadow.shadowColor = [NSColor colorWithWhite:0 alpha:0.12];
    [shadow set];
    [[self.style color:@"surface-raised"] setFill];
    [shape fill];
    [NSGraphicsContext restoreGraphicsState];
    BOOL contrast = NSWorkspace.sharedWorkspace.accessibilityDisplayShouldIncreaseContrast;
    [[self.style color:contrast ? @"line-strong" : @"line"] setStroke];
    [shape stroke];

    NSRect source = self.sourceRect;
    NSColor *accent = [self.style color:@"accent"];

    // Exit path: from the icon to the tile edge nearest System Settings.
    CGFloat direction = self.pointsLeft ? -1 : 1, y = NSMidY(source);
    CGFloat start = (self.pointsLeft ? NSMinX(source) : NSMaxX(source)) + direction*12;
    CGFloat end = (self.pointsLeft ? NSMinX(tile) : NSMaxX(tile)) - direction*18;
    NSBezierPath *path = [NSBezierPath bezierPath];
    [path moveToPoint:NSMakePoint(start, y)];
    [path lineToPoint:NSMakePoint(end, y)];
    CGFloat pathDash[] = {3, 4};
    [path setLineDash:pathDash count:2 phase:0];
    path.lineWidth = 1.5;
    path.lineCapStyle = NSLineCapStyleRound;
    [accent setStroke];
    [path stroke];
    NSBezierPath *head = [NSBezierPath bezierPath];
    [head moveToPoint:NSMakePoint(end-direction*6, y+5)];
    [head lineToPoint:NSMakePoint(end, y)];
    [head lineToPoint:NSMakePoint(end-direction*6, y-5)];
    head.lineWidth = 1.5;
    head.lineCapStyle = NSLineCapStyleRound;
    head.lineJoinStyle = NSLineJoinStyleRound;
    [head stroke];

    // Source: the app icon, lifted while hovered like a picked-up Finder item.
    NSRect icon = self.hovered && !self.dragging ? NSOffsetRect(source, 0, 2) : source;
    [NSGraphicsContext saveGraphicsState];
    NSShadow *lift = [NSShadow new];
    lift.shadowOffset = NSMakeSize(0, self.hovered ? -4 : -1);
    lift.shadowBlurRadius = self.hovered ? 8 : 2;
    lift.shadowColor = [NSColor colorWithWhite:0 alpha:self.hovered ? 0.28 : 0.14];
    if (!self.dragging) [lift set];
    [self.icon drawInRect:icon fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:self.dragging ? 0.3 : 1];
    [NSGraphicsContext restoreGraphicsState];

    if (self.ghost > 0) {
        // Glide past the edge and fade, clipped by the tile: the icon leaves this window.
        CGFloat t = self.ghost, eased = t < 0.5 ? 2*t*t : 1-pow(-2*t+2, 2)/2;
        CGFloat travel = (self.pointsLeft ? NSMinX(tile)-NSMinX(source) : NSMaxX(tile)-NSMaxX(source)) + direction*source.size.width/2;
        [NSGraphicsContext saveGraphicsState];
        [shape addClip];
        // Stay invisible while overlapping the real icon so it never reads as a doubled image.
        CGFloat cleared = MAX(0, MIN(1, (fabs(travel*eased) - source.size.width*0.45) / (source.size.width*0.4)));
        [self.icon drawInRect:NSOffsetRect(source, travel*eased, 0) fromRect:NSZeroRect
            operation:NSCompositingOperationSourceOver fraction:0.6*cleared*(1-0.6*eased)];
        [NSGraphicsContext restoreGraphicsState];
    }

    NSDictionary *nameStyle = @{NSFontAttributeName:[NSFont systemFontOfSize:12 weight:NSFontWeightSemibold], NSForegroundColorAttributeName:[self.style color:@"ink"]};
    [self drawLabel:@"Elevenex Agent" centerX:NSMidX(source) attributes:nameStyle];

    // A focus ring is for keyboard navigation. Mouse interaction should make
    // this look like an object to pick up, not a highlighted drop target.
    if (self.window.firstResponder == self && self.window.keyViewSelectionDirection != NSDirectSelection) {
        [accent setStroke];
        shape.lineWidth = 2;
        [shape stroke];
    }
}
- (void)setPointsLeft:(BOOL)pointsLeft {
    if (_pointsLeft == pointsLeft) return;
    _pointsLeft = pointsLeft;
    [self.window invalidateCursorRectsForView:self];
    [self setNeedsDisplay:YES];
}
// The icon's half of the tile is the grab handle, so the drag image stays under the pointer.
- (NSRect)grabRect {
    NSRect source = self.sourceRect;
    return NSMakeRect(NSMidX(source)-self.bounds.size.width/4, 0, self.bounds.size.width/2, self.bounds.size.height);
}
- (void)resetCursorRects { [self addCursorRect:self.grabRect cursor:NSCursor.openHandCursor]; }
- (void)updateTrackingAreas {
    [super updateTrackingAreas];
    if (self.hoverArea) [self removeTrackingArea:self.hoverArea];
    self.hoverArea = [[NSTrackingArea alloc] initWithRect:self.grabRect
        options:NSTrackingMouseEnteredAndExited|NSTrackingActiveAlways owner:self userInfo:nil];
    [self addTrackingArea:self.hoverArea];
}
- (void)setFrameSize:(NSSize)size { [super setFrameSize:size]; [self updateTrackingAreas]; }
- (void)mouseEntered:(NSEvent *)event { self.hovered = YES; [self stopGhost]; [self setNeedsDisplay:YES]; }
- (void)mouseExited:(NSEvent *)event { self.hovered = NO; [self setNeedsDisplay:YES]; }
- (void)viewDidMoveToWindow { [super viewDidMoveToWindow]; [self updateDemo]; }
- (void)viewDidHide { [super viewDidHide]; [self updateDemo]; }
- (void)viewDidUnhide { [super viewDidUnhide]; [self updateDemo]; }
- (void)updateDemo {
    BOOL run = self.window && !self.hiddenOrHasHiddenAncestor && !self.demonstrated;
    if (run && !self.demoTimer) {
        __weak AgentDragItem *weakSelf = self;
        self.demoTimer = [[NSTimer alloc] initWithFireDate:[NSDate dateWithTimeIntervalSinceNow:2]
            interval:AgentDemoInterval repeats:YES block:^(NSTimer *timer) {
                AgentDragItem *item = weakSelf;
                if (!item) { [timer invalidate]; return; }
                [item startGhost];
            }];
        [NSRunLoop.mainRunLoop addTimer:self.demoTimer forMode:NSDefaultRunLoopMode];
    } else if (!run) {
        [self.demoTimer invalidate];
        self.demoTimer = nil;
        [self stopGhost];
    }
}
- (void)startGhost {
    if (self.hovered || self.dragging || self.frameTimer || NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion) return;
    self.ghostStart = NSDate.date;
    __weak AgentDragItem *weakSelf = self;
    self.frameTimer = [NSTimer scheduledTimerWithTimeInterval:1.0/60 repeats:YES block:^(NSTimer *timer) {
        AgentDragItem *item = weakSelf;
        if (!item) { [timer invalidate]; return; }
        CGFloat t = -item.ghostStart.timeIntervalSinceNow / AgentDemoDuration;
        if (t >= 1) [item stopGhost];
        else { item.ghost = t; [item setNeedsDisplay:YES]; }
    }];
}
- (void)stopGhost {
    [self.frameTimer invalidate];
    self.frameTimer = nil;
    if (self.ghost > 0) { self.ghost = 0; [self setNeedsDisplay:YES]; }
}
- (void)mouseDown:(NSEvent *)event {
    if (!NSPointInRect([self convertPoint:event.locationInWindow fromView:nil], self.grabRect)) return;
    [self.window makeFirstResponder:nil];
    self.dragOrigin = [self.window convertPointToScreen:event.locationInWindow];
    self.demonstrated = YES;
    [self updateDemo];
    NSDraggingItem *item = [[NSDraggingItem alloc] initWithPasteboardWriter:self.appURL];
    [item setDraggingFrame:self.sourceRect contents:self.icon];
    self.dragging = YES;
    [self setNeedsDisplay:YES];
    [self beginDraggingSessionWithItems:@[item] event:event source:self];
}
- (NSDragOperation)draggingSession:(NSDraggingSession *)session sourceOperationMaskForDraggingContext:(NSDraggingContext)context { return NSDragOperationCopy; }
- (void)draggingSession:(NSDraggingSession *)session endedAtPoint:(NSPoint)point operation:(NSDragOperation)operation {
    self.dragging = NO;
    [self setNeedsDisplay:YES];
    // A click also starts and ends a session; only a real move counts as a missed drop.
    BOOL moved = hypot(point.x-self.dragOrigin.x, point.y-self.dragOrigin.y) > 24;
    if (self.dragEnded) self.dragEnded(operation != NSDragOperationNone, operation == NSDragOperationNone && moved);
}
- (BOOL)accessibilityPerformPress { if (self.useAlternative) self.useAlternative(); return YES; }
- (void)keyDown:(NSEvent *)event {
    BOOL copy = (event.modifierFlags & NSEventModifierFlagCommand) && [event.charactersIgnoringModifiers isEqualToString:@"c"];
    if (copy || [event.charactersIgnoringModifiers isEqualToString:@"\r"] || [event.charactersIgnoringModifiers isEqualToString:@" "]) {
        if (self.useAlternative) self.useAlternative();
    } else [super keyDown:event];
}
- (BOOL)becomeFirstResponder { [self setNeedsDisplay:YES]; return YES; }
- (BOOL)resignFirstResponder { [self setNeedsDisplay:YES]; return YES; }
- (void)viewDidChangeEffectiveAppearance { [super viewDidChangeEffectiveAppearance]; [self setNeedsDisplay:YES]; }
@end

@implementation AgentSetupProgress
- (void)viewDidChangeEffectiveAppearance { [super viewDidChangeEffectiveAppearance]; [self setNeedsDisplay:YES]; }
- (void)drawRect:(NSRect)dirty {
    NSString *title = self.secondStep ? @"STEP 2 OF 2 · OPTIONAL" : @"STEP 1 OF 2";
    NSDictionary *attributes = @{NSFontAttributeName:[NSFont systemFontOfSize:10 weight:NSFontWeightSemibold], NSForegroundColorAttributeName:[self.style color:@"ink-muted"], NSKernAttributeName:@0.6};
    [title drawAtPoint:NSMakePoint(0, 1) withAttributes:attributes];
    CGFloat start = [title sizeWithAttributes:attributes].width + 12;
    CGFloat width = MAX(12, (self.bounds.size.width-start-4)/2);
    for (NSUInteger step=0; step<2; step++) {
        [[self.style color:(step == 0 || self.secondStep) ? @"accent" : @"line"] setFill];
        [[NSBezierPath bezierPathWithRoundedRect:NSMakeRect(start + step*(width+4), 6, width, 3) xRadius:1.5 yRadius:1.5] fill];
    }
}
@end
