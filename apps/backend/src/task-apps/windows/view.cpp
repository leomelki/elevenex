#include "platform.h"
#include "control.h"
#include <d3d11.h>
#include <dxgi.h>
#include <dwmapi.h>
#include <sddl.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <algorithm>
#include <iostream>
#include <utility>

namespace apphost {
using namespace winrt;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;
using winrt::Windows::Graphics::SizeInt32;
using winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
using DeviceAccess = ::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess;

struct WindowGeometry { RECT bounds; UINT dpi; };

static WindowGeometry windowGeometry(HWND window) {
    RECT bounds{};
    require(SUCCEEDED(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &bounds, sizeof(bounds))),
            "App geometry unavailable");
    return {bounds, GetDpiForWindow(window)};
}

static bool sameExtent(const WindowGeometry& a, const WindowGeometry& b) {
    return a.bounds.right - a.bounds.left == b.bounds.right - b.bounds.left &&
           a.bounds.bottom - a.bounds.top == b.bounds.bottom - b.bounds.top && a.dpi == b.dpi;
}

static bool sameSize(SizeInt32 left, SizeInt32 right) {
    return left.Width == right.Width && left.Height == right.Height;
}

static void requireCaptureSize(SizeInt32 size) {
    require(size.Width > 1 && size.Height > 1 && size.Width <= 8192 && size.Height <= 8192 &&
        static_cast<long long>(size.Width) * size.Height <= 16777216, "App window exceeds capture limits");
}

static Direct3D11CaptureFrame latestCaptureFrame(const Direct3D11CaptureFramePool& pool) {
    auto frame = pool.TryGetNextFrame();
    // The pool holds two frames. Discard a superseded surface before readback.
    if (frame) {
        if (auto latest = pool.TryGetNextFrame()) return latest;
    }
    return frame;
}

static Direct3D11CaptureFrame firstCaptureFrame(const Direct3D11CaptureFramePool& pool,
    const IDirect3DDevice& device, HANDLE job, HWND window, SizeInt32& size, WindowGeometry& geometry) {
    const auto deadline = GetTickCount64() + 10'000;
    while (GetTickCount64() < deadline) {
        if (!interactive()) throw DisplayError(20, "Sign in and unlock the intended Windows session");
        if (!owned(job, window) || !IsWindowVisible(window) || !IsWindowEnabled(window) || IsIconic(window))
            throw DisplayError(22, "Waiting for an owned app window; retry when the app is visible");
        if (auto frame = latestCaptureFrame(pool)) {
            const auto currentGeometry = windowGeometry(window);
            const auto measured = frame.ContentSize();
            if (measured.Width > 1 && measured.Height > 1) {
                if (sameSize(measured, size) && sameExtent(geometry, currentGeometry)) return frame;
                // The window can settle at a different size while the capture
                // session starts. Configure the encoder from a complete frame.
                requireCaptureSize(measured);
                frame.Close();
                pool.Recreate(device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, measured);
                size = measured;
                geometry = currentGeometry;
            }
        }
        Sleep(5);
    }
    throw std::runtime_error("Windows Graphics Capture did not produce an initial app frame");
}

bool captureSupported() {
    winrt::init_apartment(apartment_type::multi_threaded);
    return GraphicsCaptureSession::IsSupported();
}

struct Target { HANDLE job; HWND window = nullptr; };
static BOOL CALLBACK pickWindow(HWND window, LPARAM data) {
    auto& target = *reinterpret_cast<Target*>(data);
    RECT rect{};
    DWORD cloaked = 0;
    DwmGetWindowAttribute(window,DWMWA_CLOAKED,&cloaked,sizeof(cloaked));
    if (!cloaked && IsWindowVisible(window) && !IsIconic(window) && IsWindowEnabled(window)
        && GetWindowRect(window,&rect) && rect.right-rect.left > 1 && rect.bottom-rect.top > 1
        && owned(target.job,window)) {
        target.window = window;
        return FALSE;
    }
    return TRUE;
}

static bool readControls(std::string& buffer, WindowInput& input, const RECT& rect) {
    HANDLE pipe = GetStdHandle(STD_INPUT_HANDLE);
    DWORD amount = 0;
    if (!PeekNamedPipe(pipe,nullptr,0,nullptr,&amount,nullptr)) return false;
    if (!amount) return true;
    char bytes[4096];
    if (!ReadFile(pipe,bytes,std::min<DWORD>(amount,sizeof(bytes)),&amount,nullptr) || !amount) return false;
    buffer.append(bytes,amount);
    require(buffer.size() < 16384,"Control command exceeded limit");
    size_t end;
    while ((end=buffer.find('\n'))!=std::string::npos) {
        std::istringstream command(buffer.substr(0,end));
        buffer.erase(0,end+1);
        uint32_t id=0;
        if (!(command >> id) || !id) return false;
        std::cout << "ack " << id << " " << (input.apply(command,rect) ? 1 : 0) << std::endl;
    }
    return true;
}

int view(const std::wstring& id, const std::wstring& pipeId) {
    if (!interactive() || !captureSupported()) throw DisplayError(20, "Unlock the Windows graphical session to stream this app");
    Handle job(OpenJobObjectW(JOB_OBJECT_QUERY,FALSE,jobName(id).c_str()));
    require(job.get(), "App job is unavailable");
    Target target{job.get()};
    for (int attempt=0; !target.window && attempt<150; ++attempt) {
        EnumWindows(pickWindow,reinterpret_cast<LPARAM>(&target));
        if (!target.window) Sleep(100);
    }
    if (!target.window) throw DisplayError(22,"Waiting for an owned app window; retry when the app is visible");
    com_ptr<ID3D11Device> d3d;
    com_ptr<ID3D11DeviceContext> context;
    HRESULT result = D3D11CreateDevice(nullptr,D3D_DRIVER_TYPE_HARDWARE,nullptr,D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        nullptr,0,D3D11_SDK_VERSION,d3d.put(),nullptr,context.put());
    if (FAILED(result)) check_hresult(D3D11CreateDevice(nullptr,D3D_DRIVER_TYPE_WARP,nullptr,D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        nullptr,0,D3D11_SDK_VERSION,d3d.put(),nullptr,context.put()));
    com_ptr<::IInspectable> surfaceDevice;
    check_hresult(CreateDirect3D11DeviceFromDXGIDevice(d3d.as<IDXGIDevice>().get(),surfaceDevice.put()));
    auto interop=get_activation_factory<GraphicsCaptureItem,IGraphicsCaptureItemInterop>();
    GraphicsCaptureItem item{nullptr};
    check_hresult(interop->CreateForWindow(target.window,winrt::guid_of<GraphicsCaptureItem>(),winrt::put_abi(item)));
    auto size=item.Size();
    requireCaptureSize(size);
    const auto device = surfaceDevice.as<IDirect3DDevice>();
    auto pool=Direct3D11CaptureFramePool::CreateFreeThreaded(device, DirectXPixelFormat::B8G8R8A8UIntNormalized,2,size);
    auto session=pool.CreateCaptureSession(item);
    auto initialGeometry = windowGeometry(target.window);
    session.StartCapture();
    auto firstFrame = firstCaptureFrame(pool, device, job.get(), target.window, size, initialGeometry);
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width=size.Width; desc.Height=size.Height; desc.MipLevels=1; desc.ArraySize=1;
    desc.Format=DXGI_FORMAT_B8G8R8A8_UNORM; desc.SampleDesc.Count=1;
    desc.Usage=D3D11_USAGE_STAGING; desc.CPUAccessFlags=D3D11_CPU_ACCESS_READ;
    com_ptr<ID3D11Texture2D> cpu;
    check_hresult(d3d->CreateTexture2D(&desc,nullptr,cpu.put()));
    require(pipeId.size()==36 && pipeId.find_first_not_of(L"0123456789abcdef-")==std::wstring::npos,"Invalid app encoder pipe");
    const auto path=L"\\\\.\\pipe\\elevenex-app-video-"+pipeId;
    PSECURITY_DESCRIPTOR sd=nullptr;
    require(ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(A;;GA;;;OW)",SDDL_REVISION_1,&sd,nullptr),
            "Could not create private encoder pipe permissions");
    SECURITY_ATTRIBUTES permissions{sizeof(SECURITY_ATTRIBUTES),sd,FALSE};
    Handle video(CreateNamedPipeW(path.c_str(),PIPE_ACCESS_OUTBOUND|FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_BYTE|PIPE_WAIT|PIPE_REJECT_REMOTE_CLIENTS,1,256*1024,4096,0,&permissions));
    LocalFree(sd);
    require(video.get()!=INVALID_HANDLE_VALUE, "Could not open private encoder pipe");
    std::cout<<"ready "<<size.Width<<" "<<size.Height<<std::endl;
    require(ConnectNamedPipe(video.get(),nullptr) || GetLastError()==ERROR_PIPE_CONNECTED, "Could not connect the app encoder");
    WindowInput input(job.get(),target.window,size.Width,size.Height);
    std::string controls;
    std::vector<BYTE> pixels(static_cast<size_t>(size.Width)*size.Height*4);
    bool haveFrame=false;
    ULONGLONG last=0;
    while (interactive() && owned(job.get(),target.window) && IsWindowVisible(target.window)
           && IsWindowEnabled(target.window) && !IsIconic(target.window)) {
        HWND foreground=GetForegroundWindow();
        if (foreground && foreground != target.window && IsWindowVisible(foreground)
            && IsWindowEnabled(foreground) && owned(job.get(), foreground))
            throw DisplayError(23,"Another owned app window became active");
        const auto geometry = windowGeometry(target.window);
        // Geometry changes before FrameArrived. An input event from the last
        // painted frame must never be scaled to the newly resized window.
        if (!sameExtent(geometry, initialGeometry))
            throw DisplayError(23, "App window resized");
        if (haveFrame && !readControls(controls,input,geometry.bounds)) break;
        const auto now=GetTickCount64();
        if (now-last < 33) { Sleep(5); continue; }
        auto frame=firstFrame ? std::exchange(firstFrame, nullptr) : latestCaptureFrame(pool);
        if (!frame && (!haveFrame || now - last < 1000)) {Sleep(5); continue;}
        if (frame) {
            if (!sameSize(frame.ContentSize(), size)) throw DisplayError(23,"App capture frame size changed");
            auto access=frame.Surface().as<DeviceAccess>();
            com_ptr<ID3D11Texture2D> texture;
            check_hresult(access->GetInterface(__uuidof(ID3D11Texture2D),texture.put_void()));
            context->CopyResource(cpu.get(),texture.get());
            D3D11_MAPPED_SUBRESOURCE map{};
            check_hresult(context->Map(cpu.get(),0,D3D11_MAP_READ,0,&map));
            for (int y=0; y<size.Height; ++y) memcpy(pixels.data()+size_t(y)*size.Width*4,
                static_cast<const BYTE*>(map.pData)+size_t(y)*map.RowPitch,size.Width*4);
            context->Unmap(cpu.get(),0);
            haveFrame=true;
        }
        DWORD written=0;
        require(WriteFile(video.get(),pixels.data(),static_cast<DWORD>(pixels.size()),&written,nullptr)
            && written==pixels.size(),"App encoder disconnected");
        last=now;
    }
    session.Close(); pool.Close();
    if (!interactive()) throw DisplayError(20,"Sign in and unlock the intended Windows session");
    if (!IsWindowEnabled(target.window) || IsIconic(target.window) || !IsWindowVisible(target.window))
        throw DisplayError(23,"App window or display geometry changed; reopen the stream");
    return 0;
}
}
