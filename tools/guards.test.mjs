import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { checkDeploymentHeaders } from './deployment-headers.mjs'
import { assertScreenEvidence, CaptureAbort } from './capture-guard.mjs'

const headerText = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8')
const headers = Object.fromEntries([...headerText.matchAll(/^  ([\w-]+): (.+)$/gm)]
  .map(([, name, value]) => [name.toLowerCase(), value]))
const valid = (candidate) => checkDeploymentHeaders(candidate).every((check) => check.pass)

test('deployment headers accept current policy and reject missing/broadened grants', () => {
  assert.equal(valid(headers), true)
  assert.equal(valid({ ...headers, 'content-security-policy': headers['content-security-policy']
    .replace('script-src ', 'ScRiPt-SrC ') }), true)
  for (const csp of [
    '',
    "default-src * 'unsafe-eval'; object-src 'none'; frame-ancestors 'none'",
    headers['content-security-policy'].replace("connect-src 'self'", "connect-src *"),
    headers['content-security-policy'].replace(/script-src [^;]+;/, ''),
    headers['content-security-policy'] + '; script-src-elem *',
    "SCRIPT-SRC * 'unsafe-inline' 'unsafe-eval'; " + headers['content-security-policy'],
    headers['content-security-policy'] + '; ScRiPt-SrC-ElEm *',
    headers['content-security-policy'].replace(/(default-src|script-src)([^;]*);/g, '$1$2\u00a0;'),
    headers['content-security-policy'].replace(/(default-src|script-src)/g, '\v$1'),
    headers['content-security-policy'].replace(/https:\/\/cdn\.jsdelivr\.net\/[^;]+/, 'https://cdn.jsdelivr.net'),
  ]) assert.equal(valid({ ...headers, 'content-security-policy': csp }), false, csp)
  assert.equal(valid({ ...headers, 'strict-transport-security': 'max-age=0' }), false)
})

test('screen evidence requires a real visible subject, not just a healthy page', () => {
  const options = { enabled: true, required: true, minCoverage: 0.04, minMean: 60, minP99: 100 }
  const lit = { coverage: 0.2, mean: 80, p99: 140 }
  assert.equal(assertScreenEvidence(lit, options), true)
  const front = { coverage: 0.0299, mean: 112.09, p99: 199 }
  assert.equal(assertScreenEvidence(front, { ...options, minCoverage: 0.02 }), true)
  assert.throws(() => assertScreenEvidence({ ...front, mean: 9, p99: 12 }, { ...options, minCoverage: 0.02 }), CaptureAbort)
  assert.throws(() => assertScreenEvidence(null, options), CaptureAbort)
  assert.throws(() => assertScreenEvidence({ ...lit, coverage: 0 }, options), CaptureAbort)
  assert.throws(() => assertScreenEvidence({ ...lit, mean: 9, p99: 12 }, options), CaptureAbort)
  assert.throws(() => assertScreenEvidence({ ...lit, mean: NaN }, options), CaptureAbort)
  assert.equal(assertScreenEvidence(null, { ...options, enabled: false }), false)
  assert.equal(assertScreenEvidence({ ...lit, coverage: 0.01 }, { ...options, required: false }), false)
})
