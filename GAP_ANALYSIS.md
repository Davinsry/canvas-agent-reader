# Dokumen Rumusan GAP & Solusi Teknis Ekstraksi Gambar Figma (Pure Canvas / Reverse Engineering)

Dokumen ini merumuskan secara mendalam akar masalah (root cause), kesenjangan (gap) antara kondisi sistem saat ini dengan ekspektasi pengguna, serta spesifikasi teknis solusi yang dapat langsung dieksekusi oleh developer / autonomous coding agent (Claude Code).

---

## 1. Aturan Keras (Hard Constraints)
1. **TIDAK MENGGUNAKAN FIGMA API KEY SAMA SEKALI**:
   - Seluruh ekstraksi harus murni bekerja via input link publik Figma di browser / canvas reader.
2. **SELURUH GAMBAR HARUS TER-OUTPUT LENGKAP**:
   - Setiap gambar, layar mobile, mockup UI, dan kartu desain yang ada di tiap section pada link tersebut harus memiliki file output tangkapan layar tersendiri secara utuh.
   - Tidak boleh ada yang terpotong menjadi remahan teks/tombol kecil, dan tidak boleh ada kartu yang terlewat.

---

## 2. Root Cause & Technical Gap Analysis

### GAP 1: Keterbatasan WebGL Canvas vs DOM HTML
- **Masalah**: Figma merender seluruh kanvasnya menggunakan **C++/Skia via WebAssembly (WebGL)** ke dalam satu elemen `<canvas>` HTML5.
- **Dampak**: Tidak ada tag HTML `<div>`, `<img>`, atau `<svg>` di DOM untuk masing-masing kartu desain. Query DOM standar (`document.querySelectorAll`) tidak dapat melihat elemen di dalam kanvas.

### GAP 2: Kegagalan Algoritma 1D Projection Profiling
- **Masalah**: Fungsi `computeContentBoxes` di `src/extractors/figma/segment.ts` saat ini mendeteksi kartu menggunakan proyeksi sumbu 1D (horizontal & vertikal).
- **Dampak**:
  1. **Panah Prototype & Grid Bercabang**: Pada flow yang memiliki konektor panah prototype atau baris atas & bawah (seperti flow Study Case/Interview), proyeksi 1D menganggap seluruh baris terhubung sebagai 1 kotak raksasa, atau sebaliknya memotong judul terpisah dari layarnya.
  2. **Section Komponen (Non-Flow)**: Pada section seperti `Master Components`, elemen tabel dan accordion dipotong-potong menjadi teks kecil (`07-card-7.png`), bukan kartu komponen utuh.

### GAP 3: Virtualisasi Panel Layers Sidebar
- **Masalah**: Panel Layers sebelah kiri Figma menggunakan *virtualized DOM tree*. Di link publik anonim, Figma secara default hanya memuat baris Section tingkat atas. Child frame/kartu di dalam section belum di-expand ke DOM.

---

## 3. Solusi Teknis Konkret untuk Claude Code (Tanpa API Key)

### Pendekatan 1 (Rekomendasi Utama): Deep-Expand Panel Layers DOM Tree
Di dalam browser Figma, panel Layers sebelah kiri menyimpan struktur pohon asli file Figma:
1. **Trigger Expand di DOM**:
   - Kirim event klik dua kali (`dblclick`) pada baris section di panel Layers, atau fokuskan baris dan kirim tombol `ArrowRight`.
   - Figma secara reaktif akan me-render daftar **child frame** asli ke dalam DOM (`data-testid="<child-node-id>-layers-panel-row"`).
2. **Navigasi & Capture Presisi**:
   - Baca seluruh nama asli dan `node-id` anak dari atribut `data-testid`.
   - Fokuskan kamera ke tiap child frame menggunakan shortcut bawaan Figma **`Shift + 2` (Zoom to Selection)** atau via URL parameter `?node-id=<child-node-id>`.
3. **Keunggulan**:
   - 100% gambar dan kartu tertangkap utuh.
   - Penamaan file otomatis mengikuti nama layer asli desainer di Figma.
   - 0 tebak-tebak piksel, deterministik, dan bebas kesalahan potong.

### Pendekatan 2: 2D Connected Component Labeling (CCL) + Morphological Closing (Pure Vision)
Jika menggunakan analisis tangkapan visual:
1. **Binarisasi**: Buat mask selisih warna dari background section (`diff > tolerance`).
2. **Morphological Closing (Dilation -> Erosion)**:
   - Gunakan kernel morfologi kotak (ukuran $32 \times 32$ piksel) pada mask biner.
   - Operasi ini akan meleburkan teks, tombol, dan gambar di dalam kartu menjadi 1 pulau/kontur solid sebuah kartu UI, serta memutus garis konektor tipis (1-2px).
3. **Connected Components 2D (Blobs)**:
   - Ekstrak kontur 2D yang memiliki ukuran batas kartu UI (`height >= 300px, width >= 200px`).
4. **Hasil**: Seluruh layar atau kartu terpotong utuh tanpa terpecah menjadi teks/komponen remahan.
