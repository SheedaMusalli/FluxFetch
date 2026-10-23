import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import AdmZip from 'adm-zip'

interface MediaToolLock {
  records: Array<{ repo: string; version: string; url: string; sha256: string }>
  files: Record<string, string>
}

const mediaToolsDirectory = (): string =>
  app.isPackaged
    ? join(app.getPath('userData'), 'media-tools')
    : join(app.getAppPath(), 'media-tools')

const bundledFfmpegDirectory = (): string =>
  app.isPackaged ? join(process.resourcesPath, 'media-tools-ffmpeg') : mediaToolsDirectory()

let pendingSetup: Promise<string> | null = null

function expectedFiles(lock: MediaToolLock, includeFfmpeg: boolean): Array<[string, string]> {
  return Object.entries(lock.files).filter(([name]) => {
    if (name === 'ffplay.exe' || name === 'ffprobe.exe') return false
    const ffmpegFile =
      name.startsWith('av') ||
      name.startsWith('sw') ||
      name === 'ffmpeg.exe' ||
      name === 'LICENSE.txt'
    return includeFfmpeg || !ffmpegFile
  })
}

async function hasVerifiedFfmpeg(directory: string, lock: MediaToolLock): Promise<boolean> {
  try {
    const files = expectedFiles(lock, true).filter(
      ([name]) =>
        name.startsWith('av') ||
        name.startsWith('sw') ||
        name === 'ffmpeg.exe' ||
        name === 'LICENSE.txt'
    )
    for (const [name, expected] of files) {
      const path = join(directory, name)
      const bytes = await readFile(path)
      // electron-builder adds an Authenticode signature to bundled .exe resources, changing
      // the file hash after the pinned source was verified during packaging.
      if (name !== 'ffmpeg.exe' && createHash('sha256').update(bytes).digest('hex') !== expected)
        return false
      if (name === 'ffmpeg.exe' && bytes.length < 100_000) return false
    }
    return files.length > 0
  } catch {
    return false
  }
}

async function hasVerifiedTools(
  directory: string,
  lock: MediaToolLock,
  includeFfmpeg: boolean
): Promise<boolean> {
  try {
    for (const [name, expected] of expectedFiles(lock, includeFfmpeg)) {
      const bytes = await readFile(join(directory, name))
      if (createHash('sha256').update(bytes).digest('hex') !== expected) return false
    }
    return true
  } catch {
    return false
  }
}

/** Install only the optional tools needed for the selected video action. */
export async function ensureMediaTools(includeFfmpeg = false): Promise<string> {
  // Inspection and downloading share the same directory. Wait before rechecking it, rather
  // than allowing one setup to replace tools while the other is still installing them.
  if (pendingSetup) {
    await pendingSetup
    return ensureMediaTools(includeFfmpeg)
  }
  const operation = (async () => {
    const destination = mediaToolsDirectory()
    const lockPath = join(app.getAppPath(), 'media-tools.lock.json')
    const lock = JSON.parse(await readFile(lockPath, 'utf8')) as MediaToolLock
    if (
      includeFfmpeg &&
      app.isPackaged &&
      (await hasVerifiedFfmpeg(bundledFfmpegDirectory(), lock))
    )
      return bundledFfmpegDirectory()
    if (await hasVerifiedTools(destination, lock, includeFfmpeg)) return destination

    const parent = app.isPackaged ? app.getPath('userData') : app.getAppPath()
    await mkdir(parent, { recursive: true })
    const staging = await mkdtemp(join(parent, `.media-tools-${randomUUID()}-`))
    try {
      const baseToolsAvailable = await hasVerifiedTools(destination, lock, false)
      if (baseToolsAvailable) await cp(destination, staging, { recursive: true })
      const records = lock.records.filter((record) =>
        record.repo === 'yt-dlp/FFmpeg-Builds' ? includeFfmpeg : !baseToolsAvailable
      )
      for (const record of records) {
        const response = await fetch(record.url, { signal: AbortSignal.timeout(180_000) })
        if (!response.ok) throw new Error(`Could not download ${record.repo} (${response.status}).`)
        const bytes = Buffer.from(await response.arrayBuffer())
        const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
        if (digest !== record.sha256)
          throw new Error(`Checksum verification failed for ${record.repo}.`)

        const assetName = new URL(record.url).pathname.split('/').pop() || ''
        if (assetName.toLowerCase().endsWith('.exe')) {
          await writeFile(join(staging, assetName), bytes, { mode: 0o700 })
          continue
        }

        const zip = new AdmZip(bytes)
        for (const entry of zip.getEntries()) {
          if (entry.isDirectory) continue
          const name = entry.entryName.split(/[\\/]/).pop() || ''
          if (
            name === 'ffplay.exe' ||
            name === 'ffprobe.exe' ||
            !/(?:\.exe|\.dll|LICENSE.*|COPYING.*)$/i.test(name)
          )
            continue
          await writeFile(join(staging, name), entry.getData(), { mode: 0o600 })
        }
      }

      const licenseDownloads = [
        {
          file: 'yt-dlp-LICENSE.txt',
          record: lock.records.find((record) => record.repo === 'yt-dlp/yt-dlp'),
          path: 'LICENSE'
        },
        {
          file: 'deno-LICENSE.txt',
          record: lock.records.find((record) => record.repo === 'denoland/deno'),
          path: 'LICENSE.md'
        }
      ]
      for (const license of licenseDownloads) {
        if (!license.record) throw new Error(`The ${license.file} source is missing.`)
        const url = `https://raw.githubusercontent.com/${license.record.repo}/${license.record.version}/${license.path}`
        const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
        if (!response.ok) throw new Error(`Could not download ${license.file}.`)
        await writeFile(join(staging, license.file), Buffer.from(await response.arrayBuffer()))
      }

      // versions.json is generated metadata, not a file in any downloaded tool archive.
      // It must exist before checking the pinned file manifest.
      await writeFile(join(staging, 'versions.json'), JSON.stringify(lock.records, null, 2))
      for (const [name, expected] of expectedFiles(lock, includeFfmpeg)) {
        const bytes = await readFile(join(staging, name))
        if (createHash('sha256').update(bytes).digest('hex') !== expected)
          throw new Error(`Checksum verification failed for ${name}.`)
      }

      await rm(destination, { recursive: true, force: true })
      await rename(staging, destination)
      return destination
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw new Error(
        `Video download tools could not be installed. Check your internet connection and try again. ${error instanceof Error ? error.message : String(error)}`
      )
    }
  })()
  pendingSetup = operation
  try {
    return await operation
  } finally {
    if (pendingSetup === operation) pendingSetup = null
  }
}
