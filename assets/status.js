export const TIME_ZONE = 'Asia/Jakarta';
export const DEFAULT_SCHEDULE = {
  timezone: TIME_ZONE,
  hours: [8, 15, 16, 17, 18, 19, 20, 21, 22, 23],
  minute: 0,
};
const DAY = 86_400_000;
const OFFSET = 7 * 60 * 60 * 1000;
const failures = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'stale']);

export function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function dateKey(value) {
  const date = validDate(value);
  return date ? new Date(date.getTime() + OFFSET).toISOString().slice(0, 10) : null;
}

export function formatDate(value, options = {}) {
  const date = validDate(value);
  if (!date) return 'Belum ada';
  return new Intl.DateTimeFormat('id-ID', { timeZone: TIME_ZONE, day: 'numeric', month: 'short', year: 'numeric', ...options }).format(date);
}

export function formatTime(value) {
  const date = validDate(value);
  if (!date) return '—';
  return `${new Intl.DateTimeFormat('id-ID', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date)} WIB`;
}

export function formatRunDate(value) {
  const date = validDate(value);
  if (!date) return 'Waktu tidak tersedia';
  const time = new Intl.DateTimeFormat('id-ID', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  return `${formatDate(date)}, ${time} WIB`;
}

export function relativeTime(value, now = new Date()) {
  const date = validDate(value);
  if (!date) return 'Belum pernah berhasil';
  const seconds = Math.max(0, Math.floor((now - date) / 1000));
  if (seconds < 60) return 'baru saja';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} menit yang lalu`;
  if (seconds < DAY / 1000) return `${Math.floor(seconds / 3600)} jam yang lalu`;
  return `${Math.floor(seconds / (DAY / 1000))} hari yang lalu`;
}

export function formatDuration(value, short = false) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const seconds = Math.max(0, Math.round(Number(value)));
  if (seconds < 60) return `${seconds} ${short ? 'dtk' : 'detik'}`;
  return `${Math.floor(seconds / 60)} ${short ? 'mnt' : 'menit'}${seconds % 60 ? ` ${seconds % 60} ${short ? 'dtk' : 'detik'}` : ''}`;
}

export function runState(run) {
  if (!run) return 'waiting';
  if (run.status !== 'completed') return 'running';
  if (run.conclusion === 'success') return 'success';
  if (failures.has(run.conclusion)) return 'failure';
  if (run.conclusion === 'cancelled') return 'cancelled';
  return 'waiting';
}

export function hasSucceededOnDate(runs = [], lastSuccess = null, targetDateKey) {
  if (!targetDateKey) return false;
  if (lastSuccess && runState(lastSuccess) === 'success' && dateKey(lastSuccess.startedAt || lastSuccess.completedAt) === targetDateKey) {
    return true;
  }
  return Array.isArray(runs) && runs.some((run) => runState(run) === 'success' && dateKey(run.startedAt) === targetDateKey);
}

export function nextSchedule(now = new Date(), schedule = DEFAULT_SCHEDULE, { succeededToday = false } = {}) {
  const key = dateKey(now);
  const midnight = Date.parse(`${key}T00:00:00+07:00`);
  const hours = (schedule?.hours?.length ? schedule.hours : DEFAULT_SCHEDULE.hours)
    .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour < 24)
    .sort((a, b) => a - b);
  const minute = Number.isInteger(schedule?.minute) ? schedule.minute : DEFAULT_SCHEDULE.minute;
  const startDay = succeededToday ? 1 : 0;
  for (let day = startDay; day < 2; day += 1) {
    for (const hour of hours) {
      const time = new Date(midnight + day * DAY + hour * 3_600_000 + minute * 60_000);
      if (time > now) return { date: time, label: `${day === 0 ? 'Hari ini' : 'Besok'}, ${String(hour).padStart(2, '0')}.${String(minute).padStart(2, '0')}` };
    }
  }
  return null;
}

export function dailyActivity(runs, now = new Date(), count = 30) {
  const today = Date.parse(`${dateKey(now)}T12:00:00+07:00`);
  const byDay = new Map();
  for (const run of runs) {
    const key = dateKey(run.startedAt);
    if (!key) continue;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(run);
  }
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(today - (count - 1 - index) * DAY);
    const key = dateKey(date);
    const dayRuns = (byDay.get(key) || []).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    // Once a retry succeeds on a given WIB day, the daily target (1x commit) is achieved.
    const state = dayRuns.some((run) => runState(run) === 'running') ? 'running'
      : dayRuns.some((run) => runState(run) === 'success') ? 'success'
      : dayRuns.some((run) => runState(run) === 'failure') ? 'failure'
      : dayRuns.length ? runState(dayRuns[0]) : 'waiting';
    return { date, key, state, runs: dayRuns };
  });
}

export function validateSnapshot(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.runs)) {
    throw new Error('Format data status tidak dikenali. Coba perbarui halaman.');
  }
  const validRun = (run) => run && Number.isSafeInteger(run.id) && Number.isSafeInteger(run.number)
    && ['completed', 'in_progress', 'queued'].includes(run.status)
    && validDate(run.startedAt)
    && (run.completedAt == null || validDate(run.completedAt))
    && (run.durationSeconds == null || (typeof run.durationSeconds === 'number' && Number.isFinite(run.durationSeconds) && run.durationSeconds >= 0));
  if (value.runs.some((run) => !validRun(run)) || (value.latestRun && !validRun(value.latestRun))
    || (value.lastSuccess && (!validRun(value.lastSuccess) || value.lastSuccess.conclusion !== 'success'))
    || (value.generatedAt && !validDate(value.generatedAt))) throw new Error('Data eksekusi belum lengkap.');
  if (value.schedule && (!Array.isArray(value.schedule.hours) || !value.schedule.hours.length
    || value.schedule.hours.some((hour) => !Number.isInteger(hour) || hour < 0 || hour > 23)
    || !Number.isInteger(value.schedule.minute) || value.schedule.minute < 0 || value.schedule.minute > 59
    || value.schedule.timezone !== TIME_ZONE)) throw new Error('Format data status tidak dikenali.');
  if (value.error && (!Array.isArray(value.error.details) || value.error.details.some((line) => typeof line !== 'string'))) {
    throw new Error('Format data status tidak dikenali.');
  }
  return value;
}

export function safeURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

export function statusCopy(snapshot, now = new Date()) {
  const state = runState(snapshot.latestRun);
  const last = snapshot.lastSuccess?.completedAt || snapshot.lastSuccess?.startedAt;
  const captions = {
    success: ['Semua berjalan lancar.', 'Commit harianmu sudah tersimpan. Sampai jumpa di jadwal berikutnya.', `Terakhir berhasil ${relativeTime(last, now)}`],
    failure: ['Ada yang perlu diperiksa.', 'Eksekusi terakhir belum berhasil. Detail penyebabnya ada di bawah.', last ? `Terakhir berhasil ${relativeTime(last, now)}` : 'Belum ada eksekusi yang berhasil'],
    running: ['Automasi sedang berjalan.', 'Commit harianmu sedang diproses. Status diperbarui setelah eksekusi selesai.', last ? `Terakhir berhasil ${relativeTime(last, now)}` : 'Menyiapkan commit pertamamu'],
    cancelled: ['Eksekusi dibatalkan.', 'Eksekusi terakhir dihentikan sebelum selesai. Jadwal berikutnya tetap tersedia.', last ? `Terakhir berhasil ${relativeTime(last, now)}` : 'Belum ada eksekusi yang berhasil'],
    waiting: ['Menunggu eksekusi pertama.', 'Status akan muncul setelah automasi pertamamu berjalan.', 'Belum ada eksekusi yang tercatat'],
  };
  if (snapshot.latestRun?.conclusion === 'skipped' || snapshot.latestRun?.conclusion === 'neutral') {
    return { state, title: 'Eksekusi terakhir dilewati.', description: 'GitHub tidak menjalankan proses commit pada eksekusi ini.', caption: last ? `Terakhir berhasil ${relativeTime(last, now)}` : 'Belum ada eksekusi yang berhasil' };
  }
  const [title, description, caption] = captions[state];
  return { state, title, description, caption };
}
