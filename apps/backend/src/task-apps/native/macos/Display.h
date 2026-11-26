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

@interface AppWindow : NSObject
@property(nonatomic) pid_t group;
@property(nonatomic) pid_t owner;
@property(nonatomic) CGWindowID window;
@property(nonatomic) CGRect bounds;
@property(nonatomic) size_t width;
@property(nonatomic) size_t height;
// WindowServer ordering is consulted for selection and each input boundary.
- (NSDictionary *)firstOwnedWindow;
- (BOOL)input:(NSDictionary *)input;
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
