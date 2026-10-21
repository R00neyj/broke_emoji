#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    borrow::Cow,
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
mod dock;

use serde::Serialize;
use tauri::{ipc::Response, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const APP_NAME: &str = "거지티콘";

/// Portable data folder next to the exe: settings, default gallery, WebView2 profile.
struct DataDir(PathBuf);

/// Gallery root folder. The folder contents are the only state:
/// PNGs in the root form the default tab, each subfolder is another tab.
struct Gallery(Mutex<PathBuf>);

#[derive(Serialize)]
struct Tab {
    name: String,
    files: Vec<String>,
}

fn err(e: impl ToString) -> String {
    e.to_string()
}

/// Accepts a single plain path component only (no separators, no `.`/`..`).
fn plain(name: &str) -> Result<&str, String> {
    let bad = name.is_empty()
        || name == "."
        || name == ".."
        || name
            .chars()
            .any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control());
    if bad {
        Err(format!("잘못된 이름: {name}"))
    } else {
        Ok(name)
    }
}

fn root(state: &State<Gallery>) -> PathBuf {
    state.0.lock().unwrap().clone()
}

/// `""` is the root tab.
fn tab_dir(root: PathBuf, tab: &str) -> Result<PathBuf, String> {
    if tab.is_empty() {
        Ok(root)
    } else {
        Ok(root.join(plain(tab)?))
    }
}

fn png_files(dir: &Path) -> Vec<String> {
    let mut files: Vec<String> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.to_ascii_lowercase().ends_with(".png"))
        .collect();
    files.sort();
    files
}

/// Sets the gallery folder, creating it if needed. Empty means `<data>/gallery`;
/// relative paths resolve against the data folder so the app stays portable.
/// Returns the path as it should be shown/saved (relative when inside the data folder).
#[tauri::command]
fn open_gallery(data: State<DataDir>, state: State<Gallery>, dir: Option<String>) -> Result<String, String> {
    let dir = dir
        .map(|d| d.trim().to_owned())
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| "gallery".into());
    let path = data.0.join(&dir);
    fs::create_dir_all(&path).map_err(err)?;
    let shown = match path.strip_prefix(&data.0) {
        Ok(rel) => rel.to_string_lossy().into_owned(),
        Err(_) => path.to_string_lossy().into_owned(),
    };
    *state.0.lock().unwrap() = path;
    Ok(shown)
}

#[tauri::command]
fn save_settings(data: State<DataDir>, json: String) -> Result<(), String> {
    fs::write(data.0.join("settings.json"), json).map_err(err)
}

#[tauri::command]
fn list_tabs(state: State<Gallery>) -> Result<Vec<Tab>, String> {
    let root = root(&state);
    let mut tabs = vec![Tab {
        name: String::new(),
        files: png_files(&root),
    }];
    let mut dirs: Vec<String> = fs::read_dir(&root)
        .map_err(err)?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    dirs.sort();
    for name in dirs {
        let files = png_files(&root.join(&name));
        tabs.push(Tab { name, files });
    }
    Ok(tabs)
}

/// Fingerprint of the gallery (tab folders plus PNG names, sizes, mtimes). The UI
/// polls it to pick up changes made outside the app, e.g. files copied in via
/// Explorer. A string because a u64 does not fit a JS number.
#[tauri::command]
fn gallery_stamp(state: State<Gallery>) -> String {
    let mut h = DefaultHasher::new();
    hash_dir(&root(&state), &mut h, true);
    format!("{:x}", h.finish())
}

fn hash_dir(dir: &Path, h: &mut DefaultHasher, tabs: bool) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let Ok(meta) = e.metadata() else { continue };
        let name = e.file_name();
        if meta.is_dir() {
            if tabs {
                name.hash(h);
                hash_dir(&e.path(), h, false);
            }
        } else if name.to_string_lossy().to_ascii_lowercase().ends_with(".png") {
            name.hash(h);
            meta.len().hash(h);
            meta.modified().ok().hash(h);
        }
    }
}

#[tauri::command]
fn read_image(state: State<Gallery>, tab: String, name: String) -> Result<Response, String> {
    let path = tab_dir(root(&state), &tab)?.join(plain(&name)?);
    Ok(Response::new(fs::read(path).map_err(err)?))
}

/// Saves already-processed PNG bytes into the tab folder; returns the new file name.
#[tauri::command]
fn save_image(state: State<Gallery>, tab: String, bytes: Vec<u8>) -> Result<String, String> {
    let dir = tab_dir(root(&state), &tab)?;
    let mut stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(err)?.as_millis();
    loop {
        let name = format!("{stamp}.png");
        let path = dir.join(&name);
        if !path.exists() {
            fs::write(path, bytes).map_err(err)?;
            return Ok(name);
        }
        stamp += 1;
    }
}

#[tauri::command]
fn delete_image(state: State<Gallery>, tab: String, name: String) -> Result<(), String> {
    fs::remove_file(tab_dir(root(&state), &tab)?.join(plain(&name)?)).map_err(err)
}

/// Overwrites an existing image (crop "덮어쓰기").
#[tauri::command]
fn replace_image(state: State<Gallery>, tab: String, name: String, bytes: Vec<u8>) -> Result<(), String> {
    let path = tab_dir(root(&state), &tab)?.join(plain(&name)?);
    if !path.is_file() {
        return Err("원본 이미지가 없어요".into());
    }
    fs::write(path, bytes).map_err(err)
}

/// Moves an image to another tab, renaming it if the name is taken there.
#[tauri::command]
fn move_image(state: State<Gallery>, from: String, name: String, to: String) -> Result<(), String> {
    let root = root(&state);
    let src = tab_dir(root.clone(), &from)?.join(plain(&name)?);
    let dir = tab_dir(root, &to)?;
    let mut dest = dir.join(&name);
    let mut stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(err)?.as_millis();
    while dest.exists() {
        dest = dir.join(format!("{stamp}.png"));
        stamp += 1;
    }
    fs::rename(src, dest).map_err(err)
}

#[tauri::command]
fn create_tab(state: State<Gallery>, name: String) -> Result<(), String> {
    fs::create_dir(root(&state).join(plain(name.trim())?)).map_err(err)
}

/// Removes an empty tab folder only; non-empty folders are refused by the OS call.
#[tauri::command]
fn delete_tab(state: State<Gallery>, name: String) -> Result<(), String> {
    fs::remove_dir(root(&state).join(plain(&name)?)).map_err(|_| "비어 있는 탭만 삭제할 수 있어요".to_string())
}

#[tauri::command]
fn rename_tab(state: State<Gallery>, from: String, to: String) -> Result<(), String> {
    let root = root(&state);
    let target = root.join(plain(to.trim())?);
    if target.exists() {
        return Err("같은 이름의 탭이 이미 있어요".into());
    }
    fs::rename(root.join(plain(&from)?), target).map_err(err)
}

#[tauri::command]
fn reveal_gallery(state: State<Gallery>) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(root(&state))
        .spawn()
        .map(|_| ())
        .map_err(err)
}

/// Puts an opaque RGBA bitmap on the clipboard as image data (not a file path).
#[tauri::command]
fn copy_image(width: usize, height: usize, rgba: Vec<u8>) -> Result<(), String> {
    if rgba.len() != width * height * 4 {
        return Err("이미지 크기가 맞지 않아요".into());
    }
    arboard::Clipboard::new()
        .and_then(|mut c| {
            c.set_image(arboard::ImageData {
                width,
                height,
                bytes: Cow::Owned(rgba),
            })
        })
        .map_err(err)
}

/// Writes the composited PNG to `<data>/drag/` and starts an OS file drag
/// (CF_HDROP), so it can be dropped into a KakaoTalk chat like a file from Explorer.
/// The drop target may read the file later (e.g. after a send confirmation), so
/// files are only cleared on the next app start.
#[tauri::command]
fn start_drag(window: WebviewWindow, data: State<DataDir>, png: Vec<u8>) -> Result<(), String> {
    let dir = data.0.join("drag");
    fs::create_dir_all(&dir).map_err(err)?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(err)?.as_millis();
    let path = dir.join(format!("{APP_NAME}_{stamp}.png"));
    fs::write(&path, png).map_err(err)?;
    // DoDragDrop runs a modal loop and must be on the UI thread.
    let w = window.clone();
    window
        .run_on_main_thread(move || {
            // If the button was already released (very quick fling), DoDragDrop would
            // wait for the next click and drop wherever the cursor happens to be.
            if !left_button_down() {
                return;
            }
            let _ = drag::start_drag(
                &w,
                drag::DragItem::Files(vec![path.clone()]),
                drag::Image::File(path),
                |_, _| {},
                drag::Options::default(),
            );
        })
        .map_err(err)
}

#[cfg(windows)]
fn key_down(vk: u16) -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    // SAFETY: plain Win32 call without pointers.
    (unsafe { GetAsyncKeyState(vk as i32) } as u16) & 0x8000 != 0
}

#[cfg(windows)]
fn left_button_down() -> bool {
    key_down(windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_LBUTTON)
}

#[cfg(not(windows))]
fn left_button_down() -> bool {
    true
}

/// Screen eyedropper. WebView2 exposes `EyeDropper` but `open()` aborts at once,
/// so this reads the pixel under the cursor directly: streams the live color to
/// `on_move`, returns it on the next left click, `None` on Esc or after 60 s.
/// A small click-through swatch window follows the cursor so the user can see
/// that picking is active. The click itself still reaches the window underneath.
#[cfg(windows)]
#[tauri::command]
async fn pick_screen_color(
    app: tauri::AppHandle,
    data: State<'_, DataDir>,
    on_move: tauri::ipc::Channel<String>,
) -> Result<Option<String>, String> {
    use std::time::{Duration, Instant};
    use tauri::PhysicalPosition;
    use windows_sys::Win32::{
        Foundation::POINT,
        Graphics::Gdi::{GetDC, GetPixel, ReleaseDC, CLR_INVALID},
        UI::{Input::KeyboardAndMouse::VK_ESCAPE, WindowsAndMessaging::GetCursorPos},
    };

    // Offset keeps the swatch out from under the cursor (it would be sampled otherwise).
    const OFFSET: i32 = 20;
    let swatch = match app.get_webview_window("picker") {
        Some(w) => w,
        None => WebviewWindowBuilder::new(&app, "picker", WebviewUrl::App("picker.html".into()))
            .inner_size(132.0, 36.0)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            // Must match the main window: WebView2 allows one profile per process.
            .data_directory(data.0.join("webview"))
            .build()
            .map_err(err)?,
    };
    let _ = swatch.set_ignore_cursor_events(true);

    let result = tauri::async_runtime::spawn_blocking({
        let swatch = swatch.clone();
        move || {
            let tick = Duration::from_millis(16);
            // The click on the eyedropper button itself must not count.
            while left_button_down() {
                std::thread::sleep(tick);
            }
            // SAFETY: screen DC (null window) is released before returning.
            let dc = unsafe { GetDC(std::ptr::null_mut()) };
            let deadline = Instant::now() + Duration::from_secs(60);
            let mut last: Option<String> = None;
            let mut last_pt = (i32::MIN, i32::MIN);
            let result = loop {
                if key_down(VK_ESCAPE) || Instant::now() > deadline {
                    break None;
                }
                // Use the color sampled before the press: pressing can change hover visuals.
                if left_button_down() {
                    break last;
                }
                let mut pt = POINT { x: 0, y: 0 };
                // SAFETY: `pt` is a valid out pointer; `dc` is the screen DC.
                let color = unsafe {
                    if GetCursorPos(&mut pt) == 0 {
                        CLR_INVALID
                    } else {
                        GetPixel(dc, pt.x, pt.y)
                    }
                };
                if (pt.x, pt.y) != last_pt {
                    last_pt = (pt.x, pt.y);
                    let _ = swatch.set_position(PhysicalPosition::new(pt.x + OFFSET, pt.y + OFFSET));
                }
                if color != CLR_INVALID {
                    // COLORREF is 0x00BBGGRR.
                    let hex = format!("#{:02x}{:02x}{:02x}", color & 0xff, (color >> 8) & 0xff, (color >> 16) & 0xff);
                    if last.as_deref() != Some(hex.as_str()) {
                        let _ = on_move.send(hex.clone());
                        let _ = swatch.eval(format!("show('{hex}')"));
                        if last.is_none() {
                            let _ = swatch.show();
                        }
                        last = Some(hex);
                    }
                }
                std::thread::sleep(tick);
            };
            // SAFETY: matches the GetDC above.
            unsafe { ReleaseDC(std::ptr::null_mut(), dc) };
            result
        }
    })
    .await
    .map_err(err);
    // Destroy rather than hide: a hidden window would keep the app alive after the
    // main window is closed.
    let _ = swatch.destroy();
    result
}

#[cfg(not(windows))]
#[tauri::command]
async fn pick_screen_color() -> Result<Option<String>, String> {
    Err("Windows에서만 지원해요".into())
}

/// Docks the gallery beside the active KakaoTalk chat room (`left`: preferred side).
#[cfg(windows)]
#[tauri::command]
fn set_dock(on: bool, left: bool) {
    dock::set(on, left);
}

#[cfg(not(windows))]
#[tauri::command]
fn set_dock() -> Result<(), String> {
    Err("Windows에서만 지원해요".into())
}

/// Opens (or focuses) the separate settings window. It loads the same page in
/// settings mode with the current settings.json; the windows sync via events.
#[tauri::command]
async fn open_settings(app: tauri::AppHandle, data: State<'_, DataDir>) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.unminimize();
        return w.set_focus().map_err(err);
    }
    let settings = fs::read_to_string(data.0.join("settings.json")).unwrap_or_default();
    let mut builder = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::default());
    // Owned by the gallery window so it stays above it (also when docked over KakaoTalk).
    if let Some(main) = app.get_webview_window("main") {
        builder = builder.parent(&main).map_err(err)?;
    }
    builder
        .title(format!("{APP_NAME} 설정"))
        // Tall enough to show every setting without scrolling (content ≈ 685px at 360 wide
        // before the dock-side row was added; one more row fits in the extra 40px).
        .inner_size(360.0, 740.0)
        .min_inner_size(320.0, 400.0)
        .disable_drag_drop_handler()
        // Must match the main window: WebView2 allows one profile per process.
        .data_directory(data.0.join("webview"))
        .initialization_script(&format!("window.__SETTINGS__ = {settings:?}; window.__MODE__ = 'settings';"))
        .build()
        .map(|_| ())
        .map_err(err)
}

fn main() {
    let data = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.join(format!("{APP_NAME}_data"))))
        .expect("cannot locate exe folder");
    fs::create_dir_all(&data).expect("cannot create data folder");
    let _ = fs::remove_dir_all(data.join("drag"));
    // Handed to the page before main.js runs; parsed (and validated) there.
    let settings = fs::read_to_string(data.join("settings.json")).unwrap_or_default();

    tauri::Builder::default()
        .manage(Gallery(Mutex::new(PathBuf::new())))
        .invoke_handler(tauri::generate_handler![
            open_gallery,
            save_settings,
            list_tabs,
            gallery_stamp,
            read_image,
            save_image,
            delete_image,
            create_tab,
            delete_tab,
            move_image,
            replace_image,
            rename_tab,
            reveal_gallery,
            copy_image,
            start_drag,
            pick_screen_color,
            set_dock,
            open_settings
        ])
        .setup(move |app| {
            let webview_dir = data.join("webview");
            app.manage(DataDir(data));
            let main_window = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title(APP_NAME)
                // 4 × 70px cells + 3 × 10px gaps + 2 × 12px padding + 6px scrollbar.
                .inner_size(340.0, 320.0)
                .min_inner_size(340.0, 320.0)
                .disable_drag_drop_handler()
                .data_directory(webview_dir)
                .initialization_script(&format!("window.__SETTINGS__ = {settings:?};"))
                .build()?;
            #[cfg(windows)]
            dock::start(main_window.hwnd()?.0);
            // Closing the gallery quits the app even if the settings window is open.
            let handle = app.handle().clone();
            main_window.on_window_event(move |e| {
                if let tauri::WindowEvent::Destroyed = e {
                    handle.exit(0);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run 거지티콘");
}
