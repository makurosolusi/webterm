// Rute `/api/settings`. Dipisah dari `api.ts` supaya file itu tetap satu tanggung jawab (routing
// workspace/sesi) — integrator menyambungkannya dengan satu baris di `route()`.
//
// KEAMANAN: tidak ada lapisan redaksi di sini, dan itu disengaja. Tidak satu pun kunci di
// `shared/settings.ts` bisa memuat rahasia (lihat catatan KEAMANAN di kepala file itu, dan alasan
// `CustomAgent.env` nodeterm tidak diport). Begitu ada kunci yang bisa, ia WAJIB diredaksi di
// jalur GET di bawah.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { db } from './db'

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

/**
 * `GET` mengembalikan snapshot penuh; `PUT` menerima PATCH parsial dan mengembalikan snapshot
 * hasil merge-nya, sehingga client yang menulis tidak perlu menebak apa yang tersimpan.
 *
 * Body tidak divalidasi di sini dengan sengaja: `mergeSettings` di dalam `db.saveSettings` adalah
 * batas input tunggal (cocokkan bentuk, buang kunci tak dikenal), jadi validator kedua di sini
 * hanya akan jadi tempat kedua yang bisa tidak sepakat.
 */
export async function settingsRoute(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
  if (method === 'GET') return json(res, 200, db.getSettings())
  if (method === 'PUT') {
    let patch: unknown
    try {
      patch = JSON.parse(await readBody(req))
    } catch {
      return json(res, 400, { error: 'bad json' })
    }
    return json(res, 200, db.saveSettings(patch))
  }
  json(res, 405, { error: 'method not allowed' })
}
