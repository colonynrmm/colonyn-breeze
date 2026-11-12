# Colonyn untuk Breeze RMM v0.123.0

Paket ini berisi tiga hal di atas Breeze v0.123.0:

1. **Colonyn Bridge**: API kecil yang dipanggil Odoo untuk membuat tenant (partner) baru, mengubah paket, modul, dan batas teknisi, suspend, aktifkan lagi, menghentikan langganan, dan mengirim ulang undangan.
2. **White-label**: nama "Breeze" diganti "Colonyn" di web app, email akun, label authenticator, dan logo.
3. **Modul per paket** (`apps/api/src/colonyn/entitlements/`, `apps/web/src/colonyn/`): modul PSA, AI, Backup & DR, Security lanjutan, dan Integrasi bisa dimatikan per tenant, plus batas jumlah teknisi. Lihat bagian *Modul dan batas teknisi*.

Service `web`, `api`, `worker`, dan `colonyn-bridge` memakai image Colonyn yang dibangun di server (`colonyn/build.sh`). Service `portal` tetap memakai image resmi LanternOps. File upstream yang diubah ditandai komentar `COLONYN` (daftar lengkap di bagian *Modul dan batas teknisi*); daftar itu yang perlu dicek setiap kali Breeze di-upgrade.

```
Odoo (server di LAN) --HTTPS + Bearer + HMAC--> Caddy (bridge.colonyn.com, IP allow-list)
                                                   |
                                                   v
                                         colonyn-bridge:3010  --(kode resmi Breeze)--> Postgres / Redis / SMTP
                                                   ^
              Breeze api  --PARTNER_HOOKS_URL------+   (device-limit dan sebagainya)
              colonyn-bridge --event bertanda tangan--> Odoo /colonyn/webhook/breeze
```

## Isi paket

| Path | Fungsi |
|---|---|
| `apps/api/src/colonyn/bridge/` | Kode Bridge (TypeScript). Dibundel menjadi `dist/colonyn-bridge.cjs` di image API Colonyn |
| `apps/api/tsup.config.ts` | Menambah entry build `colonyn-bridge` |
| `apps/api/vitest.config.colonyn.ts` | Unit test Bridge |
| `colonyn/branding/apply-branding.mjs` | Patch white-label, idempotent. Berhenti dengan error kalau file upstream berubah |
| `colonyn/docker-compose.colonyn.yml` | Overlay compose: web bermerek, service `colonyn-bridge`, Caddy |
| `colonyn/Caddyfile.colonyn` | Caddyfile stock + satu site untuk Bridge |
| `colonyn/env.colonyn.example` | Variabel tambahan untuk `.env` |
| `colonyn/build.sh` | Build image di server |
| `colonyn/bridge_client.py` | Klien Python (stdlib saja). Referensi untuk modul Odoo |
| `colonyn/tests/e2e_bridge.py` | Tes end-to-end. Jalankan ke Breeze **staging** |

## Pemasangan di server my.colonyn.com

**Prasyarat**
- Record DNS **A `bridge.colonyn.com` → IP server Breeze** di penyedia DNS Anda.
- RAM kosong sekitar 6 GB (atau swap) untuk proses build, dan disk kosong sekitar 10 GB.

**1. Siapkan source**

```bash
git clone --branch v0.123.0 --depth 1 https://github.com/LanternOps/breeze.git /opt/colonyn-breeze
tar -xzf colonyn-overlay-v0.123.0.tar.gz -C /opt/colonyn-breeze
# opsional: taruh logo sendiri
cp logo.svg favicon.svg /opt/colonyn-breeze/colonyn/branding/
```

**2. Tambah variabel ke `/opt/breeze/.env`**

Salin isi `colonyn/env.colonyn.example`, lalu isi setiap secret dengan `openssl rand -hex 32`. Untuk `COLONYN_TEMPLATE_PARTNER_ID`, ambil id Default Partner:

```bash
cd /opt/breeze
docker compose exec -T postgres psql -U breeze -d breeze -Atc "select id from partners where name='Default Partner'"
```

**3. Build dan jalankan**

```bash
sudo bash /opt/colonyn-breeze/colonyn/build.sh
cd /opt/breeze
docker compose -f docker-compose.yml -f docker-compose.colonyn.yml up -d
docker compose -f docker-compose.yml -f docker-compose.colonyn.yml ps
docker compose -f docker-compose.yml -f docker-compose.colonyn.yml logs colonyn-bridge --tail 30
```

Mulai sekarang, **setiap perintah compose harus memakai kedua file**. Agar tidak lupa, tambahkan ke `.env`:

```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.colonyn.yml
```

Setelah baris itu ada, perintah `docker compose up -d` biasa sudah otomatis memakai keduanya.

**4. Cek**
- `https://my.colonyn.com/login` menampilkan "Colonyn", dan judul tab "Sign In | Colonyn RMM".
- Dari server Odoo:
  ```bash
  python3 bridge_client.py https://bridge.colonyn.com <TOKEN> <HMAC_SECRET> GET /v1/tenants/tes-404
  ```
  Hasil yang benar adalah `404 TENANT_NOT_FOUND`. Itu menandakan autentikasi dan jalur jaringan sudah benar. Dari IP lain, Bridge harus menjawab `403 Forbidden`.

## Kontrak API untuk Odoo

Base URL: `https://bridge.colonyn.com`. Setiap request wajib membawa header berikut:

```
Authorization: Bearer <COLONYN_BRIDGE_TOKEN>
X-Colonyn-Timestamp: <unix detik>
X-Colonyn-Signature: sha256=<hex HMAC_SHA256(COLONYN_BRIDGE_HMAC_SECRET, ts + "\n" + METHOD + "\n" + path + "\n" + body)>
```

`path` termasuk query string. `body` adalah string JSON persis seperti yang dikirim (kosong untuk GET). Request dengan selisih waktu lebih dari 300 detik ditolak, jadi pastikan NTP aktif di server Odoo.

`subscription_ref` adalah kunci tenant: string stabil dari Odoo yang hanya boleh berisi huruf, angka, `.`, `_`, dan `-`. Contoh: `odoo-sub-42` dari id record subscription. Jangan memakai nama dengan `/` seperti `SUB/2026/0001`.

| Method | Path | Body | Hasil |
|---|---|---|---|
| POST | `/v1/tenants` | `subscription_ref, company_name, admin_name, admin_email, plan, max_organizations, max_devices` | `201` tenant baru, atau `200` kalau ref sudah ada (aman diulang). `409 EMAIL_IN_USE` |
| GET | `/v1/tenants/{ref}` | | Status, paket, kuota, admin, pemakaian `{organizations, sites, devices}` |
| PATCH | `/v1/tenants/{ref}/plan` | `plan, max_organizations, max_devices` | Kuota baru langsung berlaku |
| POST | `/v1/tenants/{ref}/suspend` | `reason?` | `suspended`: login ditolak (`403 PARTNER_INACTIVE`), token agent dibekukan |
| POST | `/v1/tenants/{ref}/reactivate` | `reason?` | `active` lagi, token agent dipulihkan. Bisa juga membatalkan `cancel` |
| POST | `/v1/tenants/{ref}/cancel` | `reason?` | `offboarding`: user langsung keluar, agent hanya menerima perintah uninstall, lalu `churned` |
| POST | `/v1/tenants/{ref}/invite` | `admin_email?, admin_name?` | Kirim ulang undangan, bisa sekaligus mengganti email. `409 ALREADY_ACCEPTED` kalau akun sudah aktif |

Keterangan nilai:
- `plan`: salah satu dari `free | starter | community | pro | enterprise | unlimited`.
- `max_*`: `null` berarti tanpa batas.
- Organisasi default yang dibuat otomatis sudah dihitung dalam `max_organizations`.
- Suspend, reactivate, dan cancel aman diulang. Kalau status sudah sama, hasilnya `changed: false`.

**Undangan.** Kalau Breeze gagal mengirim email, respons berisi `invite: {sent: false, invite_url, warning}`. Dalam kasus itu Odoo sebaiknya mengirim `invite_url` lewat email Odoo sendiri. Link berlaku 7 hari.

**Format error.** Semua error berbentuk `{"error": {"code", "message", "details?"}}`. Kode yang mungkin muncul: `UNAUTHORIZED`, `BAD_SIGNATURE`, `VALIDATION_FAILED` (422, dengan `details` per field), `TENANT_NOT_FOUND`, `EMAIL_IN_USE`, `ALREADY_ACCEPTED`, `TENANT_CHURNED`, `TENANT_OFFBOARDING`.

**Modul dan teknisi (opsional di `POST /v1/tenants` dan `PATCH .../plan`).** `features`: daftar modul yang termasuk paket, dari `psa | ai | backup | security_plus | integrations` (`[]` = fitur inti saja). `max_technicians`: jumlah teknisi, `null` = tanpa batas. Kalau `features` tidak dikirim, modul tenant tidak diubah (tenant lama tetap bisa semua modul). Respons `GET` berisi `features` (`null` = semua modul), `max_technicians`, `usage.technicians`, dan `warnings` (`TECHNICIANS_OVER_LIMIT`).

**Event ke Odoo.** Kalau `COLONYN_ODOO_WEBHOOK_URL` diisi, Bridge mengirim `POST` dengan body seperti di bawah, memakai skema tanda tangan yang sama (method `POST`, path dari URL webhook). Verifikasi dengan `verify_event()` di `bridge_client.py`.

```json
{"event": "breeze.device-limit", "subscription_ref": "odoo-sub-42", "partner_id": "...", "data": {...}, "sent_at": "..."}
```

## Modul dan batas teknisi

Bridge menyimpan modul per tenant di tabel `colonyn_bridge.entitlements` (satu baris per partner). Partner tanpa baris (misalnya partner milik Anda sendiri) tetap bisa memakai semua modul. API membaca tabel itu dengan cache 30 detik, jadi perubahan paket berlaku paling lambat 30 detik kemudian.

| Modul | Yang dikunci kalau tidak ada di paket |
|---|---|
| `psa` | Tiket, timesheet, kontrak, quote, invoice, katalog, billing klien, deliverables, Trust Center, dokumen; di portal klien: tiket, approval, quote, invoice, dokumen. Mode Service Desk dimatikan otomatis dan dipulihkan saat modul kembali |
| `ai` | AI chat, AI agent, Fleet, AI untuk Office, MCP server, saran remediasi. AI untuk Office dinyalakan/dimatikan otomatis |
| `backup` | Backup, C2C (M365/Google), Disaster Recovery; job backup terjadwal dilewati |
| `security_plus` | EDR, SentinelOne, Huntress, DNS security, PAM, user risk, sensitive data, peripheral, browser security, CIS, audit baseline. Ringkasan Security dan IOC scan tetap inti |
| `integrations` | API key, service principal, webhook keluar, integrasi pihak ketiga, plugin, tool source, connected apps, konfigurasi SSO (login SSO yang sudah jalan tetap aktif) |

Penolakan dari API berbentuk `403 {"code": "FEATURE_NOT_IN_PLAN", "feature", "upgradeUrl"}`; web app menyembunyikan menu modul itu dan menampilkan kartu "Upgrade plan" bila halamannya dibuka langsung. Data lama tidak dihapus dan muncul lagi begitu modul ditambahkan.

**Batas teknisi.** Dihitung dari user aktif atau diundang (bukan platform admin) yang punya keanggotaan di partner atau organisasinya. Undangan baru dan login SSO pertama ditolak dengan `403 TECHNICIAN_LIMIT` saat kuota penuh. User yang sudah ada tidak pernah dikunci; kalau kuota diturunkan di bawah jumlah user, Bridge melaporkan `TECHNICIANS_OVER_LIMIT`.

**Mematikan semua pemeriksaan:** set `COLONYN_ENTITLEMENTS=off` di `.env`, lalu `docker compose ... up -d api worker`. Semua tenant kembali bisa semua modul tanpa menghapus data paket.

**File upstream yang diubah** (cari komentar `COLONYN`): `middleware/auth.ts`, `routes/portal/index.ts`, `routes/partnerApi/index.ts`, `routes/mcpServer.ts`, `routes/orgs.ts`, `routes/users.ts`, `routes/sso.ts`, `services/aiModels/resolveModel.ts`, `jobs/backupWorker.ts`, `jobs/c2cBackupWorker.ts`, `jobs/aiAgentSweepScheduler.ts`, web `layouts/DashboardLayout.astro`, `components/layout/Sidebar.tsx`. Tes kontrak `featureMap.contract.test.ts` gagal kalau Breeze versi baru menambah router yang belum diklasifikasi.

## Template email

Bridge menyalin semua template dari partner `COLONYN_TEMPLATE_PARTNER_ID` (yang Anda ubah di **Settings → Partner → Email templates**) ke setiap tenant baru. Kalau template `staff_invite` belum ada, Bridge memakai template bawaan Colonyn berbahasa Indonesia. Setelah tenant dibuat, customer bebas mengubah template mereka sendiri.

## Upgrade Breeze

1. Clone tag baru ke folder baru, ekstrak overlay, lalu jalankan `node colonyn/branding/apply-branding.mjs --check`. Kalau script berhenti dengan "Upstream files changed", aturan branding perlu disesuaikan dulu.
2. Uji di staging: `apps/api` → `pnpm exec vitest run --config vitest.config.colonyn.ts` (Bridge, modul, dan tes kontrak peta fitur), `apps/web` → `pnpm exec vitest run src/colonyn`, lalu jalankan `colonyn/tests/e2e_bridge.py` ke Bridge staging.
3. Naikkan `COLONYN_IMAGE_TAG` dan versi di `build.sh` / compose, build, lalu `up -d`.

**Rollback:** kembalikan `COLONYN_IMAGE_TAG` ke tag sebelumnya di `.env`, lalu `docker compose -f docker-compose.yml -f docker-compose.colonyn.yml up -d`. Tabel `colonyn_bridge.entitlements` diabaikan oleh image lama. Untuk kembali ke image resmi sepenuhnya: hapus `docker-compose.colonyn.yml` dari perintah compose. Skema `colonyn_bridge` di database tidak mengganggu Breeze.

## Lisensi

Breeze berlisensi AGPL-3.0. Karena web app dimodifikasi (branding) dan Bridge berjalan bersama Breeze untuk pengguna Anda, source versi Colonyn wajib bisa diunduh pengguna. Cara paling mudah: fork publik di GitHub berisi perubahan ini, dengan link "Kode sumber" di syarat layanan atau halaman login. Folder `ee/` tidak disentuh.
