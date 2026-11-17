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
/** A request to create or change a skill (the verb must sit right before "skill", so "fix the skill loader" stays code_change). Not a playbook job: Central drafts it with skill.propose or points to the Skills tab author, and a worker must never write a Central skill. */
export const SKILL_REQUEST_WORDS = /\b(buat(kan)?|bikin(kan)?|tulis(kan)?|create|write|draft|make|edit|ubah|change|update|tambah\w*|add)\s+((a|an|the|new|sebuah|satu|baru)\s+)*skills?\b/i
