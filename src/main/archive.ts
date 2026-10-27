import AdmZip from 'adm-zip'
import { createExtractorFromData } from 'node-unrar-js'
import { app, shell } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'

export interface ArchiveEntryInfo {
  name: string
  size: number
  directory: boolean
  compressedSize?: number
  time?: number
  crc?: string
  encrypted?: boolean
}

export interface ArchiveTestResult {
  ok: boolean
  totalFiles: number
  totalBytes: number
  errors: string[]
}

async function statArchive(
  filePath: string,
  format: 'ZIP' | 'RAR'
): Promise<Awaited<ReturnType<typeof stat>>> {
  try {
    return await stat(filePath)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(
        `This ${format} file is no longer at its saved location. It may have been moved or deleted; download it again to preview or extract it.`
      )
    }
    throw error
  }
}

function openZip(filePath: string): AdmZip {
  if (!isAbsolute(filePath) || extname(filePath).toLowerCase() !== '.zip')
    throw new Error('Only local ZIP archives can be previewed.')
  return new AdmZip(filePath)
}

function safeArchiveTarget(root: string, name: string): string {
  const cleaned = name.replace(/\\/g, '/')
  const target = resolve(root, cleaned)
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel))
    throw new Error('The archive contains an unsafe file path.')
  return target
}

function get7zPath(): string | null {
  const candidatePaths = [
    app.isPackaged
      ? join(process.resourcesPath, 'archive-tools', '7z.exe')
      : join(app.getAppPath(), 'resources', 'archive-tools', '7z.exe'),
    join(process.cwd(), 'resources', 'archive-tools', '7z.exe'),
    join(process.cwd(), 'node_modules', 'electron-winstaller', 'vendor', '7z-x64.exe'),
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe'
  ]
  for (const p of candidatePaths) {
    if (existsSync(p)) return p
  }
  return null
}

interface Run7zResult {
  code: number
  output: string
}

function run7z(args: string[]): Promise<Run7zResult> {
  const binary = get7zPath()
  if (!binary) throw new Error('7-Zip binary not found')
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let out = ''
    child.stdout.on('data', (d) => {
      out += d.toString()
    })
    child.stderr.on('data', (d) => {
      out += d.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({ code: code ?? 0, output: out })
    })
  })
}

async function extractWith7z(
  archivePath: string,
  destination: string,
  files?: string[],
  password?: string
): Promise<number> {
  const args = ['x', '-y', `-o${destination}`]
  if (password !== undefined && password !== '') {
    args.push(`-p${password}`)
  } else {
    args.push('-p""')
  }
  args.push(archivePath)
  if (files && files.length > 0) {
    args.push(...files)
  }

  const result = await run7z(args)
  if (result.code !== 0) {
    const isWrongPassword =
      /wrong password/i.test(result.output) ||
      /data error in encrypted/i.test(result.output) ||
      /cannot open encrypted/i.test(result.output)
    if (isWrongPassword) {
      if (!password) {
        throw new Error('Password required for protected archive')
      }
      throw new Error('Password incorrect or extraction failed')
    }
    throw new Error(
      `Extraction failed: ${result.output.trim().split('\n').pop() || 'Unknown error'}`
    )
  }

  const filesMatch = result.output.match(/Files:\s*(\d+)/i)
  if (filesMatch) {
    return parseInt(filesMatch[1], 10)
  }
  return files && files.length > 0 ? files.length : 1
}

export async function previewZip(
  filePath: string,
  _password?: string
): Promise<ArchiveEntryInfo[]> {
  // Keep the optional argument for existing IPC callers; preview reads metadata only.
  void _password
  const info = await statArchive(filePath, 'ZIP')
  if (!info.isFile()) throw new Error('Not a valid file.')
  const entries = openZip(filePath).getEntries()
  return entries.map((entry) => ({
    name: entry.entryName,
    size: entry.header.size,
    compressedSize: entry.header.compressedSize,
    directory: entry.isDirectory,
    time: entry.header.time ? new Date(entry.header.time).getTime() : undefined,
    crc:
      entry.header.crc !== undefined
        ? (entry.header.crc >>> 0).toString(16).toUpperCase().padStart(8, '0')
        : undefined,
    encrypted: Boolean(
      (entry.header.flags & 1) !== 0 ||
      entry.header.method === 99 ||
      (entry.header as unknown as { encrypted?: boolean }).encrypted
    )
  }))
}

async function rarFileList(filePath: string, password?: string): Promise<ArchiveEntryInfo[]> {
  const data = await readFile(filePath)
  const extractor = await createExtractorFromData({
    data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
    password
  })
  try {
    const entries = [...extractor.getFileList().fileHeaders]
    return entries.map((entry) => ({
      name: entry.name,
      size: entry.unpSize,
      compressedSize: entry.packSize,
      directory: Boolean(entry.flags.directory),
      time: entry.time ? new Date(entry.time).getTime() : undefined,
      crc:
        entry.crc !== undefined
          ? (entry.crc >>> 0).toString(16).toUpperCase().padStart(8, '0')
          : undefined,
      encrypted: Boolean(entry.flags.encrypted)
    }))
  } finally {
    // The package releases WASM resources when its lazy iterator is consumed to completion.
  }
}

export async function previewArchive(
  filePath: string,
  password?: string
): Promise<ArchiveEntryInfo[]> {
  if (extname(filePath).toLowerCase() === '.rar') {
    if (!isAbsolute(filePath)) throw new Error('Only local RAR archives can be previewed.')
    const info = await statArchive(filePath, 'RAR')
    if (!info.isFile()) throw new Error('Not a valid file.')
    return rarFileList(filePath, password)
  }
  return previewZip(filePath, password)
}

export async function extractArchiveEntries(
  filePath: string,
  names: string[],
  destination: string,
  password?: string
): Promise<number> {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.rar') {
    const info = await statArchive(filePath, 'RAR')
    if (!info.isFile()) throw new Error('Not a valid RAR file.')
    if (!isAbsolute(destination)) throw new Error('Choose an extraction folder.')
    if (get7zPath()) {
      if (names && names.length > 0) {
        for (const name of names) {
          safeArchiveTarget(destination, name)
        }
      }
      await mkdir(destination, { recursive: true })
      return extractWith7z(filePath, destination, names, password)
    }
    const listed = await rarFileList(filePath, password)
    const byName = new Map(listed.map((entry) => [entry.name, entry]))
    const toExtract =
      !names || names.length === 0 ? listed.filter((e) => !e.directory).map((e) => e.name) : names
    if (toExtract.some((name) => !byName.has(name)))
      throw new Error('One or more selected files are not in the RAR.')
    const data = await readFile(filePath)
    const extractor = await createExtractorFromData({
      data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
      password
    })
    const extracted = [...extractor.extract({ files: toExtract, password }).files]
    await mkdir(destination, { recursive: true })
    const root = resolve(destination)
    let count = 0
    for (const item of extracted) {
      const header = item.fileHeader
      if (header.flags.directory) continue
      if (!item.extraction) {
        if (header.flags.encrypted) {
          throw new Error(`Password required or incorrect password for ${header.name}`)
        }
        throw new Error(`Failed to extract ${header.name}`)
      }
      const target = safeArchiveTarget(root, header.name)
      await mkdir(resolve(target, '..'), { recursive: true })
      await writeFile(target, Buffer.from(item.extraction))
      count += 1
    }
    return count
  }
  return extractZipEntries(filePath, names, destination, password)
}

export async function extractZipEntries(
  filePath: string,
  names: string[],
  destination: string,
  password?: string
): Promise<number> {
  const info = await statArchive(filePath, 'ZIP')
  if (!info.isFile()) throw new Error('Not a valid ZIP file.')
  if (!isAbsolute(destination)) throw new Error('Choose an extraction folder.')

  if (get7zPath()) {
    if (names && names.length > 0) {
      for (const name of names) {
        safeArchiveTarget(destination, name)
      }
    }
    await mkdir(destination, { recursive: true })
    return extractWith7z(filePath, destination, names, password)
  }

  const zip = openZip(filePath)
  const allEntries = zip.getEntries()
  const entries =
    !names || names.length === 0
      ? allEntries.filter((e) => !e.isDirectory)
      : (() => {
          const selected = new Set(names)
          return allEntries.filter((entry) => selected.has(entry.entryName))
        })()
  if (names && names.length > 0 && entries.length !== names.length)
    throw new Error('One or more selected files are not in the archive.')
  await mkdir(destination, { recursive: true })
  const root = resolve(destination)
  let extracted = 0
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const target = safeArchiveTarget(root, entry.entryName)
    let data: Buffer
    const isEncrypted = Boolean(
      (entry.header.flags & 1) !== 0 ||
      entry.header.method === 99 ||
      (entry.header as unknown as { encrypted?: boolean }).encrypted
    )
    if (isEncrypted && !password) {
      throw new Error(`Password required for protected file: ${entry.entryName}`)
    }
    try {
      data = password ? entry.getData(password) : entry.getData()
    } catch (err) {
      if (isEncrypted) {
        throw new Error(`Password incorrect or extraction failed for: ${entry.entryName}`)
      }
      throw err
    }
    await mkdir(resolve(target, '..'), { recursive: true })
    await writeFile(target, data)
    extracted += 1
  }
  return extracted
}

export async function testArchive(filePath: string, password?: string): Promise<ArchiveTestResult> {
  if (get7zPath()) {
    const args = ['t', '-y']
    if (password !== undefined && password !== '') {
      args.push(`-p${password}`)
    } else {
      args.push('-p""')
    }
    args.push(filePath)
    const result = await run7z(args)
    const errors: string[] = []
    let totalFiles = 0
    let totalBytes = 0

    const filesMatch = result.output.match(/Files:\s*(\d+)/i)
    if (filesMatch) totalFiles = parseInt(filesMatch[1], 10)
    const sizeMatch = result.output.match(/Size:\s*(\d+)/i)
    if (sizeMatch) totalBytes = parseInt(sizeMatch[1], 10)

    if (result.code !== 0) {
      const isWrongPassword =
        /wrong password/i.test(result.output) ||
        /data error in encrypted/i.test(result.output) ||
        /cannot open encrypted/i.test(result.output)
      if (isWrongPassword) {
        errors.push(password ? 'Password incorrect' : 'Password required for encrypted archive')
      } else {
        errors.push(
          `Archive test failed: ${result.output.trim().split('\n').pop() || 'Integrity error'}`
        )
      }
    }

    return {
      ok: errors.length === 0,
      totalFiles,
      totalBytes,
      errors
    }
  }

  const ext = extname(filePath).toLowerCase()
  const errors: string[] = []
  let totalFiles = 0
  let totalBytes = 0

  try {
    if (ext === '.rar') {
      const data = await readFile(filePath)
      const extractor = await createExtractorFromData({
        data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
        password
      })
      const headers = [...extractor.getFileList().fileHeaders]
      for (const h of headers) {
        if (!h.flags.directory) {
          totalFiles++
          totalBytes += h.unpSize
        }
      }
      const result = extractor.extract({ password })
      for (const f of result.files) {
        if (!f.fileHeader.flags.directory && !f.extraction) {
          if (f.fileHeader.flags.encrypted) {
            errors.push(`Password required or incorrect for ${f.fileHeader.name}`)
          } else {
            errors.push(`CRC or decompression failed for ${f.fileHeader.name}`)
          }
        }
      }
    } else {
      const zip = openZip(filePath)
      const entries = zip.getEntries()
      for (const entry of entries) {
        if (entry.isDirectory) continue
        totalFiles++
        totalBytes += entry.header.size
        const isEncrypted = Boolean(
          (entry.header.flags & 1) !== 0 ||
          entry.header.method === 99 ||
          (entry.header as unknown as { encrypted?: boolean }).encrypted
        )
        if (isEncrypted && !password) {
          errors.push(`Password required for encrypted file ${entry.entryName}`)
          continue
        }
        try {
          const data = password ? entry.getData(password) : entry.getData()
          if (!data && entry.header.size > 0) {
            errors.push(`Corrupted file data in ${entry.entryName}`)
          }
        } catch (err) {
          errors.push(
            `Error reading ${entry.entryName}: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }
    }
  } catch (err) {
    errors.push(`Archive structure error: ${err instanceof Error ? err.message : String(err)}`)
  }

  return {
    ok: errors.length === 0,
    totalFiles,
    totalBytes,
    errors
  }
}

export async function openArchiveEntry(
  filePath: string,
  entryName: string,
  password?: string
): Promise<void> {
  const tempDir = resolve(app.getPath('temp'), 'fluxfetch-archive-preview')
  await mkdir(tempDir, { recursive: true })
  const safeName = basename(entryName)
  const targetPath = resolve(tempDir, `${Date.now()}-${safeName}`)

  if (get7zPath()) {
    const itemExtractDir = resolve(tempDir, `${Date.now()}-extract`)
    await mkdir(itemExtractDir, { recursive: true })
    await extractWith7z(filePath, itemExtractDir, [entryName], password)
    const extractedFile = resolve(itemExtractDir, entryName)
    if (existsSync(extractedFile)) {
      await shell.openPath(extractedFile)
      return
    }
  }

  const ext = extname(filePath).toLowerCase()
  if (ext === '.rar') {
    const data = await readFile(filePath)
    const extractor = await createExtractorFromData({
      data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
      password
    })
    const extracted = [...extractor.extract({ files: [entryName], password }).files]
    const item = extracted[0]
    if (!item || !item.extraction) {
      if (item?.fileHeader.flags.encrypted) {
        throw new Error(`Password required or incorrect for ${entryName}`)
      }
      throw new Error(`Could not extract ${entryName}`)
    }
    await writeFile(targetPath, Buffer.from(item.extraction))
  } else {
    const zip = openZip(filePath)
    const entry = zip.getEntry(entryName)
    if (!entry) throw new Error(`Entry ${entryName} not found in archive`)
    const isEncrypted = Boolean(
      (entry.header.flags & 1) !== 0 ||
      (entry.header as unknown as { encrypted?: boolean }).encrypted
    )
    if (isEncrypted && !password) {
      throw new Error(`Password required for protected file: ${entryName}`)
    }
    let data: Buffer
    try {
      data = password ? entry.getData(password) : entry.getData()
    } catch (err) {
      if (isEncrypted) throw new Error(`Password incorrect for ${entryName}`)
      throw err
    }
    await writeFile(targetPath, data)
  }
  await shell.openPath(targetPath)
}
