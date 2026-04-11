use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use tokio::process::Command;

/// 前端热更新目录 (~/.openclaw/clawpanel/web-update/)
pub fn update_dir() -> PathBuf {
    super::openclaw_dir().join("clawpanel").join("web-update")
}

/// 更新清单 URL（GitHub Pages 托管）
const LATEST_JSON_URL: &str = "https://claw.qt.cool/update/latest.json";

/// 检查前端是否有新版本可用
#[tauri::command]
pub async fn check_frontend_update() -> Result<Value, String> {
    let client = super::build_http_client(std::time::Duration::from_secs(10), Some("ClawPanel"))
        .map_err(|e| format!("HTTP 客户端错误: {e}"))?;

    let resp = client
        .get(LATEST_JSON_URL)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("服务器返回 {}", resp.status()));
    }

    let manifest: Value = resp.json().await.map_err(|e| format!("解析失败: {e}"))?;

    let latest = manifest
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let current = env!("CARGO_PKG_VERSION");

    // 检查最低兼容的 app 版本（前端可能依赖较新的 Rust 后端命令）
    let min_app = manifest
        .get("minAppVersion")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0");

    let compatible = version_ge(current, min_app);
    let remote_newer = !latest.is_empty() && compatible && version_gt(&latest, current);
    let update_ready = remote_newer && update_dir().join("index.html").exists();
    let has_update = remote_newer && !update_ready;

    Ok(serde_json::json!({
        "currentVersion": current,
        "latestVersion": latest,
        "hasUpdate": has_update,
        "compatible": compatible,
        "updateReady": update_ready,
        "manifest": manifest
    }))
}

/// 下载并解压前端更新包
#[tauri::command]
pub async fn download_frontend_update(url: String, expected_hash: String) -> Result<Value, String> {
    let client = super::build_http_client(std::time::Duration::from_secs(120), Some("ClawPanel"))
        .map_err(|e| format!("HTTP 客户端错误: {e}"))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载失败: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("下载失败: HTTP {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取数据失败: {e}"))?;

    // 校验 SHA-256
    if !expected_hash.is_empty() {
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let hash = format!("{:x}", hasher.finalize());
        let expected = expected_hash
            .strip_prefix("sha256:")
            .unwrap_or(&expected_hash);
        if hash != expected {
            return Err(format!("哈希校验失败: 期望 {}，实际 {}", expected, hash));
        }
    }

    // 清理旧更新，解压新包
    let dir = update_dir();
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("清理旧更新失败: {e}"))?;
    }
    fs::create_dir_all(&dir).map_err(|e| format!("创建更新目录失败: {e}"))?;

    let cursor = std::io::Cursor::new(bytes.as_ref());
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("解压失败: {e}"))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("读取压缩条目失败: {e}"))?;

        let name = file.name().to_string();
        let target = dir.join(&name);

        if name.ends_with('/') {
            fs::create_dir_all(&target).map_err(|e| format!("创建子目录失败: {e}"))?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {e}"))?;
            }
            let mut buf = Vec::new();
            file.read_to_end(&mut buf)
                .map_err(|e| format!("读取文件内容失败: {e}"))?;
            fs::write(&target, &buf).map_err(|e| format!("写入文件失败: {e}"))?;
        }
    }

    Ok(serde_json::json!({
        "success": true,
        "files": archive.len(),
        "path": dir.to_string_lossy()
    }))
}

/// 回退前端更新（删除热更新目录，下次启动使用内嵌资源）
#[tauri::command]
pub fn rollback_frontend_update() -> Result<Value, String> {
    let dir = update_dir();
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("回退失败: {e}"))?;
    }
    Ok(serde_json::json!({ "success": true }))
}

/// 获取当前热更新状态
#[tauri::command]
pub fn get_update_status() -> Result<Value, String> {
    let dir = update_dir();
    let ready = dir.join("index.html").exists();

    // 尝试读取已下载更新的版本信息
    let update_version = if ready {
        dir.join(".version")
            .exists()
            .then(|| fs::read_to_string(dir.join(".version")).ok())
            .flatten()
            .unwrap_or_default()
    } else {
        String::new()
    };

    Ok(serde_json::json!({
        "currentVersion": env!("CARGO_PKG_VERSION"),
        "updateReady": ready,
        "updateVersion": update_version,
        "updateDir": dir.to_string_lossy()
    }))
}

/// 简单的语义化版本比较：current >= required
fn version_ge(current: &str, required: &str) -> bool {
    let parse = |s: &str| -> Vec<u32> {
        s.trim_start_matches('v')
            .split('.')
            .filter_map(|p| p.parse().ok())
            .collect()
    };
    let c = parse(current);
    let r = parse(required);
    for i in 0..r.len().max(c.len()) {
        let cv = c.get(i).copied().unwrap_or(0);
        let rv = r.get(i).copied().unwrap_or(0);
        if cv > rv {
            return true;
        }
        if cv < rv {
            return false;
        }
    }
    true
}

fn version_gt(left: &str, right: &str) -> bool {
    version_ge(left, right) && !version_ge(right, left)
}

/// 检查 OpenClaw 最新版本信息
#[tauri::command]
pub async fn check_openclaw_update() -> Result<Value, String> {
    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", "openclaw update status --json"])
        .output()
        .await
        .map_err(|e| format!("执行 openclaw 失败: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if stdout.trim().is_empty() && !stderr.is_empty() {
        return Err(format!("openclaw: {}", stderr.trim()));
    }

    let json: Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("解析 openclaw 输出失败: {} | raw: {}", e, stdout.trim().chars().take(200).collect::<String>()))?;

    Ok(json)
}

/// 执行 OpenClaw 升级
#[tauri::command]
pub async fn do_openclaw_update(emit_log: bool, app_handle: tauri::AppHandle) -> Result<Value, String> {
    use tauri::Emitter;

    // 先停掉 Gateway，避免文件冲突
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-Command", "openclaw gateway stop"])
        .output()
        .await;

    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", "openclaw update --yes --json"])
        .output()
        .await
        .map_err(|e| format!("启动 openclaw update 失败: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    if emit_log && !stdout.is_empty() {
        let _ = app_handle.emit("upgrade-log", stdout.to_string());
    }
    if emit_log && !stderr.is_empty() {
        let _ = app_handle.emit("upgrade-log", format!("[stderr] {}", stderr));
    }

    // 尝试解析最后一行 JSON
    let mut result_json = serde_json::json!({});
    for line in stdout.lines().rev() {
        let trimmed = line.trim();
        if trimmed.starts_with('{') {
            if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
                result_json = v;
                break;
            }
        }
    }

    if !output.status.success() {
        let err_msg = if result_json.get("success").and_then(|v| v.as_bool()) == Some(true) {
            String::new()
        } else {
            format!("升级失败 (exit {})", output.status)
        };
        if !err_msg.is_empty() {
            return Err(err_msg);
        }
    }

    Ok(result_json)
}

/// 根据文件扩展名推断 MIME 类型
pub fn mime_from_path(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html",
        "js" | "mjs" => "application/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

// ============================================================================
// Stream A Brief — OpenClaw 环境诊断与修复命令
// ============================================================================

/// A1: 检测 OpenClaw 环境健康状态
/// 检测 node / openclaw CLI / gateway / npm，返回 JSON
#[tauri::command]
pub async fn check_openclaw_env() -> Result<Value, String> {
    let mut env = serde_json::json!({
        "node": null,
        "openclaw": null,
        "gateway": null,
        "npm": null,
    });

    // 检测 Node.js
    let node_out = Command::new("powershell")
        .args(["-NoProfile", "-Command", "node --version 2>&1"])
        .output()
        .await;
    if let Ok(out) = node_out {
        if out.status.success() {
            let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
            env["node"] = serde_json::json!({
                "ok": true,
                "version": v.trim_start_matches('v'),
            });
        } else {
            env["node"] = serde_json::json!({
                "ok": false,
                "error": String::from_utf8_lossy(&out.stderr).trim().to_string(),
            });
        }
    } else {
        env["node"] = serde_json::json!({"ok": false, "error": "node 命令未找到"});
    }

    // 检测 openclaw CLI
    let claw_out = Command::new("powershell")
        .args(["-NoProfile", "-Command", "openclaw --version 2>&1"])
        .output()
        .await;
    if let Ok(out) = claw_out {
        if out.status.success() {
            let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
            env["openclaw"] = serde_json::json!({
                "ok": true,
                "version": v,
            });
        } else {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            env["openclaw"] = serde_json::json!({
                "ok": false,
                "error": if err.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { err },
            });
        }
    } else {
        env["openclaw"] = serde_json::json!({"ok": false, "error": "openclaw 命令未找到"});
    }

    // 检测 Gateway 状态
    let gw_out = Command::new("powershell")
        .args(["-NoProfile", "-Command", "openclaw gateway status --json 2>&1"])
        .output()
        .await;
    if let Ok(out) = gw_out {
        if out.status.success() {
            let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if raw.starts_with('{') {
                if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                    env["gateway"] = v;
                } else {
                    env["gateway"] = serde_json::json!({"ok": true, "raw": raw});
                }
            } else {
                env["gateway"] = serde_json::json!({"ok": true, "raw": raw});
            }
        } else {
            env["gateway"] = serde_json::json!({
                "ok": false,
                "error": String::from_utf8_lossy(&out.stderr).trim().to_string(),
            });
        }
    } else {
        env["gateway"] = serde_json::json!({"ok": false, "error": "gateway status 命令执行失败"});
    }

    // 检测 npm
    let npm_out = Command::new("powershell")
        .args(["-NoProfile", "-Command", "npm --version 2>&1"])
        .output()
        .await;
    if let Ok(out) = npm_out {
        if out.status.success() {
            env["npm"] = serde_json::json!({
                "ok": true,
                "version": String::from_utf8_lossy(&out.stdout).trim().to_string(),
            });
        } else {
            env["npm"] = serde_json::json!({
                "ok": false,
                "error": String::from_utf8_lossy(&out.stderr).trim().to_string(),
            });
        }
    } else {
        env["npm"] = serde_json::json!({"ok": false, "error": "npm 命令未找到"});
    }

    Ok(env)
}

/// A2: 安装 OpenClaw
/// 停掉 Gateway 后执行 npm install -g openclaw
#[tauri::command]
pub async fn install_openclaw() -> Result<Value, String> {
    // 先停 Gateway
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-Command", "openclaw gateway stop"])
        .output()
        .await;

    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", "npm install -g openclaw"])
        .output()
        .await
        .map_err(|e| format!("执行 npm install 失败: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    let success = output.status.success();
    let mut installed_version = String::new();

    // 尝试从输出中提取版本号
    for line in stdout.lines().chain(stderr.lines()) {
        if line.contains("added ") || line.contains("changed ") {
            // npm install 成功输出
        }
    }

    // 验证是否安装成功
    let verify = Command::new("powershell")
        .args(["-NoProfile", "-Command", "openclaw --version"])
        .output()
        .await;
    if let Ok(vout) = verify {
        if vout.status.success() {
            installed_version = String::from_utf8_lossy(&vout.stdout).trim().to_string();
        }
    }

    Ok(serde_json::json!({
        "success": success || !installed_version.is_empty(),
        "stdout": stdout.to_string(),
        "stderr": stderr.to_string(),
        "installed_version": installed_version,
    }))
}

/// A3: 一键修复 OpenClaw 插件
/// openclaw plugin list --json，逐个 install
#[tauri::command]
pub async fn repair_openclaw_plugins() -> Result<Value, String> {
    // 先停 Gateway
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-Command", "openclaw gateway stop"])
        .output()
        .await;

    // 获取插件列表
    let list_out = Command::new("powershell")
        .args(["-NoProfile", "-Command", "openclaw plugin list --json 2>&1"])
        .output()
        .await
        .map_err(|e| format!("执行 plugin list 失败: {}", e))?;

    let list_raw = String::from_utf8_lossy(&list_out.stdout);

    // 解析插件列表（可能是 JSON 数组或单对象）
    let plugin_names: Vec<String> = if list_raw.trim().starts_with('[') {
        serde_json::from_str::<Vec<String>>(&list_raw).unwrap_or_default()
    } else if list_raw.trim().starts_with('{') {
        // 可能是 { "plugins": [...] } 格式
        if let Ok(obj) = serde_json::from_str::<Value>(&list_raw) {
            obj.get("plugins")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default()
        } else {
            vec![]
        }
    } else {
        vec![]
    };

    let mut results = Vec::new();

    for name in &plugin_names {
        let install_out = Command::new("powershell")
            .args(["-NoProfile", "-Command", &format!("openclaw plugin install {}", name)])
            .output()
            .await;

        let ok = install_out.as_ref().map(|o| o.status.success()).unwrap_or(false);
        let msg = install_out
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();

        results.push(serde_json::json!({
            "plugin": name,
            "success": ok,
            "message": msg,
        }));
    }

    Ok(serde_json::json!({
        "total": plugin_names.len(),
        "results": results,
    }))
}

/// A4: 获取 OpenClaw 可用版本列表
/// npm view openclaw versions --json + openclaw --version
#[tauri::command]
pub async fn get_openclaw_versions() -> Result<Value, String> {
    // 获取当前安装版本
    let current = Command::new("powershell")
        .args(["-NoProfile", "-Command", "openclaw --version 2>&1"])
        .output()
        .await
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    // 获取 npm registry 上的所有版本
    let npm_out = Command::new("powershell")
        .args(["-NoProfile", "-Command", "npm view openclaw versions --json 2>&1"])
        .output()
        .await;

    let versions: Vec<String> = if let Ok(out) = npm_out {
        if out.status.success() {
            serde_json::from_str::<Vec<String>>(&String::from_utf8_lossy(&out.stdout))
                .unwrap_or_default()
        } else {
            vec![]
        }
    } else {
        vec![]
    };

    // 取最新 20 个版本
    let recent: Vec<String> = versions.into_iter().rev().take(20).collect();

    Ok(serde_json::json!({
        "current": current,
        "recent": recent,
    }))
}

/// A5: 安装指定版本的 OpenClaw
/// 停掉 Gateway 后执行 npm install -g openclaw@version
#[tauri::command]
pub async fn install_openclaw_version(version: String) -> Result<Value, String> {
    if version.is_empty() {
        return Err("版本号不能为空".to_string());
    }

    // 先停 Gateway
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-Command", "openclaw gateway stop"])
        .output()
        .await;

    let install_cmd = format!("npm install -g openclaw@{}", version);
    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", &install_cmd])
        .output()
        .await
        .map_err(|e| format!("执行 npm install 失败: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let success = output.status.success();

    // 验证
    let verify = Command::new("powershell")
        .args(["-NoProfile", "-Command", "openclaw --version"])
        .output()
        .await;
    let installed_version = verify
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    Ok(serde_json::json!({
        "success": success || !installed_version.is_empty(),
        "target_version": version,
        "installed_version": installed_version,
        "stdout": stdout.to_string(),
        "stderr": stderr.to_string(),
    }))
}

/// A6: 启动 OpenClaw 配置向导（spawn，不等待）
#[tauri::command]
pub fn start_openclaw_configure(section: String) -> Result<Value, String> {
    let cmd = if section.is_empty() {
        "openclaw configure"
    } else {
        match section.as_str() {
            "models" | "model" => "openclaw configure models",
            "channels" => "openclaw configure channels",
            "skills" => "openclaw configure skills",
            "gateway" => "openclaw configure gateway",
            _ => {
                return Err(format!("未知配置项: {}", section));
            }
        }
    };

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        const DETACHED_PROCESS: u32 = 0x00000008;

        std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", cmd])
            .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
            .spawn()
            .map_err(|e| format!("启动配置向导失败: {}", e))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("sh")
            .arg("-c")
            .arg(cmd)
            .spawn()
            .map_err(|e| format!("启动配置向导失败: {}", e))?;
    }

    Ok(serde_json::json!({
        "success": true,
        "section": section,
    }))
}

/// A7: 获取 OpenClaw 当前模型配置
/// openclaw config get models.providers，解析 JSON
#[tauri::command]
pub async fn get_openclaw_models() -> Result<Value, String> {
    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", "openclaw config get models.providers 2>&1"])
        .output()
        .await
        .map_err(|e| format!("执行 config get 失败: {}", e))?;

    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();

    if !output.status.success() {
        return Err(format!("命令失败: {}", raw));
    }

    // 尝试解析 JSON
    if raw.starts_with('{') || raw.starts_with('[') {
        match serde_json::from_str::<Value>(&raw) {
            Ok(v) => return Ok(v),
            Err(e) => return Err(format!("JSON 解析失败: {} | raw: {}", e, raw)),
        }
    }

    // 如果不是 JSON，返回原始文本
    Ok(serde_json::json!({
        "raw": raw,
    }))
}
