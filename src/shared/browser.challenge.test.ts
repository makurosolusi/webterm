import { describe, expect, it } from 'vitest'
import { detectChallenge } from './browser.challenge'
import type { ChallengeKind } from './browser.challenge'

describe('detectChallenge', () => {
  const challenged: Array<[string, string, string, ChallengeKind]> = [
    ['google sorry page', 'https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Ddetik', 'https://www.google.com/search?q=detik', 'google_unusual_traffic'],
    ['regional google sorry page', 'https://www.google.co.id/sorry/index?continue=x', '', 'google_unusual_traffic'],
    ['recaptcha as the page', 'https://www.google.com/recaptcha/api2/anchor?k=1', '', 'recaptcha'],
    ['recaptcha.net', 'https://www.recaptcha.net/recaptcha/enterprise/anchor', '', 'recaptcha'],
    ['hcaptcha', 'https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html', '', 'hcaptcha'],
    ['cloudflare challenge host', 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b', '', 'cloudflare'],
    ['cloudflare interstitial by title', 'https://shop.example/?__cf_chl_rt_tk=x', 'Just a moment...', 'cloudflare'],
    ['cloudflare block page by title', 'https://shop.example/', 'Attention Required! | Cloudflare', 'cloudflare'],
    ['verify you are human title', 'https://shop.example/check', 'Verify you are human', 'human_check'],
    ['are you a robot title', 'https://shop.example/check', 'Are you a robot?', 'human_check'],
  ]
  it.each(challenged)('%s', (_n, url, title, kind) => { expect(detectChallenge(url, title)?.kind).toBe(kind) })

  const ordinary: Array<[string, string, string]> = [
    ['google results', 'https://www.google.com/search?q=detik', 'detik - Penelusuran Google'],
    ['google home', 'https://www.google.com/', 'Google'],
    ['google path that merely starts with sorry', 'https://www.google.com/sorrynotsorry', 'x'],
    ['article about captchas', 'https://blog.example/captcha', 'Why is every site asking if I am a robot?'],
    ['cloudflare marketing page', 'https://www.cloudflare.com/', 'Cloudflare | The Web Performance & Security Company'],
    ['shop checkout with an embedded widget', 'https://shop.example/login', 'Sign in'],
    ['recaptcha-looking path on another host', 'https://shop.example/recaptcha/docs', 'Docs'],
    ['about:blank', 'about:blank', ''],
    ['not a url', 'garbage', ''],
  ]
  it.each(ordinary)('%s is not a challenge', (_n, url, title) => { expect(detectChallenge(url, title)).toBeNull() })

  it('drops the query: the sorry URL carries the search terms', () => {
    const c = detectChallenge('https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Dsecret', '')
    expect(c).toEqual({ kind: 'google_unusual_traffic', url: 'https://www.google.com/sorry/index' })
  })
})
