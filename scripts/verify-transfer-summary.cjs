const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const code = ts.transpileModule(fs.readFileSync('src/shared/transfers.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const moduleValue = { exports: {} }
vm.runInNewContext(code, { module: moduleValue, exports: moduleValue.exports })
const { createTransferSummary, transferTrayTooltip, transferPercent } = moduleValue.exports
const normal = {
  id: 'file',
  kind: 'normal',
  name: 'File',
  status: 'downloading',
  totalBytes: 1000,
  downloadedBytes: 500,
  downloadSpeed: 1048576,
  uploadSpeed: 0
}
const torrent = {
  gid: 'torrent',
  name: 'Torrent',
  status: 'active',
  totalBytes: 2000,
  downloadedBytes: 500,
  downloadSpeed: 2097152,
  uploadSpeed: 1024
}
const summary = createTransferSummary([normal], [torrent])
assert.equal(summary.downloadSpeed, 3145728)
assert.equal(summary.uploadSpeed, 1024)
assert.equal(transferPercent(summary.items[0]), 50)
assert.equal(transferPercent(summary.items[1]), 25)
const tooltip = transferTrayTooltip(summary)
assert.match(tooltip, /Normal: 50\.0%.*1\.0 MB\/s/)
assert.match(tooltip, /Torrent: 25\.0%.*2\.0 MB\/s/)
assert.ok(tooltip.length <= 127)
for (const status of ['paused', 'metadata', 'stalled', 'checking', 'error']) {
  const value = createTransferSummary(
    [],
    [{ ...torrent, status, downloadSpeed: 999, uploadSpeed: 888 }]
  )
  assert.equal(value.downloadSpeed, 0)
  assert.equal(value.uploadSpeed, 0)
}
const seeding = createTransferSummary(
  [],
  [{ ...torrent, status: 'seeding', downloadedBytes: 2000 }]
)
assert.equal(seeding.downloadSpeed, 0)
assert.match(transferTrayTooltip(seeding), /Seeding 100%/)
assert.equal(transferPercent({ totalBytes: 0, downloadedBytes: 12 }), null)
assert.match(transferTrayTooltip(createTransferSummary([], [])), /no active downloads/)
console.log(
  'PASS: mixed normal/torrent progress, rates, inactive states, seeding and Windows tooltip bounds.'
)
