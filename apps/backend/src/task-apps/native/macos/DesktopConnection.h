#import <Foundation/Foundation.h>

// LaunchServices establishes the agent's own TCC responsibility. The proxy
// retains its child group and transfers only the private display descriptor.
int runAgentInDesktop(int argc, char **argv, int displayDescriptor, const char *ownedDirectory);

@interface AgentDesktopInvocation : NSObject
@property(nonatomic) int owner;
@property(nonatomic) int display;
@property(nonatomic, strong) NSArray<NSString *> *arguments;
@end
AgentDesktopInvocation *connectAgentDesktop(const char *path);
