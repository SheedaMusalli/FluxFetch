import { useEffect, useState } from 'react'
import type { TransferSummary } from '@shared/transfers'

export function useTransferSummary(): TransferSummary {
  const [summary, setSummary] = useState<TransferSummary>({
    items: [],
    downloadSpeed: 0,
    uploadSpeed: 0
  })
  useEffect(() => {
    let mounted = true
    let receivedEvent = false
    const unsubscribe = window.fluxfetch.onTransferSummaryUpdated((value) => {
      if (!mounted) return
      receivedEvent = true
      setSummary(value)
    })
    void window.fluxfetch
      .getTransferSummary()
      .then((value) => {
        if (mounted && !receivedEvent) setSummary(value)
      })
      .catch(() => {})
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])
  return summary
}
