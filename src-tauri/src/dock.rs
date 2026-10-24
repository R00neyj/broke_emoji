//! Docks the gallery window beside the active KakaoTalk chat room (Windows only).
//!
//! A dedicated thread owns out-of-context WinEvent hooks (nothing is injected into
//! KakaoTalk): when a chat room becomes the foreground window, the gallery is raised
//! above it without taking focus and moved next to it; while the chat room moves or
//! resizes, the gallery follows, and it is minimized and restored together with the
//! chat room. A chat room is a visible, minimizable, non-topmost
//! top-level window of `KakaoTalk.exe` containing a `RICHEDIT50W` (the message
//! input); the main window (friend list) has no input and notification popups are
//! neither minimizable app windows nor non-topmost.

use std::{
    cell::Cell,
    ffi::c_void,
    sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering},
};

use windows_sys::{
    core::BOOL,
    Win32::{
        Foundation::{CloseHandle, HWND, LPARAM, RECT},
        Graphics::{
            Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS},
            Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST},
        },
        System::Threading::{
            GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
            PROCESS_QUERY_LIMITED_INFORMATION,
        },
        UI::{
            Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK},
            WindowsAndMessaging::{
                EnumChildWindows, EnumWindows, GetAncestor, GetClassNameW, GetMessageW, GetWindow,
                GetWindowLongW, GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindowVisible, PeekMessageW,
                KillTimer, PostThreadMessageW, SetTimer, SetWindowPos, WM_TIMER, CHILDID_SELF, EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE, EVENT_OBJECT_LOCATIONCHANGE, EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_MINIMIZEEND, EVENT_SYSTEM_MINIMIZESTART, ShowWindow, SW_SHOWMINNOACTIVE,
                SW_HIDE, SW_SHOWNOACTIVATE,
                GA_ROOT, GWL_EXSTYLE, GWL_STYLE, GW_HWNDPREV, HWND_TOP, MSG, OBJID_WINDOW, PM_NOREMOVE, SWP_NOACTIVATE,
                SWP_NOSIZE, SWP_NOZORDER, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_APP, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
                WS_MINIMIZEBOX,
            },
        },
    },
};

static ON: AtomicBool = AtomicBool::new(false);
static LEFT: AtomicBool = AtomicBool::new(false);
static MAIN: AtomicIsize = AtomicIsize::new(0);
static THREAD: AtomicU32 = AtomicU32::new(0);
static AUTO_HIDDEN_INIT: AtomicBool = AtomicBool::new(false);

thread_local! {
    /// Chat room being followed (hook thread only).
    static TARGET: Cell<isize> = const { Cell::new(0) };
    /// Hooks scoped to the KakaoTalk process (location, minimize/restore) and its pid.
    static KAKAO_HOOKS: Cell<([isize; 3], u32)> = const { Cell::new(([0; 3], 0)) };
    /// The gallery was minimized because the chat room was; restore it with the chat room.
    static AUTO_MINIMIZED: Cell<bool> = const { Cell::new(false) };
    /// The gallery was hidden because the chat room closed; show it when one opens again.
    static AUTO_HIDDEN: Cell<bool> = const { Cell::new(false) };
    /// Polling timer id (0 = off) and the scans left when no hidden gallery is waiting.
    /// A newly opened chat room is the foreground window before its input exists.
    static TIMER: Cell<usize> = const { Cell::new(0) };
    static RETRY: Cell<u32> = const { Cell::new(0) };
}

/// Starts the hook thread for the gallery window `main`. `hidden`: the window was
/// created hidden (autostart) and appears once a chat room opens.
pub fn start(main: HWND, hidden: bool) {
    MAIN.store(main as isize, Ordering::Relaxed);
    AUTO_HIDDEN_INIT.store(hidden, Ordering::Relaxed);
    std::thread::spawn(|| {
        // SAFETY: plain Win32 calls on this thread; `msg` is a valid out pointer.
        unsafe {
            let mut msg: MSG = std::mem::zeroed();
            // Creates the message queue so `set` can post to this thread.
            PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
            SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                std::ptr::null_mut(),
                Some(on_event),
                0,
                0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            );
            AUTO_HIDDEN.set(AUTO_HIDDEN_INIT.load(Ordering::Relaxed));
            THREAD.store(GetCurrentThreadId(), Ordering::Release);
            // WinEvent callbacks are delivered while this thread waits here.
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                if msg.hwnd.is_null() && msg.message == WM_APP {
                    apply();
                } else if msg.hwnd.is_null() && msg.message == WM_TIMER {
                    rescan();
                }
            }
        }
    });
}

/// Turns docking on/off and picks the side; takes effect immediately.
pub fn set(on: bool, left: bool) {
    ON.store(on, Ordering::Relaxed);
    LEFT.store(left, Ordering::Relaxed);
    let thread = THREAD.load(Ordering::Acquire);
    if thread != 0 {
        // SAFETY: posting a payload-free thread message.
        unsafe { PostThreadMessageW(thread, WM_APP, 0, 0) };
    }
}

/// Hook thread: on enable, docks to the topmost open chat room; on disable, stops following.
unsafe fn apply() {
    let on = ON.load(Ordering::Relaxed);
    // Without docking there is no tray to bring a hidden gallery back.
    if !on && AUTO_HIDDEN.replace(false) {
        ShowWindow(MAIN.load(Ordering::Relaxed) as HWND, SW_SHOWNOACTIVATE);
    }
    if !on {
        TARGET.set(0);
        AUTO_MINIMIZED.set(false);
        unhook_kakao();
        return;
    }
    // EnumWindows walks top-level windows in z-order, topmost first.
    let mut found: HWND = std::ptr::null_mut();
    EnumWindows(Some(find_chat), &mut found as *mut HWND as LPARAM);
    if !found.is_null() {
        follow(found, true);
    } else if AUTO_HIDDEN.get() {
        arm();
    }
}

unsafe extern "system" fn find_chat(hwnd: HWND, out: LPARAM) -> BOOL {
    if is_chat(hwnd) {
        *(out as *mut HWND) = hwnd;
        return 0;
    }
    1
}

unsafe extern "system" fn on_event(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    object: i32,
    child: i32,
    _thread: u32,
    _time: u32,
) {
    if !ON.load(Ordering::Relaxed) {
        return;
    }
    if event == EVENT_SYSTEM_FOREGROUND {
        if is_chat(hwnd) {
            follow(hwnd, true);
        } else if !hwnd.is_null() && GetAncestor(hwnd, GA_ROOT) == hwnd && is_kakao(hwnd) {
            RETRY.set(10);
            arm();
        }
        return;
    }
    if object != OBJID_WINDOW || child != CHILDID_SELF as i32 || hwnd as isize != TARGET.get() {
        return;
    }
    match event {
        EVENT_OBJECT_LOCATIONCHANGE => place(hwnd, false),
        EVENT_SYSTEM_MINIMIZESTART => {
            let main = MAIN.load(Ordering::Relaxed) as HWND;
            if IsIconic(main) == 0 {
                ShowWindow(main, SW_SHOWMINNOACTIVE);
                AUTO_MINIMIZED.set(true);
            }
        }
        EVENT_SYSTEM_MINIMIZEEND => follow(hwnd, true),
        EVENT_OBJECT_DESTROY | EVENT_OBJECT_HIDE => closed(),
        _ => {}
    }
}

unsafe fn arm() {
    if TIMER.get() == 0 {
        TIMER.set(SetTimer(std::ptr::null_mut(), 0, 400, None));
    }
}

unsafe fn disarm() {
    let id = TIMER.replace(0);
    if id != 0 {
        KillTimer(std::ptr::null_mut(), id);
    }
}

/// Timer tick: looks for a chat room that was not ready (or not open) at the last event.
unsafe fn rescan() {
    if !ON.load(Ordering::Relaxed) {
        return disarm();
    }
    let mut found: HWND = std::ptr::null_mut();
    EnumWindows(Some(find_chat), &mut found as *mut HWND as LPARAM);
    if !found.is_null() {
        follow(found, true);
        return disarm();
    }
    // A hidden gallery keeps waiting; otherwise give up after a few scans.
    if !AUTO_HIDDEN.get() {
        RETRY.set(RETRY.get().saturating_sub(1));
        if RETRY.get() == 0 {
            disarm();
        }
    }
}

unsafe fn unhook_kakao() {
    let (hooks, _) = KAKAO_HOOKS.replace(([0; 3], 0));
    for hook in hooks.into_iter().filter(|&h| h != 0) {
        UnhookWinEvent(hook as HWINEVENTHOOK);
    }
}

unsafe fn follow(chat: HWND, raise: bool) {
    TARGET.set(chat as isize);
    let mut pid = 0;
    GetWindowThreadProcessId(chat, &mut pid);
    if pid != KAKAO_HOOKS.get().1 {
        unhook_kakao();
        // Scoped to KakaoTalk so system-wide cursor/caret moves don't wake this thread.
        let hook = |first, last| {
            SetWinEventHook(first, last, std::ptr::null_mut(), Some(on_event), pid, 0, WINEVENT_OUTOFCONTEXT) as isize
        };
        let hooks = [
            hook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE),
            hook(EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND),
            hook(EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE),
        ];
        KAKAO_HOOKS.set((hooks, pid));
    }
    // Any chat room coming back brings back a gallery minimized along with a chat room;
    // a gallery the user minimized stays minimized.
    let main = MAIN.load(Ordering::Relaxed) as HWND;
    if AUTO_HIDDEN.replace(false) {
        ShowWindow(main, SW_SHOWNOACTIVATE);
    }
    if AUTO_MINIMIZED.replace(false) && IsIconic(main) != 0 {
        ShowWindow(main, SW_SHOWNOACTIVATE);
    }
    place(chat, raise);
}

/// The followed chat room was closed: switch to another open chat room, else hide
/// the gallery (the tray keeps the app alive; it comes back with the next chat room).
unsafe fn closed() {
    let mut found: HWND = std::ptr::null_mut();
    EnumWindows(Some(find_chat), &mut found as *mut HWND as LPARAM);
    if !found.is_null() {
        follow(found, true);
        return;
    }
    TARGET.set(0);
    AUTO_MINIMIZED.set(false);
    ShowWindow(MAIN.load(Ordering::Relaxed) as HWND, SW_HIDE);
    AUTO_HIDDEN.set(true);
    arm();
}

/// Moves the gallery beside `chat`, bottom edges aligned, keeping the gallery's own
/// size (preferred side, else the other side if it would leave the monitor's work area); `raise` also puts it
/// right above the chat room. Never activates the gallery.
unsafe fn place(chat: HWND, raise: bool) {
    let main = MAIN.load(Ordering::Relaxed) as HWND;
    // Minimized windows report a parking position; leave a minimized gallery alone.
    if IsIconic(chat) != 0 || IsWindowVisible(chat) == 0 || IsIconic(main) != 0 {
        return;
    }
    let chat_r = frame(chat);
    let mut outer: RECT = std::mem::zeroed();
    GetWindowRect(main, &mut outer);
    // The gallery has a native frame with invisible resize borders; align its visible edge.
    let vis = frame(main);
    let (inset_l, inset_t) = (vis.left - outer.left, vis.top - outer.top);
    let width = vis.right - vis.left;
    let height = vis.bottom - vis.top;

    let mut mi: MONITORINFO = std::mem::zeroed();
    mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
    GetMonitorInfoW(MonitorFromWindow(chat, MONITOR_DEFAULTTONEAREST), &mut mi);
    let work = mi.rcWork;
    let fits_left = chat_r.left - width >= work.left;
    let fits_right = chat_r.right + width <= work.right;
    let left = if LEFT.load(Ordering::Relaxed) { fits_left || !fits_right } else { !fits_right && fits_left };
    let x = if left { chat_r.left - width } else { chat_r.right };
    // Bottom-aligned with the chat room; never above the top of the work area.
    let y = (chat_r.bottom - height).max(work.top);

    // HWND_TOP is ignored while another process owns the foreground, but inserting
    // after the window right above the chat room is honored. Inserting after a
    // topmost window would make the gallery topmost, so fall back to HWND_TOP then.
    let mut flags = SWP_NOACTIVATE | SWP_NOSIZE;
    let mut after = HWND_TOP;
    if raise {
        let above = GetWindow(chat, GW_HWNDPREV);
        if above == main {
            flags |= SWP_NOZORDER;
        } else if !above.is_null() && GetWindowLongW(above, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST == 0 {
            after = above;
        }
    } else {
        flags |= SWP_NOZORDER;
    }
    SetWindowPos(
        main,
        after,
        x - inset_l,
        y - inset_t,
        0,
        0,
        flags,
    );
}

/// Visible window bounds (excludes DWM's invisible resize borders).
unsafe fn frame(hwnd: HWND) -> RECT {
    let mut r: RECT = std::mem::zeroed();
    let ok = DwmGetWindowAttribute(
        hwnd,
        DWMWA_EXTENDED_FRAME_BOUNDS as u32,
        &mut r as *mut RECT as *mut c_void,
        std::mem::size_of::<RECT>() as u32,
    );
    if ok != 0 {
        GetWindowRect(hwnd, &mut r);
    }
    r
}

unsafe fn is_chat(hwnd: HWND) -> bool {
    if hwnd.is_null() || IsWindowVisible(hwnd) == 0 || GetAncestor(hwnd, GA_ROOT) != hwnd {
        return false;
    }
    // Chat rooms are minimizable, non-topmost app windows; notification popups
    // (which can carry a reply input) are not.
    let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
    let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    if style & WS_MINIMIZEBOX == 0 || ex & (WS_EX_TOPMOST | WS_EX_TOOLWINDOW) != 0 || !is_kakao(hwnd) {
        return false;
    }
    let mut found = false;
    EnumChildWindows(hwnd, Some(find_input), &mut found as *mut bool as LPARAM);
    found
}

unsafe extern "system" fn find_input(hwnd: HWND, out: LPARAM) -> BOOL {
    let mut buf = [0u16; 32];
    let n = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) as usize;
    if String::from_utf16_lossy(&buf[..n]) == "RICHEDIT50W" {
        *(out as *mut bool) = true;
        return 0;
    }
    1
}

unsafe fn is_kakao(hwnd: HWND) -> bool {
    let mut pid = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if process.is_null() {
        return false;
    }
    let mut buf = [0u16; 260];
    let mut len = buf.len() as u32;
    let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len) != 0;
    CloseHandle(process);
    ok && String::from_utf16_lossy(&buf[..len as usize])
        .rsplit('\\')
        .next()
        .is_some_and(|name| name.eq_ignore_ascii_case("KakaoTalk.exe"))
}
