// LaunchServices routing fixture. It never asks for a privacy grant or captures.
#import <AppKit/AppKit.h>
#import <CoreServices/CoreServices.h>
@interface ReopenFixture : NSObject <NSApplicationDelegate>
@end
@implementation ReopenFixture
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    NSDictionary *identity = @{
        @"identifier": NSBundle.mainBundle.bundleIdentifier,
        @"path": NSBundle.mainBundle.bundlePath,
    };
    NSData *data = [NSJSONSerialization dataWithJSONObject:identity options:0 error:NULL];
    exit([data writeToFile:NSProcessInfo.processInfo.arguments[1] atomically:YES] ? 0 : 1);
}
@end
int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc == 3 && !strcmp(argv[1], "--register"))
            return LSRegisterURL((__bridge CFURLRef)[NSURL fileURLWithPath:@(argv[2])], true) == noErr ? 0 : 1;
        if (argc != 2) return 2;
        [NSApplication sharedApplication];
        ReopenFixture *fixture = [ReopenFixture new];
        NSApp.delegate = fixture;
        [NSApp run];
    }
}
