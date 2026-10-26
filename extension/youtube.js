;(() => {
  if (chrome.extension.inIncognitoContext || window !== window.top) return

  const host = document.createElement('div')
  host.id = 'fluxfetch-youtube-tools'
  host.style.cssText =
    'all:initial!important;position:fixed!important;z-index:2147483647!important;display:none;'
  const shadow = host.attachShadow({ mode: 'open' })

  shadow.innerHTML = `<style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    [hidden] { display: none !important; }

    :host {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color-scheme: dark;
      -webkit-font-smoothing: antialiased;
    }

    #toggle {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      font: inherit;
      font-size: 11.5px;
      font-weight: 600;
      letter-spacing: 0.01em;
      color: #ffffff;
      background: rgba(18, 22, 34, 0.92);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 9999px;
      padding: 6px 13px;
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(0, 0, 0, 0.25);
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    #toggle:hover {
      background: rgba(30, 36, 56, 0.96);
      border-color: rgba(139, 114, 248, 0.6);
      box-shadow: 0 6px 22px rgba(114, 88, 216, 0.38);
      transform: translateY(-1px);
    }
    #toggle:active {
      transform: translateY(0);
    }
    #toggle .icon {
      display: flex;
      align-items: center;
      justify-content: center;
      color: #a99aff;
    }
    #toggle svg {
      width: 13px;
      height: 13px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2.2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    #panel {
      position: absolute;
      right: 0;
      top: 36px;
      width: 320px;
      max-width: calc(100vw - 24px);
      max-height: 72vh;
      overflow-y: auto;
      overflow-x: hidden;
      background: #141724;
      border: 1px solid rgba(255, 255, 255, 0.11);
      border-radius: 14px;
      box-shadow: 0 20px 48px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(255, 255, 255, 0.05);
      padding: 13px 14px;
      animation: panelIn 0.18s cubic-bezier(0.16, 1, 0.3, 1);
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
    }
    #panel::-webkit-scrollbar { width: 5px; }
    #panel::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.2); border-radius: 4px; }

    @keyframes panelIn {
      from { opacity: 0; transform: translateY(-6px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    .header-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.07);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 7px;
    }
    .brand-icon {
      width: 18px;
      height: 18px;
      border-radius: 5px;
      background: linear-gradient(135deg, #7258d8, #9b72f8);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 2px 6px rgba(114, 88, 216, 0.4);
    }
    .brand-icon svg {
      width: 11px;
      height: 11px;
      stroke: #ffffff;
      fill: none;
      stroke-width: 2.4;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .brand-title {
      font-size: 10.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #a99aff;
    }

    #close {
      background: transparent;
      border: 0;
      color: #8c92a4;
      width: 22px;
      height: 22px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    #close:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #ffffff;
    }

    .video-info {
      margin-bottom: 11px;
    }
    #title {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      font-size: 12.5px;
      font-weight: 600;
      line-height: 1.35;
      color: #f1f3fa;
      word-break: break-word;
    }
    #status {
      font-size: 10.5px;
      color: #8c92a4;
      margin-top: 4px;
      line-height: 1.35;
      word-break: break-word;
    }

    #choices {
      display: flex;
      flex-direction: column;
      gap: 5px;
      margin-bottom: 6px;
    }

    .choice-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 9px;
      padding: 8px 11px;
      color: #e5e8f2;
      font-family: inherit;
      font-size: 12px;
      cursor: pointer;
      text-align: left;
      transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .choice-row:hover:not(:disabled) {
      background: rgba(114, 88, 216, 0.16);
      border-color: rgba(139, 114, 248, 0.45);
      transform: translateX(2px);
    }
    .choice-row:active:not(:disabled) {
      transform: scale(0.99);
    }
    .choice-row:disabled {
      opacity: 0.6;
      cursor: wait;
    }

    .choice-left {
      display: flex;
      align-items: center;
      gap: 9px;
      min-width: 0;
    }
    .quality-badge {
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 2px 6px;
      border-radius: 4px;
      flex-shrink: 0;
    }
    .badge-4k {
      background: rgba(245, 158, 11, 0.22);
      color: #fbbf24;
      border: 1px solid rgba(245, 158, 11, 0.4);
    }
    .badge-hd {
      background: rgba(114, 88, 216, 0.25);
      color: #c4b5fd;
      border: 1px solid rgba(139, 114, 248, 0.45);
    }
    .badge-sd {
      background: rgba(255, 255, 255, 0.08);
      color: #a4a8c1;
      border: 1px solid rgba(255, 255, 255, 0.12);
    }
    .badge-audio {
      background: rgba(86, 216, 189, 0.2);
      color: #56d8bd;
      border: 1px solid rgba(86, 216, 189, 0.4);
    }

    .choice-label {
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: #edf0f8;
    }

    .choice-right {
      display: flex;
      align-items: center;
      gap: 7px;
      flex-shrink: 0;
    }
    .choice-ext {
      font-size: 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #7b8296;
      font-weight: 600;
    }
    .choice-arrow {
      width: 13px;
      height: 13px;
      fill: none;
      stroke: #8c92a4;
      stroke-width: 2.2;
      stroke-linecap: round;
      stroke-linejoin: round;
      transition: stroke 0.15s, transform 0.15s;
    }
    .choice-row:hover:not(:disabled) .choice-arrow {
      stroke: #a99aff;
      transform: translateY(1px);
    }

    .action-btn {
      width: 100%;
      margin-top: 8px;
      padding: 7px 12px;
      font: inherit;
      font-size: 11.5px;
      font-weight: 600;
      border-radius: 8px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.15s ease;
    }
    #retry {
      background: rgba(114, 88, 216, 0.2);
      border: 1px solid rgba(139, 114, 248, 0.45);
      color: #c4b5fd;
    }
    #retry:hover {
      background: rgba(114, 88, 216, 0.35);
      color: #ffffff;
    }
    #cancel {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.35);
      color: #fca5a5;
    }
    #cancel:hover {
      background: rgba(239, 68, 68, 0.25);
      color: #ffffff;
    }

    .privacy-notice {
      margin-top: 8px;
      padding: 8px 10px;
      border-radius: 8px;
      background: rgba(245, 158, 11, 0.1);
      border: 1px solid rgba(245, 158, 11, 0.25);
      font-size: 10px;
      color: #fcd34d;
      line-height: 1.4;
    }
  </style>

  <button id="toggle" aria-expanded="false" title="Download this YouTube video with FluxFetch">
    <span class="icon">
      <svg viewBox="0 0 24 24"><path d="M12 4v12m0 0l-4-4m4 4l4-4M4 18h16" /></svg>
    </span>
    <span>Download this video</span>
  </button>

  <section id="panel" hidden aria-label="YouTube download qualities">
    <div class="header-bar">
      <div class="brand">
        <div class="brand-icon">
          <svg viewBox="0 0 24 24"><path d="M12 3v13m0 0l-4-4m4 4l4-4M4 19h16" /></svg>
        </div>
        <span class="brand-title">FluxFetch</span>
      </div>
      <button id="close" aria-label="Close">✕</button>
    </div>

    <div class="video-info">
      <div id="title">YouTube video</div>
      <div id="status" role="status">Choose video or audio quality to download</div>
    </div>

    <div id="choices"></div>

    <p class="privacy-notice" id="cookie-note" hidden>
      Only for this retry, FluxFetch sends YouTube cookies and this browser's User-Agent to the local app. The app deletes its temporary cookie file when the request ends.
    </p>

    <button id="retry" class="action-btn" hidden>Try again</button>
    <button id="cancel" class="action-btn" hidden>Cancel download</button>
  </section>`

  const $ = (id) => shadow.getElementById(id)
  let url = '',
    job = null,
    enabled = true,
    busy = false,
    stopped = false,
    polling = false,
    generation = 0,
    signature = '',
    pendingChoice = null,
    pendingWithCookies = false

  const send = (message) =>
    chrome.runtime.sendMessage({ ...message, userAgent: navigator.userAgent })

  function currentUrl() {
    try {
      const current = new URL(location.href)
      const id =
        current.pathname === '/watch'
          ? current.searchParams.get('v')
          : /^\/(?:shorts|embed)\/([\w-]{11})/.exec(current.pathname)?.[1]
      return id && /^[\w-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : ''
    } catch {
      return ''
    }
  }

  function extractPageQualities() {
    const currentTitle =
      document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent?.trim() ||
      document.querySelector('meta[name="title"]')?.content ||
      document.querySelector('#movie_player .ytp-title-link')?.textContent?.trim() ||
      document.title.replace(/\s*-\s*YouTube$/, '').trim() ||
      'YouTube video'

    let heights = []
    let hasAudio = true

    try {
      for (const script of document.scripts) {
        const text = script.textContent
        if (text && text.includes('ytInitialPlayerResponse')) {
          const match =
            /ytInitialPlayerResponse\s*=\s*({.+?});/s.exec(text) ||
            /ytInitialPlayerResponse\s*=\s*({.+})/s.exec(text)
          if (match) {
            const data = JSON.parse(match[1])
            const formats = data?.streamingData?.adaptiveFormats || data?.streamingData?.formats
            if (Array.isArray(formats)) {
              heights = [
                ...new Set(
                  formats
                    .filter((f) => f.height && Number.isFinite(f.height))
                    .map((f) => Math.floor(f.height))
                )
              ].sort((a, b) => b - a)
              hasAudio = formats.some((f) => f.mimeType && f.mimeType.startsWith('audio/'))
              if (heights.length > 0) break
            }
          }
        }
      }
    } catch { /* The page has no usable player data yet; show fallback qualities. */ }

    if (heights.length === 0) {
      heights = [1080, 720, 480, 360, 240, 144]
    }

    const choices = heights.map((h) => ({
      id: `h${h}`,
      label: `${h}p · Video + audio`,
      height: h
    }))
    if (hasAudio) {
      choices.push({ id: 'audio', label: 'Audio only · Original format', audioOnly: true })
    }

    return { title: currentTitle, choices }
  }

  function open(value) {
    $('panel').hidden = !value
    $('toggle').setAttribute('aria-expanded', String(value))
  }

  function render() {
    if (!job) return
    $('title').textContent = job.title || 'YouTube video'
    $('status').textContent =
      job.message || 'Choose a quality. Files save to your FluxFetch download folder.'
    $('cancel').hidden = !['loading', 'downloading'].includes(job.state)
    $('retry').hidden = !['error', 'cancelled', 'complete'].includes(job.state)
    $('retry').textContent = job.state === 'complete' ? 'Download another quality' : 'Try again'
    const needsSignIn =
      job.state === 'error' && /sign in|not a bot|cookies-from-browser/i.test(job.message)
    $('cookie-note').hidden = !needsSignIn

    const next = JSON.stringify([job.state, job.choices])
    if (next === signature) return
    signature = next
    $('choices').replaceChildren()

    if (job.state === 'ready' || needsSignIn) {
      for (const choice of job.choices) {
        const button = document.createElement('button')
        button.className = 'choice-row'
        button.type = 'button'

        const left = document.createElement('div')
        left.className = 'choice-left'

        const badge = document.createElement('span')
        badge.className = 'quality-badge'

        const label = document.createElement('span')
        label.className = 'choice-label'

        const right = document.createElement('div')
        right.className = 'choice-right'

        const ext = document.createElement('span')
        ext.className = 'choice-ext'

        const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        arrow.setAttribute('class', 'choice-arrow')
        arrow.setAttribute('viewBox', '0 0 24 24')
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        path.setAttribute('d', 'M12 4v12m0 0l-4-4m4 4l4-4M4 18h16')
        arrow.append(path)

        const isAudio = Boolean(
          choice.audioOnly ||
            choice.id === 'audio' ||
            /audio\s+only|^audio\b/i.test(choice.label || '')
        )
        const parsedHeight =
          Number(choice.height) ||
          (typeof choice.id === 'string' && /^h(\d+)$/.exec(choice.id)
            ? parseInt(choice.id.slice(1), 10)
            : 0) ||
          (typeof choice.label === 'string' && /^(\d+)p/i.exec(choice.label)
            ? parseInt(choice.label, 10)
            : 0)

        if (isAudio) {
          badge.classList.add('badge-audio')
          badge.textContent = 'Audio'
          label.textContent = needsSignIn ? 'Retry Audio with sign-in' : 'Audio Only'
          ext.textContent = 'M4A'
        } else if (parsedHeight >= 2160) {
          badge.classList.add('badge-4k')
          badge.textContent = '4K'
          label.textContent = needsSignIn ? 'Retry 4K with sign-in' : `${parsedHeight}p (4K Ultra HD)`
          ext.textContent = 'MP4'
        } else if (parsedHeight >= 1440) {
          badge.classList.add('badge-4k')
          badge.textContent = '2K'
          label.textContent = needsSignIn ? 'Retry 2K with sign-in' : `${parsedHeight}p (2K QHD)`
          ext.textContent = 'MP4'
        } else if (parsedHeight >= 1080) {
          badge.classList.add('badge-hd')
          badge.textContent = '1080p'
          label.textContent = needsSignIn ? 'Retry 1080p with sign-in' : `${parsedHeight}p (Full HD)`
          ext.textContent = 'MP4'
        } else if (parsedHeight >= 720) {
          badge.classList.add('badge-hd')
          badge.textContent = '720p'
          label.textContent = needsSignIn ? 'Retry 720p with sign-in' : `${parsedHeight}p (HD)`
          ext.textContent = 'MP4'
        } else if (parsedHeight > 0) {
          badge.classList.add('badge-sd')
          badge.textContent = `${parsedHeight}p`
          label.textContent = needsSignIn
            ? `Retry ${parsedHeight}p with sign-in`
            : `${parsedHeight}p (Standard)`
          ext.textContent = 'MP4'
        } else {
          badge.classList.add('badge-sd')
          badge.textContent = 'MP4'
          label.textContent = choice.label || 'Standard Video'
          ext.textContent = 'MP4'
        }

        left.append(badge, label)
        right.append(ext, arrow)
        button.append(left, right)

        button.addEventListener('click', (event) => {
          if (event.isTrusted) void handleChoiceClick(choice.id, needsSignIn)
        })
        $('choices').append(button)
      }
    }
  }

  async function handleChoiceClick(choiceId, withCookies = false) {
    if (!job?.id) {
      pendingChoice = choiceId
      pendingWithCookies = withCookies
      $('status').textContent = 'Connecting to FluxFetch…'
      $('choices')
        .querySelectorAll('button')
        .forEach((btn) => {
          btn.disabled = true
        })
      return
    }
    await request('youtubeDownload', choiceId, withCookies)
  }

  async function request(action, choice, withCookies = false, silent = false) {
    if (busy || !url) return
    busy = true
    const token = generation
    if (!silent) {
      $('status').textContent =
        action === 'youtubeInspect' ? 'Finding available qualities…' : 'Contacting FluxFetch…'
      $('choices')
        .querySelectorAll('button')
        .forEach((button) => {
          button.disabled = true
        })
    }
    try {
      const response = await send({ action, url, id: job?.id, choice, withCookies })
      if (token !== generation) return
      if (!response?.ok)
        throw new Error(
          response?.error || 'FluxFetch is unavailable. Reload the extension and this page.'
        )
      job = response.job
      signature = ''
      render()

      if (pendingChoice && job?.id) {
        const choiceToRun = pendingChoice
        const cookiesToRun = pendingWithCookies
        pendingChoice = null
        pendingWithCookies = false
        busy = false
        return void request('youtubeDownload', choiceToRun, cookiesToRun)
      }
    } catch (error) {
      if (token !== generation) return
      pendingChoice = null
      pendingWithCookies = false
      if (!silent) {
        $('status').textContent = error.message
        if (action === 'youtubeDownload') {
          job = { ...job, state: 'error', message: error.message }
          signature = ''
          render()
        }
        $('retry').hidden = false
      }
    } finally {
      busy = false
      $('choices')
        .querySelectorAll('button')
        .forEach((button) => {
          button.disabled = false
        })
    }
  }

  $('toggle').addEventListener('click', (event) => {
    if (!event.isTrusted) return
    open($('panel').hidden)
    if (!$('panel').hidden && (!job || !job.id)) {
      void request('youtubeInspect')
    }
  })

  $('close').addEventListener('click', (event) => {
    if (event.isTrusted) open(false)
  })
  $('retry').addEventListener('click', (event) => {
    if (event.isTrusted) void request('youtubeInspect')
  })
  $('cancel').addEventListener('click', (event) => {
    if (event.isTrusted) void request('youtubeCancel')
  })
  document.addEventListener('keydown', (event) => {
    if (event.isTrusted && event.key === 'Escape') open(false)
  })

  // Close when clicking outside of the download tools
  document.addEventListener(
    'click',
    (event) => {
      if (!event.isTrusted) return
      if (!host.contains(event.target) && !$('panel').hidden) {
        open(false)
      }
    },
    true
  )

  function position() {
    const next = currentUrl()
    if (next !== url) {
      url = next
      generation++
      signature = ''
      open(false)
      pendingChoice = null
      pendingWithCookies = false
      $('retry').hidden = true
      $('cancel').hidden = true

      // Immediately populate instantaneous page qualities (0ms IDM-style response)
      const instant = extractPageQualities()
      job = {
        id: '',
        url,
        state: 'ready',
        title: instant.title,
        message: 'Choose a quality. Files save to your FluxFetch download folder.',
        choices: instant.choices
      }
      render()

      // Automatically prefetch verified stream qualities in the background immediately
      void request('youtubeInspect', undefined, false, true)
    }

    const player =
      document.querySelector('#movie_player') ||
      document.querySelector('ytd-reel-video-renderer[is-active] video') ||
      document.querySelector('video')
    const rect = player?.getBoundingClientRect()
    const visible =
      enabled &&
      url &&
      rect &&
      rect.width > 120 &&
      rect.height > 80 &&
      rect.bottom > 30 &&
      rect.top < innerHeight - 30

    host.style.setProperty('display', visible ? 'block' : 'none', 'important')
    if (!visible) return

    host.style.setProperty(
      'left',
      `${Math.max(8, Math.min(innerWidth - 170, rect.right - 164))}px`,
      'important'
    )
    host.style.setProperty('top', `${Math.max(8, rect.top + 8)}px`, 'important')

    const parent = document.fullscreenElement || document.documentElement
    if (host.parentElement !== parent) parent.append(host)
  }

  async function tick() {
    if (stopped || polling) return
    position()
    polling = true
    const token = generation
    try {
      const settings = await send({ action: 'youtubeEnabled' })
      if (settings?.ok) enabled = settings.enabled
      position()
      if (
        job &&
        job.id &&
        ['loading', 'downloading'].includes(job.state) &&
        !busy &&
        token === generation
      ) {
        const response = await send({ action: 'youtubeStatus', url, id: job.id })
        if (token === generation) {
          if (!response?.ok) throw new Error(response?.error || 'FluxFetch disconnected')
          job = response.job
          render()
        }
      }
    } catch (error) {
      if (/context invalidated/i.test(error.message)) {
        stopped = true
        host.remove()
        clearInterval(timer)
      } else if (token === generation && job && job.id) {
        job.state = 'error'
        job.message = error.message
        render()
      }
    } finally {
      polling = false
    }
  }

  document.documentElement.append(host)
  const timer = setInterval(() => void tick(), 1000)
  addEventListener('scroll', position, { passive: true })
  addEventListener('resize', position)
  document.addEventListener('yt-navigate-finish', position)
  document.addEventListener('fullscreenchange', position)
  void tick()
})()
