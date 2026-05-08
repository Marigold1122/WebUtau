#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api_key_vault;
mod backend;
mod local_server;
mod tunnel;
mod updater;
mod vst_host;

use std::{
    io,
    sync::{
        atomic::{AtomicU16, Ordering},
        Arc,
    },
};
use tauri::Manager;
use tunnel::{TunnelState, TunnelStatus};
use vst_host::VstHostState;

pub struct AppCtx {
    pub tunnel: Arc<TunnelState>,
    pub local_port: AtomicU16,
    pub vst_host: Arc<VstHostState>,
}

fn main() {
    let ctx = Arc::new(AppCtx {
        tunnel: Arc::new(TunnelState::default()),
        local_port: AtomicU16::new(0),
        vst_host: Arc::new(VstHostState::default()),
    });

    let manage_ctx = Arc::clone(&ctx);

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            tunnel_get_status,
            tunnel_start,
            tunnel_stop,
            updater::check_for_updates,
            api_key_vault::save_api_key_config,
            api_key_vault::get_api_key_config,
            api_key_vault::clear_api_key_config,
            vst_host::vst_list_plugins,
            vst_host::vst_scan_dirs,
            vst_host::vst_load,
            vst_host::vst_unload,
            vst_host::vst_show_editor,
            vst_host::vst_hide_editor,
            vst_host::vst_set_param,
            vst_host::vst_get_param,
            vst_host::vst_get_state,
            vst_host::vst_set_state,
            vst_host::vst_process_offline,
            vst_host::vst_get_ws_endpoint,
            vst_host::vst_pick_plugin_file,
        ])
        .setup(move |app| {
            app.manage(backend::BackendState::default());
            app.manage(Arc::clone(&manage_ctx));
            // VST 宿主状态作为独立 State 管理，便于命令拿到 Arc
            app.manage(Arc::clone(&manage_ctx.vst_host));

            backend::start(app.handle()).map_err(io_error)?;

            // 解析 cloudflared 二进制
            let bin = tunnel::resolve_bundled_cloudflared(app.handle());
            if bin.is_some() {
                manage_ctx.tunnel.set_bundled_binary(bin);
            } else {
                manage_ctx.tunnel.mark_unavailable(
                    "未找到 cloudflared 二进制",
                    Some("应用资源目录中缺少 cloudflared，重新安装或检查打包流程".into()),
                );
            }

            // 启动嵌入式 HTTP 服务（serve 嵌入前端 + 反代 /api、/seedvc/api）
            let ctx_clone = Arc::clone(&manage_ctx);
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match local_server::spawn_local_server(app_handle).await {
                    Ok(handle) => {
                        ctx_clone.local_port.store(handle.port, Ordering::SeqCst);
                        eprintln!("[local_server] listening on 127.0.0.1:{}", handle.port);
                    }
                    Err(err) => {
                        eprintln!("[local_server] failed: {err}");
                        ctx_clone
                            .tunnel
                            .mark_unavailable("本地 HTTP 服务启动失败", Some(err));
                    }
                }
            });

            if let Some(window) = app.get_webview_window("main") {
                window.show().map_err(|error| io_error(error.to_string()))?;
                window
                    .set_focus()
                    .map_err(|error| io_error(error.to_string()))?;
            }

            // VST 集成自检：环境变量触发，跑一次 host spawn + list_plugins
            if std::env::var("MELODY_VST_SELF_TEST").ok().as_deref() == Some("1") {
                let test_app = app.handle().clone();
                let test_state = Arc::clone(&manage_ctx.vst_host);
                tauri::async_runtime::spawn(async move {
                    vst_host::run_self_test(test_app, test_state).await;
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build webUTAU desktop shell")
        .run(move |app, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                let tunnel = Arc::clone(&ctx.tunnel);
                let vst = Arc::clone(&ctx.vst_host);
                tauri::async_runtime::block_on(async move {
                    let _ = tunnel::stop_tunnel(tunnel).await;
                    vst_host::shutdown(&vst).await;
                });
                backend::stop(app);
            }
        });
}

#[tauri::command]
async fn tunnel_get_status(ctx: tauri::State<'_, Arc<AppCtx>>) -> Result<TunnelStatus, String> {
    Ok(ctx.tunnel.snapshot())
}

#[tauri::command]
async fn tunnel_start(ctx: tauri::State<'_, Arc<AppCtx>>) -> Result<TunnelStatus, String> {
    let port = ctx.local_port.load(Ordering::SeqCst);
    if port == 0 {
        ctx.tunnel.mark_unavailable(
            "本地 HTTP 服务尚未就绪",
            Some("请稍候片刻再试；若问题持续，请检查应用日志".into()),
        );
        return Ok(ctx.tunnel.snapshot());
    }
    tunnel::start_tunnel(Arc::clone(&ctx.tunnel), port).await
}

#[tauri::command]
async fn tunnel_stop(ctx: tauri::State<'_, Arc<AppCtx>>) -> Result<TunnelStatus, String> {
    Ok(tunnel::stop_tunnel(Arc::clone(&ctx.tunnel)).await)
}

fn io_error(message: impl Into<String>) -> io::Error {
    io::Error::other(message.into())
}
