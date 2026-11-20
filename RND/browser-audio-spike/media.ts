// SPIKE: jangan merge ke produk. Media uji dibangkitkan lokal: WAV 440 Hz (in-process) dan WebM/Opus 440 Hz (ffmpeg libopus).
export async function makeMedia(): Promise<{ wav: Uint8Array; webm: Uint8Array }> {
  const sr = 48000, n = Math.floor(sr * 1.4), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf)
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 440 * i / sr) * 0.5 * 32767), true)
  const p = Bun.spawn(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.4:sample_rate=48000', '-af', 'volume=4', '-c:a', 'libopus', '-f', 'webm', 'pipe:1'], { stdout: 'pipe' })
  const webm = new Uint8Array(await new Response(p.stdout).arrayBuffer())
  if (!webm.length) throw new Error('ffmpeg produced no webm (libopus needed)')
  return { wav: new Uint8Array(buf), webm }
}
