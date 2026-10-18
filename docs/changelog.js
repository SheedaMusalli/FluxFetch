/* Release highlights displayed on the FluxFetch download page. Keep newest releases first. */
;(function (root) {
  'use strict'

  root.FluxFetchChangelog = [
    {
      version: 'v1.0.0',
      items: [
        {
          kind: 'new',
          title: 'Parallel downloads across selected networks',
          text: 'Split supported downloads into streams, use chosen network adapters, resume transfers, and inspect per-network speed and progress.'
        },
        {
          kind: 'new',
          title: 'Browser handoff and download history',
          text: 'Send links from Chrome or Edge, monitor copied URLs, search your download library, refresh expired links, and manage file history.'
        },
        {
          kind: 'new',
          title: 'Queues, archives, and torrent handoff',
          text: 'Schedule URL batches, preview and selectively extract ZIP/RAR files, and send torrent links to a local qBittorrent Web UI.'
        },
        {
          kind: 'new',
          title: 'Speed tests and advanced routing',
          text: 'Test internet or combined-network throughput, limit bandwidth, configure proxies and site authentication, and optionally manage downloads remotely.'
        },
        {
          kind: 'improved',
          title: 'Optional OmniLink helper',
          text: 'Launch a separately packaged Steam multi-interface helper with clear administrator approval and connection status.'
        }
      ]
    }
  ]
})(typeof window !== 'undefined' ? window : module.exports)
