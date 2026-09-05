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
  for (const [name, expected] of Object.entries({
    'script-src-elem': REQUIRED_CSP['script-src'],
    'script-src-attr': ["'none'"],
    'style-src-elem': REQUIRED_CSP['style-src'],
    'style-src-attr': ["'none'"],
  })) {
    if (directives.has(name)) check(`CSP ${name}`, same(directives.get(name), expected))
  }
  const hsts = headers['strict-transport-security'] ?? ''
  const maxAge = Number(/(?:^|;)\s*max-age=(\d+)(?:;|$)/i.exec(hsts)?.[1] ?? 0)
  check('HSTS ≥ 1 ano', maxAge >= 31_536_000, hsts)
  check('X-Content-Type-Options: nosniff', headers['x-content-type-options'] === 'nosniff')
  check('X-Frame-Options: DENY', headers['x-frame-options']?.toUpperCase() === 'DENY')
  return checks
}
