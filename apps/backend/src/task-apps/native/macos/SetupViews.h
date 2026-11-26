#import <AppKit/AppKit.h>

@interface AgentSetupStyle : NSObject
- (NSColor *)color:(NSString *)token;
- (NSTextField *)label:(NSString *)text size:(CGFloat)size weight:(NSFontWeight)weight;
- (NSButton *)button:(NSString *)title target:(id)target action:(SEL)action primary:(BOOL)primary;
@end

@interface AgentSetupWell : NSStackView
- (instancetype)initWithViews:(NSArray<NSView *> *)views style:(AgentSetupStyle *)style spacing:(CGFloat)spacing;
@end

@interface AgentDragItem : NSView <NSDraggingSource>
@property(nonatomic, strong) AgentSetupStyle *style;
@property(nonatomic, strong) NSURL *appURL;
@property(nonatomic, strong) NSImage *icon;
// YES when System Settings sits left of the panel; the tile mirrors to point at it.
@property(nonatomic) BOOL pointsLeft;
@property(nonatomic, copy) void (^useAlternative)(void);
// missed: the pointer moved but nothing accepted the drop (for example, released inside this panel).
@property(nonatomic, copy) void (^dragEnded)(BOOL accepted, BOOL missed);
@end

@interface AgentSetupProgress : NSView
@property(nonatomic, strong) AgentSetupStyle *style;
@property(nonatomic) BOOL secondStep;
@end
