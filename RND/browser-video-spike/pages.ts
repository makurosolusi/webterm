// SPIKE: jangan merge ke produk. Local-only test pages + servers (127.0.0.1) + forwarding proxy (webterm forces a proxy).
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CANVAS = `<!doctype html><meta charset=utf-8><style>html,body{margin:0;background:#111}canvas{display:block}</style>
<canvas id=c width=1280 height=800></canvas><script>
const c=document.getElementById('c'),g=c.getContext('2d');window.__n=0
function f(t){window.__n++;g.fillStyle='hsl('+(t/20%360)+',60%,30%)';g.fillRect(0,0,1280,800)
for(let i=0;i<40;i++){g.fillStyle='hsl('+((i*9+t/10)%360)+',80%,60%)';g.fillRect((t/3+i*31)%1280,(i*37+Math.sin(t/300+i)*120+400)%800,90,60)}
g.fillStyle='#fff';g.font='bold 120px monospace';g.fillText(String(window.__n),40,140);requestAnimationFrame(f)}
requestAnimationFrame(f)</script>`
const VIDEO = (src: string) => `<!doctype html><meta charset=utf-8><style>html,body{margin:0;background:#000}video{width:100vw;height:100vh;object-fit:contain}</style>
<video id=v src="${src}" muted autoplay loop playsinline></video><script>const v=document.getElementById('v');v.play().catch(()=>{});
window.__vq=()=>{const q=v.getVideoPlaybackQuality();return{total:q.totalVideoFrames,dropped:q.droppedVideoFrames,t:v.currentTime,paused:v.paused}}</script>`
// No ffmpeg: record 4 s of an animated canvas with MediaRecorder in the page, then loop-play the blob.
const VIDEO_REC = `<!doctype html><meta charset=utf-8><style>html,body{margin:0;background:#000}video{width:100vw;height:100vh;object-fit:contain}</style>
<video id=v muted loop playsinline></video><canvas id=c width=1280 height=720 style="display:none"></canvas><script>
const v=document.getElementById('v'),c=document.getElementById('c'),g=c.getContext('2d');let n=0
window.__vq=()=>{const q=v.getVideoPlaybackQuality();return{total:q.totalVideoFrames,dropped:q.droppedVideoFrames,t:v.currentTime,paused:v.paused}}
const draw=()=>{n++;g.fillStyle='hsl('+(n*3%360)+',50%,30%)';g.fillRect(0,0,1280,720);for(let i=0;i<60;i++){g.fillStyle='hsl('+((i*6+n*4)%360)+',80%,60%)';g.fillRect((n*7+i*23)%1280,(i*41+n*3)%720,100,70)}}
const iv=setInterval(draw,1000/30);const rec=new MediaRecorder(c.captureStream(30),{mimeType:'video/webm;codecs=vp9',videoBitsPerSecond:3e6});const ch=[]
rec.ondataavailable=e=>ch.push(e.data);rec.onstop=()=>{clearInterval(iv);v.src=URL.createObjectURL(new Blob(ch,{type:'video/webm'}));v.play()};rec.start();setTimeout(()=>rec.stop(),4000)</script>`
const STATIC = `<!doctype html><meta charset=utf-8><body style="margin:0;font:20px sans-serif;padding:40px"><h1>Static page</h1>${'<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>'.repeat(14)}`

export const SCENARIOS = ['canvas', 'video', 'static'] as const
export type Scenario = (typeof SCENARIOS)[number]

/** 6 s VP9 1080p30 via ffmpeg when present; null otherwise (the page then records its own clip). */
export function makeVideo(dir: string): Uint8Array | null {
  const out = join(dir, 'v.webm')
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-t', '6', '-c:v', 'libvpx-vp9', '-b:v', '3M', '-deadline', 'realtime', '-cpu-used', '8', '-pix_fmt', 'yuv420p', out])
  return r.status === 0 ? new Uint8Array(readFileSync(out)) : null
}

export interface Servers { port: number; proxy: number; videoSource: 'ffmpeg-vp9-1080p30' | 'mediarecorder-vp9-720p30'; stop(): void }
export function startServers(video: Uint8Array | null): Servers {
  const html = (b: string) => new Response(b, { headers: { 'content-type': 'text/html' } })
  const page = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch(req) {
      const p = new URL(req.url).pathname
      if (p === '/canvas') return html(CANVAS)
      if (p === '/static') return html(STATIC)
      if (p === '/video') return html(video ? VIDEO('/v.webm') : VIDEO_REC)
      if (p === '/v.webm' && video) { // manual Range support: looping needs seeks
        const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') ?? '')
        const total = video.length
        const s = m && m[1] ? +m[1] : 0
        const e = m && m[2] ? Math.min(+m[2], total - 1) : total - 1
        const h = { 'content-type': 'video/webm', 'accept-ranges': 'bytes' }
        return m ? new Response(video.slice(s, e + 1), { status: 206, headers: { ...h, 'content-range': `bytes ${s}-${e}/${total}` } }) : new Response(video, { headers: h })
      }
      return new Response('nf', { status: 404 })
    },
  })
  const proxy = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch(req) {
      const u = new URL(req.url)
      if (u.port !== String(page.port)) return new Response('blocked', { status: 403 })
      u.hostname = '127.0.0.1'
      return fetch(u, { headers: req.headers, method: req.method })
    },
  })
  return { port: page.port!, proxy: proxy.port!, videoSource: video ? 'ffmpeg-vp9-1080p30' : 'mediarecorder-vp9-720p30', stop() { page.stop(true); proxy.stop(true) } }
}
