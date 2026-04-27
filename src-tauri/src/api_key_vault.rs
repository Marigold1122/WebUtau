// 桌面版 LLM API key 存储——走 OS 级密钥库（keyring crate 内部封装：
//   macOS  → Keychain Services
//   Windows → Credential Manager (wincred)
//   Linux   → Secret Service (libsecret，GNOME Keyring / KWallet 后端)）
//
// 安全升级：相比浏览器侧 AES-GCM 加密的 localStorage，OS 钥匙库的优势：
//   1. 密钥存在 OS 进程外的隔离存储里——浏览器引擎 / 网页 JS 都碰不到
//   2. 解锁通常受用户登录密码 / 生物识别保护
//   3. 流氓浏览器扩展 / 同源 XSS 都没办法读到
//   4. 删除应用时 OS 自动清理（用户卸载 = key 跟着没）
//
// 三个 IPC 命令暴露给前端：save / get / clear。前端通过 isTauriRuntime() 探测后
// 直接走这一路，绕过 web 端的 localStorage 加密路径
use keyring::Entry;
use serde::{Deserialize, Serialize};

// keyring 用 (service, account) 索引一条 entry。我们用 service = 应用唯一标识，
// account 区分 api_key / base_url / model 三个字段。OS Keychain Access.app 里
// 用户能搜到 "WebUtau-LyricAI" 这个 service 名直接看到 / 删除
const SERVICE_NAME: &str = "WebUtau-LyricAI";
const ACCOUNT_API_KEY: &str = "user-llm-api-key";
const ACCOUNT_BASE_URL: &str = "user-llm-base-url";
const ACCOUNT_MODEL: &str = "user-llm-model";

#[derive(Debug, Serialize, Deserialize)]
pub struct ApiKeyConfig {
    #[serde(rename = "apiKey")]
    pub api_key: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    pub model: String,
}

fn open_entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE_NAME, account)
        .map_err(|e| format!("打开 keychain entry 失败 [{}]: {}", account, e))
}

// 设字符串：空字符串视为"删除"——避免 keychain 里残留空 entry 看着乱
fn write_or_delete(account: &str, value: &str) -> Result<(), String> {
    let entry = open_entry(account)?;
    if value.is_empty() {
        // delete_credential 在 entry 不存在时会 Err(NoEntry)——这种情况算成功
        match entry.delete_credential() {
            Ok(_) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("删除 keychain entry 失败 [{}]: {}", account, e)),
        }
    } else {
        entry
            .set_password(value)
            .map_err(|e| format!("写入 keychain 失败 [{}]: {}", account, e))
    }
}

// 读字符串：不存在就返回空串。其它 IO 错误才 throw
fn read_or_empty(account: &str) -> Result<String, String> {
    let entry = open_entry(account)?;
    match entry.get_password() {
        Ok(s) => Ok(s),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(e) => Err(format!("读取 keychain 失败 [{}]: {}", account, e)),
    }
}

#[tauri::command]
pub fn save_api_key_config(config: ApiKeyConfig) -> Result<(), String> {
    write_or_delete(ACCOUNT_API_KEY, config.api_key.trim())?;
    write_or_delete(ACCOUNT_BASE_URL, config.base_url.trim())?;
    write_or_delete(ACCOUNT_MODEL, config.model.trim())?;
    Ok(())
}

#[tauri::command]
pub fn get_api_key_config() -> Result<ApiKeyConfig, String> {
    Ok(ApiKeyConfig {
        api_key: read_or_empty(ACCOUNT_API_KEY)?,
        base_url: read_or_empty(ACCOUNT_BASE_URL)?,
        model: read_or_empty(ACCOUNT_MODEL)?,
    })
}

#[tauri::command]
pub fn clear_api_key_config() -> Result<(), String> {
    // 三条 entry 各自尝试删除，单个失败不阻断其它——保证清得尽量干净
    let _ = write_or_delete(ACCOUNT_API_KEY, "");
    let _ = write_or_delete(ACCOUNT_BASE_URL, "");
    let _ = write_or_delete(ACCOUNT_MODEL, "");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 注意：keyring 在测试环境下会真的去访问 OS Keychain。
    // 为避免污染开发者本机的钥匙串，测试用一个临时 service 名 + 测完清理。
    // CI 上 Linux 没有 secret-service daemon 时这些测试会失败——加 #[ignore] 可绕过

    #[test]
    fn config_serde_roundtrip() {
        // 验证 serde rename 对了，前端发的 camelCase 能正确反序列化
        let json = r#"{"apiKey":"sk-xxx","baseUrl":"https://api.deepseek.com/v1","model":"deepseek-chat"}"#;
        let cfg: ApiKeyConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.api_key, "sk-xxx");
        assert_eq!(cfg.base_url, "https://api.deepseek.com/v1");
        assert_eq!(cfg.model, "deepseek-chat");
        // 反序列化输出也得是 camelCase
        let out = serde_json::to_string(&cfg).unwrap();
        assert!(out.contains("\"apiKey\":\"sk-xxx\""));
        assert!(out.contains("\"baseUrl\":"));
        assert!(!out.contains("\"api_key\":"));
    }
}
