#import <AppKit/AppKit.h>

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
    puts("clicked"); fflush(stdout);
}
- (void)keyDown:(NSEvent *)event {
    if ([event.charactersIgnoringModifiers isEqual:@"a"]) { puts("typed"); fflush(stdout); }
}
@end
int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(120, 120, 480, 320)
            styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
        window.title = @"Elevenex capture and input test";
        window.contentView = [[TaskAppTestView alloc] initWithFrame:window.contentView.frame];
        [window makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
        [NSApp run];
    }
    return 0;
}
