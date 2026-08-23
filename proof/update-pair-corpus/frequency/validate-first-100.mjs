#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const registrationBytes = readFileSync(join(root, 'first-100-registration.json'))
const registration = JSON.parse(registrationBytes.toString('utf8'))
const signature = JSON.parse(readFileSync(join(root, 'first-100-registration.signature.json'), 'utf8'))
const publicKey = createPublicKey(readFileSync(join(root, 'first-100-registration-public.pem')))
const ledgerLines = readFileSync(join(root, 'first-100-ledger.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.length > 0)
const ledger = ledgerLines.map((line, index) => {
  try {
    return JSON.parse(line)
  } catch {
    throw new Error(`ledger line ${index + 1} is not valid JSON`)
  }
})

assert.equal(registration.schemaVersion, 'diffwitness-first-100-registration/v1')
assert.equal(registration.state, 'FROZEN_BEFORE_R0')
assert.equal(registration.releaseBoundary.r0Release, null)
assert.equal(registration.releaseBoundary.acceptBeforeR0, false)
assert.equal(registration.sample.targetEligiblePairs, 100)
assert.equal(registration.sample.componentCap, 20)
assert.equal(registration.sample.minimumMaterialRegressions, 3)
assert.equal(registration.sample.stretchMaterialRegressions, 5)
assert.equal(registration.sample.falseCompatibleMaximum, 0)

assert.equal(signature.schemaVersion, 'diffwitness-detached-signature/v1')
assert.equal(signature.registrationId, registration.registrationId)
assert.equal(signature.algorithm, 'Ed25519')
assert.equal(
  signature.registrationSha256,
  createHash('sha256').update(registrationBytes).digest('hex'),
  'registration digest does not bind the exact bytes',
)
assert.equal(
  signature.publicKeyDerSha256,
  createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex'),
  'public-key digest mismatch',
)
assert.ok(
  verify(null, registrationBytes, publicKey, Buffer.from(signature.signatureBase64, 'base64')),
  'registration signature is invalid',
)

assert.equal(ledger.length >= 1, true)
const anchor = ledger[0]
assert.deepEqual(anchor, {
  schemaVersion: 'diffwitness-first-100-ledger/v1',
  kind: 'registration-anchor',
  registrationId: registration.registrationId,
  registrationSha256: signature.registrationSha256,
  pairEntries: 0,
})

const entries = ledger.slice(1)
let previousSequence = 0
let previousReceivedAt = ''
const dedup = new Set()
const includedByComponent = new Map()
let included = 0
let material = 0
let falseCompatible = 0

for (const [index, entry] of entries.entries()) {
  const line = index + 2
  assert.equal(entry.schemaVersion, 'diffwitness-first-100-entry/v1', `line ${line}: schema`)
  assert.equal(entry.kind, 'pair', `line ${line}: kind`)
  assert.equal(entry.registrationId, registration.registrationId, `line ${line}: registration`)
  assert.ok(Number.isSafeInteger(entry.ingestionSequence), `line ${line}: sequence type`)
  assert.ok(entry.ingestionSequence > previousSequence, `line ${line}: sequence order`)
  assert.ok(entry.receivedAt >= previousReceivedAt, `line ${line}: time order`)
  assert.ok(entry.eligibility.decidedAt >= entry.receivedAt, `line ${line}: decision before receipt`)
  previousSequence = entry.ingestionSequence
  previousReceivedAt = entry.receivedAt

  const pairKey = [
    entry.pair.ecosystem,
    entry.pair.componentIdentity,
    entry.pair.currentExactIdentity,
    entry.pair.candidateExactIdentity,
  ].join('\u0000')

  if (entry.eligibility.decision === 'INCLUDED') {
    assert.equal(entry.external, true, `line ${line}: external`)
    assert.equal(entry.optedIn, true, `line ${line}: consent`)
    assert.equal(entry.inspectionStarted, false, `line ${line}: preinspection record`)
    assert.equal(entry.eligibility.reason, 'ELIGIBLE', `line ${line}: eligible reason`)
    assert.equal(entry.pair.realUpdateIntent, true, `line ${line}: update intent`)
    assert.notEqual(entry.pair.currentExactIdentity, entry.pair.candidateExactIdentity, `line ${line}: distinct pair`)
    assert.equal(dedup.has(pairKey), false, `line ${line}: duplicate included pair`)
    dedup.add(pairKey)
    const componentCount = (includedByComponent.get(entry.pair.componentIdentity) ?? 0) + 1
    assert.ok(componentCount <= registration.sample.componentCap, `line ${line}: component cap`)
    includedByComponent.set(entry.pair.componentIdentity, componentCount)
    included += 1
  } else {
    assert.notEqual(entry.eligibility.reason, 'ELIGIBLE', `line ${line}: excluded reason`)
    assert.equal('evaluation' in entry, false, `line ${line}: excluded evaluation`)
  }

  if (entry.evaluation) {
    assert.equal(entry.eligibility.decision, 'INCLUDED', `line ${line}: evaluated exclusion`)
    assert.ok(entry.evaluation.startedAt >= entry.eligibility.decidedAt, `line ${line}: inspected before decision`)
    assert.ok(entry.evaluation.completedAt >= entry.evaluation.startedAt, `line ${line}: completion order`)
    falseCompatible += entry.evaluation.falseCompatible ? 1 : 0
    if (entry.evaluation.materiality.classification === 'MATERIAL') {
      assert.equal(entry.evaluation.materiality.evidenceComplete, true, `line ${line}: material evidence`)
      assert.ok(entry.evaluation.materiality.workflowConsequences.length > 0, `line ${line}: material consequence`)
      material += 1
    }
  }
}

assert.ok(included <= registration.sample.targetEligiblePairs, 'eligible sample exceeds 100')
assert.equal(falseCompatible, 0, 'false-compatible result present')

process.stdout.write(JSON.stringify({
  registrationId: registration.registrationId,
  pairEntries: entries.length,
  included,
  excluded: entries.length - included,
  material,
  falseCompatible,
  frequencyVerdict: included < 100
    ? 'INSUFFICIENT_DISTRIBUTION_VOLUME'
    : material >= registration.sample.minimumMaterialRegressions
      ? 'FREQUENCY_GATE_PASS'
      : 'FREQUENCY_GATE_FAIL',
}, null, 2) + '\n')
