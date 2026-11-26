#import "DesktopConnection.h"
#import <AppKit/AppKit.h>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <poll.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

@implementation AgentDesktopInvocation
@end

static const NSUInteger maxRequest = 1024;
static volatile sig_atomic_t interrupted;
static void interruptProxy(int value) { (void)value; interrupted = 1; }

static NSString *agentExecutable(void) {
    char path[PROC_PIDPATHINFO_MAXSIZE];
    return proc_pidpath(getpid(),path,sizeof(path)) > 0 ? [@(path) stringByResolvingSymlinksInPath] : nil;
}

static BOOL agentPeer(int fd) {
    uid_t uid; gid_t gid; pid_t pid = 0; socklen_t size = sizeof(pid);
    char executable[PROC_PIDPATHINFO_MAXSIZE];
    if (getpeereid(fd,&uid,&gid) || uid != geteuid() ||
        getsockopt(fd,SOL_LOCAL,LOCAL_PEERPID,&pid,&size) || pid <= 1 ||
        proc_pidpath(pid,executable,sizeof(executable)) <= 0) return NO;
    return [[@(executable) stringByResolvingSymlinksInPath]
        isEqualToString:agentExecutable()];
}

static BOOL transferBytes(int fd, void *bytes, size_t length, BOOL writing) {
    for (size_t offset = 0; offset < length;) {
        ssize_t count = writing ? send(fd,(char *)bytes+offset,length-offset,0) : recv(fd,(char *)bytes+offset,length-offset,0);
        if (count < 0 && errno == EINTR && !interrupted) continue;
        if (count <= 0) return NO;
        offset += (size_t)count;
    }
    return YES;
}

static void connectionTimeout(int fd, int seconds) {
    struct timeval timeout = {.tv_sec = seconds};
    setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof(timeout));
    setsockopt(fd,SOL_SOCKET,SO_SNDTIMEO,&timeout,sizeof(timeout));
    int yes = 1;
    setsockopt(fd,SOL_SOCKET,SO_NOSIGPIPE,&yes,sizeof(yes));
}

int runAgentInDesktop(int argc, char **argv, int displayDescriptor, const char *ownedDirectory) {
    BOOL capturing = argc == 3 && !strcmp(argv[1],"--capture-owned");
    if (!capturing && (argc != 2 || strcmp(argv[1],"--check"))) return 2;
    NSMutableArray *arguments = [NSMutableArray array];
    for (int index=1; index<argc; index++) [arguments addObject:@(argv[index])];
    NSData *request = [NSJSONSerialization dataWithJSONObject:@{@"arguments":arguments} options:0 error:NULL];
    if (!request || request.length > maxRequest) return 25;

    // A short, private path also fits macOS's 104-byte sockaddr_un.sun_path.
    char temporary[] = "/tmp/elevenex-agent-XXXXXX";
    const char *directory = ownedDirectory ?: mkdtemp(temporary);
    if (!directory) return 25;
    NSString *path = [@(directory) stringByAppendingPathComponent:@"owner"];
    struct sockaddr_un address = {.sun_family = AF_UNIX};
    strlcpy(address.sun_path,path.fileSystemRepresentation,sizeof(address.sun_path));
    address.sun_len = SUN_LEN(&address);
    int listener = socket(AF_UNIX,SOCK_STREAM,0), peer = -1, result = 25;
    if (listener < 0) { rmdir(directory); return 25; }
    fcntl(listener,F_SETFD,FD_CLOEXEC);
    struct sigaction previousTerm, previousInt, previousHup;
    struct sigaction handler = {.sa_handler = interruptProxy};
    sigemptyset(&handler.sa_mask);
    interrupted = 0;
    sigaction(SIGTERM,&handler,&previousTerm);
    sigaction(SIGINT,&handler,&previousInt);
    sigaction(SIGHUP,&handler,&previousHup);
    @try {
        if (bind(listener,(struct sockaddr *)&address,address.sun_len) || listen(listener,1)) return 25;
        NSTask *open = [NSTask new];
        open.executableURL = [NSURL fileURLWithPath:@"/usr/bin/open"];
        // The supported CLI entry is a symlink outside the .app. Resolve the
        // running executable, rather than asking NSBundle about that symlink.
        NSString *bundle = agentExecutable().stringByDeletingLastPathComponent.stringByDeletingLastPathComponent.stringByDeletingLastPathComponent;
        if (!bundle) return 25;
        open.arguments = @[@"-n",@"-g",@"-a",bundle,@"--args",@"--desktop-connection",path];
        open.standardInput = NSFileHandle.fileHandleWithNullDevice;
        open.standardOutput = NSFileHandle.fileHandleWithNullDevice;
        open.standardError = NSFileHandle.fileHandleWithNullDevice;
        if (![open launchAndReturnError:NULL]) return 25;
        CFAbsoluteTime deadline = CFAbsoluteTimeGetCurrent()+5;
        while (!interrupted && CFAbsoluteTimeGetCurrent() < deadline) {
            struct pollfd ready = {.fd=listener,.events=POLLIN};
            if (poll(&ready,1,100) <= 0) continue;
            peer = accept(listener,NULL,NULL);
            if (peer >= 0 && agentPeer(peer)) break;
            if (peer >= 0) fprintf(stderr,"Elevenex Agent rejected an unrecognized desktop peer.\n");
            if (peer >= 0) close(peer);
            peer = -1;
        }
        if (peer < 0) {
            fprintf(stderr,"Elevenex Agent did not connect to the desktop (launcher %s).\n",open.running ? "still starting" : open.terminationStatus == 0 ? "completed" : "failed");
            if (open.running) [open terminate]; return 25;
        }
        unlink(path.fileSystemRepresentation);
        rmdir(directory);
        fcntl(peer,F_SETFD,FD_CLOEXEC);
        connectionTimeout(peer,5);
        // Only capture authority crosses this channel. User programs keep their
        // original supervisor, cwd, environment, stdio and filesystem authority.
        int count = capturing ? 1 : 0;
        if (capturing && fcntl(displayDescriptor,F_GETFD) < 0) return 25;
        char control[CMSG_SPACE(sizeof(int))] = {0};
        uint8_t header[5] = {(uint8_t)count};
        uint32_t length = htonl((uint32_t)request.length);
        memcpy(header+1,&length,sizeof(length));
        struct iovec data = {.iov_base=header,.iov_len=sizeof(header)};
        struct msghdr message = {.msg_iov=&data,.msg_iovlen=1};
        if (capturing) {
            message.msg_control = control; message.msg_controllen = sizeof(control);
            struct cmsghdr *rights = CMSG_FIRSTHDR(&message);
            rights->cmsg_level = SOL_SOCKET; rights->cmsg_type = SCM_RIGHTS; rights->cmsg_len = CMSG_LEN(sizeof(int));
            memcpy(CMSG_DATA(rights),&displayDescriptor,sizeof(int));
        }
        if (sendmsg(peer,&message,0) != sizeof(header) || !transferBytes(peer,(void *)request.bytes,request.length,YES)) {
            fprintf(stderr,"Elevenex Agent could not transfer its desktop connection.\n"); return 25;
        }
        connectionTimeout(peer,0);
        // The GUI capture helper exits when this authenticated owner disconnects.
        // The original supervisor remains responsible for draining user processes.
        CFAbsoluteTime replyDeadline = CFAbsoluteTimeGetCurrent()+2;
        for (;;) {
            if (interrupted || (!capturing && CFAbsoluteTimeGetCurrent() > replyDeadline)) {
                shutdown(peer,SHUT_RDWR);
                // A preflight can be blocked inside a system API, before it has
                // a run loop watching its owner. Bound and retire that probe.
                if (!capturing && agentPeer(peer)) {
                    pid_t pid = 0; socklen_t size = sizeof(pid);
                    if (!getsockopt(peer,SOL_LOCAL,LOCAL_PEERPID,&pid,&size) && pid > 1) kill(pid,SIGTERM);
                }
                break;
            }
            struct pollfd ready = {.fd=peer,.events=POLLIN};
            if (poll(&ready,1,100) <= 0) continue;
            uint8_t code;
            if (recv(peer,&code,1,0) == 1) result = code;
            break;
        }
    } @finally {
        if (peer >= 0) close(peer);
        close(listener);
        unlink(path.fileSystemRepresentation);
        rmdir(directory);
        sigaction(SIGTERM,&previousTerm,NULL);
        sigaction(SIGINT,&previousInt,NULL);
        sigaction(SIGHUP,&previousHup,NULL);
    }
    return result;
}

static BOOL plainString(id value) {
    return [value isKindOfClass:NSString.class] && [value rangeOfString:[NSString stringWithFormat:@"%C",(unichar)0]].location == NSNotFound;
}

AgentDesktopInvocation *connectAgentDesktop(const char *path) {
    if (!path || strlen(path) >= sizeof(((struct sockaddr_un *)0)->sun_path)) return nil;
    // No file contents are trusted. Mutual peer-PID checks require the exact
    // installed agent executable, running as this user, at both ends.
    struct sockaddr_un address = {.sun_family=AF_UNIX};
    strlcpy(address.sun_path,path,sizeof(address.sun_path)); address.sun_len = SUN_LEN(&address);
    int socketFD = socket(AF_UNIX,SOCK_STREAM,0);
    if (socketFD < 0) return nil;
    int peer = fcntl(socketFD,F_DUPFD_CLOEXEC,20); close(socketFD);
    if (peer < 0) return nil;
    NSMutableArray<NSNumber *> *received = [NSMutableArray array];
    BOOL accepted = NO;
    @try {
        connectionTimeout(peer,5);
        if (connect(peer,(struct sockaddr *)&address,address.sun_len) || !agentPeer(peer)) { NSLog(@"Elevenex Agent desktop peer could not be verified"); return nil; }
        char control[CMSG_SPACE(sizeof(int))] = {0};
        uint8_t header[5];
        struct iovec data = {.iov_base=header,.iov_len=sizeof(header)};
        struct msghdr message = {.msg_iov=&data,.msg_iovlen=1,.msg_control=control,.msg_controllen=sizeof(control)};
        ssize_t bytes = recvmsg(peer,&message,MSG_WAITALL);
        for (struct cmsghdr *rights = CMSG_FIRSTHDR(&message); rights; rights = CMSG_NXTHDR(&message,rights)) {
            if (rights->cmsg_level != SOL_SOCKET || rights->cmsg_type != SCM_RIGHTS || rights->cmsg_len < CMSG_LEN(0)) continue;
            NSUInteger count = (rights->cmsg_len-CMSG_LEN(0))/sizeof(int);
            int *fds = (int *)CMSG_DATA(rights);
            for (NSUInteger index=0; index<count; index++) [received addObject:@(fds[index])];
        }
        if (bytes != sizeof(header) || (message.msg_flags & (MSG_CTRUNC|MSG_TRUNC))) { NSLog(@"Elevenex Agent desktop descriptors were incomplete"); return nil; }
        uint32_t length; memcpy(&length,header+1,sizeof(length)); length = ntohl(length);
        if (!length || length > maxRequest || received.count != header[0]) { NSLog(@"Elevenex Agent desktop request has an invalid length"); return nil; }
        NSMutableData *body = [NSMutableData dataWithLength:length];
        if (!transferBytes(peer,body.mutableBytes,length,NO)) return nil;
        NSDictionary *request = [NSJSONSerialization JSONObjectWithData:body options:0 error:NULL];
        if (![request isKindOfClass:NSDictionary.class]) return nil;
        NSArray *arguments = request[@"arguments"];
        if (![arguments isKindOfClass:NSArray.class] || !arguments.count || arguments.count > 2) return nil;
        for (id argument in arguments) if (!plainString(argument)) return nil;
        BOOL capturing = [arguments[0] isEqual:@"--capture-owned"] && arguments.count == 2;
        if (!capturing && !(arguments.count == 1 && [arguments[0] isEqual:@"--check"])) return nil;
        if (header[0] != (capturing ? 1 : 0)) return nil;
        // Keep the descriptor at its received, free number. Foundation and
        // libdispatch already own low descriptors in this LaunchServices app.
        if (capturing) fcntl(received[0].intValue,F_SETFD,FD_CLOEXEC);
        connectionTimeout(peer,0);
        AgentDesktopInvocation *invocation = [AgentDesktopInvocation new];
        invocation.owner = peer; invocation.arguments = arguments;
        invocation.display = capturing ? received[0].intValue : -1;
        accepted = YES;
        return invocation;
    } @finally {
        if (!accepted) for (NSNumber *fd in received) close(fd.intValue);
        if (!accepted) close(peer);
    }
}
