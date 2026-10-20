import { dailyActivity, formatDate, formatDuration, formatRunDate, formatTime, nextSchedule, relativeTime, runState, safeURL, statusCopy, validateSnapshot } from './status.js';

const $ = (id) => document.getElementById(id);
const demoMode = new URLSearchParams(location.search).get('demo');
const isDemo = ['success', 'error', 'running', 'waiting'].includes(demoMode);
let currentSnapshot = null;
let showAll = false;
let selectedDay = null;
let toastTimer;
let activeError = null;
let refreshing = false;

const icons = {
  success: '<path d="m7 16 6 6L25 10"/>',
  failure: '<path d="m10 10 12 12M22 10 10 22"/>',
  running: '<path d="M16 6a10 10 0 1 0 10 10"/><path d="m21 6 5 1-1 5"/>',
  cancelled: '<path d="M12 10v12m8-12v12"/>',
  waiting: '<circle cx="16" cy="16" r="10"/><path d="M16 10v6l4 3"/>',
};

function symbol(state) { return `<svg viewBox="0 0 32 32" aria-hidden="true">${icons[state] || icons.waiting}</svg>`; }
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function linkURL(node, value) { const url = safeURL(value); if (url) { node.href = url; node.hidden = false; } else { node.removeAttribute('href'); node.hidden = true; } }
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500); }

function renderHistory(snapshot) {
  const history = $('history-list');
  history.replaceChildren();
  const runs = snapshot.runs;
  $('empty-history').hidden = runs.length > 0;
  $('show-more').hidden = runs.length <= 3;
  $('show-more').textContent = showAll ? 'Tampilkan lebih sedikit' : `Lihat semua ${runs.length} eksekusi`;
  $('show-more').setAttribute('aria-expanded', String(showAll));
  for (const run of showAll ? runs : runs.slice(0, 3)) {
    const state = runState(run);
    const row = element('article', 'history-row');
    const statusIcon = element('span', 'run-symbol');
    statusIcon.dataset.state = state;
    statusIcon.innerHTML = symbol(state);
    const copy = element('div', 'run-copy');
    const titles = { success: run.commitSha ? 'Commit harian berhasil' : 'Eksekusi harian berhasil', failure: 'Automasi harian gagal', running: 'Automasi sedang berjalan', cancelled: 'Eksekusi dibatalkan', waiting: 'Eksekusi dilewati' };
    copy.append(element('h3', '', titles[state]));
    const time = element('time', '', formatRunDate(run.startedAt));
    if (run.startedAt) time.dateTime = run.startedAt;
    copy.append(time);
    row.append(statusIcon, copy, element('span', 'run-duration', formatDuration(run.durationSeconds, true)));
    const canInspect = state === 'failure' && snapshot.error && Number(snapshot.error.runId) === Number(run.id);
    const action = element(canInspect ? 'button' : 'a', `run-link${state === 'failure' ? ' run-link--error' : ''}`);
    action.setAttribute('aria-label', `${state === 'failure' ? 'Lihat detail kegagalan' : 'Buka log'} run ${run.number}`);
    if (canInspect) {
      action.type = 'button';
      action.style.border = 'none';
      action.style.background = 'transparent';
      action.append(element('span', '', 'Lihat detail'));
      action.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m8 5 5 5-5 5"/></svg>');
      action.addEventListener('click', () => { renderError(snapshot.error); $('error-details').open = true; $('error-panel').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' }); });
    } else {
      if (state === 'failure') action.append(element('span', '', 'Lihat log'));
      action.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 15 15 5M5 5h10v10"/></svg>');
      action.target = '_blank'; action.rel = 'noopener noreferrer';
      linkURL(action, run.url);
    }
    row.append(action); history.append(row);
  }
}

function selectDay(day, button) {
  selectedDay = day.key;
  for (const bar of $('activity-bars').children) bar.setAttribute('aria-pressed', String(bar === button));
  const successes = day.runs.filter((run) => runState(run) === 'success').length;
  const failed = day.runs.filter((run) => runState(run) === 'failure').length;
  const count = day.runs.length;
  $('activity-selected').textContent = `${formatDate(day.date)} · ${count ? `${count} eksekusi${successes ? `, ${successes} berhasil` : ''}${failed ? `, ${failed} gagal` : ''}` : 'Belum ada eksekusi yang tercatat'}`;
  $('activity-selected').hidden = false;
}

function renderActivity(snapshot, now) {
  const days = dailyActivity(snapshot.runs, now);
  $('activity-bars').replaceChildren();
  const labels = { success: 'Berhasil', failure: 'Ada eksekusi gagal', waiting: 'Belum ada eksekusi', running: 'Sedang berjalan', cancelled: 'Dibatalkan' };
  for (const day of days) {
    const button = element('button', 'activity-bar');
    button.type = 'button'; button.dataset.state = day.state;
    button.setAttribute('aria-label', `${formatDate(day.date)}: ${labels[day.state]}`);
    button.setAttribute('aria-pressed', String(selectedDay === day.key));
    button.title = `${formatDate(day.date)} · ${labels[day.state]}`;
    button.addEventListener('click', () => selectDay(day, button));
    $('activity-bars').append(button);
    if (selectedDay === day.key) selectDay(day, button);
  }
  $('chart-start').textContent = formatDate(days[0].date, { year: undefined });
  $('chart-end').textContent = formatDate(days.at(-1).date, { year: undefined });
}

function renderError(error) {
  activeError = error;
  $('error-panel').hidden = !error;
  if (!error) return;
  $('error-step').textContent = [error.job, error.step].filter(Boolean).join(' / ');
  $('error-message').textContent = error.message || 'Eksekusi gagal. Buka log GitHub untuk informasi selengkapnya.';
  const details = Array.isArray(error.details) ? error.details.filter((line) => typeof line === 'string') : [];
  $('error-log').textContent = details.join('\n\n');
  $('error-details').hidden = details.length === 0;
  linkURL($('error-run-link'), error.url);
}

function render(snapshot, now = new Date()) {
  const { state, title, description, caption } = statusCopy(snapshot, now);
  $('status-title').textContent = title;
  $('status-description').textContent = description;
  $('status-caption').textContent = caption;
  $('status-symbol').dataset.state = state;
  $('status-symbol').querySelector('.status-orbit-inner').innerHTML = symbol(state);
  $('status-dot').dataset.state = state;
  const successAt = snapshot.lastSuccess?.completedAt || snapshot.lastSuccess?.startedAt;
  $('last-date').textContent = formatDate(successAt);
  $('last-time').textContent = successAt ? formatTime(successAt) : 'Menunggu eksekusi pertama';
  const next = nextSchedule(now, snapshot.schedule);
  $('next-date').textContent = next?.label || '—';
  $('duration').textContent = formatDuration(snapshot.latestRun?.durationSeconds);
  $('run-number').textContent = snapshot.latestRun ? `Run #${snapshot.latestRun.number}` : 'Belum ada eksekusi';
  linkURL($('github-link'), snapshot.workflow?.url || snapshot.repository?.url || 'https://github.com');
  $('demo-notice').hidden = !isDemo;
  const generatedAt = snapshot.generatedAt && new Date(snapshot.generatedAt);
  $('updated-at').textContent = generatedAt ? `Data diperbarui ${relativeTime(generatedAt, now)} · Waktu dalam WIB` : 'Waktu ditampilkan dalam WIB';
  const stale = generatedAt && now - generatedAt > 36 * 3_600_000;
  $('data-notice').hidden = !stale;
  if (stale) $('data-notice').textContent = `Belum ada pembaruan data sejak ${formatRunDate(generatedAt)}. Status di bawah adalah hasil terakhir yang tercatat; periksa workflow pelapor di GitHub.`;
  renderActivity(snapshot, now);
  renderHistory(snapshot);
  if (state === 'failure' && snapshot.error) renderError(snapshot.error);
  else if (activeError && snapshot.error && Number(activeError.runId) === Number(snapshot.error.runId)) renderError(snapshot.error);
  else renderError(null);
}

async function refresh(manual = false) {
  if (refreshing) return;
  refreshing = true;
  const button = $('refresh-button');
  button.disabled = true; button.setAttribute('aria-busy', 'true');
  try {
    let snapshot;
    if (isDemo) {
      const { demoSnapshot } = await import('./demo.js');
      snapshot = demoSnapshot(demoMode);
    } else {
      const response = await fetch(`./data/status.json?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error('Data status belum dapat dimuat. Coba lagi sebentar.');
      snapshot = await response.json();
    }
    currentSnapshot = validateSnapshot(snapshot);
    render(currentSnapshot);
    if (manual) toast(isDemo ? 'Data demo diperbarui.' : 'Status terbaru berhasil dimuat.');
  } catch (error) {
    $('data-notice').hidden = false;
    $('data-notice').textContent = location.protocol === 'file:' ? 'Buka halaman melalui server lokal (npm run dev) atau GitHub Pages agar data status dapat dimuat.' : 'Data terbaru belum dapat dimuat. Periksa koneksi atau workflow pelapor. Status yang tampil tetap menggunakan data terakhir yang berhasil dimuat.';
    if (!currentSnapshot) $('status-caption').textContent = 'Data status belum tersedia';
    if (manual) toast(error.name === 'TimeoutError' ? 'Koneksi terlalu lama. Coba perbarui lagi.' : 'Belum dapat mengambil data terbaru.');
  } finally { refreshing = false; button.disabled = false; button.removeAttribute('aria-busy'); }
}

$('refresh-button').addEventListener('click', () => refresh(true));
$('show-more').addEventListener('click', () => { showAll = !showAll; if (currentSnapshot) renderHistory(currentSnapshot); });
$('copy-error').addEventListener('click', async () => {
  if (!activeError) return;
  const text = [activeError.message, `${activeError.job || ''} / ${activeError.step || ''}`, ...(activeError.details || [])].join('\n\n');
  try { await navigator.clipboard.writeText(text); toast('Detail error disalin.'); }
  catch { toast('Penyalinan tidak tersedia. Pilih teks error untuk menyalinnya.'); }
});

await refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
