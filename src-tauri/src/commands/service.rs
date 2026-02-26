/// 服务管理命令 (macOS launchd)
/// 动态扫描 ~/Library/LaunchAgents/ 下的 openclaw/cftunnel 相关 plist
use std::collections::HashMap;
use std::fs;
use std::process::Command;

use crate::models::types::ServiceStatus;

/// 友好名称映射
fn description_map() -> HashMap<&'static str, &'static str> {
    HashMap::from([
        ("ai.openclaw.gateway", "OpenClaw Gateway"),
        ("com.openclaw.guardian.watch", "健康监控 (60s)"),
        ("com.openclaw.guardian.backup", "配置备份 (3600s)"),
        ("com.openclaw.watchdog", "看门狗 (120s)"),
        ("com.openclaw.webhook-router", "Webhook 路由"),
        ("com.openclaw.webhook-tunnel", "Webhook SSH 隧道"),
        ("com.openclaw.cf-tunnel", "Cloudflare Tunnel (旧)"),
        ("com.cftunnel.cloudflared", "cftunnel 隧道服务"),
        ("actions.runner.2221186349-qingchen.openclaw-mac", "GitHub Actions Runner"),
    ])
}

/// 动态扫描 LaunchAgents 目录，找出所有 openclaw/cftunnel 相关 plist
fn scan_plist_labels() -> Vec<String> {
    let home = dirs::home_dir().unwrap_or_default();
    let agents_dir = home.join("Library/LaunchAgents");
    let mut labels = Vec::new();

    if let Ok(entries) = fs::read_dir(&agents_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if (name.contains("openclaw") || name.contains("cftunnel"))
                && name.ends_with(".plist")
            {
                // 文件名去掉 .plist 就是 label
                let label = name.trim_end_matches(".plist").to_string();
                labels.push(label);
            }
        }
    }
    labels.sort();
    labels
}

fn plist_path(label: &str) -> String {
    let home = dirs::home_dir().unwrap_or_default();
    format!(
        "{}/Library/LaunchAgents/{}.plist",
        home.display(),
        label
    )
}

#[tauri::command]
pub fn get_services_status() -> Result<Vec<ServiceStatus>, String> {
    let output = Command::new("launchctl")
        .arg("list")
        .output()
        .map_err(|e| format!("执行 launchctl 失败: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let labels = scan_plist_labels();
    let desc_map = description_map();
    let mut results = Vec::new();

    for label in &labels {
        let mut status = ServiceStatus {
            label: label.clone(),
            pid: None,
            running: false,
            description: desc_map
                .get(label.as_str())
                .unwrap_or(&"")
                .to_string(),
        };

        // 解析 launchctl list 输出: PID\tStatus\tLabel
        for line in stdout.lines() {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 3 && parts[2] == label {
                if let Ok(pid) = parts[0].trim().parse::<u32>() {
                    status.pid = Some(pid);
                    status.running = true;
                }
                // PID 为 "-" 但 label 存在于 launchctl list 中 → 已加载但未运行
                break;
            }
        }
        results.push(status);
    }

    Ok(results)
}

#[tauri::command]
pub fn start_service(label: String) -> Result<(), String> {
    let path = plist_path(&label);
    let output = Command::new("launchctl")
        .args(["load", &path])
        .output()
        .map_err(|e| format!("启动失败: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.trim().is_empty() {
            return Err(format!("启动 {label} 失败: {stderr}"));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn stop_service(label: String) -> Result<(), String> {
    let path = plist_path(&label);
    let output = Command::new("launchctl")
        .args(["unload", &path])
        .output()
        .map_err(|e| format!("停止失败: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.trim().is_empty() {
            return Err(format!("停止 {label} 失败: {stderr}"));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn restart_service(label: String) -> Result<(), String> {
    let path = plist_path(&label);
    // 先 unload，忽略错误（可能本来就没加载）
    let _ = Command::new("launchctl")
        .args(["unload", &path])
        .output();
    std::thread::sleep(std::time::Duration::from_millis(500));

    let output = Command::new("launchctl")
        .args(["load", &path])
        .output()
        .map_err(|e| format!("重启失败: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.trim().is_empty() {
            return Err(format!("重启 {label} 失败: {stderr}"));
        }
    }
    Ok(())
}
