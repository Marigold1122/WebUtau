#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod local_server;
mod tunnel;

use std::{
    io,
    sync::{
        atomic::{AtomicU16, Ordering},
        Arc,
    },
};
use tauri::Manager;
use tunnel::{TunnelState, TunnelStatus};

pub struct AppCtx {
    pub tunnel: Arc<TunnelState>,
    pub local_port: AtomicU16,
}

fn main() {
    let ctx = Arc::new(AppCtx {
        tunnel: Arc::new(TunnelState::default()),
        local_port: AtomicU16::new(0),
    });

    let manage_ctx = Arc::clone(&ctx);

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            tunnel_get_status,
            tunnel_start,
            tunnel_stop,
        ])
        .setup(move |app| {
            app.manage(backend::BackendState::default());
            app.manage(Arc::clone(&manage_ctx));

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

            // 启动嵌入式 HTTP 服务（serve dist + 反代 /api、/seedvc/api）
            if let Some(dist) = local_server::resolve_frontend_dist(app.handle()) {
                let ctx_clone = Arc::clone(&manage_ctx);
                tauri::async_runtime::spawn(async move {
                    match local_server::spawn_local_server(dist).await {
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
            } else {
                manage_ctx
                    .tunnel
                    .mark_unavailable("未找到前端资源目录，无法对外暴露", None);
            }

            if let Some(window) = app.get_webview_window("main") {
                window.show().map_err(|error| io_error(error.to_string()))?;
                window
                    .set_focus()
                    .map_err(|error| io_error(error.to_string()))?;
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
                tauri::async_runtime::block_on(async move {
                    let _ = tunnel::stop_tunnel(tunnel).await;
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
