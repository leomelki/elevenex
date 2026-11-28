#pragma once
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string>
#include <stdexcept>
#include <vector>

namespace apphost {
class Handle {
    HANDLE value_;
public:
    explicit Handle(HANDLE value = nullptr) : value_(value) {}
    ~Handle() { if (value_ && value_ != INVALID_HANDLE_VALUE) CloseHandle(value_); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    HANDLE get() const { return value_; }
};

class DisplayError : public std::runtime_error {
public:
    const int status;
    DisplayError(int code, const char* message): std::runtime_error(message), status(code) {}
};

inline void require(bool valid, const char* message) {
    if (!valid) throw std::runtime_error(message);
}

inline bool interactive() {
    DWORD id = 0;
    if (!ProcessIdToSessionId(GetCurrentProcessId(), &id) || !id) return false;
    HDESK input = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
    if (!input) return false;
    wchar_t current[128]{}, active[128]{};
    DWORD needed = 0;
    bool same = GetUserObjectInformationW(GetThreadDesktop(GetCurrentThreadId()), UOI_NAME, current, sizeof(current), &needed)
        && GetUserObjectInformationW(input, UOI_NAME, active, sizeof(active), &needed)
        && _wcsicmp(current, active) == 0;
    CloseDesktop(input);
    return same;
}

inline bool owned(HANDLE job, HWND window) {
    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
    BOOL member = FALSE;
    return process.get() && IsProcessInJob(process.get(), job, &member) && member;
}

inline std::wstring jobName(const std::wstring& id) {
    require(id.size() == 36 && id.find_first_not_of(L"0123456789abcdef-") == std::wstring::npos, "Invalid app run ID");
    return L"Local\\ElevenexTaskApp-" + id;
}

int launch(const std::wstring& id, int count, wchar_t** args, bool needsDesktop = true);
int view(const std::wstring& id, const std::wstring& pipe);
bool captureSupported();
}
