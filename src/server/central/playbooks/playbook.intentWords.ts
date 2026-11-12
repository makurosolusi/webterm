// User-input vocabulary, NOT product text: the words (English and Indonesian) that make a human message
// read like a playbook's job (context/playbookHint.ts). Nothing here is ever shown to anyone, so the
// English product-text scan exempts this file (src/shared/productText.english.test.ts); keep it to
// RegExp constants only, no strings.

/** web_research: analyse, research, compare, look something up. */
export const WEB_RESEARCH_WORDS = /\b(analisa|analisis|analy[sz]e|analysis|riset|research|cari(kan)?|bandingkan|compare|trending|investigate|look\s+up|browse|telusuri)\b/i
/** code_change: fix, implement, add, refactor, change. */
export const CODE_CHANGE_WORDS = /\b(perbaiki|betulkan|fix|implement\w*|tambah\w*|refactor\w*|ubah|bikin\s+fitur|add\s+(a\s+)?feature)\b/i
/** review: review a PR, branch, diff or code. */
export const REVIEW_WORDS = /\b(review|periksa|cek\s+kode|pull\s+request|PR|diff)\b/i
