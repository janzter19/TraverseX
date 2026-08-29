import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  Clock3,
  Database,
  DatabaseCheck,
  Check,
  Copy,
  Eye,
  EyeOff,
  FolderOpen,
  Gauge,
  Loader2,
  LogOut,
  Moon,
  Pencil,
  Plus,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  Sun,
  TestTube2,
  Trash2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

type Project = {
  xId: number
  project_key: string
  project_name: string
  firebase_project_id: string
  credential_ref: string
  mysql_host?: string | null
  mysql_port?: number | null
  mysql_database?: string | null
  mysql_username?: string | null
  project_status: string
  last_restart_at?: string | null
}

type Collection = {
  xId: number
  project_xId: number
  project_name: string
  firebase_collection: string
  traverse_status: string
  contract_version: string
  last_event_xId?: number | null
  last_event_change_type?: 'added' | 'modified' | 'removed' | null
  last_event_document_id?: string | null
  last_event_status?: string | null
  last_event_attempt_count?: number | null
  last_event_recorded_at?: string | null
}

type Runtime = {
  project_xId: number
  service_status: string
  firebase_reads: number
  pending_queue: number
  processed_count: number
  retry_count: number
  dead_letter_count: number
  active_collection_count: number
  listener_count: number
  last_heartbeat_at?: string | null
  last_restart_at?: string | null
  last_event_at?: string | null
  last_error_code?: string | null
  last_error_description?: string | null
}

type Dashboard = { projects: Project[]; collections: Collection[]; runtime: Runtime[]; instance_id?: string; csrf_token?: string | null }
type CollectionEvent = {
  xId: number
  firebase_collection: string
  firebase_document_id: string
  firebase_change_type: 'added' | 'modified' | 'removed'
  event_status: string
  attempt_count: number
  error_code?: string | null
  error_description?: string | null
  firebase_event_at?: string | null
  traverse_recorded_at: string
}
type PendingDocument = {
  xId: number
  project_xId: number
  collection_xId?: number | null
  firebase_collection: string
  firebase_document_id: string
  pending_state: string
  attempt_count: number
  error_code?: string | null
  error_description?: string | null
  first_seen_at: string
  updated_at: string
}
type ProjectDraft = Omit<Project, 'xId' | 'project_status'> & { project_status: string; mysql_password: string }
type CollectionDraft = { project_xId: string; firebase_collection: string; traverse_status: string }
type ServiceMetricKey = 'status' | 'pending' | 'reads' | 'processed' | 'listeners' | 'lastEvent' | 'retryCollections' | 'errorCollections'

type ServiceMetricDetails = {
  title: string
  description: string
  value: string | number
  rows: { label: string; value: string | number }[]
  collections?: Collection[]
  listenerTargets?: { name: string; source: string; status: string }[]
}

const emptyProject: ProjectDraft = {
  project_key: '',
  project_name: '',
  firebase_project_id: '',
  credential_ref: '',
  mysql_host: '127.0.0.1',
  mysql_port: 3306,
  mysql_database: '',
  mysql_username: '',
  mysql_password: '',
  project_status: 'ACTIVE',
}

const emptyCollection: CollectionDraft = {
  project_xId: '',
  firebase_collection: '',
  traverse_status: 'ACTIVE',
}

async function request(path: string, options?: RequestInit) {
  const response = await fetch(path, { credentials: 'same-origin', ...options })
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    if (response.url.includes('/admin/login')) window.location.assign('/admin/login')
    throw new Error('session_expired')
  }
  const data = await response.json().catch(() => ({ ok: false, error: 'invalid_server_response' }))
  if (!response.ok || data.ok === false) {
    const detail = typeof data.detail === 'object' && data.detail
      ? [data.detail.code, data.detail.description].filter(Boolean).join(': ')
      : typeof data.detail === 'string' ? data.detail : ''
    throw new Error([data.error ?? `http_${response.status}`, detail].filter(Boolean).join(': '))
  }
  return data
}

function statusVariant(status: string) {
  return status === 'ERROR' || status === 'DEAD_LETTER' || status === 'RETRY'
    ? ('destructive' as const)
    : status === 'RUNNING' || status === 'ACTIVE' || status === 'SUCCESS'
      ? ('secondary' as const)
      : ('outline' as const)
}

function relativeTime(value?: string | null) {
  if (!value) return 'Not recorded'
  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  const timestamp = new Date(normalized).getTime()
  if (Number.isNaN(timestamp)) return 'Unknown'
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function App() {
  const [data, setData] = useState<Dashboard>({ projects: [], collections: [], runtime: [] })
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null)
  const [darkMode, setDarkMode] = useState(() => {
    const saved = window.localStorage.getItem('traversex-theme')
    return saved ? saved === 'dark' : true
  })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [projectDialog, setProjectDialog] = useState(false)
  const [collectionDialog, setCollectionDialog] = useState(false)
  const [testDialog, setTestDialog] = useState(false)
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const [editingCollection, setEditingCollection] = useState<Collection | null>(null)
  const [projectDraft, setProjectDraft] = useState<ProjectDraft>({ ...emptyProject })
  const [collectionDraft, setCollectionDraft] = useState<CollectionDraft>({ ...emptyCollection })
  const [showPassword, setShowPassword] = useState(false)
  const [mysqlTestBusy, setMysqlTestBusy] = useState(false)
  const [mysqlTestResult, setMysqlTestResult] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [testReset, setTestReset] = useState(false)
  const [testResult, setTestResult] = useState('')
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null)
  const [collectionLogDialog, setCollectionLogDialog] = useState(false)
  const [collectionLogCollection, setCollectionLogCollection] = useState<Collection | null>(null)
  const [collectionLogs, setCollectionLogs] = useState<CollectionEvent[]>([])
  const [collectionLogsBusy, setCollectionLogsBusy] = useState(false)
  const [collectionLogsError, setCollectionLogsError] = useState('')
  const [clearLogsDialog, setClearLogsDialog] = useState(false)
  const [clearLogsBusy, setClearLogsBusy] = useState(false)
  const [logoutBusy, setLogoutBusy] = useState(false)
  const [serviceMetricDialog, setServiceMetricDialog] = useState<ServiceMetricKey | null>(null)
  const [pendingDocuments, setPendingDocuments] = useState<PendingDocument[]>([])
  const [pendingDocumentsBusy, setPendingDocumentsBusy] = useState(false)
  const [pendingDocumentsError, setPendingDocumentsError] = useState('')
  const [readEvents, setReadEvents] = useState<CollectionEvent[]>([])
  const [readEventsBusy, setReadEventsBusy] = useState(false)
  const [readEventsError, setReadEventsError] = useState('')

  const load = useCallback(async (silent = false) => {
    if (!silent) setBusy(true)
    try {
      const next = await request('/admin/api/dashboard') as Dashboard
      setData(next)
      setSelectedProjectId((current) => current ?? next.projects[0]?.xId ?? null)
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'dashboard_load_failed' })
    } finally {
      if (!silent) setBusy(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode)
    window.localStorage.setItem('traversex-theme', darkMode ? 'dark' : 'light')
  }, [darkMode])

  async function loadPendingDocuments(projectXId: number) {
    setPendingDocumentsBusy(true)
    setPendingDocumentsError('')
    try {
      const result = await request(`/admin/api/pending-queue?project_xId=${encodeURIComponent(projectXId)}&limit=200`) as { rows?: PendingDocument[] }
      setPendingDocuments(result.rows ?? [])
    } catch (error) {
      setPendingDocuments([])
      setPendingDocumentsError(error instanceof Error ? error.message : 'pending_queue_failed')
    } finally {
      setPendingDocumentsBusy(false)
    }
  }

  async function loadReadEvents(projectXId: number) {
    setReadEventsBusy(true)
    setReadEventsError('')
    try {
      const result = await request(`/admin/api/read-events?project_xId=${encodeURIComponent(projectXId)}&limit=200`) as { rows?: CollectionEvent[] }
      setReadEvents(result.rows ?? [])
    } catch (error) {
      setReadEvents([])
      setReadEventsError(error instanceof Error ? error.message : 'read_events_failed')
    } finally {
      setReadEventsBusy(false)
    }
  }

  function openServiceMetric(metric: ServiceMetricKey) {
    setServiceMetricDialog(metric)
    if (metric === 'pending' && selectedProjectId !== null) {
      void loadPendingDocuments(selectedProjectId)
    } else if (metric === 'reads' && selectedProjectId !== null) {
      void loadReadEvents(selectedProjectId)
    } else {
      setPendingDocuments([])
      setPendingDocumentsError('')
      setReadEvents([])
      setReadEventsError('')
    }
  }

  const selectedProject = data.projects.find((project) => project.xId === selectedProjectId) ?? null
  const selectedCollections = useMemo(
    () => data.collections.filter((collection) => collection.project_xId === selectedProjectId),
    [data.collections, selectedProjectId],
  )
  const selectedRuntime = data.runtime.find((runtime) => runtime.project_xId === selectedProjectId) ?? null
  const latestCollectionEvent = useMemo(
    () => [...selectedCollections]
      .filter((collection) => collection.last_event_recorded_at)
      .sort((left, right) => String(right.last_event_recorded_at).localeCompare(String(left.last_event_recorded_at)))[0] ?? null,
    [selectedCollections],
  )
  const lastEventRecordedAt = latestCollectionEvent?.last_event_recorded_at ?? selectedRuntime?.last_event_at
  const retryCollections = useMemo(
    () => selectedCollections.filter((collection) => collection.last_event_status === 'RETRY' && (collection.last_event_attempt_count ?? 0) > 1),
    [selectedCollections],
  )
  const errorCollections = useMemo(
    () => selectedCollections.filter((collection) => collection.last_event_status === 'ERROR' || collection.last_event_status === 'DEAD_LETTER'),
    [selectedCollections],
  )
  const serviceMetricDetails = useMemo(() => {
    if (!serviceMetricDialog) return null
    const runtime = selectedRuntime
    const lastEvent = latestCollectionEvent
    const listenerTargets = [
      ...selectedCollections.map((collection) => ({
        name: collection.firebase_collection,
        source: 'Registered collection',
        status: collection.traverse_status,
      })),
      ...(selectedCollections.some((collection) => collection.firebase_collection === 'project_test')
        ? []
        : [{ name: 'project_test', source: 'Built-in diagnostics listener', status: 'ACTIVE' }]),
    ]
    const common = [
      { label: 'Project', value: selectedProject?.project_name ?? 'No project selected' },
      { label: 'Project xId', value: selectedProject?.xId ?? '—' },
    ]
    const details: Record<ServiceMetricKey, ServiceMetricDetails> = {
      status: {
        title: 'Service status',
        description: 'Current state reported by the isolated TraverseX worker.',
        value: runtime?.service_status ?? 'NOT_READY',
        rows: [...common, { label: 'Last heartbeat', value: runtime?.last_heartbeat_at ?? 'Not recorded' }, { label: 'Last restart', value: runtime?.last_restart_at ?? 'Not recorded' }, { label: 'Last error', value: runtime?.last_error_code ?? 'None recorded' }, { label: 'Error description', value: runtime?.last_error_description ?? 'No error description recorded.' }],
      },
      pending: {
        title: 'Pending queue',
        description: 'Documents currently waiting for a successful MySQL projection acknowledgement. The table below is read from TraverseX MySQL.',
        value: runtime?.pending_queue ?? 0,
        rows: [],
      },
      reads: {
        title: 'Firebase reads',
        description: 'Document-change notifications received from the PENDING-only Firebase listeners during the current worker run. The table below shows their MySQL-recorded outcomes; acknowledgement-only removals do not create projection events.',
        value: runtime?.firebase_reads ?? 0,
        rows: [],
      },
      processed: {
        title: 'Processed projections',
        description: 'Successful Firebase-to-MySQL projections acknowledged during the current worker run.',
        value: runtime?.processed_count ?? 0,
        rows: [...common, { label: 'Successful projections', value: runtime?.processed_count ?? 0 }, { label: 'Retries', value: runtime?.retry_count ?? 0 }, { label: 'Dead letters', value: runtime?.dead_letter_count ?? 0 }, { label: 'Meaning', value: 'This counter is not increased when a projection fails.' }],
      },
      listeners: {
        title: 'Active listeners',
        description: 'The current value is active Firebase listener subscriptions versus expected listener targets. The list below shows the targets included in that count.',
        value: `${runtime?.listener_count ?? 0}/${runtime?.active_collection_count ?? 0}`,
        rows: [],
        listenerTargets,
      },
      lastEvent: {
        title: 'Last recorded event',
        description: 'Latest collection event cached by TraverseX. Reading this modal performs zero Firebase reads.',
        value: lastEvent?.last_event_xId ? `#${lastEvent.last_event_xId}` : 'Not recorded',
        rows: [...common, { label: 'Collection', value: lastEvent?.firebase_collection ?? 'Not recorded' }, { label: 'Change', value: lastEvent?.last_event_change_type ?? 'Not recorded' }, { label: 'Document', value: lastEvent?.last_event_document_id ?? 'Not recorded' }, { label: 'Status', value: lastEvent?.last_event_status ?? 'Not recorded' }, { label: 'Attempts', value: lastEvent?.last_event_attempt_count ?? 'Not recorded' }, { label: 'Recorded', value: lastEvent?.last_event_recorded_at ?? runtime?.last_event_at ?? 'Not recorded' }, { label: 'Runtime error', value: runtime?.last_error_code ?? 'None recorded' }, { label: 'Error description', value: runtime?.last_error_description ?? 'No error description recorded.' }],
      },
      retryCollections: {
        title: 'Retry collections',
        description: 'Collections whose latest recorded event is RETRY and has already been attempted more than once.',
        value: retryCollections.length,
        rows: [...common, { label: 'Matching collections', value: retryCollections.length }, { label: 'Rule', value: 'Latest event status = RETRY and attempts > 1' }, { label: 'Source', value: 'TraverseX MySQL collection cache; zero Firebase reads' }],
        collections: retryCollections,
      },
      errorCollections: {
        title: 'Error collections',
        description: 'Collections whose latest recorded event is an error or terminal DEAD_LETTER outcome.',
        value: errorCollections.length,
        rows: [...common, { label: 'Matching collections', value: errorCollections.length }, { label: 'Rule', value: 'Latest event status = ERROR or DEAD_LETTER' }, { label: 'Source', value: 'TraverseX MySQL collection cache; zero Firebase reads' }],
        collections: errorCollections,
      },
    }
    return details[serviceMetricDialog]
  }, [errorCollections, latestCollectionEvent, retryCollections, selectedCollections, selectedProject, selectedRuntime, serviceMetricDialog])
  const serviceUnit = `traversex@${data.instance_id ?? selectedProject?.project_key ?? 'project-a'}.service`
  const selectedMysqlTarget = selectedProject
    ? `${selectedProject.mysql_database || 'Database not configured'} · ${selectedProject.mysql_host || 'host unavailable'}${selectedProject.mysql_port ? `:${selectedProject.mysql_port}` : ''}`
    : 'No project database selected'
  const manualCommands = [
    { label: 'Start', command: `sudo systemctl start ${serviceUnit}` },
    { label: 'Stop', command: `sudo systemctl stop ${serviceUnit}` },
    { label: 'Restart', command: `sudo systemctl restart ${serviceUnit}` },
  ]

  async function copyCommand(command: string) {
    try {
      await navigator.clipboard.writeText(command)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = command
      textarea.setAttribute('readonly', '')
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      textarea.remove()
    }
    setCopiedCommand(command)
    window.setTimeout(() => setCopiedCommand((current) => current === command ? null : current), 1600)
  }

  async function submitForm(event: FormEvent<HTMLFormElement>, path: string, success: string, after?: () => void) {
    event.preventDefault()
    setBusy(true)
    setNotice(null)
    try {
      const body = new URLSearchParams()
      new FormData(event.currentTarget).forEach((value, key) => body.append(key, String(value)))
      await request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
      setNotice({ tone: 'success', text: success })
      after?.()
      await load(true)
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'request_failed' })
    } finally {
      setBusy(false)
    }
  }

  async function runTest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setTestResult('')
    try {
      const body = new URLSearchParams()
      new FormData(event.currentTarget).forEach((value, key) => body.append(key, String(value)))
      const result = await request(testReset ? '/admin/test-reset' : '/admin/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
      setTestResult(JSON.stringify(result, null, 2))
      await load(true)
    } catch (error) {
      setTestResult(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'test_failed' }, null, 2))
    } finally {
      setBusy(false)
    }
  }

  async function testMysqlConnection() {
    setMysqlTestBusy(true)
    setMysqlTestResult(null)
    try {
      const body = new URLSearchParams()
      body.set('project_xId', editingProject ? String(editingProject.xId) : '')
      body.set('mysql_host', projectDraft.mysql_host ?? '')
      body.set('mysql_port', String(projectDraft.mysql_port ?? ''))
      body.set('mysql_database', projectDraft.mysql_database ?? '')
      body.set('mysql_username', projectDraft.mysql_username ?? '')
      body.set('mysql_password', projectDraft.mysql_password)
      const result = await request('/admin/projects/test-mysql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
      setMysqlTestResult({ tone: 'success', text: result.message ?? 'MySQL connection successful.' })
    } catch (error) {
      setMysqlTestResult({ tone: 'error', text: error instanceof Error ? error.message : 'mysql_connection_failed' })
    } finally {
      setMysqlTestBusy(false)
    }
  }

  function openProject(project?: Project) {
    setEditingProject(project ?? null)
    setProjectDraft(project ? { ...project, mysql_password: '' } : { ...emptyProject })
    setShowPassword(false)
    setMysqlTestResult(null)
    setProjectDialog(true)
  }

  function openCollection(collection?: Collection) {
    setEditingCollection(collection ?? null)
    setCollectionDraft(collection
      ? {
          project_xId: String(collection.project_xId),
          firebase_collection: collection.firebase_collection,
          traverse_status: collection.traverse_status,
        }
      : { ...emptyCollection, project_xId: selectedProjectId ? String(selectedProjectId) : '' })
    setCollectionDialog(true)
  }

  async function openCollectionLogs(collection: Collection) {
    setCollectionLogCollection(collection)
    setCollectionLogs([])
    setCollectionLogsError('')
    setCollectionLogDialog(true)
    await refreshCollectionLogs(collection)
  }

  async function refreshCollectionLogs(collection: Collection) {
    setCollectionLogsBusy(true)
    setCollectionLogsError('')
    try {
      const result = await request(`/admin/api/collection-logs?collection_xId=${collection.xId}&limit=100`) as { logs: CollectionEvent[] }
      setCollectionLogs(result.logs ?? [])
    } catch (error) {
      setCollectionLogsError(error instanceof Error ? error.message : 'collection_logs_failed')
    } finally {
      setCollectionLogsBusy(false)
    }
  }

  async function clearLogs() {
    if (!data.csrf_token) {
      setNotice({ tone: 'error', text: 'Clear logs is unavailable until the Admin session is refreshed.' })
      return
    }
    setClearLogsBusy(true)
    setNotice(null)
    try {
      const result = await request('/admin/api/clear-logs', {
        method: 'POST',
        headers: { 'X-CSRF-Token': data.csrf_token },
      }) as { cleared?: { collection_events?: number; collection_cache_rows?: number } }
      setClearLogsDialog(false)
      setCollectionLogs([])
      setNotice({
        tone: 'success',
        text: `Cleared ${result.cleared?.collection_events ?? 0} event log(s) and reset ${result.cleared?.collection_cache_rows ?? 0} collection cache row(s).`,
      })
      await load(true)
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'clear_logs_failed' })
    } finally {
      setClearLogsBusy(false)
    }
  }

  async function logout() {
    setLogoutBusy(true)
    try {
      await request('/admin/logout', {
        method: 'POST',
        headers: { 'X-CSRF-Token': data.csrf_token ?? '' },
      })
      window.location.assign('/admin/login')
    } catch (error) {
      setLogoutBusy(false)
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'logout_failed' })
    }
  }

  return (
    <div className="flex h-svh min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <div
        className={cn('fixed inset-x-0 top-0 z-50 h-0.5 origin-left bg-primary transition-transform', busy ? 'scale-x-100' : 'scale-x-0')}
        aria-hidden="true"
      />
      <header className="shrink-0 border-b bg-card/90 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-[1600px] items-center justify-between gap-4 px-4 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
              <Gauge className="size-5" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold tracking-tight text-foreground">TraverseX</p>
              <p className="truncate text-xs text-muted-foreground">Standalone sync control plane</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="hidden gap-1.5 sm:flex"><ShieldCheck className="size-3.5" /> Admin</Badge>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setDarkMode((current) => !current)}
              aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              <span className="sr-only">{darkMode ? 'Switch to light mode' : 'Switch to dark mode'}</span>
              {darkMode ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </Button>
            <Button variant="outline" size="icon" onClick={() => void load()} disabled={busy} aria-label="Refresh dashboard" title="Refresh dashboard">
              <RefreshCw className={cn('size-4', busy && 'animate-spin')} />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => void logout()}
              disabled={busy || logoutBusy}
              aria-label="Log out"
              title="Log out"
            >
              <LogOut className={cn('size-4', logoutBusy && 'animate-pulse')} />
            </Button>
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1600px] space-y-6 px-4 py-6 lg:px-8 lg:py-8">
          <section>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-[0.18em] text-primary">Operations</p>
                <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Dashboard</h1>
                <p className="mt-1 text-sm text-muted-foreground">Register Firebase projects, select monitored collections, and inspect TraverseX health.</p>
              </div>
              {notice && <p role="status" className={cn('max-w-full rounded-md border px-3 py-2 text-sm', notice.tone === 'error' ? 'border-destructive/40 text-destructive' : 'border-emerald-500/40 text-emerald-500')}>{notice.text}</p>}
            </div>
          </section>

          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
              <div>
                <CardTitle className="flex items-center gap-2 text-base"><FolderOpen className="size-4 text-primary" />Active registered projects</CardTitle>
                <CardDescription>Select a project to manage its collection monitor and service.</CardDescription>
              </div>
              <Button size="icon" onClick={() => openProject()} title="Add project"><Plus className="size-4" /></Button>
            </CardHeader>
            <CardContent className="pt-0">
              <div>
                <Table>
                  <TableHeader><TableRow><TableHead>Project</TableHead><TableHead>Firebase</TableHead><TableHead>MySQL target</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {data.projects.length
                      ? data.projects.map((project) => (
                          <TableRow key={project.xId} data-state={selectedProjectId === project.xId ? 'selected' : undefined} className="cursor-pointer" onClick={() => setSelectedProjectId(project.xId)}>
                            <TableCell><div className="font-medium">{project.project_name}</div><div className="text-xs text-muted-foreground">xId {project.xId} · {project.project_key}</div><div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground"><Clock3 className="size-3" />Last restart: {relativeTime(project.last_restart_at)}</div></TableCell>
                            <TableCell><div>{project.firebase_project_id}</div><div className="max-w-64 truncate text-xs text-muted-foreground">{project.credential_ref}</div></TableCell>
                            <TableCell><div>{project.mysql_database || '—'}</div><div className="text-xs text-muted-foreground">{project.mysql_host || '—'}{project.mysql_port ? `:${project.mysql_port}` : ''}</div></TableCell>
                            <TableCell><Badge variant={statusVariant(project.project_status)}>{project.project_status}</Badge></TableCell>
                            <TableCell className="text-right"><Button variant="ghost" size="icon" onClick={(event) => { event.stopPropagation(); openProject(project) }} title={`Edit ${project.project_name}`}><Pencil className="size-4" /></Button></TableCell>
                          </TableRow>
                        ))
                      : <TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground">No registered projects yet.</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {selectedProject
            ? <div className="grid gap-6 xl:grid-cols-12">
                <Card className="min-w-0 xl:col-span-8">
                  <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
                    <div><CardTitle className="flex items-center gap-2 text-base"><Database className="size-4 text-primary" />Collection monitor</CardTitle><CardDescription>{selectedProject.project_name} · monitored Firebase collections.</CardDescription></div>
                    <Button size="icon" onClick={() => openCollection()} title="Add collection monitor"><Plus className="size-4" /></Button>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <div>
                      <Table>
                        <TableHeader><TableRow><TableHead>Collection</TableHead><TableHead>Last change</TableHead><TableHead>Document</TableHead><TableHead>Status</TableHead><TableHead>Attempts</TableHead><TableHead>Recorded</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
                        <TableBody>
                          {selectedCollections.length
                            ? selectedCollections.map((collection) => <TableRow key={collection.xId} className="cursor-pointer" onClick={() => void openCollectionLogs(collection)}><TableCell><div className="font-medium">{collection.firebase_collection}</div><div className="text-xs text-muted-foreground">xId {collection.xId} · click to view activity</div></TableCell><TableCell>{collection.last_event_xId ? <><div className="font-mono text-xs">#{collection.last_event_xId}</div><Badge variant="outline">{collection.last_event_change_type}</Badge></> : <span className="text-muted-foreground">—</span>}</TableCell><TableCell className="max-w-44 truncate font-mono text-xs" title={collection.last_event_document_id ?? undefined}>{collection.last_event_document_id ?? '—'}</TableCell><TableCell><div><Badge variant={statusVariant(collection.traverse_status)}>{collection.traverse_status}</Badge></div>{collection.last_event_status && <div className="mt-1 text-xs text-muted-foreground">Event: {collection.last_event_status}</div>}</TableCell><TableCell className="tabular-nums">{collection.last_event_attempt_count ?? '—'}</TableCell><TableCell className="whitespace-nowrap text-xs text-muted-foreground">{collection.last_event_recorded_at ?? '—'}</TableCell><TableCell className="text-right"><Button variant="ghost" size="icon" onClick={(event) => { event.stopPropagation(); openCollection(collection) }} title={`Edit ${collection.firebase_collection}`}><Pencil className="size-4" /></Button></TableCell></TableRow>)
                            : <TableRow><TableCell colSpan={7} className="h-24 text-center text-muted-foreground">No collections monitored for this project.</TableCell></TableRow>}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                  <CardFooter className="justify-between border-t pt-4 text-xs text-muted-foreground"><span>{selectedCollections.length} collection{selectedCollections.length === 1 ? '' : 's'} monitored</span><span>Firebase is read by the worker.</span></CardFooter>
                </Card>
                <Card className="min-w-0 xl:col-span-4">
                  <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ServerCog className="size-4 text-primary" />Service control</CardTitle><CardDescription>Restart only this isolated TraverseX worker instance.</CardDescription></CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-3">
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <Metric label="Status" value={selectedRuntime?.service_status ?? 'NOT_READY'} onClick={() => openServiceMetric('status')} />
                        <Metric label="Listeners" value={`${selectedRuntime?.listener_count ?? 0}/${selectedRuntime?.active_collection_count ?? 0}`} onClick={() => openServiceMetric('listeners')} />
                        <Metric label="Last event" value={relativeTime(lastEventRecordedAt)} onClick={() => openServiceMetric('lastEvent')} />
                      </div>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <Metric label="Pending" value={selectedRuntime?.pending_queue ?? 0} onClick={() => openServiceMetric('pending')} />
                        <Metric label="Reads" value={selectedRuntime?.firebase_reads ?? 0} onClick={() => openServiceMetric('reads')} />
                        <Metric label="Processed" value={selectedRuntime?.processed_count ?? 0} onClick={() => openServiceMetric('processed')} />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <Metric label="Retry collections" value={retryCollections.length} onClick={() => openServiceMetric('retryCollections')} />
                        <Metric label="Error collections" value={errorCollections.length} onClick={() => openServiceMetric('errorCollections')} />
                      </div>
                    </div>
                    <Separator />
                    <div className="flex items-center justify-between text-xs text-muted-foreground"><span>Retries / dead letters</span><span className="font-medium text-foreground">{selectedRuntime?.retry_count ?? 0} / {selectedRuntime?.dead_letter_count ?? 0}</span></div>
                    {selectedRuntime?.last_error_code && <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs"><p className="font-medium text-destructive">{selectedRuntime.last_error_code}</p><p className="mt-1 text-muted-foreground">{selectedRuntime.last_error_description || 'No description recorded.'}</p></div>}
                    <div className="rounded-md border bg-muted/20 p-3">
                      <p className="text-xs font-medium text-foreground">Manual terminal controls</p>
                      <div className="mt-2 space-y-2">
                        {manualCommands.map(({ label, command }) => {
                          const copied = copiedCommand === command
                          return (
                            <div key={label} className="flex items-center gap-2 rounded-md border bg-background/40 px-2 py-1.5">
                              <span className="w-14 shrink-0 text-[11px] font-medium text-muted-foreground">{label}</span>
                              <code className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={command}>{command}</code>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="size-8 shrink-0"
                                onClick={() => void copyCommand(command)}
                                title={copied ? `${label} command copied` : `Copy ${label.toLowerCase()} command`}
                                aria-label={copied ? `${label} command copied` : `Copy ${label.toLowerCase()} command`}
                              >
                                {copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
                              </Button>
                            </div>
                          )
                        })}
                      </div>
                      <p className="mt-2 text-[11px] text-muted-foreground">Run these commands in a terminal using an account permitted to control this instance.</p>
                    </div>
                  </CardContent>
                  <CardFooter className="flex flex-wrap items-center justify-between gap-2 border-t pt-4"><span className="text-xs text-muted-foreground">Last restart: {relativeTime(selectedRuntime?.last_restart_at)}</span>
                    <Button variant="outline" size="icon" onClick={() => setTestDialog(true)} title="Run projection test"><TestTube2 className="size-4" /></Button>
                  </CardFooter>
                </Card>
              </div>
            : <Card><CardContent className="flex min-h-32 items-center justify-center text-sm text-muted-foreground">Select a registered project to view its collections and service control.</CardContent></Card>}
        </div>
      </main>

      <footer className="shrink-0 border-t bg-card/80"><div className="mx-auto flex h-10 w-full max-w-[1600px] items-center justify-between px-4 text-[11px] text-muted-foreground lg:px-8"><span>TraverseX</span><span>Standalone project-aware worker console</span></div></footer>

      <Dialog open={projectDialog} onOpenChange={setProjectDialog}>
        <DialogContent className="flex max-h-[min(90svh,760px)] max-w-5xl flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 border-b px-6 py-5"><DialogTitle>{editingProject ? 'Edit registered project' : 'Add registered project'}</DialogTitle><DialogDescription>Configure Firebase credentials and the project-specific MySQL target.</DialogDescription></DialogHeader>
          <form id="project-form" className="min-h-0 flex-1 overflow-y-auto px-6 py-5" onSubmit={(event) => void submitForm(event, editingProject ? `/admin/projects/${editingProject.xId}` : '/admin/projects', editingProject ? 'Project updated.' : 'Project registered.', () => setProjectDialog(false))}>
            {editingProject && <input type="hidden" name="project_xId" value={editingProject.xId} />}
            <div className="grid gap-6 lg:grid-cols-2">
              <section className="rounded-lg border bg-muted/10 p-5">
                <div className="mb-5"><h2 className="text-sm font-semibold">Firebase settings</h2><p className="mt-1 text-xs text-muted-foreground">Identity and credential reference for the Firebase project.</p></div>
                <div className="space-y-4">
                  <Field label="Project key" name="project_key" value={projectDraft.project_key} onChange={(value) => setProjectDraft({ ...projectDraft, project_key: value })} required />
                  <Field label="Name" name="project_name" value={projectDraft.project_name} onChange={(value) => setProjectDraft({ ...projectDraft, project_name: value })} required />
                  <Field label="Firebase project ID" name="firebase_project_id" value={projectDraft.firebase_project_id} onChange={(value) => setProjectDraft({ ...projectDraft, firebase_project_id: value })} required />
                  <Field label="Credential reference" name="credential_ref" value={projectDraft.credential_ref} onChange={(value) => setProjectDraft({ ...projectDraft, credential_ref: value })} placeholder="/etc/traversex/firebase/project.json" required />
                </div>
              </section>

              <section className="rounded-lg border bg-muted/10 p-5">
                <div className="mb-5"><h2 className="text-sm font-semibold">MySQL settings</h2><p className="mt-1 text-xs text-muted-foreground">Connection target used for this registered project.</p></div>
                <div className="space-y-4">
                  <Field label="MySQL host" name="mysql_host" value={projectDraft.mysql_host ?? ''} onChange={(value) => setProjectDraft({ ...projectDraft, mysql_host: value })} />
                  <Field label="MySQL port" name="mysql_port" type="number" value={String(projectDraft.mysql_port ?? '')} onChange={(value) => setProjectDraft({ ...projectDraft, mysql_port: Number(value) })} />
                  <Field label="MySQL database" name="mysql_database" value={projectDraft.mysql_database ?? ''} onChange={(value) => setProjectDraft({ ...projectDraft, mysql_database: value })} />
                  <Field label="MySQL username" name="mysql_username" value={projectDraft.mysql_username ?? ''} onChange={(value) => setProjectDraft({ ...projectDraft, mysql_username: value })} />
                  <div className="space-y-2"><Label htmlFor="mysql_password">MySQL password{editingProject && <span className="ml-1 text-xs text-muted-foreground">(leave blank to keep)</span>}</Label><div className="relative"><Input id="mysql_password" name="mysql_password" type={showPassword ? 'text' : 'password'} value={projectDraft.mysql_password} onChange={(event) => { setProjectDraft({ ...projectDraft, mysql_password: event.target.value }); setMysqlTestResult(null) }} required={!editingProject} className="pr-10" /><button type="button" className="absolute right-0 top-0 mt-0 grid size-10 place-items-center border-0 bg-transparent p-0 text-muted-foreground hover:bg-transparent" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide MySQL password' : 'Show password'} title={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button></div></div>
                  <div className="rounded-md border border-dashed bg-background/30 p-3"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-medium">Connection check</p><p className="mt-1 text-xs text-muted-foreground">Test this project-specific MySQL target before saving.</p></div><Button type="button" variant="outline" size="sm" onClick={() => void testMysqlConnection()} disabled={mysqlTestBusy}>{mysqlTestBusy ? <Loader2 className="size-4 animate-spin" /> : <DatabaseCheck className="size-4" />}Test connection</Button></div>{mysqlTestResult && <p role="status" aria-live="polite" className={cn('mt-3 text-xs', mysqlTestResult.tone === 'error' ? 'text-destructive' : 'text-emerald-500')}>{mysqlTestResult.text}</p>}</div>
                </div>
              </section>
            </div>

            <section className="mt-6 rounded-lg border bg-muted/10 p-5"><div className="mb-5"><h2 className="text-sm font-semibold">Project status</h2><p className="mt-1 text-xs text-muted-foreground">Inactive projects are not available for collection monitoring.</p></div><div className="max-w-sm space-y-2"><Label htmlFor="project_status">Status</Label><select id="project_status" name="project_status" value={projectDraft.project_status} onChange={(event) => setProjectDraft({ ...projectDraft, project_status: event.target.value })} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"><option>ACTIVE</option><option>INACTIVE</option></select></div></section>
          </form>
          <DialogFooter className="shrink-0 border-t px-6 py-4"><span className="mr-auto hidden text-xs text-muted-foreground sm:inline">Credentials are encrypted before storage.</span><DialogClose asChild><Button type="button" variant="outline">Cancel</Button></DialogClose><Button type="submit" form="project-form" disabled={busy}>{busy && <Loader2 className="size-4" />}{editingProject ? 'Save changes' : 'Add project'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={collectionDialog} onOpenChange={setCollectionDialog}><DialogContent className="max-w-lg"><DialogHeader><DialogTitle>{editingCollection ? 'Edit collection monitor' : 'Add collection monitor'}</DialogTitle><DialogDescription>Select which Firebase collection TraverseX should monitor for this project.</DialogDescription></DialogHeader><form id="collection-form" className="space-y-4" onSubmit={(event) => void submitForm(event, editingCollection ? `/admin/collections/${editingCollection.xId}` : '/admin/collections', editingCollection ? 'Collection updated.' : 'Collection monitor added.', () => setCollectionDialog(false))}><div className="space-y-2"><Label htmlFor="project_xId">Registered project</Label><select id="project_xId" name="project_xId" value={collectionDraft.project_xId} onChange={(event) => setCollectionDraft({ ...collectionDraft, project_xId: event.target.value })} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" required>{data.projects.map((project) => <option key={project.xId} value={project.xId}>{project.project_name} (xId {project.xId})</option>)}</select></div><Field label="Firebase collection" name="firebase_collection" value={collectionDraft.firebase_collection} onChange={(value) => setCollectionDraft({ ...collectionDraft, firebase_collection: value })} placeholder="project_user" required /><div className="space-y-2"><Label htmlFor="traverse_status">Status</Label><select id="traverse_status" name="traverse_status" value={collectionDraft.traverse_status} onChange={(event) => setCollectionDraft({ ...collectionDraft, traverse_status: event.target.value })} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"><option>ACTIVE</option><option>INACTIVE</option></select></div></form><DialogFooter><DialogClose asChild><Button type="button" variant="outline">Cancel</Button></DialogClose><Button type="submit" form="collection-form" disabled={busy}>{busy && <Loader2 className="size-4" />}{editingCollection ? 'Save changes' : 'Add monitor'}</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={collectionLogDialog} onOpenChange={setCollectionLogDialog}>
        <DialogContent className="flex max-h-[min(90svh,820px)] max-w-7xl flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 border-b px-6 py-5 pr-16">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 space-y-1.5">
                <DialogTitle className="flex items-center gap-2"><Activity className="size-4 text-primary" />Collection activity</DialogTitle>
                <DialogDescription>{collectionLogCollection?.firebase_collection ?? 'Collection'} · MySQL operational log; opening this modal performs zero Firebase reads.</DialogDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-9 shrink-0"
                onClick={() => { if (collectionLogCollection) void refreshCollectionLogs(collectionLogCollection) }}
                disabled={!collectionLogCollection || collectionLogsBusy}
                aria-label="Refresh collection activity"
                title="Refresh collection activity"
              >
                <RefreshCw className={cn('size-4', collectionLogsBusy && 'animate-spin')} />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-9 shrink-0 text-destructive hover:text-destructive"
                onClick={() => setClearLogsDialog(true)}
                disabled={collectionLogsBusy || clearLogsBusy}
                aria-label="Clear all collection logs"
                title="Clear all collection logs"
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
            {collectionLogsBusy
              ? <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading logs…</div>
              : collectionLogsError
                ? <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{collectionLogsError}</div>
                : collectionLogs.length
                  ? <div><Table><TableHeader><TableRow><TableHead>Event ID</TableHead><TableHead>Change</TableHead><TableHead>Document</TableHead><TableHead>Status</TableHead><TableHead>Attempts</TableHead><TableHead>Error</TableHead><TableHead>Firebase event</TableHead><TableHead>Recorded</TableHead></TableRow></TableHeader><TableBody>{collectionLogs.map((event) => <TableRow key={event.xId}><TableCell className="font-mono text-xs">#{event.xId}</TableCell><TableCell><Badge variant="outline">{event.firebase_change_type}</Badge></TableCell><TableCell className="max-w-52 truncate font-mono text-xs" title={event.firebase_document_id}>{event.firebase_document_id}</TableCell><TableCell><Badge variant={statusVariant(event.event_status)}>{event.event_status}</Badge></TableCell><TableCell className="tabular-nums">{event.attempt_count}</TableCell><TableCell className="min-w-56 text-xs"><span className={event.error_code ? 'text-destructive' : 'text-muted-foreground'}>{event.error_code ?? '—'}</span><div className="mt-1 text-muted-foreground">{event.error_description ?? 'No error'}</div></TableCell><TableCell className="whitespace-nowrap text-xs text-muted-foreground">{event.firebase_event_at ?? '—'}</TableCell><TableCell className="whitespace-nowrap text-xs text-muted-foreground">{event.traverse_recorded_at}</TableCell></TableRow>)}</TableBody></Table></div>
                  : <div className="flex min-h-32 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">No activity recorded for this collection.</div>}
          </div>
          <DialogFooter className="shrink-0 border-t px-6 py-4"><span className="mr-auto text-xs text-muted-foreground">Read from TraverseX MySQL only.</span><DialogClose asChild><Button type="button" variant="outline">Close</Button></DialogClose></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={clearLogsDialog} onOpenChange={(open) => { if (!clearLogsBusy) setClearLogsDialog(open) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Trash2 className="size-4 text-destructive" />Clear all collection logs?</DialogTitle>
            <DialogDescription>
              This permanently deletes all rows from <code>traversex_collection_event</code> and clears the latest-event fields in <code>traversex_collection</code>. Firebase documents, projection tables, and pending queue records will not be changed.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            This action cannot be undone. Confirm only if you have already reviewed the current activity logs.
          </div>
          <DialogFooter>
            <DialogClose asChild><Button type="button" variant="outline" disabled={clearLogsBusy}>Cancel</Button></DialogClose>
            <Button type="button" variant="destructive" onClick={() => void clearLogs()} disabled={clearLogsBusy || !data.csrf_token}>
              {clearLogsBusy && <Loader2 className="size-4 animate-spin" />}
              Clear all logs
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={serviceMetricDialog !== null} onOpenChange={(open) => { if (!open) setServiceMetricDialog(null) }}>
        <DialogContent className={cn('max-h-[min(90svh,760px)] max-w-xl overflow-hidden p-0', ['pending', 'reads'].includes(serviceMetricDialog ?? '') && 'max-w-5xl')}>
          {serviceMetricDetails && <>
            <DialogHeader className="border-b px-6 py-5">
              <DialogTitle className="flex items-center gap-2"><Gauge className="size-4 text-primary" />{serviceMetricDetails.title}</DialogTitle>
              <DialogDescription>{serviceMetricDetails.description}</DialogDescription>
            </DialogHeader>
            <div className="max-h-[min(60svh,520px)] overflow-y-auto px-6 py-5">
              <div className="rounded-md border bg-muted/20 p-4">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Current value</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{serviceMetricDetails.value}</p>
              </div>
              {serviceMetricDetails.rows.length > 0 && <dl className="mt-5 divide-y rounded-md border">
                {serviceMetricDetails.rows.map((row) => <div key={row.label} className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4"><dt className="text-xs text-muted-foreground">{row.label}</dt><dd className="break-words text-sm">{row.value}</dd></div>)}
              </dl>}
              {serviceMetricDialog === 'pending' && <div className="mt-5 rounded-md border">
                {pendingDocumentsBusy
                  ? <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading pending documents…</div>
                  : pendingDocumentsError
                    ? <div className="m-4 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{pendingDocumentsError}</div>
                    : pendingDocuments.length
                      ? <Table><TableHeader><TableRow><TableHead>Collection</TableHead><TableHead>Firebase document</TableHead><TableHead>State</TableHead><TableHead>Attempts</TableHead><TableHead>Error</TableHead><TableHead>First seen</TableHead><TableHead>Updated</TableHead></TableRow></TableHeader><TableBody>{pendingDocuments.map((pending) => <TableRow key={pending.xId}><TableCell className="font-medium">{pending.firebase_collection}<span className="mt-1 block text-xs text-muted-foreground">Queue #{pending.xId}</span></TableCell><TableCell className="max-w-56 truncate font-mono text-xs" title={pending.firebase_document_id}>{pending.firebase_document_id}</TableCell><TableCell><Badge variant={statusVariant(pending.pending_state)}>{pending.pending_state}</Badge></TableCell><TableCell className="tabular-nums">{pending.attempt_count}</TableCell><TableCell className="min-w-56 text-xs"><span className={pending.error_code ? 'text-destructive' : 'text-muted-foreground'}>{pending.error_code ?? 'Waiting for retry'}</span><div className="mt-1 text-muted-foreground">{pending.error_description ?? 'No error description'}</div></TableCell><TableCell className="whitespace-nowrap text-xs text-muted-foreground">{pending.first_seen_at}</TableCell><TableCell className="whitespace-nowrap text-xs text-muted-foreground">{pending.updated_at}</TableCell></TableRow>)}</TableBody></Table>
                      : <div className="flex min-h-32 items-center justify-center rounded-md border-dashed text-sm text-muted-foreground">No pending documents.</div>}
              </div>}
              {serviceMetricDialog === 'reads' && <div className="mt-5 rounded-md border">
                {readEventsBusy
                  ? <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading read documents…</div>
                  : readEventsError
                    ? <div className="m-4 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{readEventsError}</div>
                    : readEvents.length
                      ? <Table><TableHeader><TableRow><TableHead>Collection</TableHead><TableHead>Firebase document</TableHead><TableHead>Change</TableHead><TableHead>Outcome</TableHead><TableHead>Attempts</TableHead><TableHead>Error</TableHead><TableHead>Firebase event</TableHead><TableHead>Recorded</TableHead></TableRow></TableHeader><TableBody>{readEvents.map((event) => <TableRow key={event.xId}><TableCell className="font-medium">{event.firebase_collection}<span className="mt-1 block text-xs text-muted-foreground">Event #{event.xId}</span></TableCell><TableCell className="max-w-56 truncate font-mono text-xs" title={event.firebase_document_id}>{event.firebase_document_id}</TableCell><TableCell><Badge variant="outline">{event.firebase_change_type}</Badge></TableCell><TableCell><Badge variant={statusVariant(event.event_status)}>{event.event_status}</Badge></TableCell><TableCell className="tabular-nums">{event.attempt_count}</TableCell><TableCell className="min-w-56 text-xs"><span className={event.error_code ? 'text-destructive' : 'text-muted-foreground'}>{event.error_code ?? 'No error'}</span><div className="mt-1 text-muted-foreground">{event.error_description ?? 'No error description'}</div></TableCell><TableCell className="whitespace-nowrap text-xs text-muted-foreground">{event.firebase_event_at ?? '—'}</TableCell><TableCell className="whitespace-nowrap text-xs text-muted-foreground">{event.traverse_recorded_at}</TableCell></TableRow>)}</TableBody></Table>
                      : <div className="flex min-h-32 items-center justify-center rounded-md border-dashed text-sm text-muted-foreground">No recorded read documents.</div>}
              </div>}
              {serviceMetricDetails.listenerTargets && <div className="mt-5 rounded-md border">
                <Table>
                  <TableHeader><TableRow><TableHead>Listener target</TableHead><TableHead>Source</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {serviceMetricDetails.listenerTargets.map((target) => <TableRow key={target.name}><TableCell className="font-medium">{target.name}</TableCell><TableCell className="text-xs text-muted-foreground">{target.source}</TableCell><TableCell><Badge variant={statusVariant(target.status)}>{target.status}</Badge></TableCell></TableRow>)}
                  </TableBody>
                </Table>
              </div>}
              {serviceMetricDetails.collections && <div className="mt-5 rounded-md border">
                <Table>
                  <TableHeader><TableRow><TableHead>Collection / table</TableHead><TableHead>Event ID</TableHead><TableHead>Status</TableHead><TableHead>Attempts</TableHead><TableHead>Document</TableHead><TableHead>Recorded</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {serviceMetricDetails.collections.length
                      ? serviceMetricDetails.collections.map((collection) => <TableRow key={collection.xId}><TableCell className="font-medium">{collection.firebase_collection}</TableCell><TableCell className="font-mono text-xs">{collection.last_event_xId ? `#${collection.last_event_xId}` : '—'}</TableCell><TableCell><Badge variant={statusVariant(collection.last_event_status ?? 'UNKNOWN')}>{collection.last_event_status ?? 'Not recorded'}</Badge></TableCell><TableCell className="tabular-nums">{collection.last_event_attempt_count ?? '—'}</TableCell><TableCell className="max-w-48 truncate font-mono text-xs" title={collection.last_event_document_id ?? undefined}>{collection.last_event_document_id ?? '—'}</TableCell><TableCell className="whitespace-nowrap text-xs text-muted-foreground">{collection.last_event_recorded_at ?? '—'}</TableCell></TableRow>)
                      : <TableRow><TableCell colSpan={6} className="h-24 text-center text-muted-foreground">No matching collections.</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </div>}
            </div>
            <DialogFooter className="border-t px-6 py-4"><span className="mr-auto text-xs text-muted-foreground">Read from TraverseX MySQL only.</span><DialogClose asChild><Button type="button" variant="outline">Close</Button></DialogClose></DialogFooter>
          </>}
        </DialogContent>
      </Dialog>

      <Dialog open={testDialog} onOpenChange={setTestDialog}><DialogContent className="flex max-h-[min(90svh,760px)] max-w-2xl flex-col gap-0 overflow-hidden p-0"><DialogHeader className="shrink-0 border-b px-6 py-5"><DialogTitle className="flex items-center gap-2"><TestTube2 className="size-4 text-primary" />Projection test</DialogTitle><DialogDescription>This modal stays open so the Firebase acknowledgement and Traverse result can be reviewed.</DialogDescription></DialogHeader><form id="test-form" className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5" onSubmit={(event) => void runTest(event)}><input type="hidden" name="project_key" value={selectedProject?.project_key ?? ''} /><Field label="Test name" name="test_name" defaultValue="TraverseX test" required /><div className="space-y-2"><Label htmlFor="test_message">Message</Label><Textarea id="test_message" name="test_message" defaultValue="Firebase-first projection test" rows={4} /></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={testReset} onChange={(event) => setTestReset(event.target.checked)} /> Reset test table and documents before inserting</label><div className="rounded-md border bg-muted/20 p-3"><div className="flex items-center justify-between gap-3"><div><p className="text-xs font-medium text-foreground">Sample Test</p><p className="mt-1 text-xs text-muted-foreground">Uses the selected project-level database.</p></div><Badge variant="outline">MySQL target</Badge></div><code className="mt-2 block truncate text-xs text-muted-foreground" title={selectedMysqlTarget}>{selectedMysqlTarget}</code></div><div className="space-y-2"><Label htmlFor="test-result">Test Results</Label>{testResult ? <pre id="test-result" className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-4 text-xs leading-relaxed" role="status" aria-live="polite">{testResult}</pre> : <div id="test-result" className="rounded-md border border-dashed bg-muted/20 p-4 text-xs text-muted-foreground" role="status" aria-live="polite">No test result yet. Run the sample test to view the Firebase acknowledgement and Traverse projection status.</div>}</div></form><DialogFooter className="shrink-0 border-t px-6 py-4"><span className="mr-auto text-xs text-muted-foreground">Result remains visible after submit.</span><Button type="submit" form="test-form" disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" />}Run test</Button></DialogFooter></DialogContent></Dialog>
    </div>
  )
}

function Field({ label, name, value, defaultValue, onChange, type = 'text', placeholder, required }: { label: string; name: string; value?: string; defaultValue?: string; onChange?: (value: string) => void; type?: string; placeholder?: string; required?: boolean }) {
  return <div className="space-y-2"><Label htmlFor={name}>{label}</Label><Input id={name} name={name} type={type} value={value} defaultValue={defaultValue} onChange={onChange ? (event) => onChange(event.target.value) : undefined} placeholder={placeholder} required={required} /></div>
}

function Metric({ label, value, onClick }: { label: string; value: string | number; onClick: () => void }) {
  return <button type="button" className="rounded-md border bg-muted/20 p-3 text-left transition-colors hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onClick} aria-label={`View ${label} details`} title={`View ${label} details`}><span className="block text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span><span className="mt-1 block text-lg font-semibold tabular-nums">{value}</span><span className="sr-only">Click to view details</span></button>
}

export default App
