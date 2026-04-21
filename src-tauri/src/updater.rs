// 「检查更新」命令：复用 tauri-plugin-updater 的 latest.json 格式，但这里用一段
// 独立的代码去拉取——目的是让 UI 能显示"当前版本 / 最新版本 / 更新日志 / 下载链接"，
// 不必强制让用户直接触发 plugin 的下载流程。
//
// endpoints 顺序 = R2 (CDN) 优先 → GitHub Releases 兜底。两份 latest.json 内容
// 的 signature / version / notes / pub_date 完全相同，只是 platforms[*].url 分别
// 指向 R2 公域和 github releases 下载。

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

const UPDATE_CHECK_ENDPOINTS: &[&str] = &[
    "https://melody-singer.harucdn.com/latest.json",
    "https://github.com/Marigold1122/melody-singer/releases/latest/download/latest.json",
];

const GITHUB_RELEASE_TAG_BASE: &str = "https://github.com/Marigold1122/melody-singer/releases/tag";

#[derive(Debug, Serialize, Clone)]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub release_url: Option<String>,
    pub release_notes: Option<String>,
    pub download_url: Option<String>,
    pub published_at: Option<String>,
    pub check_error: Option<String>,
}

fn latest_json_platform_key() -> &'static str {
    if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "darwin-aarch64"
        } else {
            "darwin-x86_64"
        }
    } else if cfg!(target_os = "windows") {
        "windows-x86_64"
    } else if cfg!(target_os = "linux") {
        "linux-x86_64"
    } else {
        ""
    }
}

fn version_is_newer(current: &str, latest: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.trim_start_matches('v')
            .split('.')
            .filter_map(|p| {
                // 去掉 prerelease 后缀（1.2.3-beta.1 → 只取 1.2.3 比较）
                let core = p.split(|c: char| !c.is_ascii_digit()).next().unwrap_or("");
                core.parse::<u64>().ok()
            })
            .collect()
    };
    let c = parse(current);
    let l = parse(latest);
    l > c
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<UpdateCheckResult, String> {
    let current_version = app
        .config()
        .version
        .clone()
        .unwrap_or_else(|| "0.0.0".to_string());

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent(format!("webUTAU/{current_version}"))
        .build()
        .map_err(|e| e.to_string())?;

    let mut last_error: Option<String> = None;
    for endpoint in UPDATE_CHECK_ENDPOINTS {
        match client.get(*endpoint).send().await {
            Ok(resp) if resp.status().is_success() => match resp.json::<Value>().await {
                Ok(body) => {
                    let latest_version = body["version"]
                        .as_str()
                        .unwrap_or("")
                        .trim_start_matches('v')
                        .to_string();
                    let notes = body["notes"].as_str().map(String::from);
                    let published = body["pub_date"].as_str().map(String::from);

                    let plat_key = latest_json_platform_key();
                    let download_url = body
                        .get("platforms")
                        .and_then(|p| p.get(plat_key))
                        .and_then(|entry| entry.get("url"))
                        .and_then(Value::as_str)
                        .map(String::from);

                    let release_url = if endpoint.contains("github.com") {
                        Some(format!("{GITHUB_RELEASE_TAG_BASE}/v{latest_version}"))
                    } else {
                        download_url.clone()
                    };

                    let update_available = !latest_version.is_empty()
                        && version_is_newer(&current_version, &latest_version);

                    return Ok(UpdateCheckResult {
                        current_version,
                        latest_version: if latest_version.is_empty() {
                            None
                        } else {
                            Some(latest_version)
                        },
                        update_available,
                        release_url,
                        release_notes: notes,
                        download_url,
                        published_at: published,
                        check_error: None,
                    });
                }
                Err(e) => {
                    last_error = Some(format!("{endpoint}: invalid JSON ({e})"));
                }
            },
            Ok(resp) => {
                last_error = Some(format!("{endpoint}: HTTP {}", resp.status()));
            }
            Err(e) => {
                last_error = Some(format!("{endpoint}: {e}"));
            }
        }
    }

    Ok(UpdateCheckResult {
        current_version,
        latest_version: None,
        update_available: false,
        release_url: None,
        release_notes: None,
        download_url: None,
        published_at: None,
        check_error: last_error.or_else(|| Some("所有更新源均不可达".to_string())),
    })
}
