/// 配置读写命令
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

use crate::models::types::VersionInfo;

fn openclaw_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".openclaw")
}

fn backups_dir() -> PathBuf {
    openclaw_dir().join("backups")
}

#[tauri::command]
pub fn read_openclaw_config() -> Result<Value, String> {
    let path = openclaw_dir().join("openclaw.json");
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("读取配置失败: {e}"))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("解析 JSON 失败: {e}"))
}

#[tauri::command]
pub fn write_openclaw_config(config: Value) -> Result<(), String> {
    let path = openclaw_dir().join("openclaw.json");
    // 备份
    let bak = openclaw_dir().join("openclaw.json.bak");
    let _ = fs::copy(&path, &bak);
    // 写入
    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, json)
        .map_err(|e| format!("写入失败: {e}"))
}

#[tauri::command]
pub fn read_mcp_config() -> Result<Value, String> {
    let path = openclaw_dir().join("mcp.json");
    if !path.exists() {
        return Ok(Value::Object(Default::default()));
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("读取 MCP 配置失败: {e}"))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("解析 JSON 失败: {e}"))
}

#[tauri::command]
pub fn write_mcp_config(config: Value) -> Result<(), String> {
    let path = openclaw_dir().join("mcp.json");
    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, json)
        .map_err(|e| format!("写入失败: {e}"))
}

#[tauri::command]
pub fn get_version_info() -> Result<VersionInfo, String> {
    // 从 openclaw.json 的 meta.lastTouchedVersion 读取
    let config = read_openclaw_config()?;
    let current = config
        .get("meta")
        .and_then(|m| m.get("lastTouchedVersion"))
        .and_then(|v| v.as_str())
        .map(String::from);

    Ok(VersionInfo {
        current,
        latest: None,
        update_available: false,
    })
}

#[tauri::command]
pub fn check_installation() -> Result<Value, String> {
    let openclaw_dir = openclaw_dir();
    let installed = openclaw_dir.join("openclaw.json").exists();
    let mut result = serde_json::Map::new();
    result.insert("installed".into(), Value::Bool(installed));
    result.insert("path".into(), Value::String(openclaw_dir.to_string_lossy().to_string()));
    Ok(Value::Object(result))
}

#[tauri::command]
pub fn write_env_file(path: String, config: String) -> Result<(), String> {
    let expanded = if path.starts_with("~/") {
        dirs::home_dir()
            .unwrap_or_default()
            .join(&path[2..])
    } else {
        PathBuf::from(&path)
    };
    if let Some(parent) = expanded.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&expanded, &config)
        .map_err(|e| format!("写入 .env 失败: {e}"))
}

// ===== 备份管理 =====

#[tauri::command]
pub fn list_backups() -> Result<Value, String> {
    let dir = backups_dir();
    if !dir.exists() {
        return Ok(Value::Array(vec![]));
    }
    let mut backups: Vec<Value> = vec![];
    let entries = fs::read_dir(&dir)
        .map_err(|e| format!("读取备份目录失败: {e}"))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let meta = fs::metadata(&path).ok();
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let created = meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let mut obj = serde_json::Map::new();
        obj.insert("name".into(), Value::String(name));
        obj.insert("size".into(), Value::Number(size.into()));
        obj.insert("created_at".into(), Value::Number(created.into()));
        backups.push(Value::Object(obj));
    }
    // 按时间倒序
    backups.sort_by(|a, b| {
        let ta = a.get("created_at").and_then(|v| v.as_u64()).unwrap_or(0);
        let tb = b.get("created_at").and_then(|v| v.as_u64()).unwrap_or(0);
        tb.cmp(&ta)
    });
    Ok(Value::Array(backups))
}

#[tauri::command]
pub fn create_backup() -> Result<Value, String> {
    let dir = backups_dir();
    fs::create_dir_all(&dir)
        .map_err(|e| format!("创建备份目录失败: {e}"))?;

    let src = openclaw_dir().join("openclaw.json");
    if !src.exists() {
        return Err("openclaw.json 不存在".into());
    }

    let now = chrono::Local::now();
    let name = format!("openclaw-{}.json", now.format("%Y%m%d-%H%M%S"));
    let dest = dir.join(&name);
    fs::copy(&src, &dest)
        .map_err(|e| format!("备份失败: {e}"))?;

    let size = fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    let mut obj = serde_json::Map::new();
    obj.insert("name".into(), Value::String(name));
    obj.insert("size".into(), Value::Number(size.into()));
    Ok(Value::Object(obj))
}

#[tauri::command]
pub fn restore_backup(name: String) -> Result<(), String> {
    // 安全检查
    if name.contains("..") || name.contains('/') {
        return Err("非法文件名".into());
    }
    let backup_path = backups_dir().join(&name);
    if !backup_path.exists() {
        return Err(format!("备份文件不存在: {name}"));
    }
    let target = openclaw_dir().join("openclaw.json");

    // 恢复前先自动备份当前配置
    if target.exists() {
        let _ = create_backup();
    }

    fs::copy(&backup_path, &target)
        .map_err(|e| format!("恢复失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn delete_backup(name: String) -> Result<(), String> {
    if name.contains("..") || name.contains('/') {
        return Err("非法文件名".into());
    }
    let path = backups_dir().join(&name);
    if !path.exists() {
        return Err(format!("备份文件不存在: {name}"));
    }
    fs::remove_file(&path)
        .map_err(|e| format!("删除失败: {e}"))
}

/// 重载 Gateway 服务（unload + load plist）
#[tauri::command]
pub fn reload_gateway() -> Result<String, String> {
    let home = dirs::home_dir().unwrap_or_default();
    let plist = format!(
        "{}/Library/LaunchAgents/ai.openclaw.gateway.plist",
        home.display()
    );

    if !std::path::Path::new(&plist).exists() {
        return Err("Gateway plist 不存在".into());
    }

    // 先 unload，忽略错误
    let _ = std::process::Command::new("launchctl")
        .args(["unload", &plist])
        .output();

    std::thread::sleep(std::time::Duration::from_millis(500));

    let output = std::process::Command::new("launchctl")
        .args(["load", &plist])
        .output()
        .map_err(|e| format!("重载 Gateway 失败: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.trim().is_empty() {
            return Err(format!("重载 Gateway 失败: {stderr}"));
        }
    }

    Ok("Gateway 已重载".into())
}

/// 测试模型连通性：向 provider 发送一个简单的 chat completion 请求
#[tauri::command]
pub async fn test_model(
    base_url: String,
    api_key: String,
    model_id: String,
) -> Result<String, String> {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    let body = serde_json::json!({
        "model": model_id,
        "messages": [{"role": "user", "content": "Hi"}],
        "max_tokens": 16,
        "stream": false
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let mut req = client.post(&url).json(&body);
    if !api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {api_key}"));
    }

    let resp = req.send().await.map_err(|e| {
        if e.is_timeout() {
            "请求超时 (30s)".to_string()
        } else if e.is_connect() {
            format!("连接失败: {e}")
        } else {
            format!("请求失败: {e}")
        }
    })?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();

    if !status.is_success() {
        // 尝试提取错误信息
        let msg = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .map(String::from)
            })
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(msg);
    }

    // 提取回复内容
    let reply = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| {
            v.get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
                .map(String::from)
        })
        .unwrap_or_else(|| "（无回复内容）".into());

    Ok(reply)
}
