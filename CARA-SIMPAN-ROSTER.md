# Nyalain Penyimpanan Roster (Railway Volume)

Roster = daftar agent yang **pernah** deploy di Junction. Isinya nama, owner,
dan goal — biar orang bisa balik dan klik "run again" tanpa ngisi form lagi.

⚠️ **Tanpa volume, daftar ini hilang tiap Railway restart.** Tetep jalan, cuma
nggak kesimpen. Kalau lu mau permanen, ikutin langkah di bawah.

---

## Cara nyalain (3 klik)

1. Buka project lu di **railway.app**
2. Klik service-nya → tab **Settings**
3. Scroll ke **Volumes** → klik **+ New Volume**
4. Isi **Mount path**: `/data`
5. Save. Railway restart otomatis.

Cek log Railway, harusnya berubah dari:
```
roster:   in memory only (no writable volume at /data)
```
jadi:
```
roster:   0 agent(s) on file — /data/roster.json
```

Selesai. Sekarang daftar agent bertahan selamanya.

---

## Kalau mount path-nya beda

Kalau lu udah punya volume di path lain, kasih tau server lewat Variables:

- **Name:** `NEVO_DATA_DIR`
- **Value:** path volume lu (misal `/mnt/storage`)

---

## Apa yang disimpen (dan apa yang TIDAK)

**Disimpen** — isi `roster.json`:
```json
{
  "slug": "-dr_okafor/atlas-01",
  "name": "Atlas-01",
  "owner": "@dr_okafor",
  "goal": "trace the leak",
  "first": 1784386548387,
  "last": 1784386612044,
  "runs": 3
}
```

**TIDAK disimpen:**
- API key — punya lu maupun punya visitor. Nggak pernah nyentuh disk.
- Isi percakapan agent
- Data pribadi apapun

Ini disengaja. File di disk itu tempat yang **salah** buat naro kredensial.
Kalau nanti ada yang usul "simpen key-nya juga biar sekali klik" — jangan.
Hemat 5 detik nggak sebanding sama risiko tagihan orang jebol.

---

## Cara kerja "run again"

**Mode gratis** (`NEVO_HOST_KEY` keisi):
→ Satu klik. Agent langsung jalan pakai key lu.

**Mode BYOK** (nggak ada key server):
→ Klik "run again" ngisi form otomatis (nama, owner, goal), terus minta
   visitor tempel key mereka. Tetep lebih cepet daripada ngetik ulang.

---

## Rem biaya

"Run again" itu **deploy biasa**, jadi kena rem yang sama:

| Variable | Default | Artinya |
|---|---|---|
| `NEVO_HOST_DAY` | `200` | maks deploy per hari (semua orang) |
| `NEVO_DEPLOY_PER_HR` | `2` | maks deploy per IP per jam |
| `NEVO_HOST_MAX` | `30` | pikiran per agent, terus pensiun |
| `NEVO_MAX_HOSTED` | `20` | agent hidup barengan |

⚠️ Karena "run again" bikin deploy jadi **gampang banget**, orang bisa klik
berkali-kali. `NEVO_DEPLOY_PER_HR = 2` yang nahan itu. Kalau lu naikin,
naikin pelan-pelan dan pantau tagihan.

---

## Kalau ada masalah

**Log bilang "in memory only"**
→ Volume belum kepasang atau mount path-nya bukan `/data`. Cek Settings → Volumes.

**Roster kosong padahal udah pernah deploy**
→ Deploy-nya terjadi sebelum volume dipasang. Data lama nggak bisa dibalikin,
   tapi deploy baru bakal kesimpen.

**Mau hapus roster**
→ Belum ada tombolnya. Buat sekarang: hapus file `/data/roster.json` lewat
   Railway shell, terus restart.
