#include "platform.h"
#include <iostream>
#include <memory>

namespace apphost {
// CreateProcess uses one command line. Follow the Windows CRT quoting rules,
// keeping backslashes before quotes and at the end of arguments unambiguous.
static std::wstring quote(const std::wstring& value) {
    std::wstring result = L"\"";
    size_t slashes = 0;
    for (wchar_t ch : value) {
        if (ch == L'\\') { slashes++; continue; }
        if (ch == L'"') result.append(slashes + 1, L'\\');
        result.append(slashes, L'\\');
        result += ch;
        slashes = 0;
    }
    result.append(slashes * 2, L'\\');
    return result + L"\"";
}

int launch(const std::wstring& id, int count, wchar_t** args, bool needsDesktop) {
    require(!needsDesktop || interactive(), "Sign in and unlock the intended Windows user session");
    // The backend commits its recovery record before sending GO. A disconnect
    // or cleanup race before this point must never create the user's process.
    for (char expected : std::string("GO\n")) {
        char value = 0;
        DWORD read = 0;
        if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), &value, 1, &read, nullptr) || read != 1) return 0;
        require(value == expected, "Invalid app launch gate");
    }
    Handle job(CreateJobObjectW(nullptr, jobName(id).c_str()));
    require(job.get() && GetLastError() != ERROR_ALREADY_EXISTS, "Could not create an owned app job");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    require(SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits)),
            "Could not configure app process cleanup");
    std::wstring command;
    for (int i = 0; i < count; ++i) {
        if (i) command += L' ';
        command += quote(args[i]);
    }
    SECURITY_ATTRIBUTES inheritable{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    Handle noInput(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                              &inheritable, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    HANDLE log = nullptr;
    require(DuplicateHandle(GetCurrentProcess(), GetStdHandle(STD_ERROR_HANDLE), GetCurrentProcess(),
                           &log, 0, TRUE, DUPLICATE_SAME_ACCESS), "Could not create app log");
    Handle logOwner(log);
    // Atomically attach the job at process creation. A helper crash between
    // CreateProcess and assignment must never leave a suspended orphan.
    SIZE_T attrBytes = 0;
    InitializeProcThreadAttributeList(nullptr, 2, 0, &attrBytes);
    std::vector<BYTE> storage(attrBytes);
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = noInput.get();
    startup.StartupInfo.hStdOutput = log;
    startup.StartupInfo.hStdError = log;
    startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    require(InitializeProcThreadAttributeList(startup.lpAttributeList, 2, 0, &attrBytes), "Could not configure app job");
    struct FreeAttrs { LPPROC_THREAD_ATTRIBUTE_LIST ptr; ~FreeAttrs() { DeleteProcThreadAttributeList(ptr); } } attrs{startup.lpAttributeList};
    HANDLE handles[] = {noInput.get(), log};
    HANDLE jobs[] = {job.get()};
    require(UpdateProcThreadAttribute(attrs.ptr, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, sizeof(handles), nullptr, nullptr)
         && UpdateProcThreadAttribute(attrs.ptr, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs, sizeof(jobs), nullptr, nullptr),
            "Cannot contain this launch in a Windows Job Object");
    PROCESS_INFORMATION info{};
    require(CreateProcessW(nullptr, command.data(), nullptr, nullptr, TRUE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, nullptr, nullptr, &startup.StartupInfo, &info),
        "Could not launch executable in the Windows session");
    Handle process(info.hProcess), thread(info.hThread);
    std::cout << "ready" << std::endl;
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    while (true) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
        require(QueryInformationJobObject(job.get(), JobObjectBasicAccountingInformation,
                &accounting, sizeof(accounting), nullptr), "Could not check app job");
        if (!accounting.ActiveProcesses) break;
        DWORD available = 0;
        if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr) || available) {
            require(TerminateJobObject(job.get(), 0), "Could not stop app processes");
        }
        Sleep(100);
    }
    DWORD exit = 0;
    GetExitCodeProcess(process.get(), &exit);
    return static_cast<int>(exit);
}
}
