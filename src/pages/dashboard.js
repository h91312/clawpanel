/**
 * 仪表盘页面
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { getActiveInstance, onGatewayChange } from '../lib/app-state.js'
import { isForeignGatewayError, isForeignGatewayService, maybeShowForeignGatewayBindingPrompt, showGatewayConflictGuidance } from '../lib/gateway-ownership.js'
import { navigate } from '../router.js'
import { t } from '../lib/i18n.js'

let _unsubGw = null

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'

  page.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${t('dashboard.title')}</h1>
      <p class="page-desc">${t('dashboard.desc')}</p>
    </div>
    <div class="stat-cards" id="stat-cards">
      <div class="stat-card loading-placeholder"></div>
      <div class="stat-card loading-placeholder"></div>
      <div class="stat-card loading-placeholder"></div>
      <div class="stat-card loading-placeholder"></div>
      <div class="stat-card loading-placeholder"></div>
      <div class="stat-card loading-placeholder"></div>
    </div>
    <div id="dashboard-overview-container"></div>
    <div id="openclaw-update-bar" style="margin:0 0 12px"></div>
    <div class="quick-actions">
      <button class="btn btn-secondary" id="btn-restart-gw">${t('dashboard.restartGw')}</button>
      <button class="btn btn-secondary" id="btn-open-web">🌐 打开 Web Dashboard</button>
      <button class="btn btn-secondary" id="btn-check-update">${t('dashboard.checkUpdate')}</button>
      <button class="btn btn-secondary" id="btn-create-backup">${t('dashboard.createBackup')}</button>
      <button class="btn btn-secondary" id="btn-diagnose-repair">🔧 诊断修复</button>
      <button class="btn btn-secondary" id="btn-minimax-oauth">🎫 MiniMax OAuth</button>
    </div>
    <div class="config-section">
      <div class="config-section-title">${t('dashboard.recentLogs')}</div>
      <div class="log-viewer" id="recent-logs" style="max-height:300px"></div>
    </div>
  `

  // 绑定事件（只绑一次）
  bindActions(page)

  // 异步加载数据
  loadDashboardData(page).catch(e => {
    console.error('[dashboard] loadDashboardData 异常:', e)
    const cardsEl = page.querySelector('#stat-cards')
    if (cardsEl && cardsEl.querySelector('.loading-placeholder')) {
      cardsEl.innerHTML = `<div class="stat-card" style="grid-column:1/-1;text-align:center;color:var(--text-secondary)"><div>${t('common.loadFailed')}: ${escapeHtml(String(e?.message || e))}</div><button class="btn btn-sm btn-secondary" style="margin-top:8px" onclick="this.closest('.page')&&this.closest('.page').__retryLoad?.()">${t('dashboard.retry')}</button></div>`
    }
  })
  page.__retryLoad = () => loadDashboardData(page).catch(() => {})

  // 监听 Gateway 状态变化，自动刷新仪表盘
  if (_unsubGw) _unsubGw()
  _unsubGw = onGatewayChange(() => {
    loadDashboardData(page)
  })

  return page
}

export function cleanup() {
  if (_unsubGw) { _unsubGw(); _unsubGw = null }
}

function openclawInstallationIdentity(installation) {
  const rawPath = String(installation?.path || '').trim()
  if (!rawPath) return ''
  const isWin = navigator.platform?.startsWith('Win') || navigator.userAgent?.includes('Windows')
  if (!isWin) return rawPath
  return rawPath
    .replace(/\//g, '\\')
    .replace(/\\openclaw(?:\.exe|\.ps1)?$/i, '\\openclaw.cmd')
    .toLowerCase()
}

function dedupeOpenclawInstallations(list = []) {
  const map = new Map()
  const preferCmd = inst => /openclaw\.cmd$/i.test(String(inst?.path || ''))
  for (const installation of Array.isArray(list) ? list : []) {
    const key = openclawInstallationIdentity(installation)
    if (!key) continue
    const existing = map.get(key)
    if (!existing || (!existing.active && installation.active) || (!preferCmd(existing) && preferCmd(installation))) {
      map.set(key, installation)
    }
  }
  return [...map.values()]
}

let _dashboardInitialized = false
let _dashboardVersionCache = null
let _dashboardStatusSummaryCache = null
let _dashboardInstanceId = ''

function syncDashboardInstanceScope() {
  const instanceId = getActiveInstance()?.id || 'local'
  if (_dashboardInstanceId && _dashboardInstanceId !== instanceId) {
    _dashboardInitialized = false
    _dashboardVersionCache = null
    _dashboardStatusSummaryCache = null
  }
  _dashboardInstanceId = instanceId
}

async function loadDashboardData(page, fullRefresh = false) {
  syncDashboardInstanceScope()
  // 分波加载：关键数据先渲染，次要数据后填充，减少白屏等待
  // 轻量调用（读文件）每次都做；重量调用（spawn CLI/网络请求）只在首次或手动刷新时做
  const withTimeout = (promise, ms) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`超时(${ms/1000}s)`)), ms))
  ])
  const coreP = withTimeout(Promise.allSettled([
    api.getServicesStatus(),
    api.readOpenclawConfig(),
    // 版本信息：首次加载或手动刷新时才查询（避免 ARM 设备上频繁查 npm registry）
    (!_dashboardInitialized || fullRefresh || !_dashboardVersionCache) ? api.getVersionInfo() : Promise.resolve(_dashboardVersionCache),
    api.readPanelConfig(),
  ]), 15000)
  const secondaryP = withTimeout(Promise.allSettled([
    api.listAgents(),
    api.readMcpConfig(),
    api.listBackups(),
  ]), 15000).catch(() => [{ status: 'rejected' }, { status: 'rejected' }, { status: 'rejected' }])
  const logsP = api.readLogTail('gateway', 20).catch(() => '')

  // 第一波：服务状态 + 配置 + 版本 → 立即渲染统计卡片
  const [servicesRes, configRes, versionRes, panelConfigRes] = await coreP
  const services = servicesRes.status === 'fulfilled' ? servicesRes.value : []
  const version = (versionRes.status === 'fulfilled' && versionRes.value)
    ? (_dashboardVersionCache = versionRes.value)
    : (_dashboardVersionCache || {})
  const config = configRes.status === 'fulfilled' ? configRes.value : null
  const panelConfig = panelConfigRes.status === 'fulfilled' ? panelConfigRes.value : null
  const gw = services.find(s => s.label === 'ai.openclaw.gateway')
  const shouldLoadStatusSummary = gw?.running === true
  if (!shouldLoadStatusSummary) {
    _dashboardStatusSummaryCache = null
  }
  if (servicesRes.status === 'rejected') toast(t('dashboard.servicesLoadFail'), 'error')
  if (versionRes.status === 'rejected') toast(t('dashboard.versionLoadFail'), 'error')

  // 自愈：补全关键默认值（先重新读取最新配置再 patch，避免用缓存覆盖其他页面的写入）
  if (config) {
    let needsPatch = false
    if (!config.gateway?.mode) needsPatch = true
    if (config.mode) needsPatch = true
    if (!config.tools || config.tools.profile !== 'full') needsPatch = true
    if (needsPatch) {
      try {
        const freshConfig = await api.readOpenclawConfig()
        let patched = false
        if (!freshConfig.gateway) freshConfig.gateway = {}
        if (!freshConfig.gateway.mode) { freshConfig.gateway.mode = 'local'; patched = true }
        if (freshConfig.mode) { delete freshConfig.mode; patched = true }
        if (!freshConfig.tools || freshConfig.tools.profile !== 'full') {
          freshConfig.tools = { profile: 'full', sessions: { visibility: 'all' }, ...(freshConfig.tools || {}) }
          freshConfig.tools.profile = 'full'
          if (!freshConfig.tools.sessions) freshConfig.tools.sessions = {}
          freshConfig.tools.sessions.visibility = 'all'
          patched = true
        }
        if (patched) api.writeOpenclawConfig(freshConfig).catch(() => {})
      } catch {}
    }
  }

  renderStatCards(page, services, version, [], config, panelConfig)
  if (gw) {
    maybeShowForeignGatewayBindingPrompt({
      service: gw,
      onRefresh: () => loadDashboardData(page, true),
    }).catch(() => {})
  }

  // OpenClaw 版本更新检查（独立，不阻塞主流程）
  loadOpenclawUpdate(page).catch(() => {})

  // 第二波：Agent、MCP、备份 → 更新卡片 + 渲染总览
  const [agentsRes, mcpRes, backupsRes] = await secondaryP
  const agents = agentsRes.status === 'fulfilled' ? agentsRes.value : []
  const mcpConfig = mcpRes.status === 'fulfilled' ? mcpRes.value : null
  const backups = backupsRes.status === 'fulfilled' ? backupsRes.value : []
  let statusSummary = null
  if (shouldLoadStatusSummary) {
    try {
      statusSummary = (!_dashboardInitialized || fullRefresh || !_dashboardStatusSummaryCache)
        ? await withTimeout(api.getStatusSummary(), 15000)
        : _dashboardStatusSummaryCache
      _dashboardStatusSummaryCache = statusSummary
    } catch {
      statusSummary = _dashboardStatusSummaryCache
    }
  }

  renderStatCards(page, services, version, agents, config, panelConfig)
  renderOverview(page, services, mcpConfig, backups, config, agents, statusSummary)

  // 第三波：日志（最低优先级）
  const logs = await logsP
  renderLogs(page, logs)

  _dashboardInitialized = true
}

async function openGatewayConflict(page, error = null, reason = null) {
  const services = await api.getServicesStatus().catch(() => [])
  const gw = services?.find?.(s => s.label === 'ai.openclaw.gateway') || services?.[0] || null
  await showGatewayConflictGuidance({
    error,
    service: gw,
    reason,
    onRefresh: async () => loadDashboardData(page, true),
  })
}

function renderStatCards(page, services, version, agents, config, panelConfig) {
  const cardsEl = page.querySelector('#stat-cards')
  const gw = services.find(s => s.label === 'ai.openclaw.gateway')
  const foreignGateway = isForeignGatewayService(gw)
  const runningCount = services.filter(s => s.running).length
  const versionMeta = version.recommended
    ? `${version.ahead_of_recommended ? t('dashboard.versionAhead', { version: version.recommended }) : version.is_recommended ? t('dashboard.versionStable', { version: version.recommended }) : t('dashboard.versionRecommend', { version: version.recommended })}${version.latest_update_available && version.latest ? ' · ' + t('dashboard.versionLatest', { version: version.latest }) : ''}`
    : (version.latest_update_available && version.latest ? t('dashboard.versionLatest', { version: version.latest }) : t('dashboard.versionUnknown'))

  // CLI 路径信息
  const cliSourceLabel = { standalone: t('dashboard.cliSourceStandalone'), 'npm-zh': t('dashboard.cliSourceNpmZh'), 'npm-official': t('dashboard.cliSourceNpmOfficial'), 'npm-global': t('dashboard.cliSourceNpmGlobal') }[version.cli_source] || t('dashboard.cliSourceUnknown')
  const installCount = dedupeOpenclawInstallations(version.all_installations).length
  const multiInstall = installCount > 1
  const cliBound = !!(panelConfig?.openclawCliPath && String(panelConfig.openclawCliPath).trim())

  const defaultAgent = agents.find(a => a.id === 'main')?.name || 'main'
  const modelCount = config?.models?.providers ? Object.values(config.models.providers).reduce((acc, p) => acc + (p.models?.length || 0), 0) : 0
  const providerCount = config?.models?.providers ? Object.keys(config.models.providers).length : 0

  cardsEl.innerHTML = `
    <div class="stat-card">
      <div class="stat-card-header">
        <span class="stat-card-label">${t('dashboard.gateway')}</span>
        <span class="status-dot ${gw?.running ? 'running' : 'stopped'}"></span>
      </div>
      <div class="stat-card-value">${foreignGateway ? t('dashboard.externalInstance') : gw?.running ? t('common.running') : t('common.stopped')}</div>
      <div class="stat-card-meta">${foreignGateway ? t('dashboard.externalGatewayDetected', { pid: gw?.pid ? ' · PID ' + gw.pid : '' }) : gw?.pid ? 'PID: ' + gw.pid : (gw?.running ? t('dashboard.portDetect') : t('dashboard.notStarted'))}</div>
      ${foreignGateway
        ? `<div class="stat-card-meta" style="margin-top:8px;color:var(--warning);line-height:1.6">${t('dashboard.foreignGatewayHint')}</div>
           <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
             <button class="btn btn-secondary btn-xs" data-action="resolve-foreign-gateway">${t('dashboard.viewGuidance')}</button>
             <button class="btn btn-primary btn-xs" data-action="open-settings">${t('dashboard.goSettings')}</button>
           </div>`
        : ''}
    </div>
    <div class="stat-card">
      <div class="stat-card-header">
        <span class="stat-card-label">${t('dashboard.versionLabel')} · ${version.source === 'official' ? t('dashboard.versionOfficial') : version.source === 'chinese' ? t('dashboard.versionChinese') : t('dashboard.versionUnknownSource')}</span>
      </div>
      <div class="stat-card-value">${version.current || t('common.unknown')}</div>
      <div class="stat-card-meta">${versionMeta}</div>
      ${version.cli_path ? `<div class="stat-card-meta" style="margin-top:2px;font-size:11px;opacity:0.7" title="${escapeHtml(version.cli_path)}">${cliSourceLabel}${multiInstall ? ' · <span' + (cliBound ? '' : ' style="color:var(--warning)"') + '>' + t('dashboard.installCount', { count: installCount }) + '</span>' : ''}</div>` : ''}
      ${multiInstall && !cliBound
        ? `<div class="stat-card-meta" style="margin-top:8px;color:var(--warning);line-height:1.6">${t('dashboard.multiInstallCardHint')}</div>
           <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
             <button class="btn btn-secondary btn-xs" data-action="resolve-multi-install">${t('dashboard.viewGuidance')}</button>
             <button class="btn btn-primary btn-xs" data-action="open-settings">${t('dashboard.goSettings')}</button>
           </div>`
        : multiInstall && cliBound
          ? `<div class="stat-card-meta" style="margin-top:4px;color:var(--text-tertiary);font-size:11px">✓ ${t('dashboard.multiInstallBoundOk', { count: installCount })}</div>`
        : ''}
      <div style="margin-top:8px">
        <button class="btn btn-secondary btn-xs" id="btn-switch-version" style="font-size:11px;padding:3px 10px">🔄 切换版本</button>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-card-header">
        <span class="stat-card-label">${t('dashboard.agentFleet')}</span>
      </div>
      <div class="stat-card-value">${agents.length} ${t('common.unit')}</div>
      <div class="stat-card-meta">${t('dashboard.defaultAgent')}: ${defaultAgent}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-header">
        <span class="stat-card-label">${t('dashboard.modelPool')}</span>
      </div>
      <div class="stat-card-value">${modelCount} ${t('common.unit')}</div>
      <div class="stat-card-meta">${t('dashboard.basedOnProviders', { count: providerCount })}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card-header">
        <span class="stat-card-label">${t('dashboard.baseServices')}</span>
      </div>
      <div class="stat-card-value">${runningCount}/${services.length}</div>
      <div class="stat-card-meta">${t('common.survivalRate')} ${services.length ? Math.round(runningCount / services.length * 100) : 0}%</div>
    </div>
    <div class="stat-card stat-card-clickable" id="card-control-ui" title="${t('dashboard.controlUIDesc')}">
      <div class="stat-card-header">
        <span class="stat-card-label">${t('dashboard.controlUI')}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="opacity:0.5"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      </div>
      <div class="stat-card-value" style="font-size:var(--font-size-sm)">${t('dashboard.controlUIDesc')}</div>
      <div class="stat-card-meta">${gw?.running ? t('dashboard.controlUIClick') : t('dashboard.controlUINotRunning')}</div>
    </div>
  `
}

// ===== OpenClaw 版本更新检查 =====
async function loadOpenclawUpdate(page) {
  const bar = page.querySelector('#openclaw-update-bar')
  if (!bar) return

  bar.innerHTML = `<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg-secondary);border-radius:var(--radius-md);border:1px solid var(--border);font-size:var(--font-size-xs);color:var(--text-tertiary)">
    <span>🦞 OpenClaw 版本检测中...</span>
  </div>`

  let updateInfo
  try {
    updateInfo = await api.checkOpenclawUpdate()
  } catch (e) {
    bar.innerHTML = `<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg-secondary);border-radius:var(--radius-md);border:1px solid var(--border);font-size:var(--font-size-xs);color:var(--text-tertiary)">
      <span>🦞</span><span>无法检测 OpenClaw 更新: ${escapeHtml(String(e?.message || e))}</span>
    </div>`
    return
  }

  const availability = updateInfo?.availability || {}
  const channel = updateInfo?.channel || {}
  const update = updateInfo?.update || {}

  const currentVersion = update?.root?.split('\\').pop()?.split('/').pop() || _dashboardVersionCache?.current || '未知'
  const latestVersion = availability.latestVersion || '未知'
  const hasUpdate = availability.hasRegistryUpdate === true
  const channelValue = channel.value || 'stable'

  if (hasUpdate) {
    bar.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:10px 14px;background:var(--bg-secondary);border-radius:var(--radius-md);border:1px solid var(--primary);border-left:3px solid var(--primary)">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:14px">🦞</span>
        <div>
          <div style="font-size:var(--font-size-sm);color:var(--text-primary);font-weight:600">
            OpenClaw ${latestVersion} 可用
          </div>
          <div style="font-size:var(--font-size-xs);color:var(--text-secondary)">
            当前版本: ${currentVersion} · 通道: ${channelValue}
          </div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <button class="btn btn-primary btn-sm" id="btn-openclaw-upgrade">🚀 升级到 ${latestVersion}</button>
        <span style="font-size:11px;color:var(--text-tertiary)">Gateway 会短暂中断</span>
      </div>
    </div>`

    page.querySelector('#btn-openclaw-upgrade')?.addEventListener('click', async () => {
      const btn = page.querySelector('#btn-openclaw-upgrade')
      if (!btn) return
      btn.disabled = true
      btn.textContent = '升级中...'

      try {
        // 先发事件通知 gateway 重启
        await api.restartService?.('ai.openclaw.gateway')?.catch(() => {})

        const result = await api.doOpenclawUpdate(false)
        if (result?.success || result?.updated) {
          toast(`OpenClaw 升级成功！`, 'success')
          btn.textContent = '✅ 升级完成'
          // 刷新版本信息
          setTimeout(() => loadOpenclawUpdate(page).catch(() => {}), 3000)
        } else {
          throw new Error(result ? JSON.stringify(result) : '升级未返回结果')
        }
      } catch (e) {
        toast('升级失败: ' + (e?.message || String(e)), 'error')
        btn.disabled = false
        btn.textContent = `🚀 升级到 ${latestVersion}`
      }
    })
  } else {
    bar.innerHTML = `<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg-secondary);border-radius:var(--radius-md);border:1px solid var(--border);font-size:var(--font-size-xs);color:var(--text-tertiary)">
      <span style="color:var(--success)">✓</span>
      <span>🦞 OpenClaw ${currentVersion} · 已是最新稳定版 · 通道: ${channelValue}</span>
    </div>`
  }
}

function renderOverview(page, services, mcpConfig, backups, config, agents, statusSummary) {
  const containerEl = page.querySelector('#dashboard-overview-container')
  const gw = services.find(s => s.label === 'ai.openclaw.gateway')
  const foreignGateway = isForeignGatewayService(gw)
  const mcpCount = mcpConfig?.mcpServers ? Object.keys(mcpConfig.mcpServers).length : 0

  const formatDate = (timestamp) => {
    if (!timestamp) return '——'
    const d = new Date(timestamp * 1000)
    const mon = d.getMonth() + 1
    const day = d.getDate()
    const hr = d.getHours().toString().padStart(2, '0')
    const min = d.getMinutes().toString().padStart(2, '0')
    return mon + '-' + day + ' ' + hr + ':' + min
  }

  const latestBackup = backups.length > 0 ? backups.sort((a,b) => b.created_at - a.created_at)[0] : null
  const lastUpdate = config?.meta?.lastTouchedVersion || t('common.unknown')
  const runtimeVer = statusSummary?.runtimeVersion || null
  const sessions = statusSummary?.sessions || null
  const runtimeMeta = runtimeVer
    ? (statusSummary?.source === 'file-read' ? t('dashboard.runtimeMetaFileRead') : t('dashboard.runtimeMetaLive'))
    : t('dashboard.runtimeMetaConfig')

  const gwPort = config?.gateway?.port || 18789
  const primaryModel = config?.agents?.defaults?.model?.primary || t('dashboard.notSet')

  containerEl.innerHTML = `
    <div class="dashboard-overview">
      <div class="overview-grid">
        <div class="overview-card" data-nav="/gateway">
          <div class="overview-card-icon" style="color:${foreignGateway ? 'var(--warning)' : gw?.running ? 'var(--success)' : 'var(--error)'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          </div>
          <div class="overview-card-body">
            <div class="overview-card-title">Gateway</div>
            <div class="overview-card-value" style="color:${foreignGateway ? 'var(--warning)' : gw?.running ? 'var(--success)' : 'var(--error)'}">${foreignGateway ? t('dashboard.externalInstance') : gw?.running ? t('common.running') : t('common.stopped')}</div>
            <div class="overview-card-meta">${foreignGateway ? `${t('dashboard.port')} ${gwPort}${gw?.pid ? ' · PID ' + gw.pid : ''} · ${t('dashboard.viewOnlyStatus')}` : `${t('dashboard.port')} ${gwPort} ${gw?.pid ? '· PID ' + gw.pid : ''}`}</div>
          </div>
          <div class="overview-card-actions">
            ${foreignGateway
              ? '<button class="btn btn-secondary btn-xs" data-action="resolve-foreign-gateway">' + t('dashboard.viewGuidance') + '</button><button class="btn btn-primary btn-xs" data-action="open-settings">' + t('dashboard.goSettings') + '</button>'
              : gw?.running
              ? '<button class="btn btn-danger btn-xs" data-action="stop-gw">' + t('dashboard.stopBtn') + '</button><button class="btn btn-secondary btn-xs" data-action="restart-gw">' + t('dashboard.restartBtn') + '</button>'
              : '<button class="btn btn-primary btn-xs" data-action="start-gw">' + t('dashboard.startBtn') + '</button>'
            }
          </div>
        </div>

        <div class="overview-card" data-nav="/models">
          <div class="overview-card-icon" style="color:var(--accent)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/></svg>
          </div>
          <div class="overview-card-body">
            <div class="overview-card-title">${t('dashboard.primaryModel')}</div>
            <div class="overview-card-value" style="font-size:var(--font-size-sm)">${primaryModel}</div>
            <div class="overview-card-meta">${t('dashboard.maxConcurrent')} ${config?.agents?.defaults?.maxConcurrent || 4}</div>
          </div>
        </div>

        <div class="overview-card" data-nav="/skills">
          <div class="overview-card-icon" style="color:var(--warning)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
          </div>
          <div class="overview-card-body">
            <div class="overview-card-title">${t('dashboard.mcpTools')}</div>
            <div class="overview-card-value">${mcpCount}</div>
            <div class="overview-card-meta">${t('dashboard.mountedExtensions')}</div>
          </div>
        </div>

        <div class="overview-card" data-nav="/services">
          <div class="overview-card-icon" style="color:var(--text-tertiary)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          </div>
          <div class="overview-card-body">
            <div class="overview-card-title">${t('dashboard.recentBackup')}</div>
            <div class="overview-card-value" style="font-size:var(--font-size-sm)">${latestBackup ? formatDate(latestBackup.created_at) : t('dashboard.noBackup')}</div>
            <div class="overview-card-meta">${t('dashboard.backupCount', { count: backups.length })}</div>
          </div>
        </div>

        <div class="overview-card" data-nav="/agents">
          <div class="overview-card-icon" style="color:var(--success)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
          </div>
          <div class="overview-card-body">
            <div class="overview-card-title">${t('dashboard.agentFleet')}</div>
            <div class="overview-card-value">${agents.length}</div>
            <div class="overview-card-meta">${t('dashboard.workspaceCount', { count: agents.filter(a => a.workspace).length })}</div>
          </div>
        </div>

        <div class="overview-card">
          <div class="overview-card-icon" style="color:var(--text-tertiary)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </div>
          <div class="overview-card-body">
            <div class="overview-card-title">${t('dashboard.runtimeVersion')}</div>
            <div class="overview-card-value" style="font-size:var(--font-size-sm)">${runtimeVer || lastUpdate}</div>
            <div class="overview-card-meta">${runtimeMeta}</div>
          </div>
        </div>
      </div>
      ${renderSessionStatus(sessions)}
    </div>
  `

  // 概览卡片点击导航
  containerEl.querySelectorAll('[data-nav]').forEach(card => {
    card.style.cursor = 'pointer'
    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return
      navigate(card.dataset.nav)
    })
  })
}

function renderSessionStatus(sessions) {
  if (!sessions || !sessions.recent || sessions.recent.length === 0) return ''
  const rows = sessions.recent.slice(0, 5).map(s => {
    const pct = s.percentUsed ?? 0
    const barColor = pct > 80 ? 'var(--error)' : pct > 50 ? 'var(--warning)' : 'var(--success)'
    const flags = (s.flags || []).map(f => `<span class="session-flag">${escapeHtml(f)}</span>`).join('')
    const model = s.model ? `<span class="session-model">${escapeHtml(s.model)}</span>` : ''
    const tokens = s.totalTokens != null && s.totalTokens > 0 ? `${Math.round(s.totalTokens / 1000)}k` : '0'
    const ctx = s.contextTokens != null ? `${Math.round(s.contextTokens / 1000)}k` : '—'
    const remaining = s.remainingTokens != null ? `${Math.round(s.remainingTokens / 1000)}k` : ctx
    const key = escapeHtml(s.key || '').replace(/^agent:main:/, '')
    return `<div class="session-row">
      <div class="session-row-header">
        <span class="session-key" title="${escapeHtml(s.key || '')}">${key || '—'}</span>
        ${model}${flags}
      </div>
      <div class="session-bar-wrap">
        <div class="session-bar" style="width:${Math.min(pct, 100)}%;background:${barColor}"></div>
      </div>
      <div class="session-row-meta">${tokens} / ${ctx} · ${t('dashboard.remaining')} ${remaining} · ${pct}%</div>
    </div>`
  })
  const defaultModel = sessions.defaults?.model || '—'
  const defaultCtx = sessions.defaults?.contextTokens ? `${Math.round(sessions.defaults.contextTokens / 1000)}k` : '—'
  return `
    <div class="config-section" style="margin-top:16px">
      <div class="config-section-title">${t('dashboard.activeSessions')} <span style="font-weight:normal;color:var(--text-tertiary);font-size:var(--font-size-xs)">${sessions.count || 0} · ${t('dashboard.defaultModel')} ${escapeHtml(defaultModel)} · ${t('dashboard.context')} ${defaultCtx}</span></div>
      <div class="session-list">${rows.join('')}</div>
    </div>`
}

function renderLogs(page, logs) {
  const logsEl = page.querySelector('#recent-logs')
  if (!logs) {
    logsEl.innerHTML = '<div style="color:var(--text-tertiary);padding:12px">' + t('dashboard.noLogs') + '</div>'
    return
  }
  const lines = logs.trim().split('\n')
  logsEl.innerHTML = lines.map(l => `<div class="log-line">${escapeHtml(l)}</div>`).join('')
  logsEl.scrollTop = logsEl.scrollHeight
}

function bindActions(page) {
  const btnRestart = page.querySelector('#btn-restart-gw')
  const btnUpdate = page.querySelector('#btn-check-update')
  const btnCreateBackup = page.querySelector('#btn-create-backup')
  const btnOpenWeb = page.querySelector('#btn-open-web')

  // 打开 Web Dashboard 按钮
  btnOpenWeb?.addEventListener('click', async () => {
    try {
      const config = await api.readOpenclawConfig()
      const port = config?.gateway?.port || 18789
      const host = window.__TAURI_INTERNALS__ ? '127.0.0.1' : (location.hostname || '127.0.0.1')
      const proto = location.protocol === 'https:' ? 'https' : 'http'
      let url = `${proto}://${host}:${port}`
      const authToken = config?.gateway?.auth?.token
      if (authToken) url += `/#token=${encodeURIComponent(authToken)}`
      if (window.__TAURI_INTERNALS__) {
        try {
          const { open } = await import('@tauri-apps/plugin-shell')
          await open(url)
        } catch {
          window.open(url, '_blank')
        }
      } else {
        window.open(url, '_blank')
      }
    } catch (e2) {
      toast('打开 Web Dashboard 失败: ' + (e2.message || e2), 'error')
    }
  })

  // Control UI 卡片点击 → 打开 OpenClaw 原生面板（用事件委托，因为卡片是动态渲染的）
  page.addEventListener('click', async (e) => {
    const card = e.target.closest('#card-control-ui')
    if (!card) return
    if (e.target.closest('button')) return
    try {
      const config = await api.readOpenclawConfig()
      const port = config?.gateway?.port || 18789
      // 远程部署时使用当前浏览器域名/IP，桌面版用 127.0.0.1
      const host = window.__TAURI_INTERNALS__ ? '127.0.0.1' : (location.hostname || '127.0.0.1')
      const proto = location.protocol === 'https:' ? 'https' : 'http'
      let url = `${proto}://${host}:${port}`
      // 如果 Gateway 配置了 token 鉴权，附加到 URL 方便直接访问
      const authToken = config?.gateway?.auth?.token
      if (authToken) url += `?token=${encodeURIComponent(authToken)}`
      // 尝试多种方式打开浏览器
      if (window.__TAURI_INTERNALS__) {
        try {
          const { open } = await import('@tauri-apps/plugin-shell')
          await open(url)
        } catch {
          window.open(url, '_blank')
        }
      } else {
        window.open(url, '_blank')
      }
    } catch (e2) {
      toast(t('dashboard.openControlUIFail') + ': ' + (e2.message || e2), 'error')
    }
  })

  // 概览区域的 Gateway 启动/停止/重启 + ClawApp 导航
  page.addEventListener('click', async (e) => {
    const actionBtn = e.target.closest('[data-action]')
    if (!actionBtn) return
    const action = actionBtn.dataset.action

    if (action === 'open-settings') {
      navigate('/settings')
      return
    }

    if (action === 'resolve-foreign-gateway') {
      await openGatewayConflict(page, null, 'foreign-gateway')
      return
    }

    if (action === 'resolve-multi-install') {
      await openGatewayConflict(page, null, 'multiple-installations')
      return
    }

    if (action === 'start-gw') {
      actionBtn.disabled = true; actionBtn.textContent = t('dashboard.starting')
      try {
        await api.startService('ai.openclaw.gateway')
        toast(t('dashboard.gwStartSent'), 'success')
        setTimeout(() => loadDashboardData(page), 2000)
      } catch (err) {
        if (isForeignGatewayError(err)) await openGatewayConflict(page, err)
        else toast(t('dashboard.startFail') + ': ' + err, 'error')
      }
      finally { actionBtn.disabled = false; actionBtn.textContent = t('dashboard.startBtn') }
    }
    if (action === 'stop-gw') {
      actionBtn.disabled = true; actionBtn.textContent = t('dashboard.stopping')
      try {
        await api.stopService('ai.openclaw.gateway')
        toast(t('dashboard.gwStopped'), 'success')
        setTimeout(() => loadDashboardData(page), 1500)
      } catch (err) {
        if (isForeignGatewayError(err)) await openGatewayConflict(page, err)
        else toast(t('dashboard.stopFail') + ': ' + err, 'error')
      }
      finally { actionBtn.disabled = false; actionBtn.textContent = t('dashboard.stopBtn') }
    }
    if (action === 'restart-gw') {
      actionBtn.disabled = true; actionBtn.textContent = t('dashboard.restarting')
      try {
        await api.restartService('ai.openclaw.gateway')
        toast(t('dashboard.gwRestartSent'), 'success')
        setTimeout(() => loadDashboardData(page), 3000)
      } catch (err) {
        if (isForeignGatewayError(err)) await openGatewayConflict(page, err)
        else toast(t('dashboard.restartFail') + ': ' + err, 'error')
      }
      finally { actionBtn.disabled = false; actionBtn.textContent = t('dashboard.restartBtn') }
    }
  })

  btnRestart?.addEventListener('click', async () => {
    btnRestart.disabled = true
    btnRestart.classList.add('btn-loading')
    btnRestart.textContent = t('dashboard.restarting')
    try {
      await api.restartService('ai.openclaw.gateway')
    } catch (e) {
      if (isForeignGatewayError(e)) await openGatewayConflict(page, e)
      else toast(t('dashboard.restartFail') + ': ' + e, 'error')
      btnRestart.disabled = false
      btnRestart.classList.remove('btn-loading')
      btnRestart.textContent = t('dashboard.restartGw')
      return
    }
    // 轮询等待实际重启完成
    const t0 = Date.now()
    while (Date.now() - t0 < 30000) {
      try {
        const s = await api.getServicesStatus()
        const gw = s?.find?.(x => x.label === 'ai.openclaw.gateway') || s?.[0]
        if (gw?.running) {
          toast(t('dashboard.gwRestarted', { pid: gw.pid }), 'success')
          btnRestart.disabled = false
          btnRestart.classList.remove('btn-loading')
          btnRestart.textContent = t('dashboard.restartGw')
          loadDashboardData(page)
          return
        }
      } catch {}
      const sec = Math.floor((Date.now() - t0) / 1000)
      btnRestart.textContent = t('dashboard.restarting') + ` ${sec}s`
      await new Promise(r => setTimeout(r, 1500))
    }
    toast(t('dashboard.restartTimeout'), 'warning')
    btnRestart.disabled = false
    btnRestart.classList.remove('btn-loading')
    btnRestart.textContent = t('dashboard.restartGw')
    loadDashboardData(page)
  })

  btnUpdate?.addEventListener('click', async () => {
    btnUpdate.disabled = true
    btnUpdate.textContent = t('dashboard.checking')
    try {
      const info = await api.getVersionInfo()
      _dashboardVersionCache = info
      if (info.ahead_of_recommended && info.recommended) {
        toast(t('dashboard.versionAheadWarn', { current: info.current || '', recommended: info.recommended }), 'warning')
      } else if (info.update_available && info.recommended) {
        toast(t('dashboard.updateAvailable', { version: info.recommended }), 'info')
      } else if (info.latest_update_available && info.latest) {
        toast(t('dashboard.alignedWithLatest', { version: info.latest }), 'info')
      } else {
        toast(t('dashboard.upToDate'), 'success')
      }
    } catch (e) {
      toast(t('dashboard.checkUpdateFail') + ': ' + e, 'error')
    } finally {
      btnUpdate.disabled = false
      btnUpdate.textContent = t('dashboard.checkUpdate')
    }
  })

  btnCreateBackup?.addEventListener('click', async () => {
    btnCreateBackup.disabled = true
    btnCreateBackup.innerHTML = t('dashboard.backingUp')
    try {
      const res = await api.createBackup()
      toast(t('dashboard.backupDone', { name: res.name }), 'success')
      setTimeout(() => loadDashboardData(page), 500)
    } catch (e) {
      toast(t('dashboard.backupFail') + ': ' + e, 'error')
    } finally {
      btnCreateBackup.disabled = false
      btnCreateBackup.textContent = t('dashboard.createBackup')
    }
  })

  // ===== 诊断与修复按钮 (B3) =====
  const btnDiagnoseRepair = page.querySelector('#btn-diagnose-repair')
  if (btnDiagnoseRepair) {
    // 动态导入 setup.js 的 modal 函数（避免循环依赖）
    btnDiagnoseRepair.addEventListener('click', async () => {
      try {
        // 直接在 dashboard 页面打开诊断 Modal
        showDiagnoseModalForDashboard(page)
      } catch (e2) {
        toast('打开诊断面板失败: ' + e2, 'error')
      }
    })
  }

  // ===== MiniMax OAuth 按钮 (B3/B2) =====
  const btnMiniMaxOAuth = page.querySelector('#btn-minimax-oauth')
  if (btnMiniMaxOAuth) {
    btnMiniMaxOAuth.addEventListener('click', async () => {
      btnMiniMaxOAuth.disabled = true
      btnMiniMaxOAuth.textContent = '⏳ 启动中...'
      try {
        await api.startOpenclawConfigure('model')
        toast('已打开 OpenClaw 配置向导，请在弹出的窗口中选择 MiniMax CN — OAuth 并完成授权', 'info', 10000)
      } catch (e) {
        toast('启动配置向导失败: ' + (e?.message || String(e)), 'error')
      } finally {
        btnMiniMaxOAuth.disabled = false
        btnMiniMaxOAuth.textContent = '🎫 MiniMax OAuth'
      }
    })
  }

  // 版本切换按钮（事件委托，card 动态渲染）
  page.addEventListener('click', async (e) => {
    if (!e.target.closest('#btn-switch-version')) return
    e.stopPropagation()
    await showVersionSwitchModal(page)
  })
}

// ============================================================================
// Stream A Brief — 版本切换 Modal
// ============================================================================

async function showVersionSwitchModal(page) {
  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px'
  const dialog = document.createElement('div')
  dialog.style.cssText = 'background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius-lg);width:100%;max-width:520px;max-height:80vh;display:flex;flex-direction:column;font-size:var(--font-size-sm)'

  const header = document.createElement('div')
  header.style.cssText = 'padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0'
  header.innerHTML = `
    <div style="font-weight:600">OpenClaw 版本切换</div>
    <button id="vs-modal-close" style="background:none;border:none;cursor:pointer;color:var(--text-tertiary);padding:4px;line-height:1">✕</button>
  `

  const body = document.createElement('div')
  body.style.cssText = 'padding:16px 20px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:12px'

  let versions = []
  let currentVersion = ''

  body.innerHTML = `<div style="color:var(--text-tertiary);padding:20px;text-align:center">加载版本列表...</div>`
  overlay.appendChild(header)
  overlay.appendChild(dialog)
  dialog.appendChild(body)
  document.body.appendChild(overlay)

  const close = () => document.body.removeChild(overlay)
  header.querySelector('#vs-modal-close').addEventListener('click', close)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })

  try {
    ;[versions, currentVersion] = await Promise.all([
      api.getOpenclawVersions(),
      new Promise(r => {
        api.getVersionInfo().then(v => r(v?.current || '')).catch(() => r(''))
      })
    ])
  } catch (e) {
    body.innerHTML = `<div style="color:var(--error);padding:20px;text-align:center">加载失败: ${escapeHtml(String(e))}</div>`
    return
  }

  const recent = versions?.recent || []
  if (recent.length === 0) {
    body.innerHTML = `<div style="color:var(--text-tertiary);padding:20px;text-align:center">未获取到可用版本</div>`
    return
  }

  body.innerHTML = `
    <div style="padding:8px 10px;background:var(--bg-secondary);border-radius:var(--radius-sm);font-size:var(--font-size-xs);color:var(--text-secondary)">
      当前版本: <strong>${escapeHtml(currentVersion)}</strong>
    </div>
    <div id="vs-list" style="display:flex;flex-direction:column;gap:6px;max-height:300px;overflow-y:auto"></div>
    <div id="vs-logs" style="padding:8px 10px;background:#0d1117;color:#c9d1d9;border-radius:var(--radius-sm);font-family:monospace;font-size:11px;min-height:60px;max-height:120px;overflow-y:auto;white-space:pre-wrap;line-height:1.5;display:none"></div>
  `

  const listEl = body.querySelector('#vs-list')
  const logsEl = body.querySelector('#vs-logs')

  for (const ver of recent) {
    const isCurrent = ver === currentVersion || ver === `v${currentVersion}`
    const btn = document.createElement('button')
    btn.style.cssText = `display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-radius:var(--radius-sm);border:1px solid ${isCurrent ? 'var(--primary)' : 'var(--border)'};background:${isCurrent ? 'rgba(59,130,246,.1)' : 'var(--bg-secondary)'};cursor:${isCurrent ? 'default' : 'pointer'};color:var(--text-primary);font-size:var(--font-size-xs);transition:all .15s`
    btn.innerHTML = `
      <span style="font-family:monospace">${escapeHtml(ver)}</span>
      ${isCurrent ? '<span style="color:var(--primary);font-size:11px">当前</span>' : ''}
    `
    if (!isCurrent) {
      btn.addEventListener('click', async () => {
        btn.disabled = true
        const origText = btn.innerHTML
        btn.textContent = `安装中... ${ver}`
        logsEl.style.display = 'block'
        const addLog = (msg) => { logsEl.textContent += `[${new Date().toLocaleTimeString('zh-CN')}] ${msg}\n`; logsEl.scrollTop = logsEl.scrollHeight }
        addLog(`开始安装 openclaw@${ver}`)
        addLog('Gateway 将自动停止')
        try {
          const result = await api.installOpenClawVersion(ver)
          if (result?.success || result?.installed_version) {
            addLog(`✅ 安装成功: ${result.installed_version}`)
            toast(`版本切换成功: ${result.installed_version}`, 'success')
            setTimeout(() => loadOpenclawUpdate(page).catch(() => {}), 2000)
          } else {
            addLog(`❌ 安装失败`)
          }
        } catch (e) {
          addLog(`❌ 失败: ${e}`)
          toast('版本切换失败: ' + e, 'error')
        }
        btn.disabled = false
        btn.innerHTML = origText
      })
    }
    listEl.appendChild(btn)
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ===== 仪表盘诊断与修复 Modal (B3) =====
let _dashRepairModal = null

function showDiagnoseModalForDashboard(page) {
  if (_dashRepairModal && document.body.contains(_dashRepairModal)) {
    _dashRepairModal.style.display = 'flex'
    return
  }

  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:9999'

  overlay.innerHTML = `
    <div style="background:var(--bg-primary);border-radius:var(--radius-lg);border:1px solid var(--border);width:min(520px,90vw);max-height:70vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.4)">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border)">
        <h3 style="margin:0;font-size:15px;color:var(--text-primary)">🔧 ${t('setup.diagnoseTitle') || '诊断与修复'}</h3>
        <button class="btn-close-dash-modal" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:20px;padding:0 4px">&times;</button>
      </div>
      <div id="dash-diagnose-log" style="flex:1;overflow:auto;padding:12px 16px;min-height:200px;max-height:400px;font-family:monospace;font-size:11px;line-height:1.8;color:var(--text-secondary);white-space:pre-wrap;word-break:break-all">
        <span style="color:var(--text-tertiary)">点击下方按钮开始...</span>
      </div>
      <div style="display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--border);justify-content:flex-end">
        <button class="btn btn-primary btn-sm" id="dash-btn-diagnose">▶ 开始诊断</button>
        <button class="btn btn-secondary btn-sm" id="dash-btn-repair">🔧 一键修复</button>
        <button class="btn btn-sm" id="dash-btn-close" style="background:var(--bg-tertiary);border:1px solid var(--border)">${t('common.close') || '关闭'}</button>
      </div>
    </div>
  `

  document.body.appendChild(overlay)
  _dashRepairModal = overlay

  const logArea = overlay.querySelector('#dash-diagnose-log')

  function dashLog(msg, type = 'info') {
    const c = { success: 'var(--success)', warn: 'var(--warning)', error: 'var(--error)', info: 'var(--text-secondary)' }
    logArea.innerHTML += `<div style="margin-bottom:2px;color:${c[type]||c.info}">${new Date().toLocaleTimeString('zh-CN',{hour12:false})}  ${msg}</div>`
    logArea.scrollTop = logArea.scrollHeight
  }

  overlay.querySelector('.btn-close-dash-modal').onclick = () => overlay.style.display = 'none'
  overlay.querySelector('#dash-btn-close').onclick = () => overlay.style.display = 'none'
  overlay.onclick = (e) => { if (e.target === overlay) overlay.style.display = 'none' }

  overlay.querySelector('#dash-btn-diagnose').onclick = async () => {
    const b = overlay.querySelector('#dash-btn-diagnose')
    b.disabled = true; logArea.innerHTML = ''
    try {
      dashLog('正在获取环境信息...')
      const env = await api.checkOpenclawEnv()
      dashLog('', 'info'); dashLog('═══ Node.js ═══', 'info')
      if (env.node?.ok === true) { dashLog(`v${env.node.version || '?'} ✓`, 'success') }
      else { dashLog(`✗ ${env.node?.error || '未安装'}`, 'error') }
      dashLog('', 'info'); dashLog('═══ OpenClaw ═══', 'info')
      if (env.openclaw?.ok === true) { dashLog(`${env.openclaw.version || '已安装'} ✓`, 'success') }
      else { dashLog(`✗ ${env.openclaw?.error || '未安装'}`, 'error') }
      dashLog('', 'info'); dashLog('═══ Gateway ═══', 'info')
      if (env.gateway?.ok === true) { dashLog(`运行中 ✓  ${typeof env.gateway === 'object' && !Array.isArray(env.gateway) ? JSON.stringify(env.gateway).slice(0, 80) : ''}`, 'success') }
      else { dashLog(`✗ ${env.gateway?.error || '未运行/未检测'}`, 'error') }
      dashLog('', 'info'); dashLog('═══ npm ═══', 'info')
      if (env.npm?.ok === true) { dashLog(`v${env.npm.version || '?'} ✓`, 'success') }
      else { dashLog(`✗ ${env.npm?.error || '不可用'}`, 'error') }
      dashLog('', 'info'); dashLog('✅ 诊断完成', 'info')
    } catch (e) { dashLog(`失败: ${e.message || e}`, 'error') } finally { b.disabled = false }
  }

  overlay.querySelector('#dash-btn-repair').onclick = async () => {
    const b = overlay.querySelector('#dash-btn-repair')
    b.disabled = true; logArea.innerHTML = ''
    try {
      dashLog('执行插件修复...')
      const r = await api.repairOpenClawPlugins()
      const total = r?.total || 0
      dashLog(`共发现 ${total} 个插件`, 'info')
      if (r?.results) {
        for (const p of r.results) {
          dashLog(`  ${p.plugin}: ${p.success ? '✓' : '✗'} ${p.message || ''}`, p.success ? 'success' : 'error')
        }
        const okCount = r.results.filter(x => x.success).length
        if (okCount === total && total > 0) dashLog('✅ 全部修复成功', 'success')
      } else {
        dashLog('无插件信息返回', 'warn')
      }
      dashLog('✅ 完成', 'success')
    } catch (e) { dashLog(`失败: ${e.message || e}`, 'error') } finally { b.disabled = false }
  }
}
