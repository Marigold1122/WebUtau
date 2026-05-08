// VST 宿主子进程的桥。
//
// 总体形态：
//   Tauri 主进程 ──spawn──> webutau_vst_host (sidecar 二进制)
//                stdio JSON 控制面 ──┐
//                ws://127.0.0.1:port 数据面（前端 AudioWorklet 直连）
//
// 控制面消息格式（行分隔 JSON）：
//   请求 → host:    {"id": <u64>, "cmd": "<name>", ...payload}
//   回应 ← host:    {"id": <u64>, "ok": true, "data": ...}
//                   {"id": <u64>, "ok": false, "error": "<message>"}
//   事件 ← host:    {"event": "<name>", ...payload}    （无 id）
//
// host 启动时第一行 stdout 必须是 {"event":"ready","wsPort":<u16>,"protocol":"webutau-vst-host/1"}
// 这样 Rust 端能把 wsPort 暴露给前端，前端 AudioWorklet 直接 ws 连过去
//
// host 二进制路径解析（按下面顺序）：
//   1. tauri::path resolver "vst-host/<binary>" 在 Resource 目录里找
//   2. cargo manifest 同级 ../external/vst-host/build/<binary>（开发态）
//   3. 找不到时所有命令返回 "host_unavailable"，前端会 fallback 到 dry-through

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex};
use tokio::time::timeout;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const HOST_BINARY: &str = if cfg!(target_os = "windows") {
    "webutau_vst_host.exe"
} else {
    "webutau_vst_host"
};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct VstHostState {
    inner: Mutex<Option<HostHandle>>,
    next_request_id: AtomicU64,
    ws_port: AtomicU16,
    spawn_attempted: AtomicBool,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
}

impl VstHostState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
            next_request_id: AtomicU64::new(1),
            ws_port: AtomicU16::new(0),
            spawn_attempted: AtomicBool::new(false),
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl Default for VstHostState {
    fn default() -> Self {
        Self::new()
    }
}

struct HostHandle {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VstEventPayload {
    pub event: String,
    #[serde(flatten)]
    pub data: Value,
}

fn resolve_host_binary(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(resource) = app
        .path()
        .resolve(format!("vst-host/{HOST_BINARY}"), BaseDirectory::Resource)
    {
        if resource.exists() {
            return Some(resource);
        }
    }
    // 开发态：直接从 external/vst-host 的 JUCE 构建产物找。
    // JUCE 的 console_app 输出布局：build/<name>_artefacts/<Config>/<name>
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        manifest_dir
            .join("../external/vst-host/build")
            .join(format!("{HOST_BINARY}_artefacts"))
            .join("Release")
            .join(HOST_BINARY),
        manifest_dir
            .join("../external/vst-host/build")
            .join(format!("{HOST_BINARY}_artefacts"))
            .join("Debug")
            .join(HOST_BINARY),
        manifest_dir
            .join("../external/vst-host/build")
            .join(format!("{HOST_BINARY}_artefacts"))
            .join(HOST_BINARY),
        manifest_dir
            .join("../external/vst-host/build")
            .join(HOST_BINARY),
    ];
    candidates.into_iter().find(|p| p.exists())
}

async fn ensure_host_spawned(
    app: &AppHandle,
    state: &Arc<VstHostState>,
) -> Result<(), String> {
    {
        let guard = state.inner.lock().await;
        if guard.is_some() {
            return Ok(());
        }
    }
    if state.spawn_attempted.swap(true, Ordering::SeqCst) {
        // 上一次 spawn 失败过；再试也是浪费。返回错误让前端走 fallback
        return Err("host_unavailable".into());
    }
    let binary = match resolve_host_binary(app) {
        Some(p) => p,
        None => return Err("host_unavailable".into()),
    };

    let mut command = Command::new(&binary);
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::inherit());
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|err| format!("failed to spawn vst host: {err}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "host stdin missing".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "host stdout missing".to_string())?;

    // 等待 ready 事件，拿到 wsPort
    let port = wait_ready(stdout, app, Arc::clone(&state.pending))
        .await
        .map_err(|err| format!("vst host ready timeout: {err}"))?;
    state.ws_port.store(port, Ordering::SeqCst);

    let mut guard = state.inner.lock().await;
    *guard = Some(HostHandle { child, stdin });
    Ok(())
}

async fn wait_ready(
    stdout: ChildStdout,
    app: &AppHandle,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
) -> Result<u16, String> {
    let app_handle = app.clone();
    let mut reader = BufReader::new(stdout).lines();

    // 第一行必须是 ready 事件
    let first = timeout(READY_TIMEOUT, reader.next_line())
        .await
        .map_err(|_| "timed out waiting for host ready".to_string())?
        .map_err(|err| format!("host stdout read error: {err}"))?
        .ok_or_else(|| "host stdout closed before ready".to_string())?;

    let parsed: Value = serde_json::from_str(&first)
        .map_err(|err| format!("host ready parse failed: {err}"))?;

    if parsed.get("event").and_then(Value::as_str) != Some("ready") {
        return Err(format!("unexpected first line from host: {first}"));
    }
    let port = parsed
        .get("wsPort")
        .and_then(Value::as_u64)
        .map(|n| n as u16)
        .ok_or_else(|| "host ready missing wsPort".to_string())?;

    // 启动后台读循环：分发响应到 pending map，事件转 emit 给前端
    tauri::async_runtime::spawn(async move {
        loop {
            let line = match reader.next_line().await {
                Ok(Some(line)) => line,
                Ok(None) => break,
                Err(err) => {
                    eprintln!("[vst_host] stdout read error: {err}");
                    break;
                }
            };
            if line.is_empty() {
                continue;
            }
            let parsed: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(err) => {
                    eprintln!("[vst_host] parse failed: {err} line={line}");
                    continue;
                }
            };
            if let Some(id) = parsed.get("id").and_then(Value::as_u64) {
                let mut guard = pending.lock().await;
                if let Some(sender) = guard.remove(&id) {
                    let _ = sender.send(parsed);
                }
            } else if parsed.get("event").is_some() {
                let _ = app_handle.emit("vst://event", parsed);
            }
        }
        eprintln!("[vst_host] stdout reader exited");
    });

    Ok(port)
}

async fn send_request(
    app: &AppHandle,
    state: &Arc<VstHostState>,
    cmd: &str,
    mut payload: Value,
) -> Result<Value, String> {
    ensure_host_spawned(app, state).await?;
    let id = state.next_request_id.fetch_add(1, Ordering::SeqCst);
    if let Value::Object(ref mut map) = payload {
        map.insert("id".into(), json!(id));
        map.insert("cmd".into(), json!(cmd));
    }
    let serialized = serde_json::to_string(&payload).map_err(|err| err.to_string())?;
    let line = format!("{serialized}\n");

    let (tx, rx) = oneshot::channel();
    state.pending.lock().await.insert(id, tx);

    {
        let mut guard = state.inner.lock().await;
        let handle = guard.as_mut().ok_or_else(|| "host_unavailable".to_string())?;
        handle
            .stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|err| format!("host stdin write failed: {err}"))?;
        handle.stdin.flush().await.ok();
    }

    let response = timeout(REQUEST_TIMEOUT, rx)
        .await
        .map_err(|_| "host response timeout".to_string())?
        .map_err(|err| format!("host response cancelled: {err}"))?;

    if response.get("ok").and_then(Value::as_bool) == Some(false) {
        let message = response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("host returned error")
            .to_string();
        return Err(message);
    }
    Ok(response.get("data").cloned().unwrap_or(Value::Null))
}

// 集成自检：spawn host + 发一条 list_plugins。仅在 cargo run 加 MELODY_VST_SELF_TEST=1 时调用
pub async fn run_self_test(app: AppHandle, state: Arc<VstHostState>) {
    eprintln!("[vst_self_test] start");
    match send_request(&app, &state, "list_plugins", json!({})).await {
        Ok(data) => {
            let count = data.as_array().map(|a| a.len()).unwrap_or(0);
            eprintln!(
                "[vst_self_test] ws_port={} list_plugins returned {} entries OK",
                state.ws_port.load(Ordering::SeqCst),
                count
            );
        }
        Err(err) => {
            eprintln!("[vst_self_test] FAILED: {err}");
        }
    }
}

pub async fn shutdown(state: &Arc<VstHostState>) {
    let mut guard = state.inner.lock().await;
    if let Some(mut handle) = guard.take() {
        let _ = handle.stdin.shutdown().await;
        let _ = handle.child.start_kill();
        let _ = handle.child.wait().await;
    }
}

// ─────────── Tauri 命令 ───────────

#[tauri::command]
pub async fn vst_list_plugins(
    app: AppHandle,
    state: tauri::State<'_, Arc<VstHostState>>,
) -> Result<Value, String> {
    send_request(&app, state.inner(), "list_plugins", json!({})).await
}

#[tauri::command]
pub async fn vst_scan_dirs(
    app: AppHandle,
    state: tauri::State<'_, Arc<VstHostState>>,
    paths: Vec<String>,
    rescan: bool,
) -> Result<Value, String> {
    send_request(&app, state.inner(), "scan_dirs", json!({ "paths": paths, "rescan": rescan })).await
}

#[tauri::command]
pub async fn vst_load(
    app: AppHandle,
    state: tauri::State<'_, Arc<VstHostState>>,
    plugin_path: String,
    sample_rate: u32,
    block_size: u32,
) -> Result<Value, String> {
    send_request(
        &app,
        state.inner(),
        "load",
        json!({
            "pluginPath": plugin_path,
            "sampleRate": sample_rate,
            "blockSize": block_size,
        }),
    )
    .await
}

#[tauri::command]
pub async fn vst_unload(
    app: AppHandle,
    state: tauri::State<'_, Arc<VstHostState>>,
    handle: String,
) -> Result<Value, String> {
    send_request(&app, state.inner(), "unload", json!({ "handle": handle })).await
}

#[tauri::command]
pub async fn vst_show_editor(
    app: AppHandle,
    state: tauri::State<'_, Arc<VstHostState>>,
    handle: String,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<Value, String> {
    send_request(
        &app,
        state.inner(),
        "show_editor",
        json!({ "handle": handle, "x": x, "y": y }),
    )
    .await
}

#[tauri::command]
pub async fn vst_hide_editor(
    app: AppHandle,
    state: tauri::State<'_, Arc<VstHostState>>,
    handle: String,
) -> Result<Value, String> {
    send_request(&app, state.inner(), "hide_editor", json!({ "handle": handle })).await
}

#[tauri::command]
pub async fn vst_set_param(
    app: AppHandle,
    state: tauri::State<'_, Arc<VstHostState>>,
    handle: String,
    index: u32,
    value: f64,
) -> Result<Value, String> {
    send_request(
        &app,
        state.inner(),
        "set_param",
        json!({ "handle": handle, "index": index, "value": value }),
    )
    .await
}

#[tauri::command]
pub async fn vst_get_param(
    app: AppHandle,
    state: tauri::State<'_, Arc<VstHostState>>,
    handle: String,
    index: u32,
) -> Result<Value, String> {
    send_request(
        &app,
        state.inner(),
        "get_param",
        json!({ "handle": handle, "index": index }),
    )
    .await
}

#[tauri::command]
pub async fn vst_get_state(
    app: AppHandle,
    state: tauri::State<'_, Arc<VstHostState>>,
    handle: String,
) -> Result<Value, String> {
    send_request(&app, state.inner(), "get_state", json!({ "handle": handle })).await
}

#[tauri::command]
pub async fn vst_set_state(
    app: AppHandle,
    state: tauri::State<'_, Arc<VstHostState>>,
    handle: String,
    chunk_b64: String,
) -> Result<Value, String> {
    send_request(
        &app,
        state.inner(),
        "set_state",
        json!({ "handle": handle, "chunkB64": chunk_b64 }),
    )
    .await
}

#[tauri::command]
pub async fn vst_process_offline(
    app: AppHandle,
    state: tauri::State<'_, Arc<VstHostState>>,
    handle: String,
    sample_rate: u32,
    block_size: u32,
    channel_count: u32,
    pcm_base64: String,
) -> Result<Value, String> {
    send_request(
        &app,
        state.inner(),
        "process_offline",
        json!({
            "handle": handle,
            "sampleRate": sample_rate,
            "blockSize": block_size,
            "channelCount": channel_count,
            "pcmBase64": pcm_base64,
        }),
    )
    .await
}

#[tauri::command]
pub async fn vst_get_ws_endpoint(
    state: tauri::State<'_, Arc<VstHostState>>,
) -> Result<String, String> {
    let port = state.ws_port.load(Ordering::SeqCst);
    if port == 0 {
        return Err("host_unavailable".into());
    }
    Ok(format!("ws://127.0.0.1:{port}"))
}

#[tauri::command]
pub async fn vst_pick_plugin_file(_app: AppHandle) -> Result<Option<String>, String> {
    // 兜底实现：dialog 插件不可用时上层调到这里。当前返回错误让前端 fallback 到 dialog
    Err("vst_pick_plugin_file not implemented; install @tauri-apps/plugin-dialog".into())
}
