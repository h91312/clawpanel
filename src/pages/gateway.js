/**
 * Gateway 配置页面
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Gateway 配置</h1>
      <p class="page-desc">配置 OpenClaw Gateway 端口、绑定和认证</p>
    </div>
    <div id="gateway-config">加载中...</div>
    <div style="margin-top:16px">
      <button class="btn btn-primary" id="btn-save-gw">保存配置</button>
    </div>
  `

  const state = { config: null }
  await loadConfig(page, state)
  page.querySelector('#btn-save-gw').onclick = async () => {
    const btn = page.querySelector('#btn-save-gw')
    btn.disabled = true
    btn.textContent = '保存中...'
    try {
      await saveConfig(page, state)
    } finally {
      btn.disabled = false
      btn.textContent = '保存配置'
    }
  }
  return page
}

async function loadConfig(page, state) {
  try {
    state.config = await api.readOpenclawConfig()
    renderConfig(page, state)
  } catch (e) {
    toast('加载配置失败: ' + e, 'error')
  }
}

function renderConfig(page, state) {
  const el = page.querySelector('#gateway-config')
  const gw = state.config?.gateway || {}

  el.innerHTML = `
    <div class="config-section">
      <div class="config-section-title">基础设置</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="form-group">
          <label class="form-label">端口</label>
          <input class="form-input" id="gw-port" type="number" value="${gw.port || 18789}" min="1024" max="65535">
        </div>
        <div class="form-group">
          <label class="form-label">绑定模式</label>
          <select class="form-input" id="gw-bind">
            <option value="loopback" ${gw.bind === 'loopback' ? 'selected' : ''}>Loopback (仅本机)</option>
            <option value="all" ${gw.bind === 'all' ? 'selected' : ''}>All (所有接口)</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">运行模式</label>
        <select class="form-input" id="gw-mode">
          <option value="local" ${gw.mode === 'local' ? 'selected' : ''}>Local</option>
          <option value="remote" ${gw.mode === 'remote' ? 'selected' : ''}>Remote</option>
        </select>
      </div>
    </div>

    <div class="config-section">
      <div class="config-section-title">认证</div>
      <div class="form-group">
        <label class="form-label">Auth Token</label>
        <div style="display:flex;gap:8px">
          <input class="form-input" id="gw-token" type="password" value="${gw.authToken || ''}" placeholder="留空则无认证" style="flex:1">
          <button class="btn btn-sm btn-secondary" id="btn-toggle-token">显示</button>
        </div>
      </div>
    </div>

    <div class="config-section">
      <div class="config-section-title">Tailscale</div>
      <div class="form-group">
        <label class="form-label">Tailscale 地址</label>
        <input class="form-input" id="gw-tailscale" value="${gw.tailscale?.address || ''}" placeholder="如 100.x.x.x:18789">
      </div>
    </div>
  `

  // 切换密码可见
  el.querySelector('#btn-toggle-token').onclick = () => {
    const input = el.querySelector('#gw-token')
    const btn = el.querySelector('#btn-toggle-token')
    if (input.type === 'password') {
      input.type = 'text'
      btn.textContent = '隐藏'
    } else {
      input.type = 'password'
      btn.textContent = '显示'
    }
  }
}

async function saveConfig(page, state) {
  const port = parseInt(page.querySelector('#gw-port')?.value) || 18789
  const bind = page.querySelector('#gw-bind')?.value || 'loopback'
  const mode = page.querySelector('#gw-mode')?.value || 'local'
  const authToken = page.querySelector('#gw-token')?.value || ''
  const tailscaleAddr = page.querySelector('#gw-tailscale')?.value || ''

  state.config.gateway = {
    ...state.config.gateway,
    port, bind, mode, authToken,
    tailscale: tailscaleAddr ? { address: tailscaleAddr } : (state.config.gateway?.tailscale || undefined),
  }

  try {
    await api.writeOpenclawConfig(state.config)
    toast('Gateway 配置已保存，正在重载服务...', 'info')
    try {
      await api.reloadGateway()
      toast('Gateway 已重载，配置已生效', 'success')
    } catch (e) {
      toast('配置已保存，但重载 Gateway 失败: ' + e, 'warning')
    }
  } catch (e) {
    toast('保存失败: ' + e, 'error')
  }
}
