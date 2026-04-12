use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{path::BaseDirectory, AppHandle, Manager};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::Mutex as AsyncMutex,
};

const URL_REGEX_PREFIX: &str = "https://";
const URL_REGEX_SUFFIX: &str = ".trycloudflare.com";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub available: bool,
    pub manual_start: bool,
    pub state: String,
    pub url: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub message: String,
    pub error: Option<String>,
    pub source: String,
    pub updated_at: u64,
}

impl TunnelStatus {
    fn idle() -> Self {
        Self {
            available: true,
            manual_start: true,
            state: "idle".into(),
            url: None,
            downloaded_bytes: 0,
            total_bytes: 0,
            message: "尚未生成分享链接".into(),
            error: None,
            source: "tauri".into(),
            updated_at: now_ms(),
        }
    }

    fn unavailable(message: impl Into<String>, error: Option<String>) -> Self {
        Self {
            available: false,
            manual_start: false,
            state: "disabled".into(),
            url: None,
            downloaded_bytes: 0,
            total_bytes: 0,
            message: message.into(),
            error,
            source: "tauri".into(),
            updated_at: now_ms(),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub struct TunnelState {
    status: Arc<Mutex<TunnelStatus>>,
    child: AsyncMutex<Option<Child>>,
    bundled_binary: Mutex<Option<PathBuf>>,
}

impl Default for TunnelState {
    fn default() -> Self {
        Self {
            status: Arc::new(Mutex::new(TunnelStatus::idle())),
            child: AsyncMutex::new(None),
            bundled_binary: Mutex::new(None),
        }
    }
}

impl TunnelState {
    pub fn snapshot(&self) -> TunnelStatus {
        self.status.lock().expect("tunnel status poisoned").clone()
    }

    fn update<F: FnOnce(&mut TunnelStatus)>(&self, mutator: F) -> TunnelStatus {
        let mut guard = self.status.lock().expect("tunnel status poisoned");
        mutator(&mut guard);
        guard.updated_at = now_ms();
        guard.clone()
    }

    pub fn mark_unavailable(&self, message: impl Into<String>, error: Option<String>) {
        let unavailable = TunnelStatus::unavailable(message, error);
        let mut guard = self.status.lock().expect("tunnel status poisoned");
        *guard = unavailable;
    }

    pub fn set_bundled_binary(&self, path: Option<PathBuf>) {
        let mut guard = self.bundled_binary.lock().expect("tunnel bin poisoned");
        *guard = path;
    }

    fn bundled_binary(&self) -> Option<PathBuf> {
        self.bundled_binary
            .lock()
            .expect("tunnel bin poisoned")
            .clone()
    }
}

pub fn resolve_bundled_cloudflared(app: &AppHandle) -> Option<PathBuf> {
    let candidates: Vec<PathBuf> = {
        let mut paths = Vec::new();
        if let Ok(p) = app
            .path()
            .resolve("cloudflared", BaseDirectory::Resource)
        {
            paths.push(p.join(cloudflared_filename()));
            paths.push(p);
        }
        let dev_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/cloudflared");
        paths.push(dev_dir.join(cloudflared_filename()));
        paths.push(dev_dir);
        paths
    };

    for candidate in candidates {
        if candidate.is_file() {
            return Some(candidate);
        }
        let with_ext = candidate.join(cloudflared_filename());
        if with_ext.is_file() {
            return Some(with_ext);
        }
    }
    None
}

fn cloudflared_filename() -> &'static str {
    if cfg!(target_os = "windows") {
        "cloudflared.exe"
    } else {
        "cloudflared"
    }
}

pub async fn start_tunnel(
    state: Arc<TunnelState>,
    local_port: u16,
) -> Result<TunnelStatus, String> {
    {
        let mut child_slot = state.child.lock().await;
        if child_slot.is_some() {
            return Ok(state.snapshot());
        }

        let binary_path = match state.bundled_binary() {
            Some(path) if path.is_file() => path,
            _ => {
                let snap = state.update(|s| {
                    s.state = "error".into();
                    s.message = "未找到 cloudflared 二进制".into();
                    s.error = Some("应用资源目录中缺少 cloudflared，请重新安装或检查打包流程".into());
                });
                return Ok(snap);
            }
        };

        ensure_executable(&binary_path);

        state.update(|s| {
            s.state = "starting".into();
            s.message = "正在建立 Cloudflare quick tunnel".into();
            s.url = None;
            s.error = None;
            s.downloaded_bytes = 0;
            s.total_bytes = 0;
        });

        let mut command = Command::new(&binary_path);
        command
            .arg("tunnel")
            .arg("--no-autoupdate")
            .arg("--url")
            .arg(format!("http://127.0.0.1:{local_port}"))
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(err) => {
                let message = format!("启动 cloudflared 失败: {err}");
                let snap = state.update(|s| {
                    s.state = "error".into();
                    s.message = "启动 cloudflared 失败".into();
                    s.error = Some(message.clone());
                });
                return Ok(snap);
            }
        };

        if let Some(stdout) = child.stdout.take() {
            spawn_line_reader(stdout, Arc::clone(&state));
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_line_reader(stderr, Arc::clone(&state));
        }

        spawn_exit_watcher(Arc::clone(&state));

        *child_slot = Some(child);
    }

    Ok(state.snapshot())
}

pub async fn stop_tunnel(state: Arc<TunnelState>) -> TunnelStatus {
    let mut child_slot = state.child.lock().await;
    if let Some(mut child) = child_slot.take() {
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
    state.update(|s| {
        s.state = "stopped".into();
        s.url = None;
        s.message = "隧道已停止".into();
    });
    state.snapshot()
}

fn ensure_executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = std::fs::metadata(path) {
            let mut perms = metadata.permissions();
            let mode = perms.mode();
            if mode & 0o111 == 0 {
                perms.set_mode(mode | 0o755);
                let _ = std::fs::set_permissions(path, perms);
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

fn spawn_line_reader<R>(reader: R, state: Arc<TunnelState>)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut buf = BufReader::new(reader).lines();
        loop {
            match buf.next_line().await {
                Ok(Some(line)) => process_line(&state, &line),
                Ok(None) => break,
                Err(_) => break,
            }
        }
    });
}

fn process_line(state: &Arc<TunnelState>, line: &str) {
    if let Some(url) = extract_url(line) {
        let snapshot = state.snapshot();
        if snapshot.url.as_deref() == Some(url.as_str()) {
            return;
        }
        state.update(|s| {
            s.state = "ready".into();
            s.url = Some(url.clone());
            s.message = "公开链接已就绪".into();
            s.error = None;
        });
        eprintln!("[tunnel] 公开链接: {url}");
    }
}

fn extract_url(line: &str) -> Option<String> {
    let start = line.find(URL_REGEX_PREFIX)?;
    let tail = &line[start..];
    let end = tail.find(URL_REGEX_SUFFIX)?;
    let candidate = &tail[..end + URL_REGEX_SUFFIX.len()];
    let host_part = &candidate[URL_REGEX_PREFIX.len()..end];
    if host_part.is_empty() {
        return None;
    }
    if !host_part
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return None;
    }
    Some(candidate.to_string())
}

fn spawn_exit_watcher(state: Arc<TunnelState>) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(750)).await;
            let mut guard = state.child.lock().await;
            let Some(child) = guard.as_mut() else {
                break;
            };
            match child.try_wait() {
                Ok(Some(status)) => {
                    *guard = None;
                    drop(guard);
                    let exited_clean = status.success();
                    state.update(|s| {
                        if s.state != "stopped" {
                            s.state = if exited_clean { "stopped".into() } else { "error".into() };
                        }
                        if !exited_clean && s.error.is_none() {
                            s.error = Some(format!("cloudflared 已退出 ({status})"));
                            s.message = "cloudflared 异常退出".into();
                        } else if exited_clean && s.url.is_some() {
                            s.message = "隧道已停止".into();
                        }
                        s.url = None;
                    });
                    break;
                }
                Ok(None) => continue,
                Err(_) => {
                    *guard = None;
                    break;
                }
            }
        }
    });
}
