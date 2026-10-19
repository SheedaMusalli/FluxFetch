/* Release highlights displayed on the FluxFetch download page. Keep newest releases first. */
;(function (root) {
  'use strict'

  root.FluxFetchChangelog = [
    {
      version: 'v2.0.0',
      items: [
        {
          kind: 'new',
          title: 'Built-in torrents and live progress',
          text: 'Download and seed through libtorrent, inspect files/trackers/peers, and follow normal and torrent progress in the library footer and tray.'
        },
        {
          kind: 'improved',
          title: 'A smaller OmniLink overlay',
          text: 'Steam download detection, expandable network details and automatic discovery of newly connected adapters.'
        },
        {
          kind: 'new',
          title: 'Firefox and Chromium browser packages',
          text: 'Browser capture, direct media and supported YouTube downloads, with full setup instructions and a fixed Windows native messaging helper.'
        },
        {
          kind: 'improved',
          title: 'A themed installation experience',
          text: 'Dark setup, license acceptance, installation options and Update or Fresh install choices. New library status filters and batch history removal.'
        }
      ]
    },
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
          title: 'Queues, archives, and built-in torrent downloads',
          text: 'Schedule URL batches, preview and selectively extract ZIP/RAR files, and download and seed torrents directly in FluxFetch.'
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
