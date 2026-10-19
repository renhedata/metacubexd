import { describe, expect, it } from 'vitest'
import { loadConfig, toWsURL } from '../config'

describe('collector/config', () => {
  it('toWsURL converts http to ws and https to wss, trimming trailing slash', () => {
    expect(toWsURL('http://127.0.0.1:9090/')).toBe('ws://127.0.0.1:9090')
    expect(toWsURL('https://host:9090')).toBe('wss://host:9090')
  })

  it('throws when COLLECTOR_TOKEN is missing or empty', () => {
    expect(() => loadConfig({})).toThrow(/COLLECTOR_TOKEN/)
    expect(() => loadConfig({ COLLECTOR_TOKEN: '' })).toThrow(/COLLECTOR_TOKEN/)
  })

  it('defaults to an empty mihomo target when MIHOMO_API_URL is missing', () => {
    const cfg = loadConfig({ COLLECTOR_TOKEN: 'tok' })
    expect(cfg.mihomoApiURL).toBe('')
  })

  it('throws when MIHOMO_API_URL is not a valid URL', () => {
    expect(() =>
      loadConfig({ COLLECTOR_TOKEN: 'tok', MIHOMO_API_URL: 'not a url' }),
    ).toThrow(/not a valid URL/)
  })

  it('applies defaults', () => {
    const cfg = loadConfig({
      COLLECTOR_TOKEN: 'tok',
      MIHOMO_API_URL: 'http://127.0.0.1:9090',
    })
    expect(cfg).toMatchObject({
      mihomoApiURL: 'http://127.0.0.1:9090',
      mihomoSecret: '',
      port: 9797,
      dbPath: './collector-data.sqlite',
      retentionMs: 0,
      token: 'tok',
      allowedOrigin: '*',
    })
  })

  it('reads overrides from env', () => {
    const cfg = loadConfig({
      MIHOMO_API_URL: 'http://h:1',
      MIHOMO_SECRET: 's',
      PORT: '8000',
      DB_PATH: '/data/x.sqlite',
      RETENTION_MS: '3600000',
      COLLECTOR_TOKEN: 'tok',
      ALLOWED_ORIGIN: 'https://app.example',
    })
    expect(cfg).toMatchObject({
      mihomoSecret: 's',
      port: 8000,
      dbPath: '/data/x.sqlite',
      retentionMs: 3600000,
      token: 'tok',
      allowedOrigin: 'https://app.example',
    })
  })
})
