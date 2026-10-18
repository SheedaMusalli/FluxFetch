import { HistoryScreen } from './screens/HistoryScreen'
import { rememberDownload } from './history'
import type { DownloadState } from '@shared/types'
import { useEffect, useState } from 'react'
import { TitleBar, type TitleBarStatus } from './components/TitleBar'
import { DownloadConfirmationDialog } from './components/DownloadConfirmationDialog'
import { DownloadQueueDialog } from './components/DownloadQueueDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { SpeedTestDialog } from './components/SpeedTestDialog'
import { NetworkBindingDialog } from './components/NetworkBindingDialog'
import { UpdateDialog } from './components/UpdateDialog'
import { TooltipProvider } from './components/ui/tooltip'
import { useDownloadEvents } from './hooks/useDownloadEvents'
import { useNetworkEvents } from './hooks/useNetworks'
import { CompleteScreen } from './screens/CompleteScreen'
import { DownloadingScreen } from './screens/DownloadingScreen'
import { ErrorScreen } from './screens/ErrorScreen'
import { IdleScreen } from './screens/IdleScreen'
import { NoConnectionsScreen } from './screens/NoConnectionsScreen'
import { useAppStore } from './store/useAppStore'

function assertNever(status: never): never {
  throw new Error(`Unhandled download status: ${String(status)}`)
}

/** One screen + title-bar status per download.status — a switch with an assertNever default so
 * a new DownloadStatus value is a compile error here instead of silently falling into whichever
 * branch happened to be last. */
function renderDownload(
  download: DownloadState,
  handlers: { onNewDownload: () => void; onDownloadAgain: () => void }
): { screen: React.JSX.Element; titleBarStatus: TitleBarStatus } {
  switch (download.status) {
    case 'downloading':
      return {
        screen: <DownloadingScreen download={download} />,
        titleBarStatus: {
          kind: 'combined',
          networkCount: download.networks.filter((network) => network.status === 'on').length
        }
      }
    case 'paused':
      return {
        screen: <DownloadingScreen download={download} />,
        titleBarStatus: {
          kind: 'paused',
          networkCount: download.networks.filter((network) => network.enabled).length
        }
      }
    case 'completed':
      return {
        screen: <CompleteScreen download={download} onNewDownload={handlers.onNewDownload} />,
        titleBarStatus: { kind: 'none' }
      }
    case 'error':
    case 'cancelled':
      return {
        screen: (
          <ErrorScreen
            download={download}
            onNewDownload={handlers.onNewDownload}
            onDownloadAgain={handlers.onDownloadAgain}
          />
        ),
        titleBarStatus: { kind: 'none' }
      }
    default:
      return assertNever(download.status)
  }
}

function App(): React.JSX.Element {
  const downloadWindowId = new URLSearchParams(window.location.search).get('downloadId')
  useDownloadEvents(downloadWindowId)
  useNetworkEvents()
  const [adding, setAdding] = useState(false)
  const [queueCount, setQueueCount] = useState(0)
  const [queueOpen, setQueueOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [speedTestOpen, setSpeedTestOpen] = useState(false)

  useEffect(() => {
    let mounted = true
    void window.plexo.getQueuedDownloads().then((queue) => mounted && setQueueCount(queue.length))
    const unsubscribe = window.plexo.onDownloadQueueChanged((queue) => setQueueCount(queue.length))
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.plexo.onPrepareRetry((url) => {
      useAppStore.getState().setDraftUrl(url)
      setAdding(true)
    })
    return unsubscribe
  }, [])

  const interfaces = useAppStore((store) => store.interfaces)
  const interfacesStatus = useAppStore((store) => store.interfacesStatus)
  const currentDownload = useAppStore((store) => store.currentDownload)
  const peakSpeedBytesPerSec = useAppStore((store) => store.peakSpeedBytesPerSec)
  const clearCurrentDownload = useAppStore((store) => store.clearCurrentDownload)
  const checkForUpdate = useAppStore((store) => store.checkForUpdate)

  useEffect(() => {
    if (downloadWindowId) return
    checkForUpdate()
    const timer = window.setInterval(() => checkForUpdate(), 6 * 60 * 60 * 1000)
    const onFocus = (): void => {
      void checkForUpdate()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [checkForUpdate, downloadWindowId])

  const handleNewDownload = (): void => {
    if (downloadWindowId) {
      void window.plexo.showMainWindow()
      return
    }
    if (currentDownload) void window.plexo.removeDownload(currentDownload.id)
    clearCurrentDownload()
  }

  useEffect(() => {
    if (currentDownload) rememberDownload(currentDownload, peakSpeedBytesPerSec)
  }, [currentDownload, peakSpeedBytesPerSec])

  const noConnections = interfacesStatus === 'ready' && interfaces.length === 0

  let screen: React.JSX.Element
  let titleBarStatus: TitleBarStatus = { kind: 'none' }

  if (downloadWindowId) {
    if (currentDownload?.id === downloadWindowId) {
      ;({ screen, titleBarStatus } = renderDownload(currentDownload, {
        onNewDownload: handleNewDownload,
        onDownloadAgain: () => void window.plexo.showMainWindow(currentDownload.url)
      }))
    } else {
      screen = <div className="p-8 text-sm text-muted-foreground">Opening download…</div>
    }
  } else if (noConnections && adding) {
    screen = <NoConnectionsScreen onBack={() => setAdding(false)} />
    titleBarStatus = { kind: 'offline' }
  } else {
    screen = adding ? (
      <IdleScreen onStarted={() => setAdding(false)} onBack={() => setAdding(false)} />
    ) : (
      <HistoryScreen
        onAdd={() => setAdding(true)}
        onQueue={() => setQueueOpen(true)}
        onSpeedTest={() => setSpeedTestOpen(true)}
        onRunOmniLink={() => window.plexo.runOmniLink()}
        onRetry={(url) => {
          useAppStore.getState().setDraftUrl(url)
          setAdding(true)
        }}
      />
    )
  }

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <TitleBar
          status={titleBarStatus}
          queueCount={queueCount}
          onOpenQueue={() => setQueueOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          libraryWindow={!downloadWindowId}
        />
        <div className="min-h-0 flex-1">{screen}</div>
        {!downloadWindowId && (
          <>
            <UpdateDialog />
            <NetworkBindingDialog />
            <DownloadConfirmationDialog />
            <DownloadQueueDialog open={queueOpen} onOpenChange={setQueueOpen} />
            <SettingsDialog
              open={settingsOpen}
              onOpenChange={setSettingsOpen}
              onOpenQueue={() => setQueueOpen(true)}
            />
            <SpeedTestDialog open={speedTestOpen} onOpenChange={setSpeedTestOpen} />
          </>
        )}
      </div>
    </TooltipProvider>
  )
}

export default App
