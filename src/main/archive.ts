import AdmZip from 'adm-zip'
import { createExtractorFromData } from 'node-unrar-js'
import { readFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
const MAX_ENTRIES = 5000
const MAX_ENTRY_BYTES = 256 * 1024 * 1024

export interface ArchiveEntryInfo {
  name: string
  size: number
  directory: boolean
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

export async function previewZip(filePath: string): Promise<ArchiveEntryInfo[]> {
  const info = await statArchive(filePath, 'ZIP')
  if (!info.isFile() || info.size > MAX_ARCHIVE_BYTES)
    throw new Error('This ZIP is too large to preview safely (maximum 512 MB).')
  const entries = openZip(filePath).getEntries()
  if (entries.length > MAX_ENTRIES) throw new Error('This ZIP contains too many items to preview.')
  return entries.slice(0, MAX_ENTRIES).map((entry) => ({
    name: entry.entryName,
    size: entry.header.size,
    directory: entry.isDirectory
  }))
}

async function rarFileList(filePath: string): Promise<ArchiveEntryInfo[]> {
  const data = await readFile(filePath)
  const extractor = await createExtractorFromData({
    data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  })
  try {
    const entries = [...extractor.getFileList().fileHeaders]
    if (entries.length > MAX_ENTRIES)
      throw new Error('This RAR contains too many items to preview.')
    return entries.slice(0, MAX_ENTRIES).map((entry) => ({
      name: entry.name,
      size: entry.unpSize,
      directory: entry.flags.directory
    }))
  } finally {
    // The package releases WASM resources when its lazy iterator is consumed to completion.
  }
}

export async function previewArchive(filePath: string): Promise<ArchiveEntryInfo[]> {
  if (extname(filePath).toLowerCase() === '.rar') {
    if (!isAbsolute(filePath)) throw new Error('Only local RAR archives can be previewed.')
    const info = await statArchive(filePath, 'RAR')
    if (!info.isFile() || info.size > MAX_ARCHIVE_BYTES)
      throw new Error('This RAR is too large to preview safely (maximum 512 MB).')
    return rarFileList(filePath)
  }
  return previewZip(filePath)
}

export async function extractArchiveEntries(
  filePath: string,
  names: string[],
  destination: string
): Promise<number> {
  if (extname(filePath).toLowerCase() !== '.rar')
    return extractZipEntries(filePath, names, destination)
  const info = await statArchive(filePath, 'RAR')
  if (!info.isFile() || info.size > MAX_ARCHIVE_BYTES)
    throw new Error('This RAR is too large to extract safely (maximum 512 MB).')
  if (!isAbsolute(destination)) throw new Error('Choose an extraction folder.')
  if (!Array.isArray(names) || names.length < 1 || names.length > 500)
    throw new Error('Select between 1 and 500 files to extract.')
  const listed = await rarFileList(filePath)
  const byName = new Map(listed.map((entry) => [entry.name, entry]))
  if (names.some((name) => !byName.has(name)))
    throw new Error('One or more selected files are not in the RAR.')
  const selected = [...new Set(names)].map((name) => byName.get(name)!)
  if (selected.some((entry) => entry.size > MAX_ENTRY_BYTES))
    throw new Error('A selected file exceeds the 256 MB per-file extraction limit.')
  const selectedBytes = selected.reduce(
    (total, entry) => total + (entry.directory ? 0 : entry.size),
    0
  )
  if (selectedBytes > MAX_ARCHIVE_BYTES)
    throw new Error('Selected files exceed the 512 MB extraction limit.')
  const data = await readFile(filePath)
  const extractor = await createExtractorFromData({
    data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  })
  const extracted = [...extractor.extract({ files: selected.map((entry) => entry.name) }).files]
  await mkdir(destination, { recursive: true })
  const root = resolve(destination)
  let count = 0
  for (const item of extracted) {
    const header = item.fileHeader
    if (header.flags.directory || !item.extraction) continue
    if (header.unpSize > MAX_ENTRY_BYTES || item.extraction.byteLength > MAX_ENTRY_BYTES)
      throw new Error('The extracted file exceeded the 256 MB per-file limit.')
    const target = safeArchiveTarget(root, header.name)
    await mkdir(resolve(target, '..'), { recursive: true })
    await writeFile(target, Buffer.from(item.extraction), { flag: 'wx' })
    count += 1
  }
  return count
}

export async function extractZipEntries(
  filePath: string,
  names: string[],
  destination: string
): Promise<number> {
  const info = await statArchive(filePath, 'ZIP')
  if (!info.isFile() || info.size > MAX_ARCHIVE_BYTES)
    throw new Error('This ZIP is too large to extract safely (maximum 512 MB).')
  if (!isAbsolute(destination)) throw new Error('Choose an extraction folder.')
  if (!Array.isArray(names) || names.length < 1 || names.length > 500)
    throw new Error('Select between 1 and 500 files to extract.')

  const zip = openZip(filePath)
  const selected = new Set(names)
  const entries = zip.getEntries().filter((entry) => selected.has(entry.entryName))
  if (entries.length !== selected.size)
    throw new Error('One or more selected files are not in the archive.')
  await mkdir(destination, { recursive: true })
  const root = resolve(destination)
  let extracted = 0
  for (const entry of entries) {
    if (entry.isDirectory) continue
    if (entry.header.size > MAX_ENTRY_BYTES) {
      throw new Error(`“${entry.entryName}” exceeds the 256 MB per-file extraction limit.`)
    }
    const target = safeArchiveTarget(root, entry.entryName)
    const data = entry.getData()
    if (data.length > MAX_ENTRY_BYTES)
      throw new Error('The extracted file exceeded the safe size limit.')
    await mkdir(resolve(target, '..'), { recursive: true })
    await writeFile(target, data, { flag: 'wx' })
    extracted += 1
  }
  return extracted
}
