/**
 * 模型配置页面
 * 模型增删改查 + 选择默认主模型应用（未选中自动成为 fallback）
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showModal } from '../components/modal.js'

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">模型配置</h1>
      <p class="page-desc">管理模型列表，选择默认主模型并一键应用</p>
    </div>
    <div class="config-actions">
      <button class="btn btn-primary btn-sm" id="btn-add-provider">+ 添加 Provider</button>
      <button class="btn btn-secondary btn-sm" id="btn-save-models">保存模型配置</button>
      <button class="btn btn-primary btn-sm" id="btn-apply-default">应用默认模型</button>
    </div>
    <div id="default-model-bar"></div>
    <div id="providers-list">加载中...</div>
  `

  const state = { config: null }
  await loadConfig(page, state)

  // 事件委托绑定
  bindTopActions(page, state)
  return page
}

async function loadConfig(page, state) {
  try {
    state.config = await api.readOpenclawConfig()
    renderDefaultBar(page, state)
    renderProviders(page, state)
  } catch (e) {
    toast('加载配置失败: ' + e, 'error')
  }
}

// 获取当前默认主模型
function getCurrentPrimary(config) {
  return config?.agents?.defaults?.model?.primary || ''
}

// 收集所有 provider/model-id 组合
function collectAllModels(config) {
  const result = []
  const providers = config?.models?.providers || {}
  for (const [pk, pv] of Object.entries(providers)) {
    for (const m of (pv.models || [])) {
      const id = typeof m === 'string' ? m : m.id
      if (id) result.push({ provider: pk, modelId: id, full: `${pk}/${id}` })
    }
  }
  return result
}

// 渲染默认模型状态栏
function renderDefaultBar(page, state) {
  const bar = page.querySelector('#default-model-bar')
  const primary = getCurrentPrimary(state.config)
  const allModels = collectAllModels(state.config)
  const fallbacks = allModels.filter(m => m.full !== primary).map(m => m.full)

  bar.innerHTML = `
    <div class="config-section" style="margin-bottom:var(--space-lg)">
      <div class="config-section-title">当前应用配置</div>
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <div>
          <span style="font-size:var(--font-size-sm);color:var(--text-tertiary)">主模型：</span>
          <span style="font-family:var(--font-mono);font-size:var(--font-size-sm);color:${primary ? 'var(--success)' : 'var(--error)'}">${primary || '未配置'}</span>
        </div>
        <div>
          <span style="font-size:var(--font-size-sm);color:var(--text-tertiary)">Fallback：</span>
          <span style="font-size:var(--font-size-sm);color:var(--text-secondary)">${fallbacks.length ? fallbacks.join(', ') : '无'}</span>
        </div>
      </div>
    </div>
  `
}

// 渲染 Provider 列表
function renderProviders(page, state) {
  const listEl = page.querySelector('#providers-list')
  const providers = state.config?.models?.providers || {}
  const keys = Object.keys(providers)
  const primary = getCurrentPrimary(state.config)

  if (!keys.length) {
    listEl.innerHTML = '<div style="color:var(--text-tertiary);padding:20px">暂无 Provider，点击上方按钮添加</div>'
    return
  }

  listEl.innerHTML = keys.map(key => {
    const p = providers[key]
    const models = p.models || []
    return `
      <div class="config-section" data-provider="${key}">
        <div class="config-section-title" style="display:flex;justify-content:space-between;align-items:center">
          <span>${key} <span style="font-size:var(--font-size-xs);color:var(--text-tertiary);font-weight:400">${p.api || p.apiType || ''} · ${models.length} 个模型</span></span>
          <div style="display:flex;gap:8px">
            <button class="btn btn-sm btn-secondary" data-action="edit-provider">编辑</button>
            <button class="btn btn-sm btn-secondary" data-action="add-model">+ 模型</button>
            <button class="btn btn-sm btn-danger" data-action="delete-provider">删除</button>
          </div>
        </div>
        <div class="provider-models">
          ${renderModelCards(key, models, primary)}
        </div>
      </div>
    `
  }).join('')

  bindProviderEvents(page, state)
}

// 渲染单个 Provider 下的模型卡片
function renderModelCards(providerKey, models, primary) {
  if (!models.length) {
    return '<div style="color:var(--text-tertiary);font-size:var(--font-size-sm);padding:8px 0">暂无模型</div>'
  }
  return models.map((m, i) => {
    const id = typeof m === 'string' ? m : m.id
    const name = m.name || id
    const full = `${providerKey}/${id}`
    const isPrimary = full === primary
    const borderColor = isPrimary ? 'var(--success)' : 'var(--border-primary)'
    const bgColor = isPrimary ? 'var(--success-muted)' : 'var(--bg-tertiary)'
    return `
      <div class="model-card" data-index="${i}" data-full="${full}"
           style="background:${bgColor};border:1px solid ${borderColor};padding:10px 14px;border-radius:var(--radius-md);margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-family:var(--font-mono);font-size:var(--font-size-sm)">${id}</span>
            ${isPrimary ? '<span style="font-size:var(--font-size-xs);background:var(--success);color:var(--text-inverse);padding:1px 6px;border-radius:var(--radius-sm)">主模型</span>' : ''}
            ${m.reasoning ? '<span style="font-size:var(--font-size-xs);background:var(--accent-muted);color:var(--accent);padding:1px 6px;border-radius:var(--radius-sm)">Reasoning</span>' : ''}
          </div>
          <div style="font-size:var(--font-size-xs);color:var(--text-tertiary);margin-top:2px">
            ${name !== id ? name + ' · ' : ''}${m.contextWindow ? (m.contextWindow / 1000) + 'K ctx' : ''}${m.cost?.input ? ' · $' + m.cost.input + '/$' + m.cost.output : ''}
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button class="btn btn-sm btn-secondary" data-action="test-model">测试</button>
          ${!isPrimary ? `<button class="btn btn-sm btn-secondary" data-action="set-primary">设为主模型</button>` : ''}
          <button class="btn btn-sm btn-secondary" data-action="edit-model">编辑</button>
          <button class="btn btn-sm btn-danger" data-action="delete-model">删除</button>
        </div>
      </div>
    `
  }).join('')
}

// 绑定 Provider 列表内的事件
function bindProviderEvents(page, state) {
  const listEl = page.querySelector('#providers-list')
  listEl.querySelectorAll('[data-action]').forEach(btn => {
    btn.onclick = () => {
      const section = btn.closest('[data-provider]')
      const providerKey = section.dataset.provider
      const action = btn.dataset.action

      if (action === 'delete-provider') {
        if (!confirm(`确定删除 Provider "${providerKey}" 及其所有模型？`)) return
        delete state.config.models.providers[providerKey]
        renderProviders(page, state)
        renderDefaultBar(page, state)
        toast(`已删除 ${providerKey}`, 'info')
      } else if (action === 'add-model') {
        addModel(page, state, providerKey)
      } else if (action === 'edit-provider') {
        editProvider(page, state, providerKey)
      } else if (action === 'delete-model') {
        const card = btn.closest('.model-card')
        const idx = parseInt(card.dataset.index)
        const models = state.config.models.providers[providerKey].models
        models.splice(idx, 1)
        renderProviders(page, state)
        renderDefaultBar(page, state)
      } else if (action === 'edit-model') {
        const card = btn.closest('.model-card')
        const idx = parseInt(card.dataset.index)
        editModel(page, state, providerKey, idx)
      } else if (action === 'set-primary') {
        const card = btn.closest('.model-card')
        const full = card.dataset.full
        setPrimary(state, full)
        renderProviders(page, state)
        renderDefaultBar(page, state)
        toast(`已设为主模型: ${full}`, 'success')
      } else if (action === 'test-model') {
        const card = btn.closest('.model-card')
        const idx = parseInt(card.dataset.index)
        testModel(btn, state, providerKey, idx)
      }
    }
  })
}

// 设置主模型（仅修改 state，不写入文件）
function setPrimary(state, full) {
  if (!state.config.agents) state.config.agents = {}
  if (!state.config.agents.defaults) state.config.agents.defaults = {}
  if (!state.config.agents.defaults.model) state.config.agents.defaults.model = {}
  state.config.agents.defaults.model.primary = full
}

// 顶部按钮事件绑定
function bindTopActions(page, state) {
  page.querySelector('#btn-add-provider').onclick = () => addProvider(page, state)

  page.querySelector('#btn-save-models').onclick = async () => {
    const btn = page.querySelector('#btn-save-models')
    btn.disabled = true
    btn.textContent = '保存中...'
    try {
      await api.writeOpenclawConfig(state.config)
      toast('模型配置已保存，正在重载 Gateway...', 'info')
      try {
        await api.reloadGateway()
        toast('Gateway 已重载，模型配置已生效', 'success')
      } catch (e) {
        toast('配置已保存，但重载 Gateway 失败: ' + e, 'warning')
      }
    } catch (e) {
      toast('保存失败: ' + e, 'error')
    } finally {
      btn.disabled = false
      btn.textContent = '保存模型配置'
    }
  }

  page.querySelector('#btn-apply-default').onclick = async () => {
    const btn = page.querySelector('#btn-apply-default')
    const primary = getCurrentPrimary(state.config)
    if (!primary) {
      toast('请先选择一个主模型', 'warning')
      return
    }
    btn.disabled = true
    btn.textContent = '应用中...'
    try {
      applyDefaultModel(state)
      await api.writeOpenclawConfig(state.config)
      renderDefaultBar(page, state)
      toast('默认模型已应用，正在重载 Gateway...', 'info')
      try {
        await api.reloadGateway()
        toast('Gateway 已重载，默认模型已生效', 'success')
      } catch (e) {
        toast('配置已保存，但重载 Gateway 失败: ' + e, 'warning')
      }
    } catch (e) {
      toast('应用失败: ' + e, 'error')
    } finally {
      btn.disabled = false
      btn.textContent = '应用默认模型'
    }
  }
}

// 应用默认模型：primary + 其余自动成为 fallback
function applyDefaultModel(state) {
  const primary = getCurrentPrimary(state.config)
  const allModels = collectAllModels(state.config)
  const fallbacks = allModels.filter(m => m.full !== primary).map(m => m.full)

  const defaults = state.config.agents.defaults
  defaults.model.primary = primary
  defaults.model.fallbacks = fallbacks

  // 生成 models 映射（所有模型的空配置对象）
  const modelsMap = {}
  modelsMap[primary] = {}
  for (const fb of fallbacks) modelsMap[fb] = {}
  defaults.models = modelsMap
}

// 添加 Provider
function addProvider(page, state) {
  showModal({
    title: '添加 Provider',
    fields: [
      { name: 'key', label: 'Provider 名称', placeholder: '如 openai, newapi' },
      { name: 'baseUrl', label: 'Base URL', placeholder: 'https://api.openai.com/v1' },
      { name: 'apiKey', label: 'API Key', placeholder: 'sk-...' },
    ],
    onConfirm: ({ key, baseUrl, apiKey }) => {
      if (!key) return
      if (!state.config.models) state.config.models = { mode: 'replace', providers: {} }
      if (!state.config.models.providers) state.config.models.providers = {}
      state.config.models.providers[key] = {
        baseUrl: baseUrl || '',
        apiKey: apiKey || '',
        api: 'openai-completions',
        models: [],
      }
      renderProviders(page, state)
      toast(`已添加 Provider: ${key}`, 'success')
    },
  })
}

// 编辑 Provider 属性
function editProvider(page, state, providerKey) {
  const p = state.config.models.providers[providerKey]
  showModal({
    title: `编辑 Provider: ${providerKey}`,
    fields: [
      { name: 'baseUrl', label: 'Base URL', value: p.baseUrl || '' },
      { name: 'apiKey', label: 'API Key', value: p.apiKey || '' },
      { name: 'api', label: 'API 类型', value: p.api || 'openai-completions' },
    ],
    onConfirm: ({ baseUrl, apiKey, api: apiType }) => {
      p.baseUrl = baseUrl
      p.apiKey = apiKey
      p.api = apiType
      renderProviders(page, state)
      toast('Provider 已更新', 'success')
    },
  })
}

// 添加模型
function addModel(page, state, providerKey) {
  showModal({
    title: `添加模型到 ${providerKey}`,
    fields: [
      { name: 'id', label: '模型 ID', placeholder: '如 claude-opus-4-6' },
      { name: 'name', label: '显示名称', placeholder: '如 Claude Opus 4.6' },
      { name: 'contextWindow', label: 'Context Window', placeholder: '如 200000' },
    ],
    onConfirm: ({ id, name, contextWindow }) => {
      if (!id) return
      const model = { id, name: name || id, reasoning: false, input: ['text', 'image'] }
      if (contextWindow) model.contextWindow = parseInt(contextWindow) || 0
      state.config.models.providers[providerKey].models.push(model)
      renderProviders(page, state)
      renderDefaultBar(page, state)
      toast(`已添加模型: ${id}`, 'success')
    },
  })
}

// 编辑模型属性
function editModel(page, state, providerKey, idx) {
  const m = state.config.models.providers[providerKey].models[idx]
  showModal({
    title: `编辑模型: ${m.id}`,
    fields: [
      { name: 'id', label: '模型 ID', value: m.id || '' },
      { name: 'name', label: '显示名称', value: m.name || '' },
      { name: 'contextWindow', label: 'Context Window', value: String(m.contextWindow || '') },
    ],
    onConfirm: (vals) => {
      if (!vals.id) return
      m.id = vals.id
      m.name = vals.name || vals.id
      if (vals.contextWindow) m.contextWindow = parseInt(vals.contextWindow) || 0
      renderProviders(page, state)
      renderDefaultBar(page, state)
      toast('模型已更新', 'success')
    },
  })
}

// 测试模型连通性
async function testModel(btn, state, providerKey, idx) {
  const provider = state.config.models.providers[providerKey]
  const model = provider.models[idx]
  const modelId = typeof model === 'string' ? model : model.id

  btn.disabled = true
  const origText = btn.textContent
  btn.textContent = '测试中...'

  try {
    const reply = await api.testModel(provider.baseUrl, provider.apiKey || '', modelId)
    toast(`${modelId} 连通正常: "${reply.slice(0, 60)}"`, 'success')
  } catch (e) {
    toast(`${modelId} 测试失败: ${e}`, 'error')
  } finally {
    btn.disabled = false
    btn.textContent = origText
  }
}
