#import <AppKit/AppKit.h>

// The factory supplies an unlaunched task. Setup owns its execution, timeout and
// cancellation, and calls it only after the user chooses Reset Accessibility.
typedef NSTask * (^AgentAccessibilityResetTask)(void);
int runAgentSetup(AgentAccessibilityResetTask createAccessibilityResetTask);
int writeAgentIconset(NSString *directory);
int printAgentPermissions(void);
