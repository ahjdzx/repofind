//! 在终端里打开一个目录。文件管理器 (Finder / 资源管理器) 用 nsh 自带的 `open_path`。
//!
//! - macOS: `open -a <终端> <目录>`; 已安装的终端从 /Applications 里找
//! - Windows: 有 Windows Terminal 用 `wt -d`, 没有就开 cmd
//! - Linux: $TERMINAL, 再按常见终端逐个试, 都让它在这个目录里启动

use std::{path::Path, process::Command};

/// macOS 上认识的终端 (应用名, 也是 `open -a` 的参数)
#[cfg(target_os = "macos")]
const MAC_TERMINALS: &[&str] = &["Terminal", "iTerm", "Ghostty", "Warp", "WezTerm", "kitty", "Alacritty"];

/// 本机装了的终端; 第一个是默认的
pub fn terminals() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let dirs = [
            "/Applications".to_string(),
            "/System/Applications/Utilities".to_string(),
            "/Applications/Utilities".to_string(),
            format!("{home}/Applications"),
        ];
        MAC_TERMINALS
            .iter()
            .filter(|name| dirs.iter().any(|d| Path::new(d).join(format!("{name}.app")).exists()))
            .map(|s| s.to_string())
            .collect()
    }
    #[cfg(not(target_os = "macos"))]
    Vec::new()
}

#[allow(dead_code)]
fn spawn(cmd: &mut Command) -> Result<(), String> {
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// 用终端打开 `dir`; `app` 只在 macOS 上有用 (空 = 系统自带的 Terminal)
pub fn open_terminal(dir: &str, app: &str) -> Result<(), String> {
    if !Path::new(dir).is_dir() {
        return Err(format!("not a directory: {dir}"));
    }
    platform_open(dir, app)
}

#[cfg(target_os = "macos")]
fn platform_open(dir: &str, app: &str) -> Result<(), String> {
    let app = if app.is_empty() { "Terminal" } else { app };
    let out = Command::new("open").args(["-a", app, dir]).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(target_os = "windows")]
fn platform_open(dir: &str, _app: &str) -> Result<(), String> {
    if spawn(Command::new("wt").args(["-d", dir])).is_ok() {
        return Ok(());
    }
    spawn(Command::new("cmd").args(["/c", "start", "", "cmd", "/K"]).current_dir(dir))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_open(dir: &str, _app: &str) -> Result<(), String> {
    // (程序, 指定目录的参数); 没有参数的直接在这个目录里启动
    let mut tries: Vec<(String, Vec<String>)> = Vec::new();
    if let Ok(t) = std::env::var("TERMINAL") {
        if !t.is_empty() {
            tries.push((t, vec![]));
        }
    }
    for (prog, flag) in [
        ("x-terminal-emulator", ""),
        ("gnome-terminal", "--working-directory="),
        ("konsole", "--workdir="),
        ("xfce4-terminal", "--working-directory="),
        ("kitty", "--directory="),
        ("alacritty", "--working-directory="),
        ("wezterm", ""),
        ("foot", ""),
        ("xterm", ""),
    ] {
        let args = if flag.is_empty() { vec![] } else { vec![format!("{flag}{dir}")] };
        tries.push((prog.to_string(), args));
    }
    let mut last = String::from("no terminal found");
    for (prog, args) in tries {
        match spawn(Command::new(&prog).args(&args).current_dir(dir)) {
            Ok(()) => return Ok(()),
            Err(e) => last = format!("{prog}: {e}"),
        }
    }
    Err(last)
}

#[cfg(not(any(unix, target_os = "windows")))]
fn platform_open(_dir: &str, _app: &str) -> Result<(), String> {
    Err("terminals are not available on this platform".into())
}
