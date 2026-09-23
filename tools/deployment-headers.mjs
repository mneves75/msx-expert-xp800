import { WEBMSX_URL } from './browser.mjs'

const REQUIRED_CSP = {
  'default-src': ["'self'"],
  'script-src': ["'self'", WEBMSX_URL],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'"],
  'connect-src': ["'self'"],
  'worker-src': ["'self'", 'blob:'],
  'object-src': ["'none'"],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
}

const PERMISSIONS_POLICY = 'geolocation=(), microphone=(), camera=(), payment=()'

export function checkDeploymentHeaders(headers) {
  const checks = []
  const check = (name, pass, detail = '') => checks.push({ name, pass, detail })
  const directives = new Map()
  for (const part of (headers['content-security-policy'] ?? '').split(';')) {
    // Browsers discard non-ASCII tokens and only split on CSP's ASCII whitespace.
    if (/[^\x00-\x7f]/.test(part)) {
      check('CSP diretiva contém somente ASCII', false)
      continue
    }
    const token = part.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '')
    const [rawName, ...values] = token.split(/[\t\n\f\r ]+/)
    if (!rawName) continue
    // CSP names are ASCII case-insensitive, including duplicate detection.
    const name = rawName.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
    check(`CSP ${name} não se repete`, !directives.has(name))
    directives.set(name, values)
  }
  const same = (actual, expected) => actual?.length === expected.length &&
    expected.every((value) => actual.includes(value))
  for (const [name, expected] of Object.entries(REQUIRED_CSP)) {
    const actual = directives.get(name)
    check(`CSP ${name}`, same(actual, expected), actual?.join(' ') ?? '(ausente)')
  }
  // These override the checked script/style directives when supplied by a host.
  const overrides = {
    'script-src-elem': REQUIRED_CSP['script-src'],
    'script-src-attr': ["'none'"],
    'style-src-elem': REQUIRED_CSP['style-src'],
    'style-src-attr': ["'none'"],
  }
  for (const [name, expected] of Object.entries(overrides)) {
    if (directives.has(name)) check(`CSP ${name}`, same(directives.get(name), expected))
  }
  // Any other directive (frame-src, media-src, …) would replace the default-src fallback.
  for (const name of directives.keys()) {
    // Own keys only: `constructor`, `toString`… exist on every object prototype.
    const allowed = Object.hasOwn(REQUIRED_CSP, name) || Object.hasOwn(overrides, name)
    if (!allowed) check(`CSP ${name} não é permitida`, false)
  }
  const hsts = headers['strict-transport-security'] ?? ''
  const maxAge = Number(/(?:^|;)\s*max-age=(\d+)(?:;|$)/i.exec(hsts)?.[1] ?? 0)
  check('HSTS ≥ 1 ano', maxAge >= 31_536_000, hsts)
  check('HSTS includeSubDomains', /(?:^|;)\s*includesubdomains\s*(?:;|$)/i.test(hsts), hsts)
  check('X-Content-Type-Options: nosniff', headers['x-content-type-options'] === 'nosniff')
  check('X-Frame-Options: DENY', headers['x-frame-options']?.toUpperCase() === 'DENY')
  for (const [name, expected] of Object.entries({
    'referrer-policy': 'strict-origin-when-cross-origin',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
  })) {
    check(`${name}: ${expected}`, headers[name]?.trim().toLowerCase() === expected, headers[name])
  }
  // Exact value, not a parse: any added, repeated or widened feature is a different policy.
  const permissions = (headers['permissions-policy'] ?? '').split(',').map((item) => item.trim()).join(', ')
  check(`Permissions-Policy: ${PERMISSIONS_POLICY}`, permissions === PERMISSIONS_POLICY, permissions)
  return checks
}
