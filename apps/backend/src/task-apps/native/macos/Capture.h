#include <sys/types.h>

// The caller owns the group. owner is the mutually authenticated native
// supervisor socket, or -1 for the legacy in-process capture entry point.
int runAppCapture(pid_t group, int displayDescriptor, int owner);
