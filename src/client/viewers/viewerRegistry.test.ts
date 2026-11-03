import { describe, expect, it } from 'vitest'
import { fileKind, type FileKind } from '../../shared/fileKind'
import { pickViewer } from './viewerRegistry'

describe('pickViewer', () => {
  it('maps each kind to its viewer when VIEWERS is on', () => {
    const on: Record<FileKind, ReturnType<typeof pickViewer>> = {
      text: null, markdown: null, image: 'image', audio: 'media', video: 'media', pdf: 'pdf', archive: 'placeholder', binary: 'placeholder',
    }
    for (const [kind, want] of Object.entries(on)) expect(`${kind}:${pickViewer(kind as FileKind, true)}`).toBe(`${kind}:${want}`)
  })

  it('flag off: every non-text kind is a placeholder, text/markdown stay with the editor', () => {
    for (const k of ['image', 'audio', 'video', 'pdf', 'archive', 'binary'] as const) expect(pickViewer(k, false)).toBe('placeholder')
    expect(pickViewer('text', false)).toBeNull()
    expect(pickViewer('markdown', false)).toBeNull()
  })

  it('SVG is an image (<img>), never a document viewer', () => {
    expect(pickViewer(fileKind('logo.svg'), true)).toBe('image')
    expect(pickViewer(fileKind('doc.pdf'), true)).toBe('pdf')
    expect(pickViewer(fileKind('clip.MP4'), true)).toBe('media')
  })
})
