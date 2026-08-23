#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const corpusRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function read(relativePath) {
  return readFileSync(join(corpusRoot, relativePath))
}

function readText(relativePath) {
  return read(relativePath).toString('utf8')
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function digest(value, algorithm, encoding = 'hex') {
  return createHash(algorithm).update(value).digest(encoding)
}

function canonical(value) {
  if (value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

function parseTsv(relativePath) {
  const lines = readText(relativePath).trimEnd().split('\n')
  const headers = lines[0].split('\t')
  return lines.slice(1).map((line) => {
    const values = line.split('\t')
    assert.equal(values.length, headers.length, `${relativePath}: malformed TSV row`)
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]))
  })
}

function onlyUnique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} must be unique`)
}

function validateReceipt(row, candidate) {
  const receipt = readJson(row.receipt)
  assert.equal(receipt.schemaVersion, 'agent-vigil-upgrade-receipt/v1')
  assert.equal(receipt.runner.image, candidate.runnerImage)
  assert.equal(receipt.runner.network, 'none')
  assert.equal(receipt.runner.filesystem, 'read-only')
  assert.equal(receipt.containment.status, 'PASS')
  assert.equal(receipt.summary.verdict, 'CHANGED')
  assert.equal(receipt.component.name, row.package)
  assert.equal(receipt.current.version, row.old_version)
  assert.equal(receipt.candidate.version, row.new_version)
  assert.equal(String(receipt.summary.changedCapabilities), row.changed_capabilities)
  assert.equal(String(receipt.summary.changedCanaries), row.changed_canaries)
  assert.equal(receipt.receiptHash, `sha256:${row.receipt_hash}`)
  const { receiptHash, ...payload } = receipt
  assert.equal(receiptHash, `sha256:${sha256(canonical(payload))}`)
  return receipt
}

function main() {
  const artifactDir = resolve(process.argv[2] ?? '')
  const outputArg = process.argv[3]
  assert.equal(
    process.argv.length,
    4,
    'usage: node regressions/validate-corpus.mjs <artifact-dir> <output.json>',
  )
  const outputPath = resolve(corpusRoot, outputArg)
  assert.ok(outputPath.startsWith(`${corpusRoot}/`), 'validation output must remain inside corpus')

  const pairsDocument = readJson('pairs.json')
  const proof = readJson('metadata/regression-proof.json')
  const pairs = pairsDocument.pairs
  const downloads = parseTsv('metadata/download-verification.tsv')
  const adapters = parseTsv('metadata/adapter-inventory.tsv')
  const runs = parseTsv('metadata/run-results.tsv')
  const regressions = parseTsv('metadata/regression-results.tsv')

  assert.equal(pairsDocument.schemaVersion, 'agent-vigil-update-pair-corpus/v1')
  assert.equal(pairsDocument.candidate.commit, 'c279c5e77f69f0898787daf4aeb0eea76f80accf')
  assert.equal(
    pairsDocument.candidate.compiledCliSha256,
    '5b11518ad92df19b424f7fe10a80f17648e0476e09f0c2cf3e97337070a72c8f',
  )
  assert.equal(pairs.length, 15)
  onlyUnique(pairs.map((pair) => pair.id), 'pair IDs')
  for (const pair of pairs) {
    assert.ok(pair.old.version && pair.new.version && pair.old.version !== pair.new.version)
    assert.match(pair.old.sha256, /^[0-9a-f]{64}$/)
    assert.match(pair.new.sha256, /^[0-9a-f]{64}$/)
    assert.match(pair.old.npmIntegrity, /^sha512-/)
    assert.match(pair.new.npmIntegrity, /^sha512-/)
    assert.match(pair.old.tarballUrl, /^https:\/\/registry\.npmjs\.org\//)
    assert.match(pair.new.tarballUrl, /^https:\/\/registry\.npmjs\.org\//)
    assert.match(pair.old.sourceCommit, /^[0-9a-f]{40}$/)
    assert.match(pair.new.sourceCommit, /^[0-9a-f]{40}$/)
  }

  assert.equal(downloads.length, 30)
  onlyUnique(downloads.map((row) => row.id), 'download IDs')
  assert.ok(downloads.every((row) => row.registry_sha1_match === 'true'))
  assert.ok(downloads.every((row) => row.registry_sha512_match === 'true'))
  for (const pair of pairs) {
    for (const side of ['old', 'new']) {
      const matches = downloads.filter((row) =>
        row.package === pair.package &&
        row.version === pair[side].version &&
        row.sha256 === pair[side].sha256)
      assert.equal(matches.length, 1, `${pair.id} ${side} download lock mismatch`)
    }
  }
  for (const row of downloads) {
    const bytes = readFileSync(join(artifactDir, `${row.id}.tgz`))
    assert.equal(String(bytes.length), row.bytes, `${row.id} byte length mismatch`)
    assert.equal(digest(bytes, 'sha1'), row.sha1, `${row.id} SHA-1 mismatch`)
    assert.equal(sha256(bytes), row.sha256, `${row.id} SHA-256 mismatch`)
    const pair = pairs.find((candidate) => candidate.package === row.package &&
      (candidate.old.version === row.version || candidate.new.version === row.version))
    assert.ok(pair, `${row.id} has no pair lock`)
    const side = pair.old.version === row.version ? pair.old : pair.new
    assert.equal(`sha512-${digest(bytes, 'sha512', 'base64')}`, side.npmIntegrity)
  }

  assert.equal(adapters.length, 15)
  onlyUnique(adapters.map((row) => row.id), 'adapter IDs')
  const blockedAdapters = adapters.filter((row) => row.current_directory_adapter.startsWith('blocked'))
  assert.equal(blockedAdapters.length, 3)
  assert.deepEqual(blockedAdapters.map((row) => row.id).sort(), ['chrome', 'claude', 'gemini'])

  assert.equal(runs.length, 12)
  onlyUnique(runs.map((row) => row.receipt), 'receipt paths')
  assert.ok(runs.every((row) => row.verdict === 'CHANGED'))
  assert.ok(runs.every((row) => row.containment === 'PASS'))
  const receipts = runs.map((row) => validateReceipt(row, pairsDocument.candidate))
  assert.equal(receipts.filter((receipt) => receipt.summary.verdict === 'SAFE').length, 0)
  assert.equal(receipts.reduce((total, receipt) => total + receipt.canaries.length, 0), 12)
  assert.ok(receipts.every((receipt) => receipt.canaries.every((canary) =>
    canary.changed && canary.comparable && canary.current.stable && canary.candidate.stable)))

  const material = pairs.filter((pair) => pair.materialRegression)
  const reproduced = material.filter((pair) => pair.materialRegression.independentlyReproduced)
  assert.equal(material.length, 4)
  assert.deepEqual(
    material.map((pair) => pair.id).sort(),
    [
      'claude-code-2.1.94-to-2.1.96',
      'codex-0.117.0-to-0.118.0',
      'mcp-inspector-2.1.0-to-2.2.0',
      'supergateway-3.3.0-to-3.4.0',
    ],
  )
  assert.equal(reproduced.length, 3)
  assert.deepEqual(
    reproduced.map((pair) => pair.id).sort(),
    [
      'claude-code-2.1.94-to-2.1.96',
      'mcp-inspector-2.1.0-to-2.2.0',
      'supergateway-3.3.0-to-3.4.0',
    ],
  )

  assert.equal(regressions.length, 4)
  assert.equal(regressions.filter((row) => row.independently_reproduced === 'true').length, 3)
  for (const pair of material) {
    const row = regressions.find((candidate) => candidate.pair_id === pair.id)
    assert.ok(row, `missing regression result for ${pair.id}`)
    assert.equal(
      row.independently_reproduced,
      String(pair.materialRegression.independentlyReproduced),
    )
  }

  assert.equal(proof.schemaVersion, 'agent-vigil-static-regression-proof/v1')
  assert.equal(proof.reproducedMaterialRegressionCountInThisProof, 2)
  assert.equal(
    proof.proofs.claudeBedrockAuthorization.verdict,
    'REPRODUCED_REQUEST_SHAPE_REGRESSION',
  )
  assert.equal(
    proof.proofs.supergatewayConcurrencyRollback.verdict,
    'REPRODUCED_CAUSAL_QUEUE_HANG_STATE',
  )
  assert.ok(Object.values(proof.negativeControls).every((control) =>
    control.byteMutationRejectedByHashLock === true))
  const claudePair = pairs.find((pair) => pair.id === 'claude-code-2.1.94-to-2.1.96')
  const supergatewayPair = pairs.find((pair) => pair.id === 'supergateway-3.3.0-to-3.4.0')
  assert.equal(proof.locks.claudeOld.tarSha256, claudePair.old.sha256)
  assert.equal(proof.locks.claudeNew.tarSha256, claudePair.new.sha256)
  assert.equal(proof.locks.supergatewayOld.tarSha256, supergatewayPair.old.sha256)
  assert.equal(proof.locks.supergatewayNew.tarSha256, supergatewayPair.new.sha256)

  const configNames = readdirSync(join(corpusRoot, 'configs')).filter((name) => name.endsWith('.json'))
  const canaryNames = readdirSync(join(corpusRoot, 'canaries/specs')).filter((name) => name.endsWith('.json'))
  assert.equal(configNames.length, 12)
  assert.equal(canaryNames.length, 12)
  assert.deepEqual(configNames.sort(), canaryNames.sort())
  for (const name of configNames) {
    JSON.parse(readText(`configs/${name}`))
    JSON.parse(readText(`canaries/specs/${name}`))
  }

  const manifest = readText('MANIFEST.md')
  assert.match(manifest, /Three are now independently reproduced/)
  assert.match(manifest, /Codex remains sourced but\s+unreproduced/)
  assert.match(manifest, /provider requests[\s\S]*not executed/i)
  const regressionReadme = readText('regressions/README.md')
  assert.match(regressionReadme, /three independently reproduced material regressions/i)
  assert.match(regressionReadme, /no gateway or MCP process ran/i)

  const authoredPaths = [
    'MANIFEST.md',
    'pairs.json',
    'regressions/README.md',
    'regressions/reproduce-static-regressions.mjs',
    'regressions/validate-corpus.mjs',
    'metadata/regression-proof.json',
    'metadata/regression-results.tsv',
  ]
  const forbiddenLocalUserPrefix = `/${'Users'}/`
  const forbiddenTemporaryPrefix = `/${'tmp'}/`
  for (const path of authoredPaths) {
    const contents = readText(path)
    assert.ok(!contents.includes(forbiddenLocalUserPrefix), `${path} contains a local user path`)
    assert.ok(!contents.includes(forbiddenTemporaryPrefix), `${path} contains a local temporary path`)
  }

  const durableHashPaths = [
    'pairs.json',
    'MANIFEST.md',
    'regressions/README.md',
    'regressions/reproduce-static-regressions.mjs',
    'regressions/validate-corpus.mjs',
    'metadata/download-verification.tsv',
    'metadata/adapter-inventory.tsv',
    'metadata/run-results.tsv',
    'metadata/regression-results.tsv',
    'metadata/regression-proof.json',
  ]
  const result = {
    schemaVersion: 'agent-vigil-corpus-validation/v1',
    asOf: '2026-08-23',
    status: 'PASS',
    candidateCommit: pairsDocument.candidate.commit,
    checks: {
      exactPairs: pairs.length,
      exactTarballsRegistryHashVerified: downloads.length,
      localTarballsRehashedSha1Sha256Sha512: downloads.length,
      currentDirectoryAdapterAcceptedPairs: runs.length,
      currentDirectoryAdapterBlockedPairs: blockedAdapters.length,
      containmentPassReceipts: receipts.length,
      changedReceipts: receipts.filter((receipt) => receipt.summary.verdict === 'CHANGED').length,
      safeReceipts: receipts.filter((receipt) => receipt.summary.verdict === 'SAFE').length,
      materialRegressionRows: material.length,
      independentlyReproducedMaterialRegressions: reproduced.length,
      newHashLockedSemanticProofs: proof.reproducedMaterialRegressionCountInThisProof,
      receiptCanonicalHashesVerified: receipts.length,
      mutationHashControlsPassed: Object.keys(proof.negativeControls).length,
    },
    reproducedPairIds: reproduced.map((pair) => pair.id).sort(),
    unreproducedMaterialPairIds: material
      .filter((pair) => !pair.materialRegression.independentlyReproduced)
      .map((pair) => pair.id)
      .sort(),
    durableFileSha256: Object.fromEntries(
      durableHashPaths.map((path) => [path, sha256(read(path))]),
    ),
    boundary:
      'PASS validates local corpus integrity and the three stated bounded regression proofs; it does not prove live provider behavior, end-to-end gateway behavior, adoption, payment, or revenue.',
  }

  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o644 })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

main()
