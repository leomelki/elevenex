#pragma once
#include "platform.h"
#include <set>
#include <sstream>
#include <windowsx.h>

namespace apphost {
class WindowInput {
    HANDLE job_;
    HWND root_;
    HWND mouse_ = nullptr, keyboard_ = nullptr;
    std::set<UINT> pressedKeys_;
    std::set<unsigned> pressedButtons_;
    int width_, height_;

    bool target(HWND window) const {
        return window && (window == root_ || IsChild(root_, window)) && owned(job_, window);
    }
    HWND keyboardTarget() const {
        GUITHREADINFO state{sizeof(state)};
        GetGUIThreadInfo(GetWindowThreadProcessId(root_, nullptr), &state);
        return target(state.hwndFocus) ? state.hwndFocus : root_;
    }
    bool key(HWND window, UINT vk, bool down) {
        if (!target(window)) return false;
        const UINT scan = MapVirtualKeyW(vk, MAPVK_VK_TO_VSC_EX);
        LPARAM flags = 1 | ((scan & 255) << 16);
        if (scan & 0xff00) flags |= 1 << 24;
        if (!down) flags |= static_cast<LPARAM>(3u << 30);
        return PostMessageW(window, down ? WM_KEYDOWN : WM_KEYUP, vk, flags);
    }
    WPARAM mouseState() const {
        WPARAM result = 0;
        if (pressedButtons_.count(0)) result |= MK_LBUTTON;
        if (pressedButtons_.count(1)) result |= MK_MBUTTON;
        if (pressedButtons_.count(2)) result |= MK_RBUTTON;
        if (pressedKeys_.count(VK_SHIFT) || pressedKeys_.count(VK_LSHIFT) || pressedKeys_.count(VK_RSHIFT)) result |= MK_SHIFT;
        if (pressedKeys_.count(VK_CONTROL) || pressedKeys_.count(VK_LCONTROL) || pressedKeys_.count(VK_RCONTROL)) result |= MK_CONTROL;
        return result;
    }
    static UINT buttonMessage(unsigned button, bool down) {
        constexpr UINT messages[][2] = {{WM_LBUTTONUP, WM_LBUTTONDOWN}, {WM_MBUTTONUP, WM_MBUTTONDOWN}, {WM_RBUTTONUP, WM_RBUTTONDOWN}};
        return messages[button][down];
    }
public:
    WindowInput(HANDLE job, HWND root, int width, int height): job_(job), root_(root), width_(width), height_(height) {}
    void release() {
        // Never deliver even a synthetic key-up across a focus/desktop boundary.
        if (interactive() && target(root_)) {
            for (auto vk : pressedKeys_) key(keyboard_, vk, false);
            for (auto button : pressedButtons_) if (target(mouse_)) PostMessageW(mouse_, buttonMessage(button, false), 0, 0);
        }
        pressedKeys_.clear(); pressedButtons_.clear(); mouse_ = nullptr; keyboard_ = nullptr;
    }
    ~WindowInput() { release(); }
    bool apply(std::istringstream& command, const RECT& bounds) {
        std::string kind;
        command >> kind;
        if (kind == "release") { release(); return true; }
        if (!interactive() || !target(root_) || !IsWindowEnabled(root_) || !IsWindowVisible(root_) || IsIconic(root_)) return false;
        if (kind == "key") {
            unsigned vk, down;
            if (!(command >> vk >> down) || !vk || vk > 254 || down > 1) return false;
            if (pressedKeys_.empty()) keyboard_ = keyboardTarget();
            if (!key(keyboard_, vk, down != 0)) return false;
            if (down) pressedKeys_.insert(vk); else pressedKeys_.erase(vk);
            return true;
        }
        if (kind == "text") {
            std::string units; command >> units;
            if (units.empty() || units.size() > 1024 || units.size() % 4 || units.find_first_not_of("0123456789abcdef") != std::string::npos) return false;
            HWND window = keyboardTarget();
            for (size_t i=0; i<units.size(); i+=4) {
                const wchar_t unit = static_cast<wchar_t>(std::stoul(units.substr(i,4), nullptr,16));
                if (!target(window) || !PostMessageW(window,WM_CHAR,unit,1)) return false;
            }
            return true;
        }
        int x,y;
        if (!(command >> x >> y) || x<0 || y<0 || x>=width_ || y>=height_) return false;
        POINT screen{bounds.left+MulDiv(x,bounds.right-bounds.left,width_), bounds.top+MulDiv(y,bounds.bottom-bounds.top,height_)};
        HWND hit = root_;
        for (int depth=0; depth<24; ++depth) {
            POINT local = screen;
            ScreenToClient(hit, &local);
            HWND child = ChildWindowFromPointEx(hit,local,CWP_SKIPDISABLED|CWP_SKIPINVISIBLE|CWP_SKIPTRANSPARENT);
            if (!child || child==hit || !target(child)) break;
            hit=child;
        }
        if (pressedButtons_.empty()) mouse_=hit;
        if (!target(mouse_)) return false;
        POINT local=screen;
        ScreenToClient(mouse_, &local);
        LPARAM position = MAKELPARAM(local.x,local.y);
        if (kind=="move") return PostMessageW(mouse_, WM_MOUSEMOVE, mouseState(), position);
        if (kind=="down" || kind=="up") {
            unsigned button;
            if (!(command >> button) || button > 2) return false;
            const bool down = kind=="down";
            if (down) pressedButtons_.insert(button); else pressedButtons_.erase(button);
            return PostMessageW(mouse_,buttonMessage(button,down),mouseState(),position);
        }
        if (kind=="wheel") {
            int dx,dy;
            if (!(command >> dx >> dy) || dx < -960 || dx > 960 || dy < -960 || dy > 960) return false;
            if (dx && !PostMessageW(mouse_,WM_MOUSEHWHEEL,MAKEWPARAM(mouseState(),dx),MAKELPARAM(screen.x,screen.y))) return false;
            return !dy || PostMessageW(mouse_,WM_MOUSEWHEEL,MAKEWPARAM(mouseState(),-dy),MAKELPARAM(screen.x,screen.y));
        }
        return false;
    }
};
}
