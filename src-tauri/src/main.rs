#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    borrow::Cow,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{ipc::Response, Manager, State, WebviewUrl, WebviewWindowBuilder};

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
        || name.chars().any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control());
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
    let dir = dir.map(|d| d.trim().to_owned()).filter(|d| !d.is_empty()).unwrap_or_else(|| "gallery".into());
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
    let mut tabs = vec![Tab { name: String::new(), files: png_files(&root) }];
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
fn reveal_gallery(state: State<Gallery>) -> Result<(), String> {
    std::process::Command::new("explorer").arg(root(&state)).spawn().map(|_| ()).map_err(err)
}

/// Puts an opaque RGBA bitmap on the clipboard as image data (not a file path).
#[tauri::command]
fn copy_image(width: usize, height: usize, rgba: Vec<u8>) -> Result<(), String> {
    if rgba.len() != width * height * 4 {
        return Err("이미지 크기가 맞지 않아요".into());
    }
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_image(arboard::ImageData { width, height, bytes: Cow::Owned(rgba) }))
        .map_err(err)
}

fn main() {
    let data = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.join(format!("{APP_NAME}_data"))))
        .expect("cannot locate exe folder");
    fs::create_dir_all(&data).expect("cannot create data folder");
    // Handed to the page before main.js runs; parsed (and validated) there.
    let settings = fs::read_to_string(data.join("settings.json")).unwrap_or_default();

    tauri::Builder::default()
        .manage(Gallery(Mutex::new(PathBuf::new())))
        .invoke_handler(tauri::generate_handler![
            open_gallery,
            save_settings,
            list_tabs,
            read_image,
            save_image,
            delete_image,
            create_tab,
            delete_tab,
            reveal_gallery,
            copy_image
        ])
        .setup(move |app| {
            let webview_dir = data.join("webview");
            app.manage(DataDir(data));
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title(APP_NAME)
                .inner_size(380.0, 540.0)
                .min_inner_size(300.0, 320.0)
                .disable_drag_drop_handler()
                .data_directory(webview_dir)
                .initialization_script(&format!("window.__SETTINGS__ = {settings:?};"))
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run 거지티콘");
}
