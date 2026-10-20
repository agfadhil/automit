# Automit

Halaman status untuk commit harian otomatis. Tampilan menggunakan HTML, CSS, dan JavaScript biasa; tidak memerlukan framework, dependency produksi, atau Personal Access Token.

## Setup sekali

1. Simpan semua file proyek ini di **default branch** sebuah repository GitHub milikmu, misalnya `main`. Gunakan repository asli, bukan fork, agar commit memenuhi syarat kontribusi profil.
2. Pada repository, buka **Settings → Pages → Build and deployment → Source**, pilih **GitHub Actions**. Ini diperlukan agar workflow dapat memublikasikan halaman status.
3. Pastikan GitHub Actions aktif dan aturan default branch mengizinkan workflow melakukan push. Workflow meminta izin `contents: write`; aturan organisasi atau ruleset tetap dapat memblokirnya. Untuk repo kerja yang dilindungi, gunakan repo pribadi terpisah daripada melemahkan aturan repo kerja.

Push konfigurasi workflow pertama kali akan menjalankan commit otomatis. Setelah itu jadwal berjalan setiap hari pada **09.17 WIB**, dengan percobaan cadangan pada **17.17 WIB**. Jika tanggal hari ini sudah tercatat, percobaan cadangan selesai tanpa commit tambahan. Tidak ada commit manual harian.

URL halaman tersedia pada **Settings → Pages** setelah workflow **Publish Automation Status** berhasil. Jika publikasi pertama berjalan sebelum Pages diaktifkan, jalankan **Publish Automation Status → Run workflow** sekali setelah memilih Source di atas, atau tunggu eksekusi harian berikutnya. Ini hanya langkah setup, bukan kewajiban harian.

## Identitas commit

Secara default, commit diatribusikan kepada pengguna yang memicu workflow menggunakan `ID+username@users.noreply.github.com`. Untuk schedule, GitHub menentukan actor berdasarkan pengguna yang terakhir mengubah jadwal. Jika ingin identitas selalu tetap, isi repository **Settings → Secrets and variables → Actions → Variables**:

| Variable | Isi |
| --- | --- |
| `COMMIT_AUTHOR_NAME` | Nama atau username GitHub milikmu |
| `COMMIT_AUTHOR_EMAIL` | Email commit yang terhubung ke akunmu; salin alamat noreply persis dari GitHub Settings → Emails |

Email author harus terhubung ke akun GitHub agar commit masuk ke grafik kontribusimu. Untuk menampilkan kontribusi repo private pada profil, aktifkan **Private contributions** pada profil GitHub.

## Cara status diperbarui

- **Daily Auto Commit** mencatat tanggal WIB, timestamp sebenarnya, run ID, dan referensi workflow pada `data/activity.json`, lalu commit dan push file itu saja. Maksimal satu commit aktivitas per tanggal; push yang berbenturan dicoba kembali tanpa force-push.
- **Publish Automation Status** berjalan setelah workflow harian selesai, termasuk ketika gagal. Workflow ini membaca hasil dari GitHub Actions API, menyimpan snapshot `data/status.json` dalam artifact halaman, lalu melakukan deploy ke Pages. Status tidak bergantung pada keberhasilan push commit harian.
- Snapshot menyertakan eksekusi terbaru, keberhasilan terakhir, durasi, riwayat, dan ringkasan kegagalan terakhir. Detail kegagalan tetap dapat dibaca setelah automasi pulih. SHA commit mengacu pada commit yang benar-benar dipush; eksekusi cadangan yang tidak membuat commit memiliki SHA kosong. “Terakhir berhasil” berarti eksekusi terakhir yang sukses, termasuk eksekusi cadangan tanpa commit baru.
- Publikasi tidak membuat commit tambahan dan tidak mengunduh atau menjalankan artifact dari workflow pemicu. Checkout selalu berasal dari default branch repo sendiri.

Data yang terlihat pada Pages adalah **snapshot terakhir yang berhasil diterbitkan**, bukan koneksi langsung ke runner. Jika workflow pelapor atau deploy Pages sendiri gagal, halaman lama tetap terlihat; perhatikan waktu pembaruan dan buka tab Actions untuk diagnosis. Workflow yang belum pernah berjalan tidak ditampilkan sebagai sukses.

## Detail error

Untuk repo publik, pesan annotation error GitHub diterbitkan setelah dibatasi panjangnya dan disaring untuk pola kredensial umum. Log mentah tidak pernah dipublikasikan. Link **GitHub Actions** membuka log lengkap.

Untuk repo private, detail annotation tidak diterbitkan secara default; halaman tetap menampilkan hasil gagal serta nama job/langkah. Untuk mengizinkan detail error pada halaman, set variable `PUBLISH_ERROR_DETAILS=true`. Isi `false` untuk menonaktifkan detail pada repo publik sekalipun. Perlakukan isi halaman Pages sebagai informasi yang dapat dilihat pengunjung halaman; penyaringan pola bukan jaminan penghapusan semua informasi sensitif.

## Pengembangan lokal

Jalankan server pengembangan dari folder proyek:

```sh
npm run dev
```

Buka alamat localhost yang ditampilkan server. Halaman tanpa snapshot run akan menampilkan kondisi belum ada eksekusi. Jangan menyimpan token GitHub di JavaScript browser.

Untuk melihat desain dengan **data contoh yang diberi label demo**, buka `http://127.0.0.1:4173/?demo=success` atau `?demo=error`. Mode `?demo=running` dan `?demo=waiting` juga tersedia. Halaman normal tidak memakai data contoh. Parameter demo hanya memengaruhi tampilan browser, tidak menjalankan atau mengubah workflow.

Tombol **Perbarui** mengambil ulang snapshot halaman; pemeriksaan ulang juga berjalan setiap 60 detik saat tab terlihat. Klik batang aktivitas untuk melihat ringkasan pada tanggal tersebut. Riwayat menampilkan tiga eksekusi terakhir, bisa diperluas, serta menyediakan detail kegagalan terakhir dan tautan log GitHub. Detail error dapat disalin.

Jalankan seluruh tes dan periksa sintaks frontend:

```sh
npm test
npm run check
```

Uji pengumpulan status, redaksi error, idempotensi commit, email author, dan batas tanggal WIB:

```sh
node --test tests/automation.test.mjs
```

`scripts/daily-commit.mjs` hanya boleh dijalankan dalam checkout runner GitHub Actions sementara; script menolak checkout lokal biasa. `scripts/build-status.mjs` dipakai oleh workflow publikasi untuk membuat folder `dist/`.

## Batasan layanan

GitHub Actions dapat menunda atau melewatkan jadwal ketika antrean sibuk; dua jadwal mengurangi risiko tetapi tidak menjamin streak tanpa putus. Jadwal repo publik otomatis dinonaktifkan setelah 60 hari tanpa aktivitas repo. Pages serta kuota/izin Actions bergantung pada pengaturan dan paket GitHub yang digunakan.

Dokumentasi resmi: [Schedule dan workflow_run](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), [kriteria kontribusi](https://docs.github.com/en/account-and-profile/reference/profile-contributions-reference), [GitHub Pages dengan Actions](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
