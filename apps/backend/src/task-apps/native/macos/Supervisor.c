// This module deliberately has no ScreenCaptureKit or UI authority. Only a
// live child group established here can subsequently be selected by the helper.
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;
static pid_t group;
static int runDirectory = -1;
static char desktopDirectory[PATH_MAX];
void setSupervisorDesktopDirectory(const char *path) { strlcpy(desktopDirectory,path,sizeof(desktopDirectory)); }
static void acknowledgeDrain(void) {
    // A fast-exiting launcher can end the supervisor before LaunchServices
    // connects. This directory is registered before the monitor thread starts.
    if (desktopDirectory[0]) {
        char socketPath[PATH_MAX];
        snprintf(socketPath,sizeof(socketPath),"%s/owner",desktopDirectory);
        unlink(socketPath);
        rmdir(desktopDirectory);
    }
    if (runDirectory < 0) return;
    int marker = openat(runDirectory, ".supervisor-drained", O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (marker >= 0) close(marker);
    close(runDirectory);
    runDirectory = -1;
}
static volatile sig_atomic_t stopping;
static void requestStop(int sig) { (void)sig; stopping = 1; }
void stopOwnedGroup(void) { stopping = 1; for (;;) pause(); }
static double now(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec + 0.000000001 * t.tv_nsec;
}
static void *monitor(void *unused) {
    (void)unused;
    int code = 0;
    double stopTime = 0;
    int rootExited = 0;
    for (;;) {
        int status = 0;
        if (!rootExited && waitpid(group, &status, WNOHANG) == group) {
            rootExited = 1;
            code = WIFEXITED(status) ? WEXITSTATUS(status) : WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 1;
        }
        if (rootExited && kill(-group, 0) < 0 && errno == ESRCH) { acknowledgeDrain(); _exit(code); }
        if (stopping && !stopTime) { kill(-group, SIGTERM); stopTime = now(); }
        if (stopTime && now() - stopTime > 1.25) kill(-group, SIGKILL);
        if (stopping) {
            struct timespec delay = {0, 50000000};
            nanosleep(&delay, NULL);
        } else {
            struct pollfd owner = {STDIN_FILENO, POLLIN, 0};
            if (poll(&owner, 1, 250) > 0) stopping = 1;
        }
    }
}
pid_t launchOwnedGroup(char **command) {
    if (!command || !command[0] || fcntl(3, F_GETFD) == -1 || fcntl(4, F_GETFD) == -1) return -1;
    // The backend releases this gate only after recording our process identity.
    // Read exactly three bytes; subsequent EOF remains the run lifetime signal.
    char gate[3];
    for (size_t offset = 0; offset < sizeof(gate);) {
        ssize_t n = read(STDIN_FILENO, gate + offset, sizeof(gate) - offset);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return -1;
        offset += (size_t)n;
    }
    if (memcmp(gate, "GO\n", sizeof(gate))) return -1;
    posix_spawn_file_actions_t files;
    posix_spawnattr_t attr;
    if (posix_spawn_file_actions_init(&files) || posix_spawnattr_init(&attr)) return -1;
    int error = posix_spawn_file_actions_addopen(&files, STDIN_FILENO, "/dev/null", O_RDONLY, 0);
    if (!error) error = posix_spawn_file_actions_addclose(&files, 3);
    if (!error) error = posix_spawn_file_actions_addclose(&files, 4);
    if (!error) error = posix_spawnattr_setpgroup(&attr, 0);
    if (!error) error = posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETPGROUP);
    if (!error && getenv("ELEVENEX_TASK_APP_DRAIN_PROOF")) {
        const char *directory = getenv("ELEVENEX_TASK_APP_RUNTIME_DIR");
        if (!directory || (runDirectory = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)) < 0 ||
            unlinkat(runDirectory, ".supervisor-drained", 0) < 0) error = EACCES;
        unsetenv("ELEVENEX_TASK_APP_DRAIN_PROOF");
    }
    if (!error) error = posix_spawnp(&group, command[0], &files, &attr, command, environ);
    posix_spawn_file_actions_destroy(&files);
    posix_spawnattr_destroy(&attr);
    if (error) { acknowledgeDrain(); fprintf(stderr, "Could not start task app: %s\n", strerror(error)); return -1; }
    signal(SIGTERM, requestStop); signal(SIGHUP, requestStop); signal(SIGINT, requestStop);
    signal(SIGPIPE, SIG_IGN);
    if (dprintf(3, "{\"kind\":\"ready\",\"group\":%d}\n", group) < 0) stopping = 1;
    close(3);
    pthread_t thread;
    if (pthread_create(&thread, NULL, monitor, NULL)) { kill(-group, SIGKILL); return -1; }
    pthread_detach(thread);
    return group;
}
