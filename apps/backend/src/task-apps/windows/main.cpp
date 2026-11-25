#include "platform.h"
#include <iostream>
#include <shellapi.h>
#include <tlhelp32.h>
#include <thread>
#include <winrt/base.h>

// Closing backend pipes normally releases the run. Monitor the actual parent
// too: a capture worker can be blocked waiting for its FFmpeg named-pipe peer.
static void stopWithParent() {
    apphost::Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
    apphost::require(snapshot.get() != INVALID_HANDLE_VALUE, "Could not identify the app supervisor");
    PROCESSENTRY32W entry{sizeof(entry)};
    DWORD parentId = 0;
    if (Process32FirstW(snapshot.get(), &entry)) {
        do {
            if (entry.th32ProcessID == GetCurrentProcessId()) {
                parentId = entry.th32ParentProcessID;
                break;
            }
        } while (Process32NextW(snapshot.get(), &entry));
    }
    apphost::require(parentId != 0, "App supervisor exited");
    HANDLE parent = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, parentId);
    apphost::require(parent != nullptr, "App supervisor exited");
    FILETIME parentStart{}, selfStart{}, exit{}, kernel{}, user{};
    apphost::require(GetProcessTimes(parent,&parentStart,&exit,&kernel,&user)
        && GetProcessTimes(GetCurrentProcess(),&selfStart,&exit,&kernel,&user)
        && CompareFileTime(&parentStart,&selfStart)<=0, "App supervisor identity changed");
    std::thread([parent] {
        WaitForSingleObject(parent, INFINITE);
        CloseHandle(parent);
        // This closes job and pipe handles even if a media thread is stalled.
        TerminateProcess(GetCurrentProcess(), 0);
    }).detach();
}

int wmain(int argc, wchar_t** argv) {
    try {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        if (argc == 2 && std::wstring(argv[1]) == L"--about-settings") {
            if (!apphost::interactive()) throw apphost::DisplayError(20,"No interactive Windows desktop");
            const auto opened = ShellExecuteW(nullptr, L"open", L"ms-settings:about", nullptr, nullptr, SW_SHOWNORMAL);
            apphost::require(reinterpret_cast<INT_PTR>(opened) > 32, "Could not open Windows Settings");
            return 0;
        }
        if (argc == 2 && std::wstring(argv[1]) == L"--check") {
            if (!apphost::interactive()) throw apphost::DisplayError(20,"No interactive Windows desktop");
            apphost::require(apphost::captureSupported(), "Windows Graphics Capture is unavailable in this session");
            return 0;
        }
        // Validate the shipped binary's atomic job attachment even on a
        // headless build worker. This mode only launches this fixed diagnostic.
        if (argc == 3 && std::wstring(argv[1]) == L"--job-drained") {
            const auto name = apphost::jobName(argv[2]);
            apphost::Handle job(OpenJobObjectW(JOB_OBJECT_QUERY, FALSE, name.c_str()));
            if (!job.get()) {
                apphost::require(GetLastError() == ERROR_FILE_NOT_FOUND, "Could not open app job for recovery");
                std::cout << "drained\n";
                return 0;
            }
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
            apphost::require(QueryInformationJobObject(job.get(), JobObjectBasicAccountingInformation,
                &accounting, sizeof(accounting), nullptr), "Could not check app job for recovery");
            std::cout << (accounting.ActiveProcesses ? "active\n" : "drained\n");
            return 0;
        }
        const std::wstring mode = argc > 1 ? argv[1] : L"";
        if (argc == 3 && (mode == L"--verify-job" || mode == L"--verify-job-hold")) {
            wchar_t executable[32768]{}, flag[]=L"--verify-member", hold[]=L"--verify-member-hold";
            DWORD length=GetModuleFileNameW(nullptr,executable,32768);
            apphost::require(length && length<32768,"Could not identify helper executable");
            wchar_t* args[]={executable, mode == L"--verify-job-hold" ? hold : flag, argv[2]};
            return apphost::launch(argv[2],3,args,false);
        }
        if (argc == 3 && (mode == L"--verify-member" || mode == L"--verify-member-hold")) {
            {
                apphost::Handle job(OpenJobObjectW(JOB_OBJECT_QUERY,FALSE,apphost::jobName(argv[2]).c_str()));
                BOOL member=FALSE;
                apphost::require(job.get() && IsProcessInJob(GetCurrentProcess(),job.get(),&member) && member,
                                 "The diagnostic child is outside its job");
            }
            std::cout << "contained" << std::endl;
            if (mode == L"--verify-member-hold") Sleep(30'000);
            return 0;
        }
        if (argc >= 4 && std::wstring(argv[1]) == L"--launch") return apphost::launch(argv[2], argc - 3, argv + 3);
        if (argc == 4 && std::wstring(argv[1]) == L"--view") {
            stopWithParent();
            return apphost::view(argv[2], argv[3]);
        }
        return 2;
    } catch (const apphost::DisplayError& error) {
        std::cerr << error.what() << std::endl;
        return error.status;
    } catch (const winrt::hresult_error& error) {
        std::cerr << "Windows app display operation failed (" << std::hex << error.code().value << ")" << std::endl;
        if (error.code().value == E_ACCESSDENIED) return 20;
    } catch (const std::exception& error) {
        std::cerr << error.what() << std::endl;
    }
    return 1;
}
