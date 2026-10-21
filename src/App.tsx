import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Activity, ArrowDown, ArrowRight, ArrowUp, ArrowUpRight, Bell, BookOpen, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, CirclePlus, Clock3, Command, ExternalLink, Filter, Github, GitPullRequest, GripVertical, LayoutDashboard, ListChecks, LoaderCircle, Menu, MoreHorizontal, Moon, PanelLeftClose, PanelLeftOpen, Plus, Search, Send, Settings, ShieldCheck, SlidersHorizontal, Sparkles, Sun, Terminal, X, XCircle, Zap } from 'lucide-react'
import type { ActivityEntry, AgentRun, Project, RunStatus, VerificationResult } from './types'
import { activity, projects, runs } from './data/mockData'
import { api, toActivityEntries, toAgentRun, toProject, type ApiRun, type IntegrationStatus } from './api'

type Page = 'Overview' | 'Agent Workspace' | 'Projects' | 'Activity Log' | 'Integrations' | 'Settings'
type Preferences = { readOnly: boolean; notifications: boolean; planDetail: 'Concise' | 'Balanced' | 'Detailed'; accent: 'violet' | 'teal' | 'blue' | 'rose' }
type CommandAction = { id: string; title: string; detail: string; icon: typeof LayoutDashboard; run: () => void }
type DashboardWidgetId = 'approvals' | 'projects' | 'runs'
type DashboardLayout = { order: DashboardWidgetId[]; hidden: DashboardWidgetId[]; wide: DashboardWidgetId[] }
const preferenceKey = 'launchpilot.preferences.v1'
const themeKey = 'launchpilot.theme.v1'
const accentTokens: Record<Preferences['accent'], { value: string; strong: string }> = { violet: { value: '#b4a8ff', strong: '#9988fb' }, teal: { value: '#83d5cb', strong: '#48b7ab' }, blue: { value: '#8bbcff', strong: '#5c9ae8' }, rose: { value: '#f0a4be', strong: '#d9789c' } }
const dashboardLayoutKey = 'launchpilot.dashboard-layout.v1'
const dashboardWidgetLabels: Record<DashboardWidgetId, string> = { approvals: 'Needs your review', projects: 'Repositories', runs: 'Recent runs' }
function loadDashboardLayout(): DashboardLayout {
  const fallback: DashboardLayout = { order: ['approvals', 'projects', 'runs'], hidden: [], wide: ['approvals'] }
  try {
    const stored = JSON.parse(localStorage.getItem(dashboardLayoutKey) ?? 'null') as Partial<DashboardLayout> | null
    const valid = (value: unknown): value is DashboardWidgetId => value === 'approvals' || value === 'projects' || value === 'runs'
    const storedOrder = Array.isArray(stored?.order) ? stored.order.filter(valid) : []
    const hidden = Array.isArray(stored?.hidden) ? stored.hidden.filter(valid) : []
    const wide = Array.isArray(stored?.wide) ? stored.wide.filter(valid) : fallback.wide
    return { order: [...new Set(storedOrder), ...fallback.order.filter(id => !storedOrder.includes(id))], hidden, wide }
  } catch { return fallback }
}
type Theme = 'dark' | 'light'
function loadTheme(): Theme { try { return localStorage.getItem(themeKey) === 'light' ? 'light' : 'dark' } catch { return 'dark' } }
function loadPreferences(): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey) ?? '{}') as Partial<Preferences>
    return { readOnly: saved.readOnly === true, notifications: saved.notifications !== false, planDetail: ['Concise', 'Balanced', 'Detailed'].includes(saved.planDetail ?? '') ? saved.planDetail as Preferences['planDetail'] : 'Detailed', accent: ['violet', 'teal', 'blue', 'rose'].includes(saved.accent ?? '') ? saved.accent as Preferences['accent'] : 'violet' }
  } catch { return { readOnly: false, notifications: true, planDetail: 'Detailed', accent: 'violet' } }
}
const navItems: { label: Page; icon: typeof LayoutDashboard }[] = [
  { label: 'Overview', icon: LayoutDashboard }, { label: 'Agent Workspace', icon: Sparkles }, { label: 'Projects', icon: BookOpen }, { label: 'Activity Log', icon: Activity }, { label: 'Integrations', icon: Zap }, { label: 'Settings', icon: Settings },
]
const statusClass: Record<RunStatus, string> = { Planned: 'planned', 'Awaiting approval': 'approval', Approved: 'verified', Rejected: 'failed', Running: 'running', Verified: 'verified', Inconclusive: 'unverified', 'Verification failed': 'failed', 'Partially completed': 'approval', Cancelled: 'planned', Failed: 'failed', Simulated: 'simulated' }

function Status({ value }: { value: RunStatus }) { return <motion.span layout className={`status ${statusClass[value]}`}><i />{value}</motion.span> }
function AgentProgress({ run }: { run: AgentRun }) {
  const reduceMotion = useReducedMotion()
  if (!['Running', 'Awaiting approval', 'Failed', 'Partially completed'].includes(run.status)) return null
  const active = run.tools.find(tool => tool.status === 'Running')
  const complete = run.tools.filter(tool => tool.status === 'Complete' || tool.status === 'Failed').length
  const total = Math.max(1, run.tools.length)
  const running = run.status === 'Running'
  const label = run.status === 'Awaiting approval' ? 'Review required before this action can continue' : run.status === 'Failed' || run.status === 'Partially completed' ? 'Run paused · inspect the outcome and recover safely' : active ? `Executing ${active.tool}` : run.stage === 'planning' ? 'Preparing a structured plan' : run.stage === 'verifying' ? 'Verifying tool results' : 'Inspecting the selected repository'
  return <motion.div layout className={`agent-progress ${running ? 'is-running' : run.status === 'Awaiting approval' ? 'needs-review' : 'has-error'}`} role="status" aria-live="polite" initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 7 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 400, damping: 30, duration: reduceMotion ? 0 : undefined }}>
    <div className="agent-progress-icon">{running ? <LoaderCircle size={16} /> : run.status === 'Awaiting approval' ? <ShieldCheck size={16} /> : <XCircle size={16} />}</div>
    <div className="agent-progress-copy"><b>{label}</b><small>Live status comes from persisted server events. Private model reasoning is not shown.</small></div>
    <span className="agent-progress-count">{complete}/{total}</span>
    <div className="agent-progress-track" aria-label={`${complete} of ${total} tool actions finished`}><i style={{ width: `${Math.round(complete / total * 100)}%` }} /></div>
  </motion.div>
}
function ExecutionJourney({ run }: { run: AgentRun }) {
  const [selected, setSelected] = useState<string | null>(null)
  const steps = run.planSteps?.map((step, index) => ({ id: step.id, label: step.title, detail: step.description, state: step.status, index })) ?? run.tools.map((tool, index) => ({ id: tool.id, label: tool.action, detail: tool.error ?? tool.result, state: tool.status.toLowerCase(), index }))
  if (!steps.length) return null
  const completed = steps.filter(step => ['succeeded', 'complete', 'completed'].includes(step.state.toLowerCase())).length
  const selectedStep = steps.find(step => step.id === selected)
  return <section className="journey-card" aria-label="Agent execution journey">
    <div className="journey-heading"><div><span className="journey-kicker">EXECUTION JOURNEY</span><b>{completed} of {steps.length} steps complete</b></div><span className="journey-source">{run.backendRunId ? 'RUN TRACE' : 'SAMPLE TRACE'}</span></div>
    <div className="journey-scroll"><ol className="journey-track">{steps.map((step, index) => { const state = step.state.toLowerCase(); const phase = ['succeeded', 'complete', 'completed'].includes(state) ? 'complete' : state === 'failed' ? 'failed' : ['running', 'executing'].includes(state) ? 'current' : state === 'awaiting_approval' ? 'approval' : 'pending'; return <li className={`journey-step ${phase} ${selected === step.id ? 'selected' : ''}`} key={step.id}><button aria-expanded={selected === step.id} onClick={() => setSelected(value => value === step.id ? null : step.id)}><span className="journey-node">{phase === 'complete' ? <Check size={13} /> : phase === 'failed' ? <X size={13} /> : index + 1}</span><span className="journey-label">{step.label}</span><small>{phase === 'complete' ? 'Done' : phase === 'failed' ? 'Failed' : phase === 'current' ? 'Running' : phase === 'approval' ? 'Review' : 'Queued'}</small></button></li> })}</ol></div>
    <AnimatePresence initial={false}>{selectedStep && <motion.div className="journey-detail" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: .16 }}><b>{selectedStep.label}</b><p>{selectedStep.detail || 'No result recorded for this step yet.'}</p></motion.div>}</AnimatePresence>
  </section>
}
function Logo({ compact = false }: { compact?: boolean }) { return <div className="brand-mark"><div className="brand-icon"><Command size={18} strokeWidth={2.2} /></div>{!compact && <span>launchpilot<span className="brand-ai"> AI</span></span>}</div> }
function IconButton({ label, children, onClick, className = '', expanded }: { label: string; children: React.ReactNode; onClick?: () => void; className?: string; expanded?: boolean }) {
  const reduceMotion = useReducedMotion()
  return <motion.button className={`icon-button ${className}`} aria-label={label} aria-expanded={expanded} title={label} onClick={onClick} whileHover={reduceMotion ? undefined : { scale: 1.04 }} whileTap={reduceMotion ? undefined : { scale: 0.96 }} transition={{ type: 'spring', stiffness: 420, damping: 28 }}>{children}</motion.button>
}

function App() {
  const reduceMotion = useReducedMotion()
  const [page, setPage] = useState<Page>('Overview')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [mobileMenu, setMobileMenu] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('All activity')
  const [selectedProject, setSelectedProject] = useState<Project>(projects[0])
  const [availableProjects, setAvailableProjects] = useState<Project[]>(projects)
  const [githubConnection, setGithubConnection] = useState<IntegrationStatus | undefined>()
  const [repositoryBusy, setRepositoryBusy] = useState(false)
  const [repositoryError, setRepositoryError] = useState('')
  const [activeRun, setActiveRun] = useState<AgentRun>(runs[0])
  const [expanded, setExpanded] = useState<string[]>(['tool-1'])
  const [decision, setDecision] = useState<'pending' | 'approved' | 'rejected'>('pending')
  const [messages, setMessages] = useState<{ role: 'user' | 'agent'; text: string }[]>([{ role: 'agent', text: runs[0].summary }])
  const [notice, setNotice] = useState('')
  const [showNewTask, setShowNewTask] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const [tourOpen, setTourOpen] = useState(false)
  const [backendRunId, setBackendRunId] = useState<string | null>(null)
  const [backendBusy, setBackendBusy] = useState(false)
  const [persistedRuns, setPersistedRuns] = useState<AgentRun[]>([])
  const [apiRuns, setApiRuns] = useState<ApiRun[]>([])
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([])
  const [integrationLoadError, setIntegrationLoadError] = useState(false)
  const [preferences, setPreferences] = useState<Preferences>(loadPreferences)
  const [theme, setTheme] = useState<Theme>(loadTheme)
  const [helpOpen, setHelpOpen] = useState(false)
  const [search, setSearch] = useState('')
  const combinedActivity = useMemo(() => [...activity, ...toActivityEntries(apiRuns)], [apiRuns])
  const filteredActivity = useMemo(() => combinedActivity.filter(item => (filter === 'All activity' || item.outcome === filter) && `${item.title} ${item.project} ${item.kind}`.toLowerCase().includes(search.toLowerCase())), [combinedActivity, filter, search])

  useEffect(() => {
    let current = true
    api.listRuns().then(records => { if (current) { setApiRuns(records); setPersistedRuns(records.map(toAgentRun)) } }).catch(() => undefined)
    api.integrations().then(async records => {
      if (!current) return
      setIntegrations(records)
      const github = records.find(item => item.id === 'github')
      setGithubConnection(github)
      if (github?.connected) {
        try {
          const liveProjects = (await api.githubRepositories()).map(toProject)
          if (current) { setAvailableProjects(liveProjects); if (liveProjects.length) setSelectedProject(liveProjects[0]) }
        } catch (error) { if (current) setRepositoryError(error instanceof Error ? error.message : 'Could not load GitHub repositories.') }
      }
    }).catch(() => { if (current) setIntegrationLoadError(true) })
    const url = new URL(window.location.href)
    if (url.searchParams.get('github') === 'connected') { setNotice('GitHub authorization completed. Loading repositories from your account.'); url.searchParams.delete('github'); window.history.replaceState({}, '', url) }
    return () => { current = false }
  }, [])

  useEffect(() => { localStorage.setItem(preferenceKey, JSON.stringify(preferences)) }, [preferences])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem(themeKey, theme) } catch { /* Theme still applies for this session. */ }
  }, [theme])
  useEffect(() => {
    if (!notice || page === 'Agent Workspace') return
    const timer = window.setTimeout(() => setNotice(current => current === notice ? '' : current), 7000)
    return () => window.clearTimeout(timer)
  }, [notice, page])
  useEffect(() => {
    if (!backendRunId || activeRun.backendRunId !== backendRunId || activeRun.status !== 'Running') return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let retryDelay = 650
    const poll = async () => {
      try {
        const fresh = await api.getRun(backendRunId)
        if (stopped) return
        retryDelay = 650
        const mapped = toAgentRun(fresh)
        upsertApiRun(fresh)
        setActiveRun(current => current.backendRunId === backendRunId ? mapped : current)
        if (!['queued', 'planning', 'executing', 'verifying'].includes(fresh.state)) {
          if (['completed', 'partially_completed', 'failed', 'cancelled'].includes(fresh.state)) {
            setMessages(current => current[current.length - 1]?.text === mapped.summary ? current : [...current, { role: 'agent', text: mapped.summary }])
            setNotice(`Run ${fresh.id} · ${mapped.status} · LLM ${fresh.mode} · GitHub ${fresh.githubMode}${fresh.githubMode === 'mock' ? ' (simulated; no GitHub requests)' : ''}`)
          }
          return
        }
      } catch (error) {
        if (!stopped) setNotice(`Live status refresh failed: ${error instanceof Error ? error.message : 'API unavailable'}. Retrying shortly.`)
      }
      if (!stopped) {
        timer = setTimeout(poll, retryDelay)
        retryDelay = Math.min(retryDelay * 2, 10_000)
      }
    }
    timer = setTimeout(poll, 350)
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [backendRunId, activeRun.backendRunId, activeRun.status])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setShowNewTask(false); setCommandOpen(value => !value) }
      if (event.key === 'Escape') { setShowNewTask(false); setCommandOpen(false); setHelpOpen(false); setMobileMenu(false); setNotificationsOpen(false) }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  async function refreshGitHub() {
    setRepositoryBusy(true)
    setRepositoryError('')
    try {
      const records = await api.integrations()
      setIntegrations(records)
      const github = records.find(item => item.id === 'github')
      setGithubConnection(github)
      if (github?.connected) {
        const liveProjects = (await api.githubRepositories()).map(toProject)
        setAvailableProjects(liveProjects)
        if (!liveProjects.some(item => item.id === selectedProject.id)) setSelectedProject(liveProjects[0] ?? projects[0])
      } else setAvailableProjects(projects)
    } catch (error) { setRepositoryError(error instanceof Error ? error.message : 'Could not load GitHub repositories.') }
    finally { setRepositoryBusy(false) }
  }

  async function disconnectGitHub() {
    setRepositoryBusy(true)
    setRepositoryError('')
    try {
      await api.disconnectGitHub()
      setAvailableProjects(projects)
      setSelectedProject(projects[0])
      const records = await api.integrations()
      setIntegrations(records)
      setGithubConnection(records.find(item => item.id === 'github'))
    } catch (error) { setRepositoryError(error instanceof Error ? error.message : 'Could not disconnect GitHub.') }
    finally { setRepositoryBusy(false) }
  }

  function upsertApiRun(record: ApiRun) {
    setApiRuns(prev => [record, ...prev.filter(run => run.id !== record.id)])
    setPersistedRuns(prev => [toAgentRun(record), ...prev.filter(run => run.backendRunId !== record.id)])
  }

  async function startTask(text = '') {
    if (githubConnection?.mode === 'live' && !githubConnection.connected) { setPage('Integrations'); setNotice('Connect GitHub and select one of your authorized repositories before starting an inspection.'); return }
    if (githubConnection?.connected && !availableProjects.some(project => project.id === selectedProject.id)) { setNotice('Choose a repository returned by the connected GitHub account.'); return }
    const goal = text || 'Prepare my GitHub project for hackathon submission. Check its README, missing documentation, open issues, and project readiness.'
    setPage('Agent Workspace')
    setQuery('')
    setBackendRunId(null)
    setBackendBusy(true)
    setDecision('pending')
    setNotice('Creating your run…')
    setMessages([{ role: 'user', text: goal }])
    try {
      const created = await api.createRun(goal, { owner: selectedProject.owner, name: selectedProject.name }, preferences.readOnly)
      const agentRun = toAgentRun(created)
      upsertApiRun(created)
      setBackendRunId(created.id)
      setActiveRun(agentRun)
      setMessages([{ role: 'user', text: goal }, { role: 'agent', text: agentRun.summary }])
      setDecision('pending')
      setNotice(`Run ${created.id} · LLM ${created.mode} · GitHub ${created.githubMode}${created.githubMode === 'mock' ? ' (simulated; no GitHub requests)' : ''}`)
    } catch (error) {
      setNotice(`Could not create run: ${error instanceof Error ? error.message : 'Unexpected API error'}`)
    } finally { setBackendBusy(false) }
  }
  async function sendMessage() {
    const text = query.trim()
    if (!text) return
    setQuery('')
    if (!backendRunId) { await startTask(text); return }
    setBackendBusy(true)
    setNotice('Submitting a new focused run for this repository…')
    setMessages(prev => [...prev, { role: 'user', text }])
    try {
      const created = await api.createRun(text, { owner: selectedProject.owner, name: selectedProject.name }, preferences.readOnly)
      const mapped = toAgentRun(created)
      upsertApiRun(created)
      setBackendRunId(created.id)
      setActiveRun(mapped)
      setMessages(prev => [...prev, { role: 'agent', text: mapped.summary }])
      setDecision('pending')
      setNotice(`New run ${created.id} · LLM ${created.mode} · GitHub ${created.githubMode}${created.githubMode === 'mock' ? ' (simulated; no GitHub requests)' : ''}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected API error'
      setMessages(prev => [...prev, { role: 'agent', text: `I could not start that run: ${message}` }])
      setNotice(`Could not submit follow-up: ${message}`)
    } finally { setBackendBusy(false) }
  }
  async function decide(approved: boolean) {
    if (!backendRunId) { setNotice('This is a static sample run. Start a new task to exercise backend approval.'); return }
    const action = activeRun.planSteps?.find(step => step.requiresApproval && step.status === 'awaiting_approval')
    if (!action) { setNotice('There is no pending approval action for this run.'); return }
    setBackendBusy(true)
    try {
      const updated = await api.decide(backendRunId, action.id, action.approvalDigest ?? '', approved ? 'approve' : 'reject')
      upsertApiRun(updated)
      const mapped = toAgentRun(updated)
      setActiveRun(mapped)
      setDecision(approved ? 'approved' : 'rejected')
      setMessages(prev => [...prev, { role: 'agent', text: mapped.summary }])
      setNotice(approved ? `Approval recorded · LLM ${updated.mode} · GitHub ${updated.githubMode}${updated.githubMode === 'mock' ? ' (simulated only)' : ''}` : 'Action declined. No external write was performed.')
    } catch (error) { const message = error instanceof Error ? error.message : 'Unexpected API error'; if (message.includes('changed. Review the updated target')) { try { const fresh = await api.getRun(backendRunId); upsertApiRun(fresh); setActiveRun(toAgentRun(fresh)); setDecision('pending') } catch { /* retain the safe approval error for the user */ } } setNotice(`Approval request failed: ${message}`) }
    finally { setBackendBusy(false) }
  }
  async function retryRun() {
    if (!backendRunId) { setNotice('Start a new task to run a backend retry.'); return }
    setBackendBusy(true)
    try { const updated = await api.continueRun(backendRunId); upsertApiRun(updated); setActiveRun(toAgentRun(updated)); setDecision('pending'); setNotice(`Retry ${updated.id} · ${updated.mode} / ${updated.githubMode}`) }
    catch (error) { setNotice(`Retry failed: ${error instanceof Error ? error.message : 'Unexpected API error'}`) }
    finally { setBackendBusy(false) }
  }
  async function cancelRun() {
    if (!backendRunId) { setNotice('This is a static sample run.'); return }
    setBackendBusy(true)
    try { const updated = await api.cancelRun(backendRunId); upsertApiRun(updated); setActiveRun(toAgentRun(updated)); setNotice(updated.state === 'cancelled' ? 'Run cancelled. Completed actions remain recorded.' : 'Cancellation requested. Any in-flight tool call will finish before remaining steps stop.') }
    catch (error) { setNotice(`Cancellation unavailable: ${error instanceof Error ? error.message : 'Unexpected API error'}`) }
    finally { setBackendBusy(false) }
  }
  function toggleDetails(id: string) { setExpanded(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]) }
  function navigate(destination: Page) { setPage(destination); setMobileMenu(false) }
  function openRun(run: AgentRun) {
    setActiveRun(run)
    setBackendRunId(run.backendRunId ?? null)
    setPage('Agent Workspace')
    setMessages([{ role: 'agent', text: run.summary }])
    setDecision(run.status === 'Awaiting approval' ? 'pending' : 'approved')
    setNotificationsOpen(false)
  }
  const commandActions: CommandAction[] = [
    { id: 'new-task', title: 'Start a new task', detail: 'Describe a goal for the agent', icon: Plus, run: () => setShowNewTask(true) },
    ...navItems.map(({ label, icon }) => ({ id: `page-${label}`, title: `Go to ${label}`, detail: 'Navigate workspace', icon, run: () => navigate(label) })),
    { id: 'theme', title: `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`, detail: 'Change appearance · saved on this device', icon: theme === 'dark' ? Sun : Moon, run: () => setTheme(value => value === 'dark' ? 'light' : 'dark') },
    { id: 'help', title: 'Open safety guide', detail: 'Approvals, permissions and verification', icon: CircleHelp, run: () => setHelpOpen(true) },
    { id: 'tour', title: 'Take the product tour', detail: 'Learn the LaunchPilot workflow', icon: Sparkles, run: () => setTourOpen(true) },
  ]

  return <div className="app-shell" data-theme={theme} style={{ '--accent': accentTokens[preferences.accent].value, '--accent-strong': accentTokens[preferences.accent].strong } as React.CSSProperties}>
    <aside className={`sidebar ${sidebarOpen ? '' : 'collapsed'} ${mobileMenu ? 'mobile-open' : ''}`}>
      <div className="sidebar-top"><Logo compact={!sidebarOpen} /><IconButton label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'} className="collapse-btn" onClick={() => setSidebarOpen(v => !v)}>{sidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}</IconButton></div>
      <button className="new-task" onClick={() => { setShowNewTask(true); setMobileMenu(false) }}><Plus size={17} /><span>New task</span><kbd>⌘ K</kbd></button>
      <div className="nav-label">WORKSPACE</div>
      <nav aria-label="Main navigation">{navItems.map(({ label, icon: Icon }) => <button key={label} className={`nav-item ${page === label ? 'active' : ''}`} onClick={() => navigate(label)} title={!sidebarOpen ? label : undefined}><Icon size={17} /><span>{label}</span>{label === 'Agent Workspace' && sidebarOpen && <span className="nav-count">1</span>}</button>)}</nav>
      <div className="sidebar-bottom">
        <div className="connection-row"><span className="github-mark"><Github size={16} /></span>{sidebarOpen && <><div><b>GitHub</b><small>{!integrations.length ? 'Checking server…' : githubConnection?.connected ? `Connected · ${githubConnection.user?.login}` : githubConnection?.status === 'error' ? 'Connection error' : githubConnection?.mode === 'mock' ? 'Explicit mock mode' : 'Not connected'}</small></div><MoreHorizontal size={17} className="subtle" /></>}</div>
        <div className="profile-row"><div className="avatar">WS</div>{sidebarOpen && <><div className="profile-copy"><b>Workspace</b><small>{githubConnection?.user?.login ? `GitHub · ${githubConnection.user.login}` : 'Local developer session'}</small></div><ChevronDown size={15} className="subtle" /></>}</div>
      </div>
    </aside>
    <main className="main-shell">
      <header className="topbar">
        <div className="topbar-left"><IconButton label="Open navigation" className="mobile-menu-btn" onClick={() => setMobileMenu(v => !v)}>{mobileMenu ? <X size={18} /> : <Menu size={18} />}</IconButton><div className="breadcrumb"><span>Workspace</span><ChevronRight size={14} /><b>{page}</b></div></div>
        <div className="topbar-actions">
          <label className="project-switcher"><Github size={15} /><select aria-label="Active repository for new tasks" value={selectedProject.id} onChange={event => { const selected = availableProjects.find(project => project.id === event.target.value); if (selected) setSelectedProject(selected) }} title="Repository used for new tasks">{availableProjects.map(project => <option key={project.id} value={project.id}>{project.owner}/{project.name}</option>)}</select><ChevronDown size={13} /></label>
          <span className={`prototype-pill ${githubConnection?.connected ? 'is-connected' : ''}`}><span /> {githubConnection?.connected ? 'GitHub · live' : githubConnection?.mode === 'live' ? 'GitHub · disconnected' : 'GitHub · mock data'}</span>
          <IconButton label="Search pages and actions · Ctrl K" onClick={() => setCommandOpen(true)}><Search size={17} /></IconButton>
          <IconButton label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} onClick={() => setTheme(value => value === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</IconButton>
          <IconButton label="Help and safety guide" className="mobile-hide" onClick={() => setHelpOpen(true)}><CircleHelp size={17} /></IconButton>
          {preferences.notifications && <div className="notification-anchor"><IconButton label="Open notifications" expanded={notificationsOpen} onClick={() => setNotificationsOpen(value => !value)}>{notificationsOpen ? <X size={17} /> : <Bell size={17} />}{persistedRuns.some(run => run.status === 'Awaiting approval') && <i className="notification-dot" />}</IconButton>{notificationsOpen && <NotificationCenter runs={persistedRuns.length ? persistedRuns : runs} entries={combinedActivity} onOpenRun={openRun} onNavigate={destination => { navigate(destination); setNotificationsOpen(false) }} />}</div>}
          <div className="avatar top-avatar mobile-hide" title={githubConnection?.user?.login ?? 'Workspace'}>{(githubConnection?.user?.login?.slice(0, 2) ?? 'WS').toUpperCase()}</div>
        </div>
      </header>
      <div className="page-content"><AnimatePresence mode="wait" initial={false}><motion.div key={page} className="page-view" initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -5 }} transition={{ duration: reduceMotion ? 0.01 : 0.18, ease: [0.22, 1, 0.36, 1] }}>
        {page === 'Overview' && <Overview recentRuns={persistedRuns.length ? persistedRuns : runs} projects={availableProjects} busy={backendBusy} onStart={startTask} onNavigate={navigate} onSelectRun={run => { setActiveRun(run); setBackendRunId(run.backendRunId ?? null); setPage('Agent Workspace'); setMessages([{ role: 'agent', text: run.summary }]); setDecision(run.status === 'Awaiting approval' ? 'pending' : 'approved') }} onSelectProject={project => { setSelectedProject(project); setPage('Projects') }} />}
        {page === 'Agent Workspace' && <Workspace run={activeRun} messages={messages} query={query} setQuery={setQuery} onSend={sendMessage} decision={decision} onDecide={decide} expanded={expanded} toggleDetails={toggleDetails} notice={notice} onClearNotice={() => setNotice('')} onNew={() => setShowNewTask(true)} onRetry={retryRun} onCancel={cancelRun} busy={backendBusy} planDetail={preferences.planDetail} />}
        {page === 'Projects' && <Projects selected={selectedProject} projects={availableProjects} connected={Boolean(githubConnection?.connected)} busy={repositoryBusy} error={repositoryError} onConnect={() => githubConnection?.mode === 'live' && !githubConnection.connected ? window.location.assign('/api/integrations/github/connect') : navigate('Integrations')} onRefresh={refreshGitHub} onStart={text => startTask(text)} onSelect={setSelectedProject} runs={persistedRuns.length ? persistedRuns : githubConnection?.mode === 'mock' ? runs : []} onOpenRun={run => { setActiveRun(run); setBackendRunId(run.backendRunId ?? null); setDecision(run.status === 'Awaiting approval' ? 'pending' : 'approved'); setPage('Agent Workspace') }} />}
        {page === 'Activity Log' && <ActivityLog entries={filteredActivity} filter={filter} setFilter={setFilter} search={search} setSearch={setSearch} expanded={expanded} toggleDetails={toggleDetails} hasBackendEvents={apiRuns.length > 0} />}
        {page === 'Integrations' && <Integrations integrations={integrations} loadError={integrationLoadError} busy={repositoryBusy} error={repositoryError} onConnect={() => window.location.assign('/api/integrations/github/connect')} onDisconnect={disconnectGitHub} onRefresh={refreshGitHub} />}
        {page === 'Settings' && <SettingsPage preferences={preferences} onChange={setPreferences} />}
      </motion.div></AnimatePresence></div>
    </main>
    <AnimatePresence>{showNewTask && <NewTaskModal key="new-task" reduceMotion={Boolean(reduceMotion)} onClose={() => setShowNewTask(false)} onStart={text => { setShowNewTask(false); startTask(text) }} project={selectedProject} projects={availableProjects} onProject={setSelectedProject} />}</AnimatePresence>
    <AnimatePresence>{commandOpen && <CommandPalette key="command-palette" actions={commandActions} reduceMotion={Boolean(reduceMotion)} onClose={() => setCommandOpen(false)} />}</AnimatePresence>
    <AnimatePresence>{tourOpen && <OnboardingTour key="onboarding-tour" onClose={() => setTourOpen(false)} onNavigate={navigate} reduceMotion={Boolean(reduceMotion)} />}</AnimatePresence>
    <AnimatePresence>{helpOpen && <HelpDialog key="help" reduceMotion={Boolean(reduceMotion)} onClose={() => setHelpOpen(false)} />}</AnimatePresence>
    <AnimatePresence>{notice && page !== 'Agent Workspace' && <motion.div className={`app-toast ${/could not|failed|error|unavailable/i.test(notice) ? 'toast-error' : ''}`} role={/could not|failed|error|unavailable/i.test(notice) ? 'alert' : 'status'} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: .18 }}><span className="toast-icon">{/could not|failed|error|unavailable/i.test(notice) ? <XCircle size={16} /> : <CheckCircle2 size={16} />}</span><span>{notice}</span><button aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={15} /></button></motion.div>}</AnimatePresence>
  </div>
}

function Overview({ recentRuns, projects: workspaceProjects, busy, onStart, onNavigate, onSelectRun, onSelectProject }: { recentRuns: AgentRun[]; projects: Project[]; busy: boolean; onStart: (text?: string) => void; onNavigate: (page: Page) => void; onSelectRun: (run: AgentRun) => void; onSelectProject: (project: Project) => void }) {
  const [layout, setLayout] = useState<DashboardLayout>(loadDashboardLayout)
  const [customizing, setCustomizing] = useState(false)
  const [draggedWidget, setDraggedWidget] = useState<DashboardWidgetId | null>(null)
  const examples = ['Audit a repository for release readiness', 'Summarize open issues and suggest next steps', 'Prepare documentation for a hackathon submission']
  const now = new Date()
  const greeting = now.getHours() < 12 ? 'Good morning' : now.getHours() < 18 ? 'Good afternoon' : 'Good evening'
  const dateLabel = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(now).toUpperCase()
  const approvalRuns = recentRuns.filter(run => run.status === 'Awaiting approval')
  useEffect(() => { try { localStorage.setItem(dashboardLayoutKey, JSON.stringify(layout)) } catch { /* Keep this session's layout if storage is unavailable. */ } }, [layout])
  function moveWidget(source: DashboardWidgetId, target: DashboardWidgetId) {
    if (source === target) return
    setLayout(current => { const order = [...current.order]; const from = order.indexOf(source); const to = order.indexOf(target); if (from < 0 || to < 0) return current; order.splice(from, 1); order.splice(to, 0, source); return { ...current, order } })
  }
  function moveBy(id: DashboardWidgetId, direction: -1 | 1) {
    setLayout(current => { const order = [...current.order]; const from = order.indexOf(id); const to = Math.max(0, Math.min(order.length - 1, from + direction)); if (from === to) return current; order.splice(from, 1); order.splice(to, 0, id); return { ...current, order } })
  }
  const widgets: Record<DashboardWidgetId, React.ReactNode> = {
    approvals: <><div className="section-heading compact"><div><h2>Needs your review</h2><p>External actions pause here until you decide.</p></div><span className="widget-count">{approvalRuns.length}</span></div>{approvalRuns.length ? <div className="run-list">{approvalRuns.slice(0, 3).map(run => <button className="run-row" key={run.id} onClick={() => onSelectRun(run)}><div className="run-status-icon approval"><ShieldCheck size={14} /></div><div className="run-copy"><b>{run.title}</b><small>{run.owner ? `${run.owner}/${run.project}` : run.project} <span>·</span> {run.backendRunId ? 'Persisted run' : 'Sample run'}</small></div><Status value={run.status} /><ArrowRight size={14} className="row-arrow" /></button>)}</div> : <div className="widget-empty"><CheckCircle2 size={17} /><span>No actions waiting for approval</span><small>Approved writes always require an explicit review first.</small></div>}</>,
    projects: <><div className="section-heading compact"><div><h2>Repositories</h2><p>{workspaceProjects.some(project => project.url) ? 'Connected GitHub repositories' : 'Sample data · connect GitHub for live repositories'}</p></div><button className="text-link" onClick={() => onNavigate('Projects')}>Browse <ArrowRight size={14} /></button></div><div className="project-list">{workspaceProjects.length ? workspaceProjects.slice(0, 3).map(project => <button className="project-row" key={project.id} onClick={() => onSelectProject(project)}><div className={`project-avatar ${project.color}`}>{project.initials}</div><div className="project-main"><div className="project-title"><b>{project.owner}/<strong>{project.name}</strong></b><span className="coming-soon">{project.url ? 'GITHUB' : 'SAMPLE'}</span></div><p>{project.description}</p><div className="project-meta"><span>{project.language}</span><span>·</span><span>{project.openIssues} {project.url ? 'open' : 'sample'} issues</span></div></div><ArrowUpRight size={16} className="row-arrow" /></button>) : <div className="overview-empty"><Github size={18} /><b>No repositories loaded</b><span>Connect GitHub to choose a repository.</span><button className="text-link" onClick={() => onNavigate('Integrations')}>Connect GitHub <ArrowRight size={14} /></button></div>}</div><button className="workspace-link" onClick={() => onNavigate('Projects')}><span>All repositories</span><ArrowRight size={15} /></button></>,
    runs: <><div className="section-heading compact"><div><h2>Recent runs</h2><p>Plans, actions, and verified outcomes.</p></div><button className="text-link" onClick={() => onNavigate('Activity Log')}>Activity <ArrowRight size={14} /></button></div>{recentRuns.length ? <div className="run-list">{recentRuns.slice(0, 4).map(run => <button className="run-row" key={run.id} onClick={() => onSelectRun(run)}><div className={`run-status-icon ${statusClass[run.status]}`}>{run.status === 'Verified' ? <Check size={14} /> : run.status === 'Failed' ? <X size={14} /> : run.status === 'Running' ? <LoaderCircle size={14} /> : <Clock3 size={14} />}</div><div className="run-copy"><b>{run.title}</b><small>{run.project} <span>·</span> {run.time}</small></div><Status value={run.status} /></button>)}</div> : <div className="widget-empty"><Sparkles size={17} /><span>No runs yet</span><small>Describe a goal above to plan your first agent run.</small></div>}<button className="workspace-link" onClick={() => onNavigate('Agent Workspace')}><span><Sparkles size={15} /> Open agent workspace</span><ArrowRight size={15} /></button></>,
  }
  return <div className="overview-page">
    <div className="welcome-row"><div><div className="eyebrow"><span className="eyebrow-rule" /> {dateLabel}</div><h1>{greeting}, developer <span className="wave">✳</span></h1><p>Make your next release a little less work.</p></div><button className="button-secondary" onClick={() => onNavigate('Activity Log')}><Clock3 size={15} /> View activity</button></div>
    <section className="prompt-panel"><div className="prompt-heading"><div className="sparkle-tile"><Sparkles size={17} /></div><div><h2>What do you want to accomplish?</h2><p>Describe a developer task. Your agent will plan it, ask before changes, and verify the result.</p></div></div><div className="prompt-box"><textarea aria-label="Describe a task" placeholder="e.g. Prepare my project for hackathon submission…" rows={2} disabled={busy} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onStart(e.currentTarget.value) } }} /><div className="prompt-bottom"><span><ShieldCheck size={14} /> You stay in control · approval required for changes</span><button className="button-primary" disabled={busy} onClick={() => { const el = document.querySelector<HTMLTextAreaElement>('.prompt-box textarea'); onStart(el?.value) }}>{busy ? 'Planning…' : 'Plan task'} <ArrowRight size={15} /></button></div></div><div className="example-row"><span>TRY</span>{examples.map(example => <button key={example} disabled={busy} onClick={() => onStart(example)}>{example}<ArrowUpRight size={12} /></button>)}</div></section>
    <div className="section-heading dashboard-heading"><div><h2>Your command center</h2><p>Approvals, repositories, and agent runs.</p></div><div className="customize-wrap"><button className={`button-secondary customize-button ${customizing ? 'selected' : ''}`} aria-expanded={customizing} onClick={() => setCustomizing(value => !value)}><SlidersHorizontal size={15} /> {customizing ? 'Done' : 'Customize'}</button>{customizing && <div className="dashboard-customize" role="group" aria-label="Customize dashboard widgets"><div className="customize-title"><b>Dashboard layout</b><small>Drag cards to reorder, resize, or hide them.</small></div>{layout.order.map((id, index) => <div className="customize-row" key={id}><GripVertical size={14} /><label><input type="checkbox" checked={!layout.hidden.includes(id)} onChange={event => setLayout(current => ({ ...current, hidden: event.target.checked ? current.hidden.filter(item => item !== id) : [...current.hidden, id] }))} />{dashboardWidgetLabels[id]}</label><button aria-label={`Move ${dashboardWidgetLabels[id]} earlier`} disabled={index === 0} onClick={() => moveBy(id, -1)}><ArrowUp size={14} /></button><button aria-label={`Move ${dashboardWidgetLabels[id]} later`} disabled={index === layout.order.length - 1} onClick={() => moveBy(id, 1)}><ArrowDown size={14} /></button><button className="widget-size-button" aria-label={`Make ${dashboardWidgetLabels[id]} ${layout.wide.includes(id) ? 'standard' : 'wide'}`} onClick={() => setLayout(current => ({ ...current, wide: current.wide.includes(id) ? current.wide.filter(item => item !== id) : [...current.wide, id] }))}>{layout.wide.includes(id) ? 'Wide' : 'Standard'}</button></div>)}</div>}</div></div>
    <motion.div layout className="overview-grid dashboard-widgets">{layout.order.filter(id => !layout.hidden.includes(id)).map(id => <motion.section key={id} layout className={`content-section dashboard-widget ${layout.wide.includes(id) ? 'widget-wide' : ''} ${customizing ? 'widget-editing' : ''}`} style={{ gridColumn: layout.wide.includes(id) ? '1 / -1' : undefined }} draggable={customizing} onDragStart={event => { setDraggedWidget(id); (event as unknown as React.DragEvent<HTMLElement>).dataTransfer.effectAllowed = 'move' }} onDragOver={event => { if (customizing) event.preventDefault() }} onDrop={event => { event.preventDefault(); if (draggedWidget) moveWidget(draggedWidget, id); setDraggedWidget(null) }} onDragEnd={() => setDraggedWidget(null)}>{customizing && <div className="widget-drag-hint"><GripVertical size={14} /> Drag to reorder</div>}{widgets[id]}</motion.section>)}{layout.order.every(id => layout.hidden.includes(id)) && <div className="dashboard-empty"><b>Your dashboard is clear</b><span>Turn on a widget in Customize to bring your command center back.</span></div>}</motion.div>
    <div className="safety-note"><ShieldCheck size={15} /><span><b>Built for confidence.</b> LaunchPilot previews changes before they happen and verifies results after every approved action.</span><button onClick={() => onNavigate('Settings')}>Explore permissions <ArrowRight size={13} /></button></div>
  </div>
}

function Workspace({ run, messages, query, setQuery, onSend, decision, onDecide, expanded, toggleDetails, notice, onClearNotice, onNew, onRetry, onCancel, busy, planDetail }: { run: AgentRun; messages: { role: 'user' | 'agent'; text: string }[]; query: string; setQuery: (x: string) => void; onSend: () => void; decision: string; onDecide: (approved: boolean) => void; expanded: string[]; toggleDetails: (x: string) => void; notice: string; onClearNotice: () => void; onNew: () => void; onRetry: () => void; onCancel: () => void; busy: boolean; planDetail: Preferences['planDetail'] }) {
  const pendingAction = run.planSteps?.find(step => step.requiresApproval && step.status === 'awaiting_approval')
  const approvalPreview = pendingAction?.approvalPreview as Record<string, unknown> | undefined
  return <div className="workspace-page"><div className="workspace-header"><div><div className="eyebrow">AGENT WORKSPACE <span className="separator">/</span> {run.project}</div><h1>{run.title}</h1><div className="workspace-header-meta"><Status value={run.status} /><span><Clock3 size={13} /> Started {run.time}</span><span><span className="prototype-mini" /> {run.mode ? `LLM ${run.mode} · GitHub ${run.githubMode}` : 'Static sample'}</span>{run.goalStatus && <span className={`goal-outcome ${run.goalStatus}`}>Goal {run.goalStatus.replace(/_/g, ' ')}</span>}</div></div><div className="workspace-header-buttons">{run.status === 'Awaiting approval' && <button className="button-secondary" onClick={onCancel} disabled={busy}><X size={14} /> Cancel run</button>}{['Failed', 'Partially completed', 'Verification failed', 'Inconclusive'].includes(run.status) && <button className="button-secondary" onClick={onRetry} disabled={busy}><ArrowRight size={14} /> {run.status === 'Inconclusive' ? 'Retry verification' : 'Retry failed steps'}</button>}<button className="button-secondary" onClick={onNew}><Plus size={15} /> New task</button></div></div>
    {notice && <div className="notice"><ShieldCheck size={15} /><span>{notice}</span><button onClick={onClearNotice} aria-label="Dismiss notice"><X size={15} /></button></div>}
    <div className="workspace-layout"><section className="conversation-panel"><div className="conversation-head"><div className="agent-avatar"><Sparkles size={16} /></div><div><b>LaunchPilot agent</b><small>{run.mode ? `${run.mode} planning · GitHub ${run.githubMode}` : 'Static sample data'}</small></div><button className="subtle-button" aria-label="Show plan details" onClick={() => toggleDetails('plan')}><MoreHorizontal size={17} /></button></div><AgentProgress run={run} /><div className="conversation-content"><ExecutionJourney run={run} /><div className="day-divider"><span>{run.time}</span></div>{messages.map((message, i) => <div className={`message ${message.role}`} key={`${i}-${message.role}`}><div className={message.role === 'agent' ? 'message-agent-icon' : 'message-user-icon'}>{message.role === 'agent' ? <Sparkles size={14} /> : 'YOU'}</div><div className="message-body"><span className="message-author">{message.role === 'agent' ? 'LaunchPilot' : 'You'}</span><p>{message.text}</p>{message.role === 'agent' && i === 0 && <div className="agent-summary-meta"><span><CheckCircle2 size={13} /> {run.tools.filter(tool => tool.status === 'Complete').length} tool steps completed</span><span><Clock3 size={13} /> {run.tools.filter(tool => tool.status === 'Pending').length} pending</span></div>}</div></div>)}
      <div className="plan-card"><div className="card-overline"><ListChecks size={15} /><span>PROPOSED PLAN</span><span className="plan-count">{run.planSteps ? `${run.planSteps.length} steps` : run.backendRunId ? 'Preparing' : '5 steps'}</span></div><h3>{run.planSteps || run.backendRunId ? run.title : 'Get orbit-docs submission-ready'}</h3><p className="plan-intro">{run.summary}</p><div className="plan-steps">{run.planSteps ? run.planSteps.map((step, i) => <div className={`plan-step ${step.status === 'succeeded' ? 'done' : ''}`} key={step.id}><div className="step-number">{step.status === 'succeeded' ? <Check size={12} /> : i + 1}</div><span title={step.description}>{step.title}</span>{planDetail !== 'Concise' && <p>{planDetail === 'Detailed' ? step.description : `${step.description.slice(0, 120)}${step.description.length > 120 ? '…' : ''}`}</p>}<small>{step.status === 'skipped' ? 'Not enabled' : `${step.risk} risk${step.requiresApproval ? ' · approval' : ''}`}</small></div>) : run.backendRunId ? <div className="plan-loading" role="status"><span className="skeleton-line" /><span className="skeleton-line short" /><small>Waiting for the server to return the structured plan…</small></div> : ['Review README and repository metadata', 'Scan open issues for blockers and stale items', 'Check for essential project documentation', 'Prepare a documentation checklist draft', 'Verify all findings and report readiness'].map((item, i) => <div className={`plan-step ${i < 3 ? 'done' : ''}`} key={item}><div className="step-number">{i < 3 ? <Check size={12} /> : i + 1}</div><span>{item}</span>{i < 3 && <small>Done</small>}</div>)}</div><div className="plan-footer"><span><ShieldCheck size={14} /> {run.githubMode === 'live' ? 'Write actions require approval before they execute.' : run.mode ? 'Development simulation · no GitHub changes are made.' : 'No changes will be made without your approval.'}</span><button className="expand-button" onClick={() => toggleDetails('plan')}>{expanded.includes('plan') ? 'Hide details' : 'View details'} <ChevronDown className={expanded.includes('plan') ? 'rotate' : ''} size={14} /></button></div>{expanded.includes('plan') && <div className="expanded-detail">{run.planSteps ? 'Step permissions and risk are assigned by the server tool registry. Repository data is treated as untrusted content.' : 'This plan uses static sample data.'}</div>}</div>
      <div className="tool-section"><div className="tool-section-title"><span>TOOL EXECUTION</span><span className="tool-count">{run.tools.length} actions</span></div>{run.tools.length ? run.tools.map(tool => <div className="tool-card" key={tool.id}><button className="tool-card-head" onClick={() => toggleDetails(tool.id)}><div className={`tool-icon ${tool.status.toLowerCase()}`}>{tool.status === 'Complete' ? <Check size={14} /> : tool.status === 'Failed' ? <X size={14} /> : <Clock3 size={14} />}</div><div className="tool-copy"><b>{tool.tool}</b><span>{tool.action}</span></div><span className={`tool-status ${tool.status.toLowerCase()}`}>{tool.status}</span><ChevronDown size={15} className={expanded.includes(tool.id) ? 'rotate' : ''} /></button>{expanded.includes(tool.id) && <div className="tool-result"><p>{tool.result || tool.error || 'No result has been recorded.'}</p>{run.githubMode === 'live' && tool.resultLinks?.map(link => <a key={link.url} href={link.url} target="_blank" rel="noreferrer">{link.label} <ExternalLink size={12} /></a>)}{run.githubMode === 'live' && !tool.resultLinks?.length && tool.resultUrl && <a href={tool.resultUrl} target="_blank" rel="noreferrer">Open verified GitHub result <ExternalLink size={12} /></a>}<small><Clock3 size={12} /> {tool.duration}</small></div>}</div>) : <div className="empty-tool-note">No tool calls have been recorded for this run yet.</div>}</div>
      <div className="verify-card"><div className="verify-head"><div><div className="card-overline"><ShieldCheck size={15} /><span>VERIFICATION</span></div><h3>Evidence checks</h3></div><span className="verify-progress">{run.verification.filter(item => item.status === 'passed').length} passed</span></div>{run.verification.length ? run.verification.map(item => <VerificationRow key={item.id ?? item.label} item={item} />) : <div className="empty-tool-note">No verification result has been recorded yet.</div>}</div>
      {decision === 'pending' && run.status === 'Awaiting approval' && <div className="approval-card"><div className="approval-icon"><GitPullRequest size={17} /></div><div className="approval-copy"><h3>Review proposed action</h3><p>{pendingAction?.description ?? 'This static sample proposes an external action.'}</p><div className="change-summary"><span><ShieldCheck size={13} /> {pendingAction ? `${pendingAction.risk} risk · ${[pendingAction.permission, ...(pendingAction.additionalPermissions ?? [])].join(' + ')} · ${pendingAction.id}` : 'Sample only'}</span><span><Plus size={13} /> {pendingAction?.title ?? 'Proposed change'}</span>{run.owner && <span><Github size={13} /> Target: {run.owner}/{run.project}{pendingAction?.toolName === 'create_documentation_pull_request' ? ' · README file from repository · new branch + pull request' : pendingAction?.toolName === 'create_github_issue' ? ' · new issue' : ''}</span>}<span><ArrowRight size={13} /> Expected effect: {pendingAction?.toolName === 'create_github_issue' ? 'Create one issue in this repository.' : 'Create a new documentation branch and open a pull request; the default branch is not changed.'}</span></div>{approvalPreview && <details className="approval-payload"><summary>Exact proposed payload</summary><pre>{JSON.stringify(approvalPreview, null, 2)}</pre></details>}<small>Approval is bound to a server-computed digest of this exact target and payload. Any change requires a new decision.</small></div><div className="approval-actions"><button className="button-secondary" disabled={busy} onClick={() => onDecide(false)}>Reject</button><button className="button-primary" disabled={busy || !pendingAction?.approvalDigest} onClick={() => onDecide(true)}><Check size={14} /> {busy ? 'Working…' : 'Approve action'}</button></div></div>}{decision !== 'pending' && <div className={`decision-card ${decision}`}><CheckCircle2 size={16} /><div><b>{decision === 'approved' ? 'Approved' : 'Rejected'}</b><span>{decision === 'approved' ? run.githubMode === 'live' ? 'The approved action was executed and the backend reports its verification result.' : 'The backend recorded approval, but GitHub mock mode performed no external write.' : 'The proposed action was declined. No external write was performed.'}</span></div></div>}
      <div className="composer"><textarea aria-label="Message the agent" placeholder="Ask a follow-up or refine the plan…" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend() } }} /><div className="composer-foot"><span><kbd>↵</kbd> to send · <kbd>⇧ ↵</kbd> for new line</span><button aria-label="Send message" className="send-button" onClick={onSend} disabled={!query.trim()}><Send size={15} /></button></div></div></div></section>
      <aside className="run-sidebar">
        <div className="side-card">
          <div className="side-card-head"><span>RUN OVERVIEW</span><span className="tool-count">{run.mode ? 'LIVE DATA' : 'SAMPLE'}</span></div>
          {run.mode ? <div className="readiness-score"><div className="score-ring"><strong>—</strong><span>no score</span></div><div><b>Readiness not scored</b><p>Review the evidence checks below; this run does not calculate a numeric score.</p></div></div> : <><div className="readiness-score"><div className="score-ring"><strong>72</strong><span>/ 100</span></div><div><b>Good foundation</b><p>Sample project readiness score.</p></div></div><div className="readiness-bar"><span style={{ width: '72%' }} /></div><div className="readiness-legend"><span>0</span><span>Sample readiness</span><span>100</span></div></>}
        </div>
        <div className="side-card">
          <div className="side-card-head"><span>PROJECT</span><button onClick={() => navigator.clipboard?.writeText(`https://github.com/${run.owner ?? 'northstar-labs'}/${run.project}`)} aria-label="Copy repository URL"><ExternalLink size={14} /></button></div>
          <div className="repo-title"><div className="project-avatar violet">{(run.project[0] ?? 'R').toUpperCase()}</div><div><b>{run.owner ?? 'northstar-labs'}/{run.project}</b><small>{run.githubMode === 'live' ? <><i className="online-dot" /> GitHub connected</> : run.mode ? 'GitHub mock · no requests sent' : 'Static sample repository'}</small></div></div>
          {run.mode ? <div className="repo-stats"><span><Github size={13} /> {run.tools.length} tool actions</span><span>{run.verification.length} verification checks</span></div> : <div className="repo-stats"><span><span className="language-dot" /> TypeScript</span><span>☆ 248 stars</span><span><CirclePlus size={13} /> 6 issues</span></div>}
          <div className="repo-link"><Github size={14} /> {run.githubMode === 'live' && run.owner && run.project !== 'Needs repository' ? <a href={`https://github.com/${run.owner}/${run.project}`} target="_blank" rel="noreferrer">github.com/{run.owner}/{run.project}</a> : <span>Repository URL is for display only in this sample.</span>} <ExternalLink size={12} /></div>
        </div>
        <div className="side-card">
          <div className="side-card-head"><span>RUN TRACE</span><span className="tool-count">{run.mode ? 'RECORDED' : 'SAMPLE'}</span></div>
          <div className="timeline">{run.tools.length ? run.tools.map(tool => <div className={`timeline-item ${tool.status === 'Complete' ? 'complete' : tool.status === 'Failed' ? 'failed' : tool.status === 'Running' ? 'current' : 'future'}`} key={tool.id}><i /><div><b>{tool.action}</b><small>{tool.status}{run.githubMode === 'mock' && run.mode ? ' · simulated fixture' : ''}</small></div></div>) : <div className="empty-tool-note">No tool calls recorded yet.</div>}</div>
        </div>
        <div className="side-help"><CircleHelp size={15} /><span>{run.githubMode === 'live' ? 'Tool results are recorded from GitHub responses.' : run.mode ? 'Mock mode · external services were not called.' : 'Actions are simulated in prototype mode.'}</span></div>
      </aside></div>
  </div>
}
function VerificationRow({ item }: { item: VerificationResult }) {
  const [open, setOpen] = useState(false)
  const reduceMotion = useReducedMotion()
  return (
    <motion.div layout className="verification-row verification-evidence" initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduceMotion ? 0 : 0.16 }}>
      <span className={`verification-icon ${item.status}`}>{item.status === 'passed' ? <CheckCircle2 size={15} /> : item.status === 'failed' ? <XCircle size={15} /> : <Clock3 size={15} />}</span>
      <span className="verification-label">{item.label}</span>
      <span className={`verification-detail ${item.status}`}>{item.status === 'passed' ? 'Verified' : item.status === 'failed' ? 'Verification failed' : 'Inconclusive'}</span>
      <button className="expand-button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Hide evidence' : 'Evidence'} <ChevronDown size={13} className={open ? 'rotate' : ''} /></button>
      <small className="verification-copy">{item.detail}</small>
      <AnimatePresence initial={false}>
        {open && <motion.div className="activity-detail verification-proof" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: reduceMotion ? 0 : 0.16 }}>
          <div><span><Clock3 size={13} /> {item.verifiedAt ? new Date(item.verifiedAt).toLocaleString() : 'Timestamp unavailable'}</span></div>
          <pre>{JSON.stringify(item.evidence ?? { status: item.status, detail: item.detail }, null, 2)}</pre>
        </motion.div>}
      </AnimatePresence>
    </motion.div>
  )
}

function Projects({ selected, projects: workspaceProjects, connected, busy, error, onConnect, onRefresh, onStart, onSelect, runs: projectRuns, onOpenRun }: { selected: Project; projects: Project[]; connected: boolean; busy: boolean; error: string; onConnect: () => void; onRefresh: () => void; onStart: (goal: string) => void; onSelect: (p: Project) => void; runs: AgentRun[]; onOpenRun: (r: AgentRun) => void }) {
  const liveRepos = connected && workspaceProjects.some(project => Boolean(project.url))
  const recentRuns = projectRuns.filter(run => run.project === selected.name && run.owner?.toLowerCase() === selected.owner.toLowerCase())
  return <div className="subpage"><div className="subpage-heading"><div><div className="eyebrow">WORKSPACE · {liveRepos ? 'CONNECTED GITHUB' : 'SAMPLE MODE'}</div><h1>Projects</h1><p>{liveRepos ? 'Select a repository your GitHub App can access to inspect its readiness.' : 'Connect a GitHub App to load authorized repositories. Sample projects are clearly marked.'}</p></div><div className="workspace-header-buttons">{liveRepos && <button className="button-secondary" onClick={onRefresh} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh repositories'}</button>}<button className="button-primary" onClick={onConnect}><Github size={15} /> {connected ? 'Manage connection' : 'Connect GitHub'}</button></div></div>
    {error && <div className="notice error-notice"><XCircle size={15} /><span>{error}</span></div>}
    <div className="projects-layout"><div className="project-picker">{workspaceProjects.map(project => <button className={`project-picker-row ${project.id === selected.id ? 'selected' : ''}`} key={project.id} onClick={() => onSelect(project)}><div className={`project-avatar ${project.color}`}>{project.initials}</div><div><b>{project.name}</b><small>{project.owner}</small></div><ChevronRight size={15} /></button>)}</div>
      {workspaceProjects.length ? <div className="project-detail"><div className="project-detail-head"><div className={`project-avatar large ${selected.color}`}>{selected.initials}</div><div className="project-detail-title"><div><h2>{selected.owner}/{selected.name}</h2><span className="coming-soon">{selected.url ? (selected.private ? 'PRIVATE · AUTHORIZED' : 'PUBLIC · AUTHORIZED') : 'SAMPLE REPOSITORY'}</span></div><p>{selected.description}</p><div className="project-meta"><span>{selected.language}</span><span>·</span><span>{selected.url ? '☆ ' + selected.stars + ' stars' : '☆ ' + selected.stars + ' sample stars'}</span><span>·</span><span>{selected.openIssues} {selected.url ? 'open issues' : 'sample issues'}</span>{selected.defaultBranch && <><span>·</span><span>default: {selected.defaultBranch}</span></>}</div></div>{selected.url && <a className="button-secondary" href={selected.url} target="_blank" rel="noreferrer"><Github size={15} /> View on GitHub <ArrowUpRight size={14} /></a>}</div>
        <div className="project-summary"><div><span>INTEGRATION</span><b>{selected.url ? 'Live GitHub repository' : 'Sample data · no GitHub request'}</b></div><div><span>LAST UPDATED</span><b>{selected.updated}</b></div><div><span>OPEN ISSUES</span><b>{selected.openIssues}</b></div></div>
        <div className="section-heading compact project-section-heading"><div><h2>Repository readiness</h2><p>{selected.url ? 'Inspect metadata, README, documentation, issues and pull requests.' : 'Connect GitHub to inspect a real repository.'}</p></div></div><div className="project-run-list"><button className="project-task-row" disabled={!selected.url || busy} onClick={() => onStart('Check whether my project is ready for the hackathon. Inspect the README, setup instructions, license, demo information, documentation, open issues and pull requests. Provide an evidence-backed readiness checklist and propose specific improvements.') }><div className="run-status-icon running"><Sparkles size={14} /></div><div><b>Inspect project readiness</b><small>{selected.url ? 'Runs against this selected repository through the live GitHub integration.' : 'Sample repository is not connected to GitHub.'}</small></div><span className="button-primary">Start inspection <ArrowRight size={14} /></span></button></div>
        <div className="section-heading compact project-section-heading"><div><h2>Recent agent tasks</h2><p>{liveRepos ? 'Backend runs for this repository.' : 'Illustrative sample runs.'}</p></div></div>{recentRuns.length ? <div className="project-run-list">{recentRuns.slice(0, 6).map(run => <button className="project-task-row" key={run.id} onClick={() => onOpenRun(run)}><div className={`run-status-icon ${statusClass[run.status]}`}>{run.status === 'Verified' ? <Check size={14} /> : run.status === 'Failed' ? <X size={14} /> : <Clock3 size={14} />}</div><div><b>{run.title}</b><small>{run.time} · {run.tools.length} tool actions</small></div><Status value={run.status} /><ChevronRight size={15} /></button>)}</div> : <EmptyState title="No recent runs" detail="Start an inspection to create the first agent run for this repository." icon={<Sparkles size={18} />} />}
      </div> : <EmptyState title={busy ? 'Loading repositories…' : 'No authorized repositories found'} detail={connected ? 'Confirm this GitHub App is installed on a repository, then refresh.' : 'Connect GitHub to list repositories available to your account.'} icon={<Github size={19} />} />}
    </div>
  </div>
}

function ActivityLog({ entries, filter, setFilter, search, setSearch, expanded, toggleDetails, hasBackendEvents }: { entries: ActivityEntry[]; filter: string; setFilter: (x: string) => void; search: string; setSearch: (x: string) => void; expanded: string[]; toggleDetails: (x: string) => void; hasBackendEvents: boolean }) {
  return <div className="subpage">
    <div className="subpage-heading"><div><div className="eyebrow">WORKSPACE</div><h1>Activity log</h1><p>A transparent record of agent actions and outcomes.</p></div><div className="activity-summary"><span>{hasBackendEvents ? 'Persisted run events available' : 'Example activity records'}</span><small>{hasBackendEvents ? `${entries.filter(item => item.source === 'backend').length} backend events and sample history` : 'No backend runs saved yet'}</small></div></div>
    <div className="activity-toolbar"><div className="search-input"><Search size={16} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search activity…" /></div><label className="filter-select"><Filter size={15} /><select aria-label="Filter activity" value={filter} onChange={e => setFilter(e.target.value)}><option>All activity</option><option>Awaiting approval</option><option>Approved</option><option>Rejected</option><option>Verified</option><option>Verification failed</option><option>Inconclusive</option><option>Partially completed</option><option>Cancelled</option><option>Simulated</option><option>Failed</option></select><ChevronDown size={14} /></label><button className="button-secondary" onClick={() => { setSearch(''); setFilter('All activity') }}>Clear filters</button></div>
    <div className="activity-feed"><div className="feed-date">RECENT EVENTS <span>{hasBackendEvents ? 'PERSISTED + SAMPLE' : 'SAMPLE'}</span></div>{entries.length ? entries.map(item => <div className="activity-item" key={item.id}><div className={`activity-type-icon ${statusClass[item.outcome]}`}>{item.kind.toLowerCase().includes('issue') ? <ListChecks size={15} /> : item.kind.toLowerCase().includes('approval') ? <GitPullRequest size={15} /> : <Github size={15} />}</div><div className="activity-item-body"><button className="activity-title-row" onClick={() => toggleDetails(item.id)}><div><small>{item.kind} <span>·</span> {item.project}</small><b>{item.title}</b></div><div className="activity-right"><Status value={item.outcome} /><span className="activity-time">{item.time}</span><ChevronDown size={15} className={expanded.includes(item.id) ? 'rotate' : ''} /></div></button>{expanded.includes(item.id) && <div className="activity-detail"><p>{item.detail}</p>{item.evidence !== undefined && <details className="approval-payload"><summary>Sanitized event evidence</summary><pre>{JSON.stringify(item.evidence, null, 2)}</pre></details>}<div><span><ShieldCheck size={13} /> {item.source === 'backend' ? 'Persisted backend event' : 'Sample data'}</span><span><Clock3 size={13} /> {item.time}</span></div></div>}</div></div>) : <EmptyState title="No activity matches" detail="Try a different search or clear your filters." icon={<Search size={18} />} />}</div>
    <div className="prototype-footnote"><ShieldCheck size={14} /> Backend events are persisted by the API; sample history is clearly labeled.</div>
  </div>
}

function Integrations({ integrations, loadError, busy, error, onConnect, onDisconnect, onRefresh }: { integrations: IntegrationStatus[]; loadError: boolean; busy: boolean; error: string; onConnect: () => void; onDisconnect: () => void; onRefresh: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const github = integrations.find(item => item.id === 'github')
  const llm = integrations.find(item => item.id === 'llm')
  const githubStatus = loadError ? 'Unavailable' : github?.status === 'connected' ? 'Connected' : github?.status === 'disconnected' ? 'Not connected' : github?.status === 'error' ? 'Connection error · reconnect required' : github?.status === 'mock' ? 'Mock mode' : 'Loading status…'
  return <div className="subpage"><div className="subpage-heading"><div><div className="eyebrow">PREFERENCES</div><h1>Integrations</h1><p>Connect the GitHub App to inspect repositories authorized by your account.</p></div></div>
    {error && <div className="notice error-notice"><XCircle size={15} /><span>{error}</span></div>}
    <section className="settings-card integration-card"><div className="integration-icon"><Github size={22} /></div><div className="integration-main"><div className="integration-title"><h2>GitHub</h2><span className={github?.connected ? 'connected-label' : 'coming-soon'}>{githubStatus}</span></div><p>{github?.mode === 'live' ? 'GitHub App user authorization keeps access tokens encrypted on this server. Repository access follows the repositories selected during GitHub authorization.' : 'Explicit development mock mode: no GitHub requests are made. Configure a GitHub App to enable live connection.'}</p><div className="github-account"><div className="integration-icon muted-icon"><ShieldCheck size={16} /></div><div><b>{github?.user?.login ? `Connected as ${github.user.login}` : github?.mode === 'live' ? 'No GitHub account connected' : 'Live app credentials not configured'}</b><small>{github?.connected ? 'Access token remains encrypted on the server and is never sent to the browser.' : github?.mode === 'live' ? 'Select Connect to authorize the registered GitHub App.' : 'Set GITHUB_MODE=live and provide the App credentials in the server environment.'}</small></div><span className={github?.connected ? 'connected-label' : 'coming-soon'}>{github?.connected ? 'CONNECTED' : github?.mode === 'mock' ? 'MOCK MODE' : 'DISCONNECTED'}</span></div><div className="integration-scope"><span>REQUESTED GITHUB APP PERMISSIONS</span>{(github?.permissions ?? ['Repository metadata: read', 'Contents: read', 'Issues: read/write for approved issue creation', 'Pull requests: read']).map(permission => <div key={permission}><CheckCircle2 size={14} /> {permission}</div>)}<small>GitHub Apps use their configured repository permissions rather than broad personal access tokens. The app setup guide lists the exact permissions to enable.</small></div><div className="integration-scope"><span>WHAT LAUNCHPILOT DOES</span><div><CheckCircle2 size={14} /> Read repository metadata, permitted text files, issues and pull requests</div><div><CheckCircle2 size={14} /> Check configurable readiness signals from the repository tree</div><div><CheckCircle2 size={14} /> Create an issue or documentation pull request only after explicit approval</div><small>All repository targets are rechecked against the connected account before every tool call.</small></div></div><div className="integration-actions">{github?.mode === 'live' && !github.connected && <button className="button-primary" disabled={busy} onClick={onConnect}><Github size={15} /> Connect GitHub</button>}{github?.connected && <><button className="button-secondary" disabled={busy} onClick={onRefresh}>{busy ? 'Refreshing…' : 'Refresh repositories'}</button><button className="text-danger" disabled={busy} onClick={onDisconnect}>Disconnect and revoke</button></>}<button className="button-secondary" onClick={() => setExpanded(v => !v)}>{expanded ? 'Hide details' : 'View details'} <ChevronDown size={14} className={expanded ? 'rotate' : ''} /></button></div>{expanded && <div className="integration-expanded"><b>Authorization security</b><span>OAuth state is checked against an HttpOnly, SameSite cookie. GitHub App access and refresh tokens are encrypted at rest with AES-256-GCM. Disconnect revokes the GitHub App grant before deleting the encrypted credential. This local prototype is single-user and should not be exposed as a multi-user service.</span></div>}</section>
    <section className="settings-card integration-other"><div className="integration-icon muted-icon"><Sparkles size={20} /></div><div><h2>Planning provider</h2><p>{llm?.name ?? (loadError ? 'API unavailable' : 'Loading provider status…')} · {llm?.status === 'configured' ? 'configured on the server' : llm?.status === 'mock' ? 'deterministic development responses' : 'status unavailable'}</p></div><span className="coming-soon">{llm?.mode?.toUpperCase() ?? 'UNKNOWN'}</span></section>
    <section className="settings-card integration-other"><div className="integration-icon muted-icon"><Terminal size={20} /></div><div><h2>Local development tools</h2><p>Terminal and arbitrary filesystem access are not available to the agent.</p></div><span className="coming-soon">NOT CONFIGURED</span></section><div className="prototype-footnote"><ShieldCheck size={14} /> API keys remain server-side; mock and live modes are shown explicitly.</div></div>
}

function SettingsPage({ preferences, onChange }: { preferences: Preferences; onChange: (value: Preferences) => void }) {
  const update = (key: keyof Preferences, value: Preferences[keyof Preferences]) => onChange({ ...preferences, [key]: value })
  return <div className="subpage">
    <div className="subpage-heading"><div><div className="eyebrow">PREFERENCES</div><h1>Settings</h1><p>Set boundaries and personalize your workspace.</p></div><span className="saved-label"><CheckCircle2 size={14} /> Saved in this browser</span></div>
    <section className="settings-card"><div className="settings-section-title"><div className="settings-icon"><ShieldCheck size={17} /></div><div><h2>Agent permissions</h2><p>Read-only preferences are included in each run request.</p></div></div><div className="toggle-row"><div><b>Require approval for external writes</b><small>Always enforced by the backend. It cannot be disabled from settings.</small></div><span className="always-on"><ShieldCheck size={13} /> Always on</span></div><ToggleRow title="Read-only mode" detail="Inspect and plan, but skip issue creation and documentation pull requests." value={preferences.readOnly} onChange={value => update('readOnly', value)} /><ToggleRow title="Notification center" detail="Show or hide notifications in the header." value={preferences.notifications} onChange={value => update('notifications', value)} /></section>
    <section className="settings-card preference-card"><div className="settings-section-title"><div className="settings-icon violet-icon"><Sparkles size={17} /></div><div><h2>Planning preferences</h2><p>Fine-tune how LaunchPilot presents a task.</p></div></div><div className="preference-row"><div><b>Plan detail</b><small>How much context should be included in proposed plans?</small></div><select value={preferences.planDetail} onChange={event => update('planDetail', event.target.value as Preferences['planDetail'])}><option>Concise</option><option>Balanced</option><option>Detailed</option></select></div><div className="preference-row"><div><b>Verification summary</b><small>Always show verification results before completing a run.</small></div><span className="always-on"><Check size={13} /> Always on</span></div></section>
    <section className="settings-card preference-card"><div className="settings-section-title"><div className="settings-icon violet-icon"><Sun size={17} /></div><div><h2>Appearance</h2><p>Choose an accent color; switch between light and dark from the header.</p></div></div><div className="preference-row"><div><b>Accent color</b><small>Applied to navigation, focus states, and primary actions.</small></div><select aria-label="Accent color" value={preferences.accent} onChange={event => update('accent', event.target.value as Preferences['accent'])}><option value="violet">Electric violet</option><option value="teal">Sea glass</option><option value="blue">Arctic blue</option><option value="rose">Soft rose</option></select></div></section>
    <div className="prototype-footnote"><ShieldCheck size={14} /> Preferences are stored in this browser. External writes still require exact-payload approval.</div>
  </div>
}

function CommandPalette({ actions, onClose, reduceMotion }: { actions: CommandAction[]; onClose: () => void; reduceMotion: boolean }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const filtered = actions.filter(action => `${action.title} ${action.detail}`.toLowerCase().includes(query.trim().toLowerCase()))
  const choose = (action: CommandAction | undefined) => { if (!action) return; onClose(); action.run() }
  return <motion.div className="modal-backdrop command-backdrop" role="presentation" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : .14 }} onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <motion.section className="command-palette" role="dialog" aria-modal="true" aria-labelledby="command-title" initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8, scale: .99 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -5, scale: .99 }} transition={{ type: 'spring', stiffness: 420, damping: 34, duration: reduceMotion ? 0 : undefined }}>
      <h2 id="command-title" className="sr-only">Command palette</h2>
      <div className="command-search"><Search size={18} /><input autoFocus value={query} onChange={event => { setQuery(event.target.value); setActive(0) }} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(index + 1, filtered.length - 1)) } else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(index - 1, 0)) } else if (event.key === 'Enter') { event.preventDefault(); choose(filtered[active]) } }} placeholder="Search pages and actions…" aria-label="Search commands" /><kbd>ESC</kbd></div>
      <div className="command-list" role="listbox" aria-label="Commands">{filtered.length ? filtered.map((action, index) => { const Icon = action.icon; return <button role="option" aria-selected={index === active} className={`command-option ${index === active ? 'selected' : ''}`} key={action.id} onMouseEnter={() => setActive(index)} onClick={() => choose(action)}><span className="command-icon"><Icon size={16} /></span><span className="command-copy"><b>{action.title}</b><small>{action.detail}</small></span>{index === active && <kbd>↵</kbd>}</button> }) : <div className="command-empty"><Search size={17} /><span>No matching actions</span><small>Try a page name or “new task”.</small></div>}</div>
      <div className="command-footer"><span><kbd>↑</kbd><kbd>↓</kbd> to navigate</span><span><kbd>↵</kbd> to select</span><span>LaunchPilot command menu</span></div>
    </motion.section>
  </motion.div>
}

function NotificationCenter({ runs: recentRuns, entries, onOpenRun, onNavigate }: { runs: AgentRun[]; entries: ActivityEntry[]; onOpenRun: (run: AgentRun) => void; onNavigate: (page: Page) => void }) {
  const approvals = recentRuns.filter(run => run.status === 'Awaiting approval').slice(0, 3)
  return <motion.section className="notification-center" aria-label="Notifications" initial={{ opacity: 0, y: -5, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -4, scale: .99 }} transition={{ duration: .14 }}>
    <div className="notification-head"><div><b>Notifications</b><small>{approvals.length ? `${approvals.length} action${approvals.length === 1 ? '' : 's'} need review` : 'You’re up to date'}</small></div><span className="notification-live">{recentRuns.some(run => run.backendRunId) ? 'PERSISTED' : 'SAMPLE'}</span></div>
    {approvals.length > 0 && <div className="notification-group"><span className="notification-label">NEEDS YOUR REVIEW</span>{approvals.map(run => <button className="notification-item approval-item" key={run.id} onClick={() => onOpenRun(run)}><span className="notification-symbol"><ShieldCheck size={15} /></span><span><b>{run.title}</b><small>{run.owner ? `${run.owner}/${run.project}` : run.project} · exact action approval</small></span><ChevronRight size={15} /></button>)}</div>}
    <div className="notification-group"><span className="notification-label">RECENT ACTIVITY</span>{entries.slice(0, 3).map(item => <button className="notification-item" key={item.id} onClick={() => onNavigate('Activity Log')}><span className={`notification-symbol ${statusClass[item.outcome]}`}><Activity size={14} /></span><span><b>{item.title}</b><small>{item.project} · {item.time}{item.source === 'sample' ? ' · sample' : ''}</small></span><ChevronRight size={15} /></button>)}{!entries.length && !approvals.length && <div className="notification-empty"><Bell size={17} /><span>No activity yet</span><small>Run updates and approvals will appear here.</small></div>}</div>
    <button className="notification-footer" onClick={() => onNavigate('Activity Log')}>Open activity log <ArrowRight size={14} /></button>
  </motion.section>
}

function OnboardingTour({ onClose, onNavigate, reduceMotion }: { onClose: () => void; onNavigate: (page: Page) => void; reduceMotion: boolean }) {
  const [step, setStep] = useState(0)
  const tour = [
    { title: 'Start with the outcome', detail: 'Describe a developer goal in plain language. Choose an example prompt or write your own, then LaunchPilot prepares a structured plan.', page: 'Overview' as Page, label: 'Open the command center', icon: LayoutDashboard },
    { title: 'Review before changes', detail: 'Plans show ordered steps, risk, permissions, and the exact payload. External writes pause until you approve or reject them.', page: 'Agent Workspace' as Page, label: 'Open the agent workspace', icon: ShieldCheck },
    { title: 'Connect only what you need', detail: 'Authorize a GitHub App to inspect selected repositories. Credentials stay server-side, and mock mode is clearly labeled.', page: 'Integrations' as Page, label: 'Review integrations', icon: Github },
    { title: 'Verify the actual result', detail: 'Tool results and verification evidence are recorded in the activity log. A model response alone never counts as proof.', page: 'Activity Log' as Page, label: 'View the activity log', icon: Activity },
  ]
  const current = tour[step]
  const Icon = current.icon
  return <motion.div className="modal-backdrop tour-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><motion.section className="tour-dialog" role="dialog" aria-modal="true" aria-labelledby="tour-title" initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: .99 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0 }} transition={{ type: 'spring', stiffness: 360, damping: 30 }}><div className="tour-top"><div className="tour-icon"><Icon size={20} /></div><button className="icon-button" aria-label="Close tour" onClick={onClose}><X size={17} /></button></div><div className="tour-progress-label">LAUNCHPILOT TOUR <span>{step + 1} / {tour.length}</span></div><h2 id="tour-title">{current.title}</h2><p>{current.detail}</p><div className="tour-dots" aria-label={`Step ${step + 1} of ${tour.length}`}>{tour.map((item, index) => <i key={item.title} className={index <= step ? 'active' : ''} />)}</div><div className="tour-actions"><button className="button-secondary" onClick={() => setStep(index => Math.max(0, index - 1))} disabled={step === 0}>Back</button><button className="tour-open-link" onClick={() => { onNavigate(current.page); onClose() }}>{current.label} <ArrowUpRight size={14} /></button>{step < tour.length - 1 ? <button className="button-primary" onClick={() => setStep(index => Math.min(tour.length - 1, index + 1))}>Next <ArrowRight size={14} /></button> : <button className="button-primary" onClick={onClose}>Finish <Check size={14} /></button>}</div></motion.section></motion.div>
}

function HelpDialog({ onClose, reduceMotion }: { onClose: () => void; reduceMotion: boolean }) {
  return <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : 0.16 }} onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><motion.section className="new-task-modal" role="dialog" aria-modal="true" aria-labelledby="help-heading" initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.99 }} transition={{ type: 'spring', stiffness: 360, damping: 30, duration: reduceMotion ? 0 : undefined }}><div className="modal-head"><div className="sparkle-tile"><ShieldCheck size={17} /></div><div><h2 id="help-heading">How LaunchPilot works</h2><p>Plan first. Review external changes. Verify the result.</p></div><IconButton label="Close help" onClick={onClose}><X size={17} /></IconButton></div><div className="integration-scope"><span>RUN MODES</span><div><CheckCircle2 size={14} /> Mock mode uses deterministic sample data and performs no GitHub requests.</div><div><CheckCircle2 size={14} /> Live GitHub mode requires a configured GitHub App and account authorization.</div><div><CheckCircle2 size={14} /> LLM provider mode is shown on every run; mock planning is not represented as live AI.</div></div><div className="integration-scope"><span>SAFETY</span><div><ShieldCheck size={14} /> Every external write needs approval for its exact target and payload.</div><div><ShieldCheck size={14} /> Verification is based on tool results and GitHub read-back, not agent narration.</div><div><ShieldCheck size={14} /> The app does not have user login or multi-user isolation; run locally.</div></div><div className="modal-actions"><button className="button-primary" onClick={onClose}>Got it</button></div></motion.section></motion.div>
}
function ToggleRow({ title, detail, value, onChange }: { title: string; detail: string; value: boolean; onChange: (v: boolean) => void }) { return <div className="toggle-row"><div><b>{title}</b><small>{detail}</small></div><button role="switch" aria-checked={value} className={`toggle ${value ? 'on' : ''}`} onClick={() => onChange(!value)}><span /></button></div> }
function EmptyState({ title, detail, icon }: { title: string; detail: string; icon: React.ReactNode }) { return <div className="empty-state"><div>{icon}</div><b>{title}</b><p>{detail}</p></div> }

function NewTaskModal({ onClose, onStart, project, projects: workspaceProjects, onProject, reduceMotion }: { onClose: () => void; onStart: (text: string) => void; project: Project; projects: Project[]; onProject: (p: Project) => void; reduceMotion: boolean }) {
  const [text, setText] = useState('')
  return <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : 0.16 }} onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}><motion.section className="new-task-modal" role="dialog" aria-modal="true" aria-labelledby="new-task-heading" initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.99 }} transition={{ type: 'spring', stiffness: 360, damping: 30, duration: reduceMotion ? 0 : undefined }}><div className="modal-head"><div className="sparkle-tile"><Sparkles size={17} /></div><div><h2 id="new-task-heading">Start a new task</h2><p>Describe what you want the agent to help with.</p></div><IconButton label="Close" onClick={onClose}><X size={17} /></IconButton></div><label className="field-label" htmlFor="task-description">YOUR GOAL</label><textarea id="task-description" autoFocus rows={4} value={text} onChange={e => setText(e.target.value)} placeholder="e.g. Review my project for launch readiness…" /><label className="field-label" htmlFor="project-select">PROJECT</label><div className="modal-project"><div className={`project-avatar ${project.color}`}>{project.initials}</div><select id="project-select" value={project.id} onChange={e => onProject(workspaceProjects.find(p => p.id === e.target.value) ?? workspaceProjects[0])}>{workspaceProjects.map(p => <option key={p.id} value={p.id}>{p.owner}/{p.name}{p.url ? ' · GitHub' : ' · sample'}</option>)}</select><ChevronDown size={15} /></div><div className="modal-notice"><ShieldCheck size={15} /><span>LaunchPilot will show evidence and a plan first. No GitHub changes are made without approval.</span></div><div className="modal-actions"><button className="button-secondary" onClick={onClose}>Cancel</button><button className="button-primary" disabled={!text.trim() || !workspaceProjects.length} onClick={() => onStart(text.trim())}>Create plan <ArrowRight size={15} /></button></div></motion.section></motion.div>
}

export default App
