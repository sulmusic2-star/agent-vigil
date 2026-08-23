#!/usr/bin/env node

/**
 * Hash-locked, read-only reproducers for two published update regressions.
 *
 * This program treats npm tarballs as inert byte archives. It does not import,
 * execute, install, or spawn anything from either package. The only modeled
 * behavior is a small, explicit state transition derived from exact published
 * runtime text after all expected hashes and versions have been checked.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

const LOCKS = Object.freeze({
  claudeOld: {
    package: '@anthropic-ai/claude-code',
    version: '2.1.94',
    tarSha256: '14a2aa53b5227d165f629bcad120c13fc09728168445c95e95641d62c4b00382',
    files: {
      'package/package.json': {
        bytes: 1370,
        sha256: '9fe686f624114c3837e0b8d65f132dd202b584e8742796365e5e4d3fc40b1736',
      },
      'package/cli.js': {
        bytes: 13308322,
        sha256: '11fa0f142edee45aa24ad60b071345847da6c8b2372d338037fe8c4fd4469564',
      },
    },
  },
  claudeNew: {
    package: '@anthropic-ai/claude-code',
    version: '2.1.96',
    tarSha256: '46d70278ea9ac6a8f9c0b772a562c7b90be00a11caa9ba006bc99fbc3a88de58',
    files: {
      'package/package.json': {
        bytes: 1370,
        sha256: '90277b47ea9397b5d57917ec9a2036d3cc7168e8be911eead46de951e44a119b',
      },
      'package/cli.js': {
        bytes: 13308470,
        sha256: '62ad81e3eb00df80ac019b607cd4bad36607f665bffc7b4e9e3db7ade492d66e',
      },
    },
  },
  supergatewayOld: {
    package: 'supergateway',
    version: '3.3.0',
    tarSha256: 'd5f56809d24dd39d4f7e7a60cc057943adfc6e312771576698870b730c684fcf',
    files: {
      'package/package.json': {
        bytes: 1570,
        sha256: '386cd0cf2a9aa0411c2a78882452f69e51c7aeea033d97bc7ad8806ba9bf4a88',
      },
      'package/dist/index.js': {
        bytes: 10431,
        sha256: '8242023e1a86afbdd1fce55418485d9858029996b99c9fe42c7e112e575f67b4',
      },
      'package/dist/gateways/stdioToSse.js': {
        bytes: 5719,
        sha256: '9715b00c9fe1030a5125c5f3a068b86fd9f175d37836878ac18d9e842bb50e41',
      },
      'package/dist/lib/stdioProcessPool.js': {
        bytes: 2877,
        sha256: '73b84f7c0de5707aab61e46b2db05990015fa529c60724deb27771842928450a',
      },
    },
  },
  supergatewayNew: {
    package: 'supergateway',
    version: '3.4.0',
    tarSha256: '380005d495afba26c2fc68a51fc315503d73cf8c3f5a709b5fd0cddde8fb5d3b',
    files: {
      'package/package.json': {
        bytes: 1570,
        sha256: 'd1d6973fe578d3561564ea1fa083c2ee0febe0c64a5835480ea2f509a36fbe8c',
      },
      'package/dist/index.js': {
        bytes: 9959,
        sha256: 'cebd02836f72bd5b632ed345ed7ce8a4b39e96d464e69a22aef91688e7a68646',
      },
      'package/dist/gateways/stdioToSse.js': {
        bytes: 5223,
        sha256: '9732171ff2f8e759d5355486c9e6908d57827cfb18dd3e3f58afbf6c3cb81b8c',
      },
    },
  },
})

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function assertSha256(buffer, expected, label) {
  assert.equal(sha256(buffer), expected, `${label} SHA-256 mismatch`)
}

function readTarString(header, start, length) {
  const field = header.subarray(start, start + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8')
}

function readTarOctal(header, start, length) {
  const value = readTarString(header, start, length).trim().replace(/^0+/, '')
  return value === '' ? 0 : Number.parseInt(value, 8)
}

function readTarEntries(tgz, wantedPaths) {
  const tar = gunzipSync(tgz, { maxOutputLength: 256 * 1024 * 1024 })
  const wanted = new Set(wantedPaths)
  const found = new Map()
  let offset = 0

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break

    const name = readTarString(header, 0, 100)
    const prefix = readTarString(header, 345, 155)
    const path = prefix ? `${prefix}/${name}` : name
    const size = readTarOctal(header, 124, 12)
    assert.ok(Number.isSafeInteger(size) && size >= 0, `invalid tar size for ${path}`)
    const bodyStart = offset + 512
    const bodyEnd = bodyStart + size
    assert.ok(bodyEnd <= tar.length, `truncated tar entry ${path}`)

    if (wanted.has(path)) found.set(path, Buffer.from(tar.subarray(bodyStart, bodyEnd)))
    offset = bodyStart + Math.ceil(size / 512) * 512
  }

  for (const path of wanted) assert.ok(found.has(path), `missing locked tar entry ${path}`)
  return found
}

function loadLockedArtifact(path, lock) {
  const tgz = readFileSync(path)
  assertSha256(tgz, lock.tarSha256, `${basename(path)} tarball`)
  const entries = readTarEntries(tgz, Object.keys(lock.files))

  for (const [entryPath, expected] of Object.entries(lock.files)) {
    const entry = entries.get(entryPath)
    assert.equal(entry.length, expected.bytes, `${entryPath} byte length mismatch`)
    assertSha256(entry, expected.sha256, entryPath)
  }

  const metadata = JSON.parse(entries.get('package/package.json').toString('utf8'))
  assert.equal(metadata.name, lock.package, 'package name mismatch')
  assert.equal(metadata.version, lock.version, 'package version mismatch')

  return { metadata, entries }
}

function findClaudeBedrockBuilder(cli) {
  const start = cli.indexOf('if(P==="bedrock")')
  const end = cli.indexOf('if(P==="foundry")', start)
  assert.ok(start >= 0 && end > start, 'Claude Bedrock builder block not found')
  return cli.slice(start, end)
}

function inspectClaudeArtifact(artifact, expectedStyle) {
  const cli = artifact.entries.get('package/cli.js').toString('utf8')
  const builder = findClaudeBedrockBuilder(cli)
  const sdkDeletesAuthorizationOnSkip =
    /if\(this\.skipAuth\)\{\w+\.headers\.delete\("Authorization"\);return\}/.test(cli)
  const sdkPreservesAuthorizationWithAuthToken = /if\(this\.authToken\)return;/.test(cli)
  const awsBearerTokenMarkerPresent = builder.includes('AWS_BEARER_TOKEN_BEDROCK')

  assert.ok(sdkDeletesAuthorizationOnSkip, 'embedded Bedrock SDK skipAuth deletion not found')
  assert.ok(sdkPreservesAuthorizationWithAuthToken, 'embedded Bedrock SDK authToken path not found')
  assert.ok(awsBearerTokenMarkerPresent, 'Bedrock bearer-token branch not found')

  const oldStyle =
    builder.includes('...(G||Z)&&{skipAuth:!0}') &&
    builder.includes('...Z&&{defaultHeaders:{...X.defaultHeaders,Authorization:`Bearer ${Z}`}}') &&
    !builder.includes('apiKey:')
  const newStyle =
    builder.includes('Z=pq_(X.defaultHeaders)') &&
    builder.includes('...G&&!v&&{skipAuth:!0}') &&
    builder.includes('...v&&{apiKey:v.match(/^Bearer (.+)$/i)?.[1]??v') &&
    builder.includes('defaultHeaders:{...Z.rest,Authorization:v}')

  assert.equal(expectedStyle === 'old', oldStyle, 'unexpected old Claude builder signature')
  assert.equal(expectedStyle === 'new', newStyle, 'unexpected new Claude builder signature')

  return {
    style: expectedStyle,
    builderSha256: sha256(Buffer.from(builder)),
    builderBytes: Buffer.byteLength(builder),
    sdkDeletesAuthorizationOnSkip,
    sdkPreservesAuthorizationWithAuthToken,
    awsBearerTokenMarkerPresent,
  }
}

function normalizeHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, value]))
}

function removeAuthorization(headers) {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'authorization') delete headers[key]
  }
}

function findAuthorization(headers) {
  let value
  for (const [key, candidate] of Object.entries(headers)) {
    if (key.toLowerCase() === 'authorization') value = candidate
  }
  return value
}

function modelClaudeRequest(builder, scenario) {
  let headers = normalizeHeaders(scenario.defaultHeaders ?? {})
  let skipAuth = false
  let apiKey

  if (builder.style === 'old') {
    skipAuth = scenario.skipBedrockAuth || Boolean(scenario.awsBearerToken)
    if (scenario.awsBearerToken) {
      headers.Authorization = `Bearer ${scenario.awsBearerToken}`
    }
  } else {
    const customAuthorization = findAuthorization(headers)
    removeAuthorization(headers)
    const authorization = scenario.awsBearerToken
      ? `Bearer ${scenario.awsBearerToken}`
      : scenario.skipBedrockAuth
        ? customAuthorization
        : undefined
    skipAuth = scenario.skipBedrockAuth && !authorization
    if (authorization) {
      apiKey = authorization.match(/^Bearer (.+)$/i)?.[1] ?? authorization
      headers.Authorization = authorization
    } else {
      headers = normalizeHeaders(scenario.defaultHeaders ?? {})
    }
  }

  // Exact relevant semantics of the embedded AnthropicBedrock.prepareRequest:
  // skipAuth deletes Authorization; authToken (created from apiKey) preserves it.
  if (skipAuth) removeAuthorization(headers)
  else if (apiKey) {
    // No-op: the bundled SDK returns early from prepareRequest when authToken exists.
  }

  const authorizationAtTransport = findAuthorization(headers) ?? null
  const signal = skipAuth
    ? 'NO_AUTHORIZATION_AFTER_SKIP'
    : apiKey
      ? 'AUTHORIZED_BEARER_SHAPE'
      : 'SIGV4_CREDENTIAL_PATH'

  return {
    skipAuth,
    apiKeyPresent: Boolean(apiKey),
    authorizationAtTransport,
    signal,
  }
}

function reproduceClaude(oldArtifact, newArtifact) {
  const oldBuilder = inspectClaudeArtifact(oldArtifact, 'old')
  const newBuilder = inspectClaudeArtifact(newArtifact, 'new')
  const scenarios = [
    {
      id: 'aws-bearer-token',
      input: { awsBearerToken: 'inert-token', skipBedrockAuth: false, defaultHeaders: {} },
    },
    {
      id: 'skip-auth-with-custom-authorization',
      input: {
        awsBearerToken: null,
        skipBedrockAuth: true,
        defaultHeaders: { authorization: 'Bearer inert-custom-token', 'x-fixture': '1' },
      },
    },
  ].map(({ id, input }) => ({
    id,
    old: modelClaudeRequest(oldBuilder, input),
    new: modelClaudeRequest(newBuilder, input),
  }))

  for (const scenario of scenarios) {
    assert.equal(
      scenario.old.signal,
      'NO_AUTHORIZATION_AFTER_SKIP',
      `${scenario.id}: old must be red`,
    )
    assert.equal(
      scenario.new.signal,
      'AUTHORIZED_BEARER_SHAPE',
      `${scenario.id}: new must be green`,
    )
  }

  const controls = {
    sharedMarkerCannotDistinguishVersions: {
      old: oldBuilder.awsBearerTokenMarkerPresent,
      new: newBuilder.awsBearerTokenMarkerPresent,
    },
    oldCredentialChainDoesNotFalsePositive: modelClaudeRequest(oldBuilder, {
      awsBearerToken: null,
      skipBedrockAuth: false,
      defaultHeaders: {},
    }),
    newExplicitNoAuthRemainsNoAuth: modelClaudeRequest(newBuilder, {
      awsBearerToken: null,
      skipBedrockAuth: true,
      defaultHeaders: {},
    }),
  }
  assert.deepEqual(controls.sharedMarkerCannotDistinguishVersions, { old: true, new: true })
  assert.equal(controls.oldCredentialChainDoesNotFalsePositive.skipAuth, false)
  assert.equal(controls.oldCredentialChainDoesNotFalsePositive.signal, 'SIGV4_CREDENTIAL_PATH')
  assert.equal(controls.newExplicitNoAuthRemainsNoAuth.skipAuth, true)
  assert.equal(controls.newExplicitNoAuthRemainsNoAuth.apiKeyPresent, false)
  assert.equal(controls.newExplicitNoAuthRemainsNoAuth.signal, 'NO_AUTHORIZATION_AFTER_SKIP')

  return {
    verdict: 'REPRODUCED_REQUEST_SHAPE_REGRESSION',
    oldVersion: oldArtifact.metadata.version,
    newVersion: newArtifact.metadata.version,
    oldBuilder,
    newBuilder,
    scenarios,
    controls,
    boundary:
      'Exact bundled builder and embedded SDK semantics reproduced with inert inputs; no Bedrock request was sent and the remote HTTP 403 response itself was not replayed.',
  }
}

function inspectSupergatewayOld(artifact) {
  const index = artifact.entries.get('package/dist/index.js').toString('utf8')
  const gateway = artifact.entries.get('package/dist/gateways/stdioToSse.js').toString('utf8')
  const pool = artifact.entries.get('package/dist/lib/stdioProcessPool.js').toString('utf8')
  const maxOption = index.match(/\.option\('maxConcurrency',[\s\S]*?default:\s*(\d+),[\s\S]*?\}\)/)
  assert.ok(maxOption, '3.3 maxConcurrency default not found')
  const defaultMaxConcurrency = Number(maxOption[1])

  const acquireOffset = gateway.indexOf('child = await pool.acquire()')
  const transportOffset = gateway.indexOf('const sseTransport = new SSEServerTransport', acquireOffset)
  const releaseOffset = gateway.indexOf("req.on('close'", transportOffset)
  const poolReleaseOffset = gateway.indexOf('pool.release(child)', releaseOffset)
  assert.ok(acquireOffset >= 0 && transportOffset > acquireOffset, 'acquire must gate transport creation')
  assert.ok(releaseOffset > transportOffset && poolReleaseOffset > releaseOffset, 'release must follow close')
  assert.ok(pool.includes('return new Promise((resolve) => {'), 'queued promise not found')
  assert.ok(pool.includes('this.queue.push(() => {'), 'queue insertion not found')
  assert.ok(!pool.slice(pool.indexOf('async acquire()'), pool.indexOf('release(child)')).includes('setTimeout'), 'unexpected acquire timeout')
  assert.ok(!pool.slice(pool.indexOf('async acquire()'), pool.indexOf('release(child)')).includes('reject('), 'unexpected acquire rejection')

  return {
    topology: 'per-session-bounded-pool',
    defaultMaxConcurrency,
    acquireBeforeTransport: true,
    releaseOnlyAfterConnectionClose: true,
    queuedAcquireTimeout: false,
    queuedAcquireReject: false,
  }
}

function inspectSupergatewayNew(artifact) {
  const index = artifact.entries.get('package/dist/index.js').toString('utf8')
  const gateway = artifact.entries.get('package/dist/gateways/stdioToSse.js').toString('utf8')
  assert.ok(!index.includes(".option('maxConcurrency'"), '3.4 unexpectedly retains maxConcurrency CLI gate')
  assert.ok(!gateway.includes('pool.acquire()'), '3.4 unexpectedly retains pool acquisition')
  assert.ok(!gateway.includes('StdioChildProcessPool'), '3.4 unexpectedly retains process pool')
  assert.ok(gateway.includes('const child = spawn(stdioCmd, { shell: true });'), '3.4 shared child not found')
  assert.ok(gateway.includes('const sseTransport = new SSEServerTransport'), '3.4 SSE transport construction not found')
  assert.ok(gateway.includes('await server.connect(sseTransport);'), '3.4 transport connection not found')
  return {
    topology: 'shared-child-no-acquire-barrier',
    acquireBeforeTransport: false,
    perSessionLease: false,
  }
}

function modelSessionEstablishment({ topology, capacity, events }) {
  let activeLeases = 0
  const queue = []
  const states = {}

  for (const event of events) {
    if (event.type === 'open') {
      if (topology === 'shared-child-no-acquire-barrier') {
        states[event.session] = 'reaches-transport-without-pool-barrier'
      } else if (activeLeases < capacity) {
        activeLeases += 1
        states[event.session] = 'holds-lease-reaches-transport'
      } else {
        queue.push(event.session)
        states[event.session] = 'queued-before-transport-without-timeout'
      }
    } else if (event.type === 'close') {
      if (states[event.session] === 'holds-lease-reaches-transport') activeLeases -= 1
      states[event.session] = 'closed'
      const next = queue.shift()
      if (next) {
        activeLeases += 1
        states[next] = 'holds-lease-reaches-transport'
      }
    } else {
      assert.fail(`unknown scheduler event ${event.type}`)
    }
  }

  return { states, activeLeases, queueDepth: queue.length }
}

function reproduceSupergateway(oldArtifact, newArtifact) {
  const oldTopology = inspectSupergatewayOld(oldArtifact)
  const newTopology = inspectSupergatewayNew(newArtifact)
  const twoLongLivedConnections = [
    { type: 'open', session: 'idle-preflight' },
    { type: 'open', session: 'real-client' },
  ]
  const oldResult = modelSessionEstablishment({
    topology: oldTopology.topology,
    capacity: oldTopology.defaultMaxConcurrency,
    events: twoLongLivedConnections,
  })
  const newResult = modelSessionEstablishment({
    topology: newTopology.topology,
    capacity: Infinity,
    events: twoLongLivedConnections,
  })

  assert.equal(oldResult.states['idle-preflight'], 'holds-lease-reaches-transport')
  assert.equal(oldResult.states['real-client'], 'queued-before-transport-without-timeout')
  assert.equal(oldResult.queueDepth, 1)
  assert.equal(newResult.states['idle-preflight'], 'reaches-transport-without-pool-barrier')
  assert.equal(newResult.states['real-client'], 'reaches-transport-without-pool-barrier')
  assert.equal(newResult.queueDepth, 0)

  const controls = {
    oneConnection: modelSessionEstablishment({
      topology: oldTopology.topology,
      capacity: oldTopology.defaultMaxConcurrency,
      events: [{ type: 'open', session: 'only-client' }],
    }),
    closeBeforeSecond: modelSessionEstablishment({
      topology: oldTopology.topology,
      capacity: oldTopology.defaultMaxConcurrency,
      events: [
        { type: 'open', session: 'first-client' },
        { type: 'close', session: 'first-client' },
        { type: 'open', session: 'second-client' },
      ],
    }),
    capacityTwo: modelSessionEstablishment({
      topology: oldTopology.topology,
      capacity: 2,
      events: twoLongLivedConnections,
    }),
  }
  assert.equal(controls.oneConnection.queueDepth, 0)
  assert.equal(controls.closeBeforeSecond.queueDepth, 0)
  assert.equal(controls.closeBeforeSecond.states['second-client'], 'holds-lease-reaches-transport')
  assert.equal(controls.capacityTwo.queueDepth, 0)
  assert.equal(controls.capacityTwo.states['real-client'], 'holds-lease-reaches-transport')

  return {
    verdict: 'REPRODUCED_CAUSAL_QUEUE_HANG_STATE',
    oldVersion: oldArtifact.metadata.version,
    newVersion: newArtifact.metadata.version,
    oldTopology,
    newTopology,
    scenario: { events: twoLongLivedConnections, old: oldResult, new: newResult },
    controls,
    boundary:
      'Exact published runtime topology plus a trusted deterministic scheduler reproduced the default-one queued-before-transport-without-timeout state; 3.4 was only shown to remove that pool barrier. No gateway, child process, socket, server, browser, or MCP client was executed.',
  }
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    assert.ok(key?.startsWith('--') && value, `invalid argument near ${key ?? '<end>'}`)
    options[key.slice(2)] = value
  }
  for (const required of ['artifact-dir', 'output']) {
    assert.ok(options[required], `missing --${required}`)
  }
  return options
}

function mutationControl(path, expectedSha256) {
  const original = readFileSync(path)
  const mutated = Buffer.from(original)
  mutated[mutated.length - 1] ^= 1
  let rejected = false
  try {
    assertSha256(mutated, expectedSha256, 'mutated control')
  } catch (error) {
    assert.match(error.message, /SHA-256 mismatch/)
    rejected = true
  }
  assert.equal(rejected, true, 'one-byte mutation was not rejected')
  return { byteMutationRejectedByHashLock: rejected }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const artifactDir = resolve(options['artifact-dir'])
  const paths = {
    claudeOld: join(artifactDir, 'claude-old.tgz'),
    claudeNew: join(artifactDir, 'claude-new.tgz'),
    supergatewayOld: join(artifactDir, 'supergateway-old.tgz'),
    supergatewayNew: join(artifactDir, 'supergateway-new.tgz'),
  }
  const artifacts = Object.fromEntries(
    Object.entries(paths).map(([id, path]) => [id, loadLockedArtifact(path, LOCKS[id])]),
  )

  const result = {
    schemaVersion: 'agent-vigil-static-regression-proof/v1',
    asOf: '2026-08-23',
    executionPolicy: {
      artifactHandling: 'read-only gzip/tar parsing and hashing',
      vendorCodeExecuted: false,
      installScriptsExecuted: false,
      childCommandsExecuted: false,
      socketsOrServersOpened: false,
      accountsOrCredentialsUsed: false,
    },
    locks: Object.fromEntries(
      Object.entries(LOCKS).map(([id, lock]) => [id, {
        package: lock.package,
        version: lock.version,
        tarSha256: lock.tarSha256,
        files: lock.files,
      }]),
    ),
    proofs: {
      claudeBedrockAuthorization: reproduceClaude(artifacts.claudeOld, artifacts.claudeNew),
      supergatewayConcurrencyRollback: reproduceSupergateway(
        artifacts.supergatewayOld,
        artifacts.supergatewayNew,
      ),
    },
    negativeControls: {
      claudeOldMutation: mutationControl(paths.claudeOld, LOCKS.claudeOld.tarSha256),
      claudeNewMutation: mutationControl(paths.claudeNew, LOCKS.claudeNew.tarSha256),
      supergatewayOldMutation: mutationControl(
        paths.supergatewayOld,
        LOCKS.supergatewayOld.tarSha256,
      ),
      supergatewayNewMutation: mutationControl(
        paths.supergatewayNew,
        LOCKS.supergatewayNew.tarSha256,
      ),
    },
    reproducedMaterialRegressionCountInThisProof: 2,
  }

  const serialized = `${JSON.stringify(result, null, 2)}\n`
  writeFileSync(resolve(options.output), serialized, { encoding: 'utf8', mode: 0o644 })
  process.stdout.write(serialized)
}

main()
