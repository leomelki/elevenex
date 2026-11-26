#import "Display.h"
#import "Setup.h"
#import "DesktopConnection.h"
#import "Capture.h"
#import <ApplicationServices/ApplicationServices.h>
#import <signal.h>
#import <fcntl.h>
#import <unistd.h>

static int runAgentCommand(int argc, char *argv[], BOOL desktop, int displayDescriptor, int owner) {
    @autoreleasepool {
        if (argc == 1 || (argc == 2 && !strcmp(argv[1], "--setup"))) return runAgentSetup(^{
            NSTask *task = [NSTask new];
            task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/tccutil"];
            // Never reset All, Screen Recording or another application's grants.
            // A stale ad hoc build's Accessibility entry must be removed before
            // the user can grant the current build access in System Settings.
            task.arguments = @[@"reset", @"Accessibility", @"com.elevenex.task-app-display"];
            return task;
        });
        if (argc == 3 && !strcmp(argv[1], "--write-iconset")) return writeAgentIconset(@(argv[2]));
        if (argc == 2 && !strcmp(argv[1], "--permission-status")) return printAgentPermissions();
        if (argc == 2 && !strcmp(argv[1], "--self-test")) {
            setDisplayOutput(stdout);
            AppEncoder *encoder = [AppEncoder new];
            encoder.failed = ^{};
            return [encoder configureWidth:64 height:64] && [encoder encodeTestFrame] ? 0 : 24;
        }
        if (argc == 2 && !strcmp(argv[1], "--authorize")) {
            CGRequestScreenCaptureAccess();
            NSDictionary *options = @{ (__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES };
            return AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options) && CGPreflightScreenCaptureAccess() ? 0 : 21;
        }
        if (argc == 2 && (!strcmp(argv[1], "--screen-settings") || !strcmp(argv[1], "--accessibility-settings"))) {
            if (!AppSessionActive()) return 20;
            BOOL screen = !strcmp(argv[1], "--screen-settings");
            NSString *pane = screen ? @"Privacy_ScreenCapture" : @"Privacy_Accessibility";
            NSURL *url = [NSURL URLWithString:[@"x-apple.systempreferences:com.apple.preference.security?" stringByAppendingString:pane]];
            if (![NSWorkspace.sharedWorkspace openURL:url]) return 24;
            // Request only the selected permission, so the helper is listed even on first use.
            if (screen && !CGPreflightScreenCaptureAccess()) CGRequestScreenCaptureAccess();
            if (!screen && !AXIsProcessTrusted()) {
                NSDictionary *options = @{ (__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES };
                AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
            }
            return 0;
        }
        if (argc == 2 && !strcmp(argv[1], "--check")) {
            if (!desktop) return runAgentInDesktop(argc,argv,-1,NULL);
            if (!AppSessionActive()) return 20;
            return CGPreflightScreenCaptureAccess() ? 0 : 21;
        }
        if (desktop && argc == 3 && !strcmp(argv[1],"--capture-owned")) {
            char *end;
            long group = strtol(argv[2],&end,10);
            if (*end || group <= 1 || group > INT_MAX || kill(-(pid_t)group,0)) return 2;
            return runAppCapture((pid_t)group,displayDescriptor,owner);
        }
        BOOL desktopLaunch = argc >= 3 && !strcmp(argv[1],"--launch-desktop");
        if (argc < 3 || (!desktopLaunch && strcmp(argv[1],"--launch"))) return 2;
        char directory[] = "/tmp/elevenex-agent-XXXXXX";
        if (desktopLaunch) {
            if (!mkdtemp(directory)) return 25;
            setSupervisorDesktopDirectory(directory);
        }
        pid_t group = launchOwnedGroup(argv + 2);
        if (group <= 0) { if (desktopLaunch) rmdir(directory); return 2; }
        if (desktopLaunch) {
            char groupText[32]; snprintf(groupText,sizeof(groupText),"%d",group);
            char *capture[] = {argv[0],"--capture-owned",groupText,NULL};
            int result = runAgentInDesktop(3,capture,displayDescriptor,directory);
            if (result == 25) {
                FILE *output = fdopen(dup(displayDescriptor),"wb");
                if (output) { setDisplayOutput(output); displayReceipt(0,25); fclose(output); }
            }
            // A lost capture host ends this run through the normal supervisor
            // cleanup path; never abandon its user process group.
            stopOwnedGroup();
        }
        return runAppCapture(group,displayDescriptor,-1);
    }
}

int main(int argc, char *argv[]) {
    @autoreleasepool {
        if (argc == 3 && !strcmp(argv[1],"--desktop-connection")) {
            AgentDesktopInvocation *invocation = connectAgentDesktop(argv[2]);
            if (!invocation) return 25;
            // The private desktop entry accepts only a check or capture of the
            // authenticated native supervisor's group, never a launch command.
            char **command = calloc(invocation.arguments.count+2,sizeof(char *));
            if (!command) return 25;
            command[0] = argv[0];
            for (NSUInteger index=0; index<invocation.arguments.count; index++)
                command[index+1] = (char *)invocation.arguments[index].UTF8String;
            uint8_t code = runAgentCommand((int)invocation.arguments.count+1,command,YES,invocation.display,invocation.owner);
            write(invocation.owner,&code,1);
            close(invocation.owner);
            free(command);
            return code;
        }
        return runAgentCommand(argc,argv,NO,4,-1);
    }
}
