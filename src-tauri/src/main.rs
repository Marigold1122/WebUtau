#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;

use std::io;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(backend::BackendState::default());

            backend::start(app.handle()).map_err(io_error)?;

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
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                backend::stop(app);
            }
        });
}

fn io_error(message: impl Into<String>) -> io::Error {
    io::Error::other(message.into())
}
