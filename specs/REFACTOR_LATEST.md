# Refactor Plan — FloodLens Jakarta

Target: **demo portfolio yang di-harden**, bukan layanan publik berskala besar.

## Problem Statement

FloodLens saat ini bekerja sebagai demo lokal: satu `index.html` 987 baris, satu `server.py` 218 baris, tiga commit, dan nol test. Untuk disebut production grade, ada masalah yang harus diselesaikan dari sudut pandang developer:

1. **Kebocoran source code.** `SimpleHTTPRequestHandler` menyajikan seluruh root repo. `server.py`, `README.md`, dan isi `.git` dapat diakses lewat HTTP. Ini bug keamanan, bukan hanya masalah kerapian.
2. **Dua parser OSM.** Query dan simplifikasi Overpass ditulis dua kali: di Python dan di JavaScript. Keduanya bisa menghasilkan graph berbeda tanpa ada test yang mendeteksi drift.
3. **Browser bergantung pada Overpass langsung.** Client mencoba tiga endpoint Overpass publik sebelum proxy. Ini membocorkan IP pengguna ke pihak ketiga, rentan CORS/rate limit, dan membuat E2E bergantung pada layanan live.
4. **Cache tidak aman untuk concurrency.** Cache OSM adalah variabel global tanpa lock. Dua request bersamaan dapat memicu fetch ganda; tidak ada stale-if-error saat Overpass down.
5. **Tidak ada verifikasi otomatis.** Tidak ada unit test, E2E, CI, atau fixture. Setiap refactor berisiko mengubah hasil analisis tanpa terdeteksi.
6. **Supply chain longgar.** `leaflet-draw` dimuat dari unpkg tanpa SRI; tidak ada CSP. Satu script CDN yang berubah dapat mengeksekusi kode di origin aplikasi.
7. **Monolith dan CSS mati.** UI, parsing, graph, dan rendering bercampur. File berisi dua tema (`color-scheme: dark` lalu `light`) dengan aturan yang saling menimpa.
8. **Tidak ada operasi produksi.** Tidak ada healthcheck, structured log, security header, Dockerfile, atau jalur deploy.

### Perilaku saat ini yang harus dipahami sebelum diubah

- `server.py` bind ke `127.0.0.1:8766`, menyajikan root repo, dan menyediakan `/api/osm` (3 endpoint Overpass, cache 900 detik) serta `/api/flood` (proxy PNG BNPB).
- Client memuat Leaflet dari unpkg, mencoba Overpass langsung, lalu fallback ke `/api/osm`. Respons langsung disederhanakan di browser; respons proxy sudah disederhanakan server.
- Client membangun graph dari setiap pasangan node jalan, menangani `oneway` dan `oneway=-1`, men-snap origin/fasilitas ke node terdekat dengan scan linear, lalu menjalankan Dijkstra dua kali: baseline dan skenario.
- Zona dianggap menutup segmen bila **midpoint** segmen berada di dalam polygon. Tidak ada model kedalaman, waktu, lalu lintas, atau turn restriction.
- Hasil yang terlihat pengguna: jumlah fasilitas dalam radius 5 km sebelum/sesudah, jarak RS terdekat sebelum/sesudah, lima fasilitas terdekat, segmen tertutup, dan dua rute di peta.

### Invariant yang wajib dipertahankan

Untuk payload OSM tersederhana yang sama, origin yang sama, dan ring polygon yang sama:

- himpunan `closed segment key` identik;
- `distances` dan `previous` dari Dijkstra baseline dan skenario identik;
- jumlah fasilitas dalam 5 km, jarak RS terdekat, dan lima fasilitas terdekat identik;
- urutan koordinat rute yang digambar identik;
- selisih numerik maksimum `1e-6` meter.

Ini adalah gate utama refactor. Test karakterisasi harus dibuat **sebelum** logika client dipindahkan.

## Solution

Hardening tanpa mengubah fitur atau metode analisis:

- Backend tetap Python standard library, tetapi dipecah menjadi modul domain, cache, HTTP, dan entry point.
- Hanya `public/` yang disajikan. Source, test, dan `.git` tidak pernah masuk akar statis.
- Browser selalu memakai proxy untuk OSM dan BNPB. Parser OSM hanya ada di Python.
- Client dipecah menjadi ES module tanpa build step. Logika graph dan analisis murni dapat dites dengan `node:test`.
- Leaflet dan Leaflet.draw di-vendor lokal. CSP ketat, tanpa inline script.
- Cache TTL ber-lock dengan stale-if-error untuk OSM dan flood overlay.
- Fixture mode deterministik untuk E2E, aktif hanya lewat env dan ditolak di production.
- pytest, `node:test`, Playwright, dan GitHub Actions.
- Dockerfile non-root + Render blueprint + healthcheck.
- README diselaraskan dengan struktur dan operasi baru.

Tidak ada fitur baru: tanpa share URL, export, Web Worker, auth, atau perubahan metode.

## Commits

Urutan ini sengaja menaruh test karakterisasi sebelum refactor berisiko. Setiap commit harus meninggalkan aplikasi yang bisa dijalankan.

1. `docs: add refactor plan` → verify: `test -f specs/REFACTOR_LATEST.md`

2. `chore: add Python and Node test tooling` — tambah `requirements-dev.txt` (pytest, coverage, ruff), konfigurasi pytest/ruff, `package.json` private bertipe module, script `test`, dan perluasan `.gitignore` untuk `node_modules`, `test-results`, `playwright-report`. Tambah smoke test Python dan Node agar toolchain terbukti jalan.
   → verify: `python -m pip install -r requirements-dev.txt && python -m pytest -q && npm test`

3. `test: add synthetic Overpass fixture and characterize parser` — tambah fixture Overpass sintetis yang mencakup jalan satu arah, jalan `access=no`, fasilitas node dan way, duplikat fasilitas, serta satu jembatan yang bisa diputus polygon. Test mengunci query bbox/filter, jumlah road/facility, klasifikasi hospital/clinic, dedupe, dan penanganan `oneway`.
   → verify: `python -m pytest -q tests/test_osm_parser.py`

4. `test: characterize HTTP API with stubbed upstream` — jalankan handler di port ephemeral, monkeypatch fetch OSM/BNPB, dan kunci status, content type, cache header, serta bentuk error JSON. Tidak ada network nyata.
   → verify: `python -m pytest -q tests/test_http_contract.py`

5. `refactor(server): extract configuration and OSM domain module` — pindahkan konstanta, query, simplifikasi, dan validasi output ke modul domain. Tambah `schemaVersion`, tolak `NaN`/`Infinity`, dan validasi koordinat berada dalam pilot bounds. `server.py` hanya merangkai.
   → verify: `python -m pytest -q tests/test_osm_parser.py`

6. `refactor(server): extract flood overlay client` — pindahkan fetch dan validasi PNG ke modul sendiri. Content type dan magic bytes tetap divalidasi. Tambah test untuk respons HTML, body kosong, dan timeout.
   → verify: `python -m pytest -q tests/test_flood_client.py`

7. `refactor(server): add lock-protected TTL cache with stale-if-error` — cache generik dengan clock injectable, single-flight lock, TTL OSM 900 detik dan flood 3600 detik. Saat upstream gagal, sajikan entri stale bila ada; bila tidak ada, kembalikan error terklasifikasi. Test hit, expiry, stale fallback, dan dua thread bersamaan.
   → verify: `python -m pytest -q tests/test_cache.py`

8. `refactor(server): move static app into public and stop serving repository root` — buat `public/`, pindahkan `index.html`, arahkan handler hanya ke sana. Tolak dotfile. Test bahwa `/`, aset publik, dan `/healthz` dapat diakses, sedangkan `server.py`, `README.md`, `.git/config`, dan path traversal tidak.
   → verify: `python -m pytest -q tests/test_static_isolation.py`

9. `feat(server): add health endpoint, security headers, and structured logs` — `/healthz` mengembalikan status aplikasi tanpa memanggil upstream. Tambah `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, `frame-ancestors`, dan log JSON per request berisi request id, method, path tanpa query sensitif, status, durasi, serta cache status. Jangan log IP.
   → verify: `python -m pytest -q tests/test_http_contract.py tests/test_security_headers.py`

10. `refactor(server): add environment config and graceful shutdown` — `FLOODLENS_HOST`, `FLOODLENS_PORT`, TTL, dan log level. Default tetap `127.0.0.1:8766` untuk lokal; container memakai `0.0.0.0`. Tangani SIGINT/SIGTERM, tutup server, dan set thread daemon. Tolak konfigurasi fixture saat `FLOODLENS_ENV=production`.
    → verify: `python -m pytest -q tests/test_config.py`

11. `build: vendor Leaflet and Leaflet.draw locally` — simpan JS, CSS, marker images, dan atribusi lisensi di `public/vendor`. Hapus semua referensi unpkg. Tambah test statis yang memastikan tidak ada URL unpkg dan seluruh aset yang dirujuk benar-benar ada.
    → verify: `python -m pytest -q tests/test_static_assets.py`

12. `feat(server): add fixture mode for deterministic tests` — `FLOODLENS_FIXTURE_DIR` menyajikan payload OSM dan PNG flood dari disk. Mode ini hanya aktif bila env di-set, menolak production, dan mencatat warning saat startup. Test memastikan tidak ada panggilan upstream dan fixture tidak bocor di mode normal.
    → verify: `python -m pytest -q tests/test_fixture_mode.py`

13. `test: add Playwright fixture-mode scenario test` — jalankan server fixture, buka aplikasi, muat data, pilih origin, gambar polygon, lalu assert jumlah fasilitas sebelum/sesudah, jarak RS, lima fasilitas, dan tidak ada console error. Untuk tahap ini, intercept request Overpass/BNPB langsung agar karakterisasi memakai implementasi client yang sekarang. Simpan nilai expected sebagai baseline invariant.
    → verify: `npx playwright test`

14. `ci: add GitHub Actions test workflow` — Python 3.12 dan Node 22, cache dependency, jalankan pytest, `node --test`, dan Playwright Chromium. Upload report saat gagal. Tidak ada akses layanan live.
    → verify: `python -m pytest -q && npm test && npx playwright test` (CI memverifikasi pada push)

15. `refactor(client): move inline CSS to stylesheet` — pindahkan seluruh `<style>` ke aset CSS eksternal. Tidak ada perubahan selector atau nilai. E2E dan screenshot review memastikan tampilan identik.
    → verify: `npx playwright test`

16. `refactor(client): move inline script to ES module` — pindahkan script ke `public/src/app.js` sebagai satu module, tanpa mengubah urutan inisialisasi. Hapus inline script. E2E harus tetap lulus.
    → verify: `npx playwright test`

17. `refactor(client): make OSM and flood proxy-only` — hapus query dan parser Overpass dari client. Semua data OSM lewat `/api/osm`; overlay BNPB lewat `/api/flood`. Hapus request langsung ke pihak ketiga. Standarkan error API menjadi `{error:{code,message}}` di server dan client. Perbarui E2E agar tidak lagi meng-intercept Overpass dan memastikan hanya origin aplikasi plus tile OSM yang dihubungi.
    → verify: `npm test && python -m pytest -q && npx playwright test`

18. `feat(server): enforce strict CSP and static cache policy` — setelah tidak ada inline script, terapkan `script-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `connect-src 'self'`, `img-src 'self' data: blob: https://*.tile.openstreetmap.org`, dan allowlist font Google. Aset vendor memakai cache immutable; `index.html` dan module memakai revalidasi. Test header dan E2E memastikan tidak ada pelanggaran CSP.
    → verify: `python -m pytest -q tests/test_security_headers.py && npx playwright test`

19. `refactor(client): extract configuration and geo helpers` — pindahkan bounds, threshold, endpoint, haversine, point-in-polygon, dan helper format ke module murni. Tambah test nilai jarak yang diketahui dan kasus batas polygon (vertex, tepi, luar, polygon berulang).
    → verify: `npm test && npx playwright test`

20. `refactor(client): extract graph and pathfinding` — pindahkan pembangunan graph, MinHeap, Dijkstra, dan restore path ke module murni dengan state eksplisit. Test arah oneway, `oneway=-1`, edge terblokir, node tak terjangkau, dan tie-breaking.
    → verify: `npm test && npx playwright test`

21. `refactor(client): extract scenario analysis` — pindahkan perhitungan closed segments, ringkasan radius 5 km, nearest hospital, lima fasilitas, dan render data ke fungsi murni. UI hanya mengonsumsi hasil. Test memakai fixture yang sama dengan E2E.
    → verify: `npm test && npx playwright test`

22. `test: add analysis golden regression for fixed scenario` — simpan hasil karakterisasi dari commit 13 sebagai golden JSON dan bandingkan seluruh distance map, closed set, jumlah, dan urutan rute dengan toleransi `1e-6`. Ini adalah gate invariant.
    → verify: `npm test`

23. `refactor(client): remove superseded dark-theme CSS` — hapus blok tema lama yang ditimpa tema terang, aturan duplikat, dan font yang tidak dipakai. Jalankan E2E dan bandingkan screenshot desktop serta mobile sebelum/sesudah. Tidak ada perubahan visual yang disengaja.
    → verify: `npx playwright test`

24. `docs: align README with structure and operations` — perbaiki nama folder yang salah, struktur proyek, cara test, env var, fixture mode, Docker, Render, security model, batasan data, dan atribusi lisensi vendor. Hapus klaim yang tidak lagi benar.
    → verify: `python -c "from pathlib import Path; t=Path('README.md').read_text(); assert 'floodlens-jabodetabek' not in t" && python -m pytest -q`

25. `build: add Dockerfile, .dockerignore, and Render blueprint` — image `python:3.12-slim`, non-root, hanya runtime file, healthcheck `/healthz`, env `PORT`, tanpa dev dependency. Render blueprint memakai Docker, health check, dan `FLOODLENS_ENV=production`. Tambah script smoke container yang build, run, cek health, cek `/api/osm`, lalu cleanup.
    → verify: `bash scripts/container_smoke.sh`

26. `chore: final production verification` — jalankan seluruh gate, cek tidak ada referensi CDN, tidak ada secret, dan dokumentasikan rollback image. Tidak ada perubahan perilaku.
    → verify: `python -m pytest -q && npm test && npx playwright test && bash scripts/container_smoke.sh`

## Decision Document

### Modul dan tanggung jawab

- **Config**: seluruh env var, bounds pilot, endpoint upstream, TTL, timeout, dan validasi kombinasi mode production/fixture.
- **OSM domain**: query Overpass, simplifikasi, dedupe fasilitas, validasi schema dan koordinat, serta serialisasi JSON yang valid.
- **Flood client**: fetch overlay BNPB, validasi PNG, dan metadata cache.
- **Cache**: TTL generik, single-flight, stale-if-error, clock injectable.
- **Web layer**: routing, static serving terbatas `public/`, security header, error mapping, request log, healthcheck.
- **Entry point**: hanya membaca config dan menjalankan server.
- **Client config/geo**: konstanta dan matematika murni tanpa DOM.
- **Client graph**: graph adjacency, Dijkstra, path restoration.
- **Client analysis**: interpretasi skenario, ringkasan metrik, data untuk render.
- **Client API**: satu-satunya jalur ke backend, timeout, dan normalisasi error.
- **Client app**: Leaflet, DOM, event, dan render. Tidak mengandung algoritma graph.

### Kontrak API

- `GET /api/osm` mengembalikan `schemaVersion`, `source`, `roads`, `facilities`, dan `bounds`. `?refresh=1` memaksa pengambilan baru.
- `GET /api/flood` mengembalikan PNG. Server menangani cache dan ETag; client tidak pernah memanggil BNPB langsung.
- `GET /healthz` mengembalikan status aplikasi dan versi. Tidak memanggil upstream.
- Error memakai `{error:{code,message}}` dengan code `upstream_unavailable`, `upstream_invalid`, `fixture_unavailable`, atau `internal_error`.
- Tidak ada endpoint yang menerima input pengguna selain query `refresh`.

### Keputusan arsitektur

- **Satu parser.** Hanya Python yang memparsing Overpass. Client menerima schema tersederhanakan.
- **Static root terbatas.** Hanya `public/` yang disajikan; dotfile dan path traversal ditolak.
- **Vendor lokal.** Leaflet, Leaflet.draw, CSS, dan gambar marker disimpan di repo. Google Fonts tetap eksternal dengan allowlist CSP; self-host font di luar scope.
- **Tanpa build step.** ES module native; `node:test` untuk unit, Playwright untuk browser.
- **Fixture bukan fallback produksi.** Fixture hanya aktif lewat env eksplisit dan ditolak saat production.
- **Cache in-memory.** Cukup untuk satu instance demo. Multi-instance dan cache persisten di luar scope.
- **Analisis tetap di main thread.** Tidak ada Web Worker pada refactor ini; batas performa didokumentasikan.
- **Tidak ada auth.** Aplikasi read-only dan tidak menyimpan data pengguna.
- **Deployment satu instance.** Docker non-root + Render; tidak ada orkestrasi multi-region.

### Perubahan schema dan perilaku yang disengaja

- Respons OSM mendapat `schemaVersion`.
- Error API berubah dari string menjadi objek terklasifikasi.
- Client tidak lagi memiliki fallback langsung ke Overpass atau BNPB.
- Tidak ada perubahan pada bobot edge, aturan midpoint polygon, radius 5 km, atau snapping fasilitas.

### Batas keamanan

- CSP ketat, tanpa inline script.
- `connect-src 'self'`: semua data aplikasi lewat origin sendiri.
- `img-src` hanya self, data/blob, dan tile OSM.
- Tidak ada log nilai sensitif atau IP klien.
- Container berjalan sebagai non-root.
- Tidak ada rate limit pada refactor ini; dicatat sebagai batas demo satu instance.

## Testing Decisions

### Prinsip

Test yang baik menguji perilaku eksternal: schema API, hasil analisis, status HTTP, dan interaksi pengguna. Test tidak boleh bergantung pada nama fungsi internal, urutan iterasi Map, atau detail implementasi render. Tidak ada test yang memanggil Overpass atau BNPB live.

### Modul yang dites

- **Python OSM**: query, filter, dedupe, klasifikasi, validasi, serialisasi.
- **Python flood**: validasi content type, magic bytes, timeout, error.
- **Python cache**: TTL, single-flight, stale-if-error, concurrency.
- **Python web**: routing, static isolation, security header, health, error contract, fixture mode.
- **JS geo**: haversine, point-in-polygon, kasus batas.
- **JS graph**: arah edge, blockade, unreachable, tie-breaking, path restoration.
- **JS analysis**: golden scenario, metrik, urutan rute.
- **E2E**: load data, origin, draw polygon, metrik berubah, tidak ada console error, tidak ada request eksternal selain tile, CSP bersih.

### Prior art

Repo belum punya test. Pola yang ditetapkan:

- fixture JSON sintetis kecil dan dibaca oleh Python, Node, serta Playwright;
- server ephemeral di port 0 untuk test HTTP;
- monkeypatch fetch upstream, bukan menguji network;
- golden JSON untuk invariant analisis;
- E2E menjalankan server fixture sebagai `webServer` Playwright.

### Gate wajib

- `python -m pytest -q`
- `npm test`
- `npx playwright test`
- `bash scripts/container_smoke.sh`

## Out of Scope

- Web Worker, share URL, export GeoJSON/CSV.
- Auth, user account, database, cache persisten, multi-instance.
- Rate limiting, WAF, DDoS protection.
- Perubahan model hidrologi, kedalaman, waktu, lalu lintas, turn restriction, atau emergency routing.
- Perubahan metode closure midpoint dan threshold 5 km.
- Redesign visual, fitur mobile baru, PWA/offline.
- Self-host tile OSM atau font Google.
- Audit WCAG penuh; hanya smoke test aksesibilitas dan regresi E2E.
- Migrasi ke FastAPI, Node, atau TypeScript.
- Optimasi spatial index dan benchmark performa; dicatat sebagai batas yang diketahui.

## Further Notes

- **Hard gate**: nilai expected E2E harus diambil dari implementasi saat ini pada commit 13, sebelum ekstraksi logika client. Jangan membuat golden value setelah refactor.
- **Fixture harus representatif**: minimal satu rute alternatif, satu jalan buntu, satu oneway, dan satu fasilitas yang terputus. Tanpa itu, invariant test bisa lulus tanpa menguji skenario penting.
- **Risiko data live**: payload OSM berubah setiap saat. Test memakai fixture; smoke live manual dilakukan sekali per release, bukan di CI.
- **Rollback**: setiap commit dapat di-revert sendiri. Deploy memakai image tag; rollback berarti menjalankan tag sebelumnya.
- **Batasan performa**: Dijkstra dan snapping tetap di main thread. Untuk pilot area ini masih wajar; bila bounds diperluas, langkah berikutnya adalah Web Worker dan spatial index.
- **Langkah berikutnya**: jalankan `kickoff-branch` untuk membuat branch refactor, lalu eksekusi commit 2 sampai 26 secara berurutan.

## Execution Status (2026-10-21)

Implemented on branch `refactor/production-hardening` in 25 commits.

Gates passing locally:

- `python -m pytest -q` — 43 passed.
- `python -m ruff check .` — clean.
- `npm test` — 13 passed.
- `npx playwright test` — 1 scenario passed, no console or external request.
- `bash scripts/container_smoke.sh` — image builds, non-root server starts, `/healthz` and `/` respond.

Deviations from the original commit sequence:

- Inline JavaScript extraction and the proxy-only API change landed in one commit.
- Configuration and geo-helper extraction was committed after the deployment files; the files were present and tested earlier.
- Dead-CSS cleanup removed only the superseded dark-theme `:root` variables. Full duplicate-rule removal is deferred because it needs a screenshot baseline across desktop and mobile.

Known limits after this refactor: in-memory single-instance cache, no auth or rate limiting, main-thread analysis, and third-party map tiles and fonts.
