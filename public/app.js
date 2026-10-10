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
  const m = v.match(/^([+-]?)([\d.,]+)([kmb])?$/i);
  if (!m) return '';
  const base = m[3] ? Number(m[2].replace(/,/g, '.')) : Number(m[2].replace(/,/g, ''));
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[3]?.toLowerCase()] ?? 1;
  const sign = m[1] === '-' ? -1 : 1;
  return Number.isFinite(base) ? Math.round(sign * base * mult * 100) / 100 : '';
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
      switchToFallback(err.error, err.partial, err.attempts);
    } else {
      showError(err.message);
    }
  } finally {
    setLoading(false);
  }
});

const SOURCE_LABELS = {
  'instagram-graph-api': 'Meta Business Discovery API',
  'instagram-web': 'Instagram public endpoint',
  page: 'Profile web page',
  instagram: 'Instagram',
};

function switchToFallback(message, partial, attempts = []) {
  showTab('manual');
  const note = $('#fallback-note');
  const details = attempts.length ? `
    <details class="tech">
      <summary>Technical details</summary>
      <ul>${attempts.map((a) => `<li><b>${esc(SOURCE_LABELS[a.source] ?? a.source)}:</b> ${esc(a.error)}</li>`).join('')}</ul>
    </details>` : '';
  note.innerHTML = `<strong>Let's do it another way.</strong> ${esc(message)}${details}`;
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
  const numeric = ['followers', 'following', 'posts', 'postsPerWeek', 'avgLikes', 'avgComments', 'avgViews', 'avgShares', 'newFollowers30d'];
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

// Hosting caps uploads at ~4.5 MB per request, and the AI reads images at
// ~1600px anyway, so downscale and re-encode before sending.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_SIDE = 1600;

async function shrinkImage(file) {
  if (file.type === 'image/gif') return file; // keep GIFs as-is
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

$('#extract-btn').addEventListener('click', async () => {
  const status = $('#extract-status');
  const btn = $('#extract-btn');
  btn.disabled = true;
  status.textContent = 'Reading your screenshots…';
  try {
    const shrunk = await Promise.all(state.files.map((f) => shrinkImage(f)));
    const total = shrunk.reduce((sum, f) => sum + f.size, 0);
    if (total > MAX_UPLOAD_BYTES) throw new Error('Those screenshots are too large together — try fewer images.');
    const fd = new FormData();
    shrunk.forEach((f) => fd.append('screenshots', f));
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
// Status colours always travel with an icon + word, never colour alone.
function status(score) {
  if (score === null || score === undefined) return { key: 'na', label: 'No data', icon: '–' };
  if (score >= 70) return { key: 'good', label: 'Strong', icon: '▲' };
  if (score >= 45) return { key: 'fair', label: 'Fair', icon: '●' };
  return { key: 'weak', label: 'Weak', icon: '▼' };
}
const pill = (st) => `<span class="pill pill-${st.key}"><i>${st.icon}</i> ${st.label}</span>`;

function ring(score) {
  const r = 66;
  const c = 2 * Math.PI * r;
  const st = status(score);
  return `
    <div class="ring ring-${st.key}" data-tip="Overall creator score: ${score}/100 · ${st.label}">
      <svg width="156" height="156" viewBox="0 0 156 156" aria-hidden="true">
        <circle class="ring-bg" cx="78" cy="78" r="${r}" fill="none" stroke-width="12"/>
        <circle class="ring-fg" cx="78" cy="78" r="${r}" fill="none" stroke-width="12"
          stroke-dasharray="${c}" stroke-dashoffset="${c}" data-target="${c * (1 - score / 100)}"/>
      </svg>
      <div class="ring-label"><strong data-count="${score}">0</strong><span>/ 100</span></div>
    </div>`;
}

/** Radar of category scores — one series, so one hue; points carry tooltips. */
function radar(categories) {
  const cats = categories.filter((c) => c.score !== null);
  if (cats.length < 3) {
    return '<p class="empty">Add a few more numbers to see your creator shape.</p>';
  }
  const size = 300;
  const cx = size / 2;
  const cy = size / 2;
  const R = 112;
  const pt = (i, v) => {
    const a = (Math.PI * 2 * i) / cats.length - Math.PI / 2;
    return [cx + Math.cos(a) * R * (v / 100), cy + Math.sin(a) * R * (v / 100)];
  };
  const rings = [25, 50, 75, 100].map((v) =>
    `<polygon class="radar-grid" points="${cats.map((_, i) => pt(i, v).join(',')).join(' ')}"/>`).join('');
  const spokes = cats.map((_, i) => {
    const [x, y] = pt(i, 100);
    return `<line class="radar-grid" x1="${cx}" y1="${cy}" x2="${x}" y2="${y}"/>`;
  }).join('');
  const strong = `<polygon class="radar-threshold" points="${cats.map((_, i) => pt(i, 70).join(',')).join(' ')}"/>`;
  const shape = cats.map((c, i) => pt(i, c.score).join(',')).join(' ');
  const labels = cats.map((c, i) => {
    const [x, y] = pt(i, 128);
    const anchor = Math.abs(x - cx) < 8 ? 'middle' : x > cx ? 'start' : 'end';
    return `<text class="radar-label" x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="middle">${esc(c.label)}</text>`;
  }).join('');
  const dots = cats.map((c, i) => {
    const [x, y] = pt(i, c.score);
    const st = status(c.score);
    return `<g class="radar-hit" data-tip="${esc(c.label)}: ${c.score}/100 · ${st.label}">
      <circle cx="${x}" cy="${y}" r="14" fill="transparent"/>
      <circle class="radar-dot dot-${st.key}" cx="${x}" cy="${y}" r="5"/></g>`;
  }).join('');
  return `
    <svg class="radar" viewBox="-62 -6 ${size + 124} ${size + 12}" role="img"
      aria-label="Radar chart of category scores: ${cats.map((c) => `${c.label} ${c.score}`).join(', ')}">
      ${rings}${spokes}${strong}
      <polygon class="radar-shape" points="${shape}"/>
      ${labels}${dots}
    </svg>
    <div class="legend">
      <span><i class="lg-shape"></i> Your scores</span>
      <span><i class="lg-threshold"></i> “Strong” line (70)</span>
    </div>`;
}

/** Bullet gauge: your engagement vs the platform benchmark. */
function engagementGauge(rate, benchmark) {
  if (rate === null) return '';
  const max = Math.max(rate, benchmark * 2) * 1.1;
  const st = status(rate >= benchmark ? 75 : rate >= benchmark * 0.6 ? 55 : 30);
  return `
    <div class="gauge" data-tip="You: ${rate}% · Benchmark: ${benchmark}%">
      <div class="gauge-track"><i class="gauge-fill fill-${st.key}" data-w="${(rate / max) * 100}"></i></div>
      <span class="gauge-mark" style="left:${(benchmark / max) * 100}%"></span>
    </div>`;
}

function delta(value, unit, goodWhenPositive = true) {
  if (value === null || value === undefined) return '';
  const positive = value > 0;
  const key = value === 0 ? 'fair' : positive === goodWhenPositive ? 'good' : 'weak';
  const icon = value === 0 ? '●' : positive ? '▲' : '▼';
  return `<span class="pill pill-${key}"><i>${icon}</i> ${positive ? '+' : ''}${value}${unit}</span>`;
}

function renderReport(report, missing = []) {
  state.lastReport = report;
  const p = report.profile;
  const m = report.metrics;
  const handle = p.handle ? `@${p.handle}` : '';
  const name = p.displayName || handle || 'Your profile';
  const overall = status(report.overall);
  const byKey = Object.fromEntries(report.categories.map((c) => [c.key, c]));

  const engVsBench = m.engagementRate === null ? null : +(m.engagementRate - m.engagementBenchmark).toFixed(2);
  const tiles = [
    {
      k: 'Followers', v: fmt(p.followers), st: status(byKey.reach.score),
      extra: m.growthRate !== null ? `${delta(m.growthRate, '% / 30d')}` : `<span class="s">${esc(report.tier?.label ?? '')}</span>`,
    },
    {
      k: 'Engagement rate', v: m.engagementRate === null ? '—' : `${m.engagementRate}%`, st: status(byKey.engagement.score),
      extra: m.engagementRate === null
        ? '<span class="s">Add likes &amp; comments</span>'
        : `${delta(engVsBench, ' pts vs benchmark')}${engagementGauge(m.engagementRate, m.engagementBenchmark)}<span class="s">${esc(report.platformLabel)} benchmark ≈ ${m.engagementBenchmark}%</span>`,
    },
    {
      k: 'Posting', v: p.postsPerWeek ? `${p.postsPerWeek}×/wk` : fmt(p.posts), st: status(byKey.consistency.score ?? byKey.library.score),
      extra: `<span class="s">${p.postsPerWeek ? `Ideal ≈ ${m.idealPostsPerWeek}×/wk · ${fmt(p.posts)} posts` : `posts · ideal ${m.idealPostsPerWeek}×/wk`}</span>`,
    },
    {
      k: 'Follower ratio', v: m.followerRatio === null ? '—' : `${m.followerRatio}×`, st: status(byKey.authority.score),
      extra: `<span class="s">${m.viewsPerFollower !== null ? `${m.viewsPerFollower} views / follower` : 'followers ÷ following'}</span>`,
    },
  ];

  const missingNote = missing.length || report.confidence < 70
    ? `<div class="notice">This report is based on ${report.confidence}% of the data we look for.
        <a href="#" id="complete-data">Add more details</a> (likes, comments, growth, posting frequency) for a sharper analysis.</div>`
    : '';

  const ins = report.insights;
  const insightsHtml = ins ? `
    <section class="insights">
      <p class="eyebrow eyebrow-inv">Personalised by the RevigenForge analyst</p>
      <h3>Your growth read</h3>
      <p class="summary">${esc(ins.summary)}</p>
      <h4>Your audience</h4><p>${esc(ins.audienceRead)}</p>
      <h4>Content ideas for you</h4>
      <div class="ideas">${ins.contentIdeas.map((i, n) => `<div class="idea c${(n % 4) + 1}"><strong>${esc(i.title)}</strong><span>${esc(i.why)}</span></div>`).join('')}</div>
      <h4>Your 90-day plan</h4>
      <div class="timeline">${ins.growthPlan.map((g, n) => `<div class="c${(n % 3) + 1}"><b>${esc(g.timeframe)}</b><span>${esc(g.action)}</span></div>`).join('')}</div>
      <h4>Brand partnership readiness</h4><p>${esc(ins.brandFit)}</p>
      <h4>From the team</h4><p class="note">${esc(ins.personalNote)}</p>
    </section>` : '';

  const checksOk = report.profileChecks.filter((c) => c.ok).length;

  $('#results').innerHTML = `
    ${missingNote}
    <div class="card report-head st-${overall.key}">
      ${ring(report.overall)}
      <div class="who">
        <p class="eyebrow">${esc(report.platformLabel)} · Profile report</p>
        <h2>${esc(name)}</h2>
        ${handle && p.displayName ? `<div class="handle">${esc(handle)}</div>` : ''}
        ${p.bio ? `<p class="bio">${esc(p.bio)}</p>` : ''}
        <div class="tags">
          ${report.tier ? `<span class="tag tag-solid">${esc(report.tier.label)}</span>` : ''}
          ${p.niche ? `<span class="tag">${esc(p.niche)}</span>` : ''}
          ${p.verified ? '<span class="tag">✓ Verified</span>' : ''}
          <span class="tag">Data confidence ${report.confidence}%</span>
        </div>
      </div>
      <div class="grade">
        <div class="letter">${esc(report.grade.letter)}</div>
        <strong>${esc(report.grade.label)}</strong>
        ${pill(overall)}
      </div>
    </div>

    <div class="tiles">
      ${tiles.map((t) => `
        <div class="tile st-${t.st.key}">
          <div class="tile-top"><span class="k">${t.k}</span>${t.st.key === 'na' ? '' : pill(t.st)}</div>
          <div class="v">${esc(t.v)}</div>
          ${t.extra}
        </div>`).join('')}
    </div>

    ${insightsHtml}

    <div class="cols">
      <section class="card block">
        <h3>Your creator shape <small>0 – 100</small></h3>
        ${radar(report.categories)}
      </section>
      <section class="card block">
        <h3>Score breakdown <small>hover for detail</small></h3>
        ${report.categories.map((c) => {
          const st = status(c.score);
          return `
          <div class="bar-row" data-tip="${esc(c.label)}: ${c.score === null ? 'no data yet' : `${c.score}/100 · ${st.label}`} · weight ${Math.round(c.weight * 100)}%">
            <div class="bar-top"><span>${esc(c.label)}</span>
              ${c.score === null ? '<span class="na">No data</span>' : `<span class="bar-val"><b>${c.score}</b>${pill(st)}</span>`}</div>
            <div class="bar ${c.score === null ? 'is-na' : ''}"><i class="fill-${st.key}" data-w="${c.score ?? 0}"></i><span class="bar-mark" title="Strong (70)"></span></div>
          </div>`;
        }).join('')}
        <div class="legend">
          <span><i class="sw sw-good"></i> ▲ Strong 70+</span>
          <span><i class="sw sw-fair"></i> ● Fair 45–69</span>
          <span><i class="sw sw-weak"></i> ▼ Weak &lt;45</span>
        </div>
      </section>
    </div>

    <section class="card block">
      <h3>Action plan <small>${report.recommendations.length} steps · highest impact first</small></h3>
      <div class="recs">
        ${report.recommendations.length ? report.recommendations.map((r) => `
          <div class="rec rec-${r.priority}">
            <span class="prio prio-${r.priority}">${{ high: '▲ High', medium: '● Medium', low: '▽ Low' }[r.priority]}</span>
            <div><h4>${esc(r.title)}</h4><p>${esc(r.detail)}</p></div>
          </div>`).join('') : '<p class="empty">Nothing urgent — keep doing what you are doing.</p>'}
      </div>
    </section>

    <div class="cols">
      <section class="card block">
        <h3>Profile checklist <small>${checksOk}/${report.profileChecks.length} done</small></h3>
        <div class="progress"><i class="fill-${status((checksOk / report.profileChecks.length) * 100).key}" data-w="${(checksOk / report.profileChecks.length) * 100}"></i></div>
        <ul class="checklist">
          ${report.profileChecks.map((c) => `<li class="${c.ok ? 'ok' : 'no'}"><span class="mark">${c.ok ? '✓' : '✕'}</span>${esc(c.label)}</li>`).join('')}
        </ul>
      </section>
      <section class="card block">
        <h3>What's working</h3>
        ${report.strengths.length
          ? `<ul class="strengths">${report.strengths.map((s) => `<li><span class="mark">▲</span>${esc(s)}</li>`).join('')}</ul>`
          : '<p class="empty">Add more of your numbers to uncover your strengths.</p>'}
      </section>
    </div>

    <section class="card help">
      <img class="help-logo" src="logo.png" alt="RevigenForge" width="640" height="353" />
      <p class="eyebrow">Grow with RevigenForge</p>
      <h3>Where we'd focus together</h3>
      <div class="help-grid">
        ${report.revigenforge.map((h, n) => `<div class="help-item c${n + 1}"><span class="k">${String(n + 1).padStart(2, '0')} · ${esc(h.area)}</span><strong>${esc(h.support)}</strong></div>`).join('')}
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
    $$('#results [data-w]').forEach((el) => { el.style.width = `${Math.max(0, Math.min(100, el.dataset.w))}%`; });
    const fg = $('.ring-fg');
    if (fg) fg.style.strokeDashoffset = fg.dataset.target;
    countUp($('[data-count]'));
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

function countUp(el) {
  if (!el) return;
  const target = Number(el.dataset.count);
  const start = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - start) / 1100);
    el.textContent = Math.round(target * (1 - (1 - t) ** 3));
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ---------------- Tooltips ---------------- */
const tip = document.createElement('div');
tip.className = 'tooltip';
tip.setAttribute('role', 'tooltip');
tip.hidden = true;
document.body.append(tip);
document.addEventListener('pointermove', (e) => {
  const target = e.target.closest?.('[data-tip]');
  if (!target) { tip.hidden = true; return; }
  tip.textContent = target.dataset.tip;
  tip.hidden = false;
  const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  const y = e.clientY - tip.offsetHeight - 12 < 0 ? e.clientY + 18 : e.clientY - tip.offsetHeight - 12;
  tip.style.transform = `translate(${x}px, ${y}px)`;
});
document.addEventListener('pointerleave', () => { tip.hidden = true; });

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
