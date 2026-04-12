use serde::Deserialize;
use std::{
    env,
    fs::{self, OpenOptions},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{path::BaseDirectory, AppHandle, Manager};

const BACKEND_HOST: &str = "127.0.0.1";
const BACKEND_PORT: u16 = 38510;
const BACKEND_START_TIMEOUT: Duration = Duration::from_secs(20);
const BACKEND_CONNECT_TIMEOUT: Duration = Duration::from_millis(250);

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct BackendState(pub Mutex<Option<Child>>);

impl Default for BackendState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

#[derive(Debug, Deserialize)]
struct RuntimeManifest {
    #[serde(rename = "backendExecutable")]
    backend_executable: String,
    fingerprint: String,
    platform: String,
}

struct InstalledRuntime {
    executable_path: PathBuf,
    working_dir: PathBuf,
    voicebanks_dir: PathBuf,
    uploads_dir: PathBuf,
    output_dir: PathBuf,
    log_path: PathBuf,
}

pub fn start(app: &AppHandle) -> Result<(), String> {
    if port_is_open(BACKEND_PORT) {
        return Ok(());
    }

    let state = app.state::<BackendState>();
    let mut child_slot = state
        .0
        .lock()
        .map_err(|_| "failed to lock backend process state".to_string())?;

    if child_slot.is_some() {
        return Ok(());
    }

    let runtime = install_runtime(app)?;
    let mut child = spawn_backend(&runtime)?;
    wait_for_backend_ready(&mut child, &runtime.log_path)?;
    *child_slot = Some(child);

    Ok(())
}

pub fn stop(app: &AppHandle) {
    let state = app.state::<BackendState>();
    let Ok(mut child_slot) = state.0.lock() else {
        return;
    };

    let Some(child) = child_slot.as_mut() else {
        return;
    };

    let _ = child.kill();
    let _ = child.wait();
    *child_slot = None;
}

fn install_runtime(app: &AppHandle) -> Result<InstalledRuntime, String> {
    let bundled_runtime_dir = resolve_bundled_runtime_dir(app)?;
    let bundled_manifest_path = bundled_runtime_dir.join("backend-manifest.json");
    let bundled_manifest_text = fs::read_to_string(&bundled_manifest_path).map_err(|error| {
        format!(
            "failed to read Tauri backend manifest {}: {error}",
            bundled_manifest_path.display()
        )
    })?;
    let manifest: RuntimeManifest = serde_json::from_str(&bundled_manifest_text)
        .map_err(|error| format!("failed to parse Tauri backend manifest: {error}"))?;

    let storage_root = resolve_storage_root()?;
    let runtime_install_dir = storage_root.join("runtime");
    let installed_manifest_path = runtime_install_dir.join("backend-manifest.json");
    let installed_executable_path = runtime_install_dir
        .join("backend")
        .join(&manifest.backend_executable);

    let manifest_matches = fs::read_to_string(&installed_manifest_path)
        .map(|current| current == bundled_manifest_text)
        .unwrap_or(false);

    if !manifest_matches || !installed_executable_path.exists() {
        if runtime_install_dir.exists() {
            fs::remove_dir_all(&runtime_install_dir).map_err(|error| {
                format!(
                    "failed to clear installed runtime directory {}: {error}",
                    runtime_install_dir.display()
                )
            })?;
        }
        copy_dir_recursive(&bundled_runtime_dir, &runtime_install_dir)?;
        ensure_executable_bit(&installed_executable_path)?;
    }

    let voicebanks_dir = storage_root.join("voicebanks");
    let uploads_dir = storage_root.join("uploads");
    let output_dir = storage_root.join("output");
    let log_path = storage_root.join("logs").join("backend.log");

    fs::create_dir_all(&voicebanks_dir).map_err(|error| {
        format!(
            "failed to create voicebanks directory {}: {error}",
            voicebanks_dir.display()
        )
    })?;
    fs::create_dir_all(&uploads_dir).map_err(|error| {
        format!(
            "failed to create uploads directory {}: {error}",
            uploads_dir.display()
        )
    })?;
    fs::create_dir_all(&output_dir).map_err(|error| {
        format!(
            "failed to create output directory {}: {error}",
            output_dir.display()
        )
    })?;
    if let Some(log_dir) = log_path.parent() {
        fs::create_dir_all(log_dir).map_err(|error| {
            format!(
                "failed to create backend log directory {}: {error}",
                log_dir.display()
            )
        })?;
    }

    seed_voicebanks_if_needed(
        &runtime_install_dir.join("voicebanks-seed"),
        &voicebanks_dir,
    )?;
    write_voicebanks_readme(&voicebanks_dir)?;

    let _ = (&manifest.fingerprint, &manifest.platform);

    Ok(InstalledRuntime {
        executable_path: installed_executable_path,
        working_dir: runtime_install_dir.join("backend"),
        voicebanks_dir,
        uploads_dir,
        output_dir,
        log_path,
    })
}

fn resolve_bundled_runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resolve("runtime", BaseDirectory::Resource)
        .map_err(|error| format!("failed to resolve Tauri resource directory: {error}"))?;
    if resource_dir.exists() {
        return Ok(resource_dir);
    }

    let dev_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/runtime");
    if dev_dir.exists() {
        return Ok(dev_dir);
    }

    Err(
        "desktop runtime resources are missing. Run `npm run tauri:prepare-assets` before starting the Tauri shell."
            .to_string(),
    )
}

fn resolve_storage_root() -> Result<PathBuf, String> {
    if cfg!(target_os = "windows") {
        let executable_path = env::current_exe()
            .map_err(|error| format!("failed to resolve current executable path: {error}"))?;
        let install_dir = executable_path.parent().ok_or_else(|| {
            format!(
                "failed to resolve install directory from executable path {}",
                executable_path.display()
            )
        })?;
        return Ok(install_dir.to_path_buf());
    }

    let home_dir = env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "failed to resolve HOME for desktop data directory".to_string())?;
    Ok(home_dir.join("webutau"))
}

fn seed_voicebanks_if_needed(source_dir: &Path, target_dir: &Path) -> Result<(), String> {
    if !source_dir.exists() || !directory_is_empty(target_dir)? {
        return Ok(());
    }
    copy_dir_contents(source_dir, target_dir)
}

fn spawn_backend(runtime: &InstalledRuntime) -> Result<Child, String> {
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&runtime.log_path)
        .map_err(|error| {
            format!(
                "failed to open backend log {}: {error}",
                runtime.log_path.display()
            )
        })?;
    let stderr = stdout
        .try_clone()
        .map_err(|error| format!("failed to clone backend log handle: {error}"))?;

    let mut command = Command::new(&runtime.executable_path);
    command.current_dir(&runtime.working_dir);
    command.env("VoicebanksPath", &runtime.voicebanks_dir);
    command.env("UploadsPath", &runtime.uploads_dir);
    command.env("OutputPath", &runtime.output_dir);
    command.env("MELODY_TAURI_WRAPPER", "1");
    command.stdout(Stdio::from(stdout));
    command.stderr(Stdio::from(stderr));
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command.spawn().map_err(|error| {
        format!(
            "failed to launch bundled DiffSinger backend {}: {error}",
            runtime.executable_path.display()
        )
    })
}

fn wait_for_backend_ready(child: &mut Child, log_path: &Path) -> Result<(), String> {
    let deadline = Instant::now() + BACKEND_START_TIMEOUT;
    while Instant::now() < deadline {
        if port_is_open(BACKEND_PORT) {
            return Ok(());
        }

        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("failed to poll backend status: {error}"))?
        {
            return Err(format!(
                "bundled DiffSinger backend exited early with status {status}. See {}",
                log_path.display()
            ));
        }

        thread::sleep(Duration::from_millis(200));
    }

    let _ = child.kill();
    let _ = child.wait();

    Err(format!(
        "bundled DiffSinger backend did not become ready on http://{BACKEND_HOST}:{BACKEND_PORT} within {}s. See {}",
        BACKEND_START_TIMEOUT.as_secs(),
        log_path.display()
    ))
}

fn port_is_open(port: u16) -> bool {
    let address: SocketAddr = format!("{BACKEND_HOST}:{port}")
        .parse()
        .expect("backend socket address must be valid");
    TcpStream::connect_timeout(&address, BACKEND_CONNECT_TIMEOUT).is_ok()
}

fn copy_dir_recursive(source_dir: &Path, target_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(target_dir).map_err(|error| {
        format!(
            "failed to create runtime directory {}: {error}",
            target_dir.display()
        )
    })?;
    copy_dir_contents(source_dir, target_dir)
}

fn copy_dir_contents(source_dir: &Path, target_dir: &Path) -> Result<(), String> {
    for entry in fs::read_dir(source_dir)
        .map_err(|error| format!("failed to read directory {}: {error}", source_dir.display()))?
    {
        let entry = entry.map_err(|error| {
            format!(
                "failed to enumerate directory {}: {error}",
                source_dir.display()
            )
        })?;
        let source_path = entry.path();
        let target_path = target_dir.join(entry.file_name());
        let file_type = entry.file_type().map_err(|error| {
            format!(
                "failed to inspect runtime entry {}: {error}",
                source_path.display()
            )
        })?;

        if file_type.is_dir() {
            copy_dir_recursive(&source_path, &target_path)?;
        } else {
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    format!(
                        "failed to create runtime parent directory {}: {error}",
                        parent.display()
                    )
                })?;
            }
            fs::copy(&source_path, &target_path).map_err(|error| {
                format!(
                    "failed to copy runtime file {} -> {}: {error}",
                    source_path.display(),
                    target_path.display()
                )
            })?;
        }
    }

    Ok(())
}

fn directory_is_empty(path: &Path) -> Result<bool, String> {
    for entry in fs::read_dir(path)
        .map_err(|error| format!("failed to read directory {}: {error}", path.display()))?
    {
        let entry = entry.map_err(|error| {
            format!("failed to enumerate directory {}: {error}", path.display())
        })?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if matches!(name.as_ref(), "README.txt" | ".DS_Store") {
            continue;
        }
        return Ok(false);
    }
    Ok(true)
}

fn write_voicebanks_readme(voicebanks_dir: &Path) -> Result<(), String> {
    let readme_path = voicebanks_dir.join("README.txt");
    if readme_path.exists() {
        return Ok(());
    }

    let content = [
        "webUTAU Voicebanks",
        "",
        "Place each DiffSinger/OpenUtau voicebank in its own subdirectory here.",
        "Examples:",
        "  voicebanks/YourSinger/dsconfig.yaml",
        "  voicebanks/YourSinger/character.txt",
        "",
        "You can also import zipped voicebanks from inside the app.",
    ]
    .join("\n");

    fs::write(&readme_path, content).map_err(|error| {
        format!(
            "failed to write voicebank directory guide {}: {error}",
            readme_path.display()
        )
    })
}

#[cfg(unix)]
fn ensure_executable_bit(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = fs::metadata(path).map_err(|error| {
        format!(
            "failed to stat backend executable {}: {error}",
            path.display()
        )
    })?;
    let mut permissions = metadata.permissions();
    permissions.set_mode(permissions.mode() | 0o755);
    fs::set_permissions(path, permissions).map_err(|error| {
        format!(
            "failed to mark backend executable as runnable {}: {error}",
            path.display()
        )
    })
}

#[cfg(not(unix))]
fn ensure_executable_bit(_path: &Path) -> Result<(), String> {
    Ok(())
}
