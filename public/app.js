/* scarpcrap — dashboard. JavaScript nu, sans framework ni etape de build. */

'use strict';

const TOKEN_KEY = 'scarpcrap.token';

/* Un lien du type site.tld/?token=XXX evite toute saisie manuelle sur
   mobile (clavier, autocomplete de mot de passe qui interfere, etc). */
const urlToken = new URLSearchParams(location.search).get('token');
if (urlToken) {
  localStorage.setItem(TOKEN_KEY, urlToken.trim());
  history.replaceState(null, '', location.pathname);
}

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  status: null,
  deals: [],
  charts: {},
};

/* ────────────────────────────── Utilitaires ─────────────────────────── */

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function money(cents, currency) {
  const value = (Number(cents) || 0) / 100;
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: currency || 'EUR',
    maximumFractionDigits: Math.abs(value) < 100 ? 2 : 0,
  }).format(value);
}

function pct(value) {
  const n = Number(value) || 0;
  return `${n > 0 ? '+' : ''}${n.toFixed(0)} %`;
}

function dateLabel(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Echappe systematiquement : les titres d'annonces viennent de vendeurs tiers. */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function banner(message, kind) {
  const el = $('#banner');
  if (!message) { el.hidden = true; return; }
  el.textContent = message;
  el.className = `banner${kind ? ` is-${kind}` : ''}`;
  el.hidden = false;
  if (kind === 'ok') setTimeout(() => { el.hidden = true; }, 4000);
}

/* ──────────────────────────────── API ───────────────────────────────── */

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (options.body) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, { ...options, headers });

  if (res.status === 401) {
    openGate('Jeton refuse. Verifie AUTH_TOKEN cote serveur.');
    throw new Error('unauthorized');
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
  return data;
}

/* ─────────────────────────── Deverrouillage ─────────────────────────── */

function openGate(message) {
  $('#app').hidden = true;
  $('#gate').hidden = false;
  const error = $('#gate-error');
  error.textContent = message || '';
  error.hidden = !message;
}

function closeGate() {
  $('#gate').hidden = true;
  $('#app').hidden = false;
}

$('#gate-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.token = $('#gate-token').value.trim();
  localStorage.setItem(TOKEN_KEY, state.token);
  await boot();
});

/* ─────────────────────────────── Onglets ────────────────────────────── */

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    $$('.panel').forEach((panel) => {
      panel.hidden = panel.id !== `tab-${tab.dataset.tab}`;
    });
    if (tab.dataset.tab === 'synthese') void loadSynthese();
    if (tab.dataset.tab === 'capital') void loadCapital();
    if (tab.dataset.tab === 'systeme') void loadSysteme();
  });
});

/* ──────────────────────────────── Deals ─────────────────────────────── */

function trustClass(score) {
  if (score >= 85) return 'is-good';
  if (score >= 70) return 'is-info';
  if (score >= 55) return 'is-warn';
  return 'is-danger';
}

function compQualityLabel(deal) {
  const q = Number(deal.compQuality) || 0;
  if (q >= 0.7) return { text: 'estimation solide', cls: 'is-good' };
  if (q >= 0.45) return { text: 'estimation moyenne', cls: 'is-info' };
  return { text: 'estimation fragile', cls: 'is-warn' };
}

function renderTrust(deal) {
  const trust = deal.trust || {};
  const components = trust.components || [];
  if (components.length === 0) return '';

  const items = components.map((c) => {
    const ratio = c.max > 0 ? Math.round((c.score / c.max) * 100) : 0;
    return `
      <li class="trust-item">
        <span>${esc(c.label)}</span>
        <span class="num">${c.score} / ${c.max}</span>
        <span class="trust-bar"><span style="width:${ratio}%"></span></span>
        <span class="trust-detail">${esc(c.detail)}</span>
      </li>`;
  }).join('');

  const flags = (trust.flags || []).map((f) => `<span class="badge is-danger">${esc(f)}</span>`).join('');

  return `
    <details>
      <summary>Detail du score de confiance (${deal.trustScore}/100)</summary>
      <ul class="trust-list">${items}</ul>
      ${flags ? `<div class="flags">${flags}</div>` : ''}
    </details>`;
}

function renderDeal(deal) {
  const quality = compQualityLabel(deal);
  const profitClass = deal.netProfitCents > 0 ? 'is-good' : 'is-bad';
  const delta = deal.categoryIndexDelta;

  const thumb = deal.imageUrl
    ? `<img class="deal-thumb" src="${esc(deal.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : `<div class="deal-thumb is-placeholder">📦</div>`;

  const actions = deal.status === 'new'
    ? `<button class="btn btn-primary" data-action="buy" data-id="${deal.id}">Acheter</button>
       <button class="btn btn-danger" data-action="skip" data-id="${deal.id}">Skip</button>`
    : `<span class="badge">${esc(deal.status)}</span>
       <button class="btn" data-action="reset" data-id="${deal.id}">Remettre en liste</button>`;

  return `
  <article class="deal" id="deal-${deal.id}">
    ${thumb}
    <div>
      <h3 class="deal-title">
        <a href="${esc(deal.url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(deal.title)}</a>
      </h3>
      <div class="badges">
        <span class="badge is-info">${esc(deal.domainLabel)}</span>
        <span class="badge">${esc(deal.source)}</span>
        <span class="badge ${trustClass(deal.trustScore)}">confiance ${deal.trustScore}</span>
        <span class="badge ${quality.cls}">${quality.text}</span>
        <span class="badge">revente ${esc(deal.resaleMarketplace)}</span>
        ${delta !== null && delta !== undefined
          ? `<span class="badge ${delta >= 0 ? 'is-good' : 'is-warn'}">${delta >= 0 ? '+' : ''}${Number(delta).toFixed(0)} pts vs categorie</span>`
          : ''}
      </div>

      <div class="metrics">
        <div class="metric">
          <span class="metric-value">${money(deal.buyTotalCents, deal.currency)}</span>
          <span class="metric-label">Achat total</span>
        </div>
        <div class="metric">
          <span class="metric-value">${money(deal.resaleEstimateCents, deal.currency)}</span>
          <span class="metric-label">Revente estimee</span>
        </div>
        <div class="metric">
          <span class="metric-value">${money(deal.feesTotalCents, deal.currency)}</span>
          <span class="metric-label">Frais reels</span>
        </div>
        <div class="metric">
          <span class="metric-value ${profitClass}">${money(deal.netProfitCents, deal.currency)}</span>
          <span class="metric-label">Profit net</span>
        </div>
        <div class="metric">
          <span class="metric-value ${profitClass}">${pct(deal.roiPct)}</span>
          <span class="metric-label">ROI</span>
        </div>
        <div class="metric">
          <span class="metric-value ${profitClass}">${money(deal.roiPerDayCents, deal.currency)}</span>
          <span class="metric-label">ROI / jour</span>
        </div>
        <div class="metric">
          <span class="metric-value">${deal.daysToReceive} + ${deal.daysToSell} j</span>
          <span class="metric-label">Reception + revente</span>
        </div>
      </div>

      ${renderTrust(deal)}
    </div>
    <div class="deal-actions">${actions}</div>
  </article>`;
}

function filterParams() {
  const params = new URLSearchParams({
    status: $('#f-status').value,
    domain: $('#f-domain').value,
    source: $('#f-source').value,
    sort: $('#f-sort').value,
  });
  const roi = $('#f-roi').value;
  const trust = $('#f-trust').value;
  const profit = $('#f-profit').value;
  if (roi !== '') params.set('minRoi', roi);
  if (trust !== '') params.set('minTrust', trust);
  if (profit !== '') params.set('minProfit', String(Math.round(Number(profit) * 100)));
  return params;
}

async function loadDeals() {
  const container = $('#deals');
  container.innerHTML = '<p class="muted small">Chargement…</p>';
  try {
    const data = await api(`/api/deals?${filterParams().toString()}`);
    state.deals = data.deals;

    $('#deals-summary').textContent =
      `${data.count} deal(s) — tries par ${$('#f-sort').selectedOptions[0].textContent.toLowerCase()}.`;

    if (data.deals.length === 0) {
      container.innerHTML = '';
      const empty = $('#deals-empty');
      empty.hidden = false;
      empty.textContent = state.status && state.status.lastRun
        ? "Aucun deal ne passe les filtres. Baisse les seuils, ou lance un nouveau cycle."
        : "Aucun cycle n'a encore tourne. Clique sur « Lancer un cycle ».";
      return;
    }

    $('#deals-empty').hidden = true;
    container.innerHTML = data.deals.map(renderDeal).join('');
  } catch (err) {
    if (err.message !== 'unauthorized') banner(`Chargement des deals impossible : ${err.message}`, 'error');
    container.innerHTML = '';
  }
}

/** Delegation d'evenements : les cartes sont reconstruites a chaque chargement. */
$('#deals').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;

  const id = button.dataset.id;
  const action = button.dataset.action;
  const deal = state.deals.find((d) => String(d.id) === String(id));

  try {
    if (action === 'buy') {
      const suggested = ((deal?.buyTotalCents ?? 0) / 100).toFixed(2);
      const input = prompt(
        "Prix reellement paye, frais de port inclus (en EUR).\n\n" +
        "Rappel : cet outil ne fait aucun achat. Tu achetes toi-meme sur la plateforme.",
        suggested,
      );
      if (input === null) return;
      const value = Number(String(input).replace(',', '.'));
      if (!Number.isFinite(value) || value < 0) { banner('Montant invalide.', 'error'); return; }
      await api(`/api/deals/${id}/buy`, {
        method: 'POST',
        body: JSON.stringify({ pricePaidCents: Math.round(value * 100) }),
      });
      banner('Deal marque comme achete. Saisis le prix de vente dans l onglet Capital une fois revendu.', 'ok');
    } else if (action === 'skip') {
      await api(`/api/deals/${id}/skip`, { method: 'POST', body: JSON.stringify({}) });
    } else if (action === 'reset') {
      await api(`/api/deals/${id}/reset`, { method: 'POST', body: JSON.stringify({}) });
    }
    await loadDeals();
  } catch (err) {
    if (err.message !== 'unauthorized') banner(err.message, 'error');
  }
});

['#f-domain', '#f-source', '#f-status', '#f-sort'].forEach((sel) => {
  $(sel).addEventListener('change', () => void loadDeals());
});
['#f-roi', '#f-trust', '#f-profit'].forEach((sel) => {
  $(sel).addEventListener('change', () => void loadDeals());
});
$('#btn-refresh').addEventListener('click', () => void loadDeals());

/* ────────────────────────────── Synthese ────────────────────────────── */

const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { labels: { color: '#8b93a3' } } },
  scales: {
    x: { ticks: { color: '#8b93a3' }, grid: { color: '#262b36' } },
    y: { ticks: { color: '#8b93a3' }, grid: { color: '#262b36' } },
  },
};

function drawChart(key, canvasId, spec) {
  if (state.charts[key]) state.charts[key].destroy();
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  state.charts[key] = new Chart(canvas.getContext('2d'), spec);
}

async function loadSynthese() {
  try {
    const [categories, domains, risk, decisions] = await Promise.all([
      api('/api/stats/categories'),
      api('/api/stats/domains'),
      api('/api/stats/risk'),
      api('/api/stats/decisions?limit=300'),
    ]);

    // ── Indice de revente par categorie
    const cats = categories.categories.filter((c) => c.sampleSize >= 5);
    drawChart('categories', 'chart-categories', {
      type: 'bar',
      data: {
        labels: cats.map((c) => c.label),
        datasets: [{
          label: 'Marge mediane (%)',
          data: cats.map((c) => c.medianMarginPct),
          backgroundColor: cats.map((c) => (c.medianMarginPct >= 0 ? '#4ade80' : '#f87171')),
        }],
      },
      options: {
        ...CHART_DEFAULTS,
        plugins: {
          ...CHART_DEFAULTS.plugins,
          tooltip: {
            callbacks: {
              afterLabel: (ctx) => {
                const c = cats[ctx.dataIndex];
                return `${c.sampleSize} observations · revente ~${Math.round(c.avgDaysToSell)} j`;
              },
            },
          },
        },
      },
    });

    // ── ROI/jour par domaine
    drawChart('domains', 'chart-domains', {
      type: 'bar',
      data: {
        labels: domains.domains.map((d) => d.label),
        datasets: [{
          label: 'ROI / jour (EUR)',
          data: domains.domains.map((d) => d.avgRoiPerDayCents / 100),
          backgroundColor: '#60a5fa',
        }],
      },
      options: {
        ...CHART_DEFAULTS,
        indexAxis: 'y',
        plugins: {
          ...CHART_DEFAULTS.plugins,
          tooltip: {
            callbacks: {
              afterLabel: (ctx) => {
                const d = domains.domains[ctx.dataIndex];
                return `${d.deals} deals · ROI moyen ${d.avgRoiPct} % · confiance ${d.avgTrust}`;
              },
            },
          },
        },
      },
    });

    // ── Nuage risque / profit
    const byDomain = new Map();
    for (const point of risk.points) {
      if (!byDomain.has(point.label)) byDomain.set(point.label, []);
      byDomain.get(point.label).push({ x: point.trustScore, y: point.netProfitCents / 100, title: point.title });
    }
    const palette = ['#4ade80', '#60a5fa', '#fbbf24', '#f87171', '#c084fc', '#22d3ee', '#fb923c', '#a3e635'];
    drawChart('risk', 'chart-risk', {
      type: 'scatter',
      data: {
        datasets: Array.from(byDomain.entries()).map(([label, points], i) => ({
          label,
          data: points,
          backgroundColor: palette[i % palette.length],
        })),
      },
      options: {
        ...CHART_DEFAULTS,
        scales: {
          x: { ...CHART_DEFAULTS.scales.x, title: { display: true, text: 'Score de confiance', color: '#8b93a3' }, min: 0, max: 100 },
          y: { ...CHART_DEFAULTS.scales.y, title: { display: true, text: 'Profit net (EUR)', color: '#8b93a3' } },
        },
        plugins: {
          ...CHART_DEFAULTS.plugins,
          tooltip: { callbacks: { label: (ctx) => ctx.raw.title } },
        },
      },
    });

    // ── Historique des decisions, agrege par jour
    const byDay = new Map();
    for (const d of decisions.decisions) {
      const day = (d.createdAt || '').slice(0, 10);
      if (!day) continue;
      if (!byDay.has(day)) byDay.set(day, { bought: 0, skipped: 0, sold: 0 });
      const bucket = byDay.get(day);
      if (bucket[d.action] !== undefined) bucket[d.action] += 1;
    }
    const days = Array.from(byDay.keys()).sort();
    drawChart('decisions', 'chart-decisions', {
      type: 'bar',
      data: {
        labels: days,
        datasets: [
          { label: 'Achetes', data: days.map((d) => byDay.get(d).bought), backgroundColor: '#4ade80' },
          { label: 'Ecartes', data: days.map((d) => byDay.get(d).skipped), backgroundColor: '#8b93a3' },
          { label: 'Vendus', data: days.map((d) => byDay.get(d).sold), backgroundColor: '#60a5fa' },
        ],
      },
      options: {
        ...CHART_DEFAULTS,
        scales: {
          x: { ...CHART_DEFAULTS.scales.x, stacked: true },
          y: { ...CHART_DEFAULTS.scales.y, stacked: true, ticks: { ...CHART_DEFAULTS.scales.y.ticks, precision: 0 } },
        },
      },
    });

    // ── Tableau des dernieres decisions
    const rows = decisions.decisions.slice(0, 40).map((d) => `
      <tr>
        <td>${dateLabel(d.createdAt)}</td>
        <td><span class="badge">${esc(d.action)}</span></td>
        <td>${esc(d.title)}</td>
        <td>${esc(d.domain)}</td>
        <td class="num">${money(d.netProfitCents)}</td>
        <td class="num">${pct(d.roiPct)}</td>
      </tr>`).join('');
    $('#decisions-table').innerHTML = decisions.decisions.length
      ? `<table><thead><tr><th>Date</th><th>Action</th><th>Annonce</th><th>Domaine</th>
         <th class="num">Profit estime</th><th class="num">ROI</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="muted small">Aucune decision enregistree pour le moment.</p>';
  } catch (err) {
    if (err.message !== 'unauthorized') banner(`Synthese indisponible : ${err.message}`, 'error');
  }
}

/* ─────────────────────────────── Capital ────────────────────────────── */

async function loadCapital() {
  try {
    const data = await api('/api/stats/capital');
    const s = data.summary;

    $('#capital-tiles').innerHTML = [
      { label: 'Investi', value: money(s.investedCents), cls: '' },
      { label: 'Recupere (net de frais)', value: money(s.recoveredCents), cls: '' },
      { label: 'Profit net realise', value: money(s.realisedProfitCents), cls: s.realisedProfitCents >= 0 ? 'is-good' : 'is-bad' },
      { label: 'Capital immobilise', value: money(s.openCapitalCents), cls: '' },
      { label: 'Positions ouvertes', value: String(s.openPositions), cls: '' },
      { label: 'Taux de reussite', value: `${s.winRate} %`, cls: '' },
      { label: 'Duree moyenne de detention', value: `${s.avgHoldDays} j`, cls: '' },
    ].map((t) => `
      <div class="tile">
        <div class="tile-value ${t.cls}">${t.value}</div>
        <div class="tile-label">${t.label}</div>
      </div>`).join('');

    const rows = data.positions.map((p) => {
      const sold = p.soldPriceCents !== null && p.soldPriceCents !== undefined;
      const realised = sold ? p.soldPriceCents - (p.soldFeesCents || 0) - p.boughtPriceCents : null;
      return `
      <tr>
        <td><a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(p.title)}</a></td>
        <td>${esc(p.domain)}</td>
        <td>${dateLabel(p.boughtAt)}</td>
        <td class="num">${money(p.boughtPriceCents, p.currency)}</td>
        <td class="num">${sold ? money(p.soldPriceCents, p.currency) : '—'}</td>
        <td class="num ${realised !== null ? (realised >= 0 ? 'is-good' : 'is-bad') : ''}">
          ${realised !== null ? money(realised, p.currency) : `<span class="muted">est. ${money(p.estimatedProfitCents, p.currency)}</span>`}
        </td>
        <td>${sold ? dateLabel(p.soldAt) : `<button class="btn" data-sell="${p.dealId}">Marquer vendu</button>`}</td>
      </tr>`;
    }).join('');

    $('#capital-table').innerHTML = data.positions.length
      ? `<table><thead><tr><th>Article</th><th>Domaine</th><th>Achete le</th>
         <th class="num">Prix d'achat</th><th class="num">Prix de vente</th>
         <th class="num">Resultat</th><th>Vendu le</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="muted small">Aucune position. Marque un deal comme « Acheter » pour commencer le suivi.</p>';
  } catch (err) {
    if (err.message !== 'unauthorized') banner(`Capital indisponible : ${err.message}`, 'error');
  }
}

$('#capital-table').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-sell]');
  if (!button) return;
  const id = button.dataset.sell;

  const priceInput = prompt('Prix de vente encaisse, port inclus (EUR) :', '');
  if (priceInput === null) return;
  const price = Number(String(priceInput).replace(',', '.'));
  if (!Number.isFinite(price) || price < 0) { banner('Montant invalide.', 'error'); return; }

  const feesInput = prompt('Frais preleves par la plateforme et le transporteur (EUR) :', '0');
  if (feesInput === null) return;
  const fees = Number(String(feesInput).replace(',', '.'));

  try {
    await api(`/api/deals/${id}/sold`, {
      method: 'POST',
      body: JSON.stringify({
        soldPriceCents: Math.round(price * 100),
        feesCents: Number.isFinite(fees) ? Math.round(fees * 100) : 0,
      }),
    });
    banner('Vente enregistree. L indice de revente par categorie a ete recalcule.', 'ok');
    await loadCapital();
  } catch (err) {
    if (err.message !== 'unauthorized') banner(err.message, 'error');
  }
});

/* ─────────────────────────────── Systeme ────────────────────────────── */

const COMPLIANCE_BADGE = {
  'official-api': { label: 'API officielle', cls: 'is-good' },
  tolerated: { label: 'Tolere', cls: 'is-warn' },
  'against-tos': { label: 'Contraire aux CGU', cls: 'is-danger' },
};

async function loadSysteme() {
  try {
    const [status, runs] = await Promise.all([api('/api/status'), api('/api/runs?limit=15')]);
    state.status = status;

    // ── Sources
    $('#connectors').innerHTML = status.connectors.map((c) => {
      const badge = COMPLIANCE_BADGE[c.compliance.level] || { label: c.compliance.level, cls: '' };
      const roles = [c.canDiscover ? 'decouverte' : null, c.canCompare ? 'comparaison' : null]
        .filter(Boolean).join(' + ');
      return `
        <div class="connector">
          <div class="connector-head">
            <strong>${esc(c.label)}</strong>
            <span class="badge ${c.active ? 'is-good' : ''}">${c.active ? 'actif' : 'inactif'}</span>
            <span class="badge ${badge.cls}">${badge.label}</span>
            <span class="badge">${roles || 'aucun role'}</span>
          </div>
          <p class="muted small">${esc(c.compliance.summary)}</p>
          ${c.missing ? `<p class="small error">${esc(c.missing)}</p>` : ''}
          ${c.compliance.reference ? `<p class="small"><a href="${esc(c.compliance.reference)}" target="_blank" rel="noopener noreferrer">Documentation</a></p>` : ''}
        </div>`;
    }).join('');

    // ── Seuils
    const form = $('#settings-form');
    form.minTrustScore.value = status.settings.minTrustScore;
    form.minRoiPct.value = status.settings.minRoiPct;
    form.minNetProfitEur.value = (status.settings.minNetProfitCents / 100).toFixed(2);
    form.alertMinTrustScore.value = status.settings.alertMinTrustScore;
    form.alertMinRoiPerDayEur.value = (status.settings.alertMinRoiPerDayCents / 100).toFixed(2);
    form.alertMaxPerRun.value = status.settings.alertMaxPerRun;

    // ── Chasses
    $('#hunts').innerHTML = `<table><thead><tr><th>Identifiant</th><th>Source</th><th>Domaine</th>
      <th>Requete</th><th>Note</th></tr></thead><tbody>${
      status.hunts.map((h) => `
        <tr>
          <td><code>${esc(h.id)}</code></td>
          <td>${esc(h.source)}</td>
          <td>${esc(h.domain)}</td>
          <td>${esc(h.query)}</td>
          <td class="muted">${esc(h.note)}</td>
        </tr>`).join('')}</tbody></table>`;

    // ── Frais
    $('#fees').innerHTML = `<table><thead><tr><th>Marketplace</th><th class="num">Commission</th>
      <th class="num">Encaissement</th><th class="num">Port sortant</th><th class="num">Emballage</th>
      <th>Note</th></tr></thead><tbody>${
      status.fees.map((f) => `
        <tr>
          <td>${esc(f.label)}</td>
          <td class="num">${f.commissionPct} %${f.fixedCents ? ` + ${money(f.fixedCents)}` : ''}</td>
          <td class="num">${f.paymentPct} %${f.paymentFixedCents ? ` + ${money(f.paymentFixedCents)}` : ''}</td>
          <td class="num">${money(f.shipOutCents)}</td>
          <td class="num">${money(f.packagingCents)}</td>
          <td class="muted">${esc(f.note)}</td>
        </tr>`).join('')}</tbody></table>`;

    // ── Cycles
    $('#runs').innerHTML = runs.runs.length
      ? `<table><thead><tr><th>Debut</th><th>Statut</th><th class="num">Annonces</th>
         <th class="num">Deals crees</th><th class="num">Alertes</th><th>Erreurs</th></tr></thead><tbody>${
        runs.runs.map((r) => {
          let errors = [];
          try { errors = JSON.parse(r.errors_json || '[]'); } catch { errors = []; }
          return `
          <tr>
            <td>${dateLabel(r.started_at)}</td>
            <td><span class="badge ${r.status === 'ok' ? 'is-good' : r.status === 'failed' ? 'is-danger' : 'is-warn'}">${esc(r.status)}</span></td>
            <td class="num">${r.listings_found}</td>
            <td class="num">${r.deals_created}</td>
            <td class="num">${r.alerts_sent}</td>
            <td class="muted small">${esc(errors.join(' · '))}</td>
          </tr>`;
        }).join('')}</tbody></table>`
      : '<p class="muted small">Aucun cycle enregistre.</p>';
  } catch (err) {
    if (err.message !== 'unauthorized') banner(`Etat systeme indisponible : ${err.message}`, 'error');
  }
}

$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  try {
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        minTrustScore: Number(form.minTrustScore.value),
        minRoiPct: Number(form.minRoiPct.value),
        minNetProfitCents: Math.round(Number(form.minNetProfitEur.value) * 100),
        alertMinTrustScore: Number(form.alertMinTrustScore.value),
        alertMinRoiPerDayCents: Math.round(Number(form.alertMinRoiPerDayEur.value) * 100),
        alertMaxPerRun: Number(form.alertMaxPerRun.value),
      }),
    });
    banner('Seuils enregistres.', 'ok');
    await loadDeals();
  } catch (err) {
    if (err.message !== 'unauthorized') banner(err.message, 'error');
  }
});

$('#btn-test-alert').addEventListener('click', async () => {
  try {
    const res = await api('/api/alerts/test', { method: 'POST', body: JSON.stringify({}) });
    banner(res.ok ? 'Alerte de test envoyee. Verifie ton telephone et ta montre.' : 'Envoi refuse par ntfy.', res.ok ? 'ok' : 'error');
  } catch (err) {
    if (err.message !== 'unauthorized') banner(err.message, 'error');
  }
});

/* ──────────────────────────── Cycle manuel ──────────────────────────── */

$('#btn-run').addEventListener('click', async () => {
  const button = $('#btn-run');
  button.disabled = true;
  $('#run-state').textContent = 'Cycle en cours…';
  banner('Collecte en cours. Selon les sources actives, cela peut prendre quelques minutes.', null);
  try {
    const res = await api('/api/run', { method: 'POST', body: JSON.stringify({}) });
    const s = res.summary;
    banner(
      `Cycle termine en ${Math.round(s.durationMs / 1000)} s — ${s.listingsFound} annonces, ` +
      `${s.listingsEvaluated} evaluees, ${s.dealsCreated} nouveaux deals, ${s.alertsSent} alertes.` +
      (s.errors.length ? ` Avertissements : ${s.errors.join(' · ')}` : ''),
      s.errors.length ? 'warn' : 'ok',
    );
    await loadDeals();
  } catch (err) {
    if (err.message !== 'unauthorized') banner(`Cycle en echec : ${err.message}`, 'error');
  } finally {
    button.disabled = false;
    $('#run-state').textContent = '';
  }
});

/* ──────────────────────────── Demarrage ─────────────────────────────── */

async function boot() {
  try {
    const status = await api('/api/status');
    state.status = status;
    closeGate();

    $('#market-label').textContent =
      `${status.market.country} · ${status.market.currency}` + (status.demoMode ? ' · MODE DEMO' : '');

    // Filtres alimentes par le serveur : la liste des domaines et des
    // sources ne doit jamais etre dupliquee dans le front.
    const domainSelect = $('#f-domain');
    domainSelect.innerHTML = '<option value="all">Tous</option>' +
      status.domains.map((d) => `<option value="${esc(d.id)}">${esc(d.label)}</option>`).join('');

    const sourceSelect = $('#f-source');
    sourceSelect.innerHTML = '<option value="all">Toutes</option>' +
      status.connectors.filter((c) => c.canDiscover)
        .map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('');

    $('#f-roi').value = status.settings.minRoiPct;
    $('#f-trust').value = status.settings.minTrustScore;
    $('#f-profit').value = (status.settings.minNetProfitCents / 100).toFixed(0);

    const warnings = [];
    if (!status.alerts.ready) warnings.push("Alertes montre inactives : renseigne NTFY_TOPIC.");
    const inactive = status.connectors.filter((c) => !c.active && c.id !== 'demo');
    if (inactive.length === status.connectors.length - 1) {
      warnings.push('Aucune source configuree : ajoute au moins les cles eBay, ou active DEMO_MODE.');
    }
    if (status.demoMode) warnings.push('Mode demo actif : les deals affiches sont fictifs.');
    if (warnings.length) banner(warnings.join(' — '), 'warn');

    await loadDeals();
  } catch (err) {
    if (err.message !== 'unauthorized') {
      openGate(`Connexion impossible : ${err.message}`);
    }
  }
}

if (!state.token) {
  // Sans jeton enregistre, on tente quand meme : AUTH_TOKEN peut etre vide en local.
  void boot();
} else {
  $('#gate-token').value = '';
  void boot();
}
