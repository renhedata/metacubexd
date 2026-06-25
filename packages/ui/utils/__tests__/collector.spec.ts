import { describe, expect, it } from 'vitest'
import { normalizeBackend as daemonNormalize } from '../../../../collector/backends'
import { normalizeBackend } from '../collector'

const FIXTURES = [
  'http://127.0.0.1:9090',
  'HTTP://Mihomo-A:9090/',
  'http://user:pass@h:9090/',
  'http://h:9090/?x=1#frag',
  'https://example.com/mihomo/',
  'https://example.com:8443/path//',
]

describe('utils/collector normalizeBackend', () => {
  it('matches the daemon implementation on every fixture', () => {
    for (const raw of FIXTURES) {
      expect(normalizeBackend(raw)).toBe(daemonNormalize(raw))
    }
  })

  it('canonicalizes credentials, query, fragment and trailing slashes', () => {
    expect(normalizeBackend('http://user:pass@h:9090/?x=1#f')).toBe(
      'http://h:9090',
    )
    expect(normalizeBackend('https://example.com/mihomo/')).toBe(
      'https://example.com/mihomo',
    )
    expect(() => normalizeBackend('not a url')).toThrow()
  })
})
