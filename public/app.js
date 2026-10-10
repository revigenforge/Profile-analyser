const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = { aiEnabled: false, files: [], lastReport: null };

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmt = (n) => {
  if (n === null || n === undefined) return '—';
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${+(n / 1e3).toFixed(1)}K`;
  return Number(n).toLocaleString();
};

/** Accepts "12.4K", "1,234", "1.2M" and returns a plain number (or ''). */
function parseHumanNumber(value) {
  const v = String(value ?? '').trim().replace(/\s/g, '');
  if (!v) return '';
  const m = v.match(/^([\d.,]+)([kmb])?$/i);
  if (!m) return '';
  const base = m[2] ? Number(m[1].replace(/,/g, '.')) : Number(m[1].replace(/,/g, ''));
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase()] ?? 1;
  return Number.isFinite(base) ? Math.round(base * mult * 100) / 100 : '';
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  let body = {};
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    Object.assign(err, body, { status: res.status });
    throw err;
  }
  return body;
}

/* ---------------- Tabs ---------------- */
function showTab(name) {
  $$('.tab').forEach((t) => {
    const active = t.dataset.tab === name;
    t.classList.toggle('is-active', active);
    t.setAttribute('aria-selected', String(active));
  });
  $$('.panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  hideError();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

function showError(message) {
  const el = $('#form-error');
  el.textContent = message;
  el.hidden = false;
}
function hideError() { $('#form-error').hidden = true; }

function setLoading(on, text = 'Analysing profile…') {
  $('#loading').hidden = !on;
  $('#loading-text').textContent = text;
  $$('button[type="submit"]').forEach((b) => { b.disabled = on; });
  if (on) $('#results').hidden = true;
}

/* ---------------- Link mode ---------------- */
$('#link-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();
  const url = $('#profile-url').value.trim();
  if (!url) return;
  setLoading(true, 'Reading your public profile…');
  try {
    const data = await api('/api/analyze/url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    renderReport(data.report, data.missing);
  } catch (err) {
    if (err.fallback) {
      switchToFallback(err.error, err.partial);
    } else {
      showError(err.message);
    }
  } finally {
    setLoading(false);
  }
});

function switchToFallback(message, partial) {
  showTab('manual');
  const note = $('#fallback-note');
  note.innerHTML = `<strong>Let's do it another way.</strong> ${esc(message)}`;
  note.hidden = false;
  if (partial) fillForm(partial);
  $('#manual-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------------- Manual mode ---------------- */
const form = $('#manual-form');

function fillForm(data, { onlyEmpty = false } = {}) {
  for (const [key, value] of Object.entries(data ?? {})) {
    if (value === null || value === undefined || value === '') continue;
    const field = form.elements.namedItem(key);
    if (!field || field instanceof RadioNodeList) continue;
    if (field.type === 'checkbox') {
      if (!onlyEmpty || !field.checked) field.checked = Boolean(value);
    } else if (!onlyEmpty || !field.value) {
      field.value = key === 'handle' ? String(value).replace(/^@?/, '@') : value;
    }
  }
}

function readForm() {
  const fd = new FormData(form);
  const numeric = ['followers', 'following', 'posts', 'postsPerWeek', 'avgLikes', 'avgComments', 'avgViews', 'avgShares'];
  const profile = {};
  for (const [key, value] of fd.entries()) {
    profile[key] = numeric.includes(key) ? parseHumanNumber(value) : value;
  }
  profile.handle = (profile.handle || '').replace(/^@/, '');
  profile.verified = form.elements.verified.checked;
  return profile;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();
  setLoading(true);
  try {
    const data = await api('/api/analyze/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: readForm() }),
    });
    renderReport(data.report);
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
});

/* ---------------- Screenshots ---------------- */
const dropzone = $('#dropzone');
const fileInput = $('#screenshots');

function addFiles(list) {
  const images = [...list].filter((f) => /^image\/(png|jpe?g|webp|gif)$/.test(f.type));
  state.files = [...state.files, ...images].slice(0, 6);
  renderThumbs();
}

function renderThumbs() {
  const wrap = $('#thumbs');
  wrap.innerHTML = '';
  state.files.forEach((file, i) => {
    const div = document.createElement('div');
    div.className = 'thumb';
    const img = document.createElement('img');
    img.alt = `Screenshot ${i + 1}`;
    img.src = URL.createObjectURL(file);
    img.onload = () => URL.revokeObjectURL(img.src);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '×';
    btn.setAttribute('aria-label', `Remove screenshot ${i + 1}`);
    btn.onclick = () => { state.files.splice(i, 1); renderThumbs(); };
    div.append(img, btn);
    wrap.append(div);
  });
  $('#extract-btn').disabled = !state.files.length || !state.aiEnabled;
  $('#extract-status').textContent = state.files.length && !state.aiEnabled
    ? 'Automatic reading is off on this server — type the numbers from your screenshots below.'
    : '';
}

fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('is-over'); }));
['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('is-over'); }));
dropzone.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
document.addEventListener('paste', (e) => {
  if (!$('#manual-form').hidden && e.clipboardData?.files?.length) addFiles(e.clipboardData.files);
});

$('#extract-btn').addEventListener('click', async () => {
  const status = $('#extract-status');
  const btn = $('#extract-btn');
  btn.disabled = true;
  status.textContent = 'Reading your screenshots…';
  try {
    const fd = new FormData();
    state.files.forEach((f) => fd.append('screenshots', f));
    const { extracted } = await api('/api/extract', { method: 'POST', body: fd });
    if (!extracted) throw new Error('No readable images found.');
    const { notes, ...fields } = extracted;
    fillForm(fields, { onlyEmpty: true });
    const found = Object.entries(fields).filter(([, v]) => v !== null && v !== '').length;
    status.textContent = `Filled ${found} field${found === 1 ? '' : 's'} — please double-check before analysing.${notes ? ` Note: ${notes}` : ''}`;
  } catch (err) {
    status.textContent = err.message;
  } finally {
    btn.disabled = !state.files.length;
  }
});

/* ---------------- Report ---------------- */
function ring(score) {
  const r = 66;
  const c = 2 * Math.PI * r;
  return `
    <div class="ring">
      <svg width="156" height="156" viewBox="0 0 156 156" aria-hidden="true">
        <circle class="ring-bg" cx="78" cy="78" r="${r}" fill="none" stroke-width="12"/>
        <circle class="ring-fg" cx="78" cy="78" r="${r}" fill="none" stroke-width="12"
          stroke-dasharray="${c}" stroke-dashoffset="${c}" data-target="${c * (1 - score / 100)}"/>
      </svg>
      <div class="ring-label"><strong>${score}</strong><span>/ 100</span></div>
    </div>`;
}

function renderReport(report, missing = []) {
  state.lastReport = report;
  const p = report.profile;
  const m = report.metrics;
  const handle = p.handle ? `@${p.handle}` : '';
  const name = p.displayName || handle || 'Your profile';

  const tiles = [
    { k: 'Followers', v: fmt(p.followers), s: report.tier?.label ?? 'Add followers for tier' },
    {
      k: 'Engagement', v: m.engagementRate === null ? '—' : `${m.engagementRate}%`,
      s: `${report.platformLabel} benchmark ≈ ${m.engagementBenchmark}%`,
      inv: m.engagementRate !== null && m.engagementRate >= m.engagementBenchmark,
    },
    { k: 'Posts', v: fmt(p.posts), s: p.postsPerWeek ? `${p.postsPerWeek}×/week (ideal ${m.idealPostsPerWeek})` : `Ideal ${m.idealPostsPerWeek}×/week` },
    { k: 'Follower ratio', v: m.followerRatio === null ? '—' : `${m.followerRatio}×`, s: m.viewsPerFollower !== null ? `${m.viewsPerFollower} views / follower` : 'followers ÷ following' },
  ];

  const missingNote = missing.length || report.confidence < 70
    ? `<div class="notice">This report is based on ${report.confidence}% of the data we look for.
        <a href="#" id="complete-data">Add more details</a> (likes, comments, posting frequency) for a sharper analysis.</div>`
    : '';

  const ins = report.insights;
  const insightsHtml = ins ? `
    <section class="insights">
      <p class="eyebrow eyebrow-inv">Personalised by the RevigenForge analyst</p>
      <h3>Your growth read</h3>
      <p class="summary">${esc(ins.summary)}</p>
      <h4>Your audience</h4><p>${esc(ins.audienceRead)}</p>
      <h4>Content ideas for you</h4>
      <div class="ideas">${ins.contentIdeas.map((i) => `<div class="idea"><strong>${esc(i.title)}</strong><span>${esc(i.why)}</span></div>`).join('')}</div>
      <h4>Your 90-day plan</h4>
      <div class="timeline">${ins.growthPlan.map((g) => `<div><b>${esc(g.timeframe)}</b><span>${esc(g.action)}</span></div>`).join('')}</div>
      <h4>Brand partnership readiness</h4><p>${esc(ins.brandFit)}</p>
      <h4>From the team</h4><p class="note">${esc(ins.personalNote)}</p>
    </section>` : '';

  $('#results').innerHTML = `
    ${missingNote}
    <div class="card report-head">
      ${ring(report.overall)}
      <div class="who">
        <p class="eyebrow">${esc(report.platformLabel)} · Profile report</p>
        <h2>${esc(name)}</h2>
        ${handle && p.displayName ? `<div class="handle">${esc(handle)}</div>` : ''}
        ${p.bio ? `<p class="bio">${esc(p.bio)}</p>` : ''}
        <div class="tags">
          ${report.tier ? `<span class="tag tag-solid">${esc(report.tier.label)}</span>` : ''}
          ${p.niche ? `<span class="tag">${esc(p.niche)}</span>` : ''}
          ${p.verified ? '<span class="tag">Verified</span>' : ''}
          <span class="tag">Data confidence ${report.confidence}%</span>
        </div>
      </div>
      <div class="grade">
        <div class="letter">${esc(report.grade.letter)}</div>
        <strong>${esc(report.grade.label)}</strong>
      </div>
    </div>

    <div class="tiles">
      ${tiles.map((t) => `<div class="tile ${t.inv ? 'tile-inv' : ''}"><div class="k">${t.k}</div><div class="v">${esc(t.v)}</div><div class="s">${esc(t.s)}</div></div>`).join('')}
    </div>

    ${insightsHtml}

    <div class="cols">
      <section class="card block">
        <h3>Score breakdown <small>0 – 100</small></h3>
        ${report.categories.map((c) => `
          <div class="bar-row">
            <div class="bar-top"><span>${esc(c.label)}</span>${c.score === null ? '<span class="na">No data</span>' : `<span>${c.score}</span>`}</div>
            <div class="bar ${c.score === null ? 'is-na' : ''}"><i data-w="${c.score ?? 0}"></i></div>
          </div>`).join('')}
      </section>
      <section class="card block">
        <h3>Profile checklist <small>${report.profileChecks.filter((c) => c.ok).length}/${report.profileChecks.length}</small></h3>
        <ul class="checklist">
          ${report.profileChecks.map((c) => `<li class="${c.ok ? '' : 'no'}"><span class="mark ${c.ok ? 'ok' : ''}">${c.ok ? '✓' : ''}</span>${esc(c.label)}</li>`).join('')}
        </ul>
      </section>
    </div>

    <div class="cols">
      <section class="card block">
        <h3>Action plan <small>${report.recommendations.length} steps</small></h3>
        <div class="recs">
          ${report.recommendations.length ? report.recommendations.map((r) => `
            <div class="rec">
              <span class="prio prio-${r.priority}">${r.priority}</span>
              <div><h4>${esc(r.title)}</h4><p>${esc(r.detail)}</p></div>
            </div>`).join('') : '<p class="empty">Nothing urgent — keep doing what you are doing.</p>'}
        </div>
      </section>
      <section class="card block">
        <h3>What's working</h3>
        ${report.strengths.length
          ? `<ul class="strengths">${report.strengths.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`
          : '<p class="empty">Add more of your numbers to uncover your strengths.</p>'}
      </section>
    </div>

    <section class="card help">
      <p class="eyebrow">Grow with RevigenForge</p>
      <h3>Where we'd focus together</h3>
      <div class="help-grid">
        ${report.revigenforge.map((h) => `<div class="help-item"><span class="k">${esc(h.area)}</span><strong>${esc(h.support)}</strong></div>`).join('')}
      </div>
      <div class="report-actions">
        <a class="btn btn-primary" href="#connect">Connect with RevigenForge</a>
        <button class="btn btn-ghost" type="button" id="print-report">Download report (PDF)</button>
        <button class="btn btn-ghost" type="button" id="new-analysis">Analyse another profile</button>
      </div>
    </section>
  `;

  $('#results').hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    $$('.bar > i[data-w]').forEach((el) => { el.style.width = `${el.dataset.w}%`; });
    const fg = $('.ring-fg');
    if (fg) fg.style.strokeDashoffset = fg.dataset.target;
  }));
  $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Pre-fill the connect form so creators can reach out in one click.
  const cf = $('#connect-form');
  if (handle && !cf.elements.handle.value) cf.elements.handle.value = handle;
  if (p.displayName && !cf.elements.name.value) cf.elements.name.value = p.displayName;
  cf.elements.platform.value = p.platform;

  $('#print-report').onclick = () => window.print();
  $('#new-analysis').onclick = () => {
    $('#results').hidden = true;
    $('#analyse').scrollIntoView({ behavior: 'smooth' });
  };
  const complete = $('#complete-data');
  if (complete) {
    complete.onclick = (e) => {
      e.preventDefault();
      fillForm({ ...p, handle: p.handle ?? '' });
      showTab('manual');
      $('#fallback-note').hidden = true;
      $('#manual-form').scrollIntoView({ behavior: 'smooth' });
    };
  }
}

/* ---------------- Connect ---------------- */
$('#connect-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cf = e.currentTarget;
  const status = $('#connect-status');
  const fd = new FormData(cf);
  const payload = {
    name: fd.get('name'),
    email: fd.get('email'),
    handle: fd.get('handle'),
    platform: fd.get('platform'),
    goals: fd.get('goals'),
    interests: fd.getAll('interests'),
    score: state.lastReport?.overall ?? null,
  };
  status.textContent = 'Sending…';
  try {
    await api('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    cf.reset();
    status.textContent = "You're in. The RevigenForge team will reach out personally soon.";
  } catch (err) {
    status.textContent = err.message;
  }
});

/* ---------------- Init ---------------- */
$('#year').textContent = new Date().getFullYear();
api('/api/status').then((s) => { state.aiEnabled = s.aiEnabled; renderThumbs(); }).catch(() => {});
