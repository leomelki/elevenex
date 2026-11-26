#import <AppKit/AppKit.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <VideoToolbox/VideoToolbox.h>

BOOL AppSessionActive(void);
BOOL ownsAppProcess(pid_t group, pid_t owner);
pid_t launchOwnedGroup(char **command);
void stopOwnedGroup(void);
void setSupervisorDesktopDirectory(const char *path);
void setDisplayOutput(FILE *channel);
void displayReceipt(uint32_t id, uint8_t flag);

typedef NS_ENUM(uint8_t, AppInputResult) {
    AppInputUnavailable = 0,
    AppInputAccepted = 1,
    AppInputNeedsAccessibility = 2,
    AppInputNeedsForeground = 3,
    AppInputWindowBlocked = 4,
    // The capture loop verifies this request before returning an input receipt.
    AppInputActivationRequested = 255,
};

@interface AppWindow : NSObject
@property(nonatomic) pid_t group;
@property(nonatomic) pid_t owner;
@property(nonatomic) CGWindowID window;
// WindowServer frame for change detection; ScreenCaptureKit can exclude its border.
@property(nonatomic) CGRect windowBounds;
// Captured picture's screen coordinates, used to map viewer input.
@property(nonatomic) CGRect bounds;
@property(nonatomic) size_t width;
@property(nonatomic) size_t height;
// Visible owned windows are candidates for initial capture selection.
- (NSDictionary *)firstOwnedWindow;
// Revalidate the selected capture window and its original WindowServer size.
- (BOOL)currentBounds:(CGRect *)bounds;
// Validate the selected target and distinguish a competing owned window from lost foreground.
- (AppInputResult)inputWindowBounds:(CGRect *)bounds excluding:(NSMutableArray<NSValue *> *)occlusions
    verifyFocus:(BOOL)verifyFocus;
@property(nonatomic, readonly, getter=isFrontmost) BOOL frontmost;
@property(nonatomic, readonly) BOOL hasHeldInput;
- (AppInputResult)input:(NSDictionary *)input;
- (void)releaseInput;
@end

@interface AppEncoder : NSObject <SCStreamOutput, SCStreamDelegate>
- (BOOL)configureWidth:(int)width height:(int)height;
- (void)refresh;
- (void)disable;
- (void)finish;
@property(nonatomic, copy) void (^failed)(void);
- (BOOL)encodeTestFrame;
@end
