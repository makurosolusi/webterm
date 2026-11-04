// Seluruh teks kartu "Token akses" (Rule 15). Tanpa nama env var; sumber "env" disebut dengan kata biasa.

export const TOKEN_TEXT = {
  title: 'Token akses',
  loading: 'Memeriksa token akses...',
  loadFailed: 'Status token akses belum bisa dimuat. Coba lagi sebentar.',
  off: 'Mati. Siapa pun di komputer ini bisa membuka webterm lewat 127.0.0.1 tanpa token.',
  onFile: 'Aktif. Setiap browser harus membuka webterm lewat tautan berisi token.',
  onEnv: 'Aktif, diatur dari luar webterm (variabel lingkungan saat server dijalankan). Untuk mengganti atau mematikannya, ubah pengaturan peluncuran server itu.',
  why: 'Nyalakan bila webterm dibuka dari perangkat lain atau lewat tunnel, supaya hanya pemegang tautan yang bisa masuk.',
  offRemote: 'Token hanya bisa dinyalakan dari halaman yang dibuka langsung di komputer ini (127.0.0.1).',
  enable: 'Aktifkan token',
  rotate: 'Rotasi token',
  confirmEnable:
    'Aktifkan token akses?\n\nTautan berisi token hanya ditampilkan SEKALI. Salin sekarang. Tab webterm lain yang sedang terbuka harus dibuka ulang memakai tautan itu.',
  confirmRotate:
    'Rotasi token akses?\n\nToken lama langsung tidak berlaku. Tautan baru hanya ditampilkan SEKALI. Perangkat dan tab lain harus dibuka ulang memakai tautan baru.',
  linkIntro: 'Tautan ini hanya ditampilkan sekali. Salin sekarang dan simpan di tempat aman.',
  linkLabel: 'Tautan berisi token',
  copy: 'Salin',
  copied: 'Tersalin',
  copyFailed: 'Gagal menyalin. Pilih teks tautan lalu salin manual.',
  reloadHint: 'Tab ini sudah memakai token baru dan akan dimuat ulang saat Anda menekan Selesai atau menutup pengaturan.',
  done: 'Selesai',
  // Kode 403/409/500 dari tokenAccess.api.ts -> kalimat jujur (sebab + jalan keluar).
  agentCannot: 'Ditolak: token akses hanya bisa diubah dari jendela webterm, bukan dari sesi agent.',
  browserOnly: 'Ditolak: token akses hanya bisa diubah dari halaman webterm di browser.',
  loopbackOnly: 'Ditolak: token hanya bisa dinyalakan dari halaman yang dibuka langsung di komputer ini (127.0.0.1).',
  changed: 'Status token berubah di tempat lain. Status terbaru sudah dimuat.',
  failed: 'Perubahan belum berhasil. Coba lagi sebentar.',
} as const
