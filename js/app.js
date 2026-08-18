const THEME_KEY = 'warranty:v1:theme';
const THEME_VALUES = ['system', 'light', 'dark'];

const VENDORS = [
  { id: 'dell', name: 'Dell', status: 'active' },
  { id: 'lenovo', name: 'Lenovo', status: 'coming-soon' },
  { id: 'apple', name: 'Apple', status: 'coming-soon' },
];

const state = {
  vendor: 'dell',
};

function currentTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  return THEME_VALUES.includes(saved) ? saved : 'system';
}

function applyTheme(theme) {
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  const icon = document.getElementById('theme-toggle-icon');
  icon.textContent = theme === 'dark' ? '\u{1F319}' : theme === 'light' ? '☀️' : '\u{1F5A5}️';
  document.getElementById('theme-toggle-btn').setAttribute(
    'aria-label',
    `Color theme: ${theme}. Click to change.`
  );
}

function initTheme() {
  applyTheme(currentTheme());
  document.getElementById('theme-toggle-btn').addEventListener('click', () => {
    const next = THEME_VALUES[(THEME_VALUES.indexOf(currentTheme()) + 1) % THEME_VALUES.length];
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
}

function renderVendorTabs() {
  const nav = document.getElementById('vendor-tabs');
  nav.innerHTML = '';
  for (const vendor of VENDORS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vendor-tab' + (vendor.status !== 'active' ? ' is-disabled' : '');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(vendor.id === state.vendor));
    btn.innerHTML = `
      <span class="vendor-tab-name">${vendor.name}</span>
      <span class="vendor-tab-status">${vendor.status === 'active' ? 'Available' : 'Coming soon'}</span>
    `;
    btn.addEventListener('click', () => {
      state.vendor = vendor.id;
      renderVendorTabs();
      renderVendorPanel();
    });
    nav.appendChild(btn);
  }
}

function renderVendorPanel() {
  const vendor = VENDORS.find((v) => v.id === state.vendor);
  const comingSoonPanel = document.getElementById('coming-soon-panel');
  const lookupPanel = document.getElementById('lookup-panel');
  const resultsPanel = document.getElementById('results-panel');

  if (vendor.status !== 'active') {
    comingSoonPanel.hidden = false;
    lookupPanel.hidden = true;
    resultsPanel.hidden = true;
    document.getElementById('coming-soon-heading').textContent = `${vendor.name} warranty lookup`;
    document.getElementById('coming-soon-message').textContent =
      `${vendor.name} isn't wired up yet — Dell is the only manufacturer supported right now. Check back once ${vendor.name} support ships.`;
    return;
  }

  comingSoonPanel.hidden = true;
  lookupPanel.hidden = false;
  document.getElementById('lookup-heading').textContent = `${vendor.name} warranty lookup`;
}

function parseTags(raw) {
  return [...new Set(raw.split(/[,\s]+/).map((t) => t.trim().toUpperCase()).filter(Boolean))];
}

function setError(message) {
  const el = document.getElementById('lookup-error');
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

function statusLabel(status) {
  if (status === 'active') return 'Active';
  if (status === 'expired') return 'Expired';
  return 'Unknown';
}

function formatDaysRemaining(days) {
  if (days === null || days === undefined) return '';
  if (days >= 0) return `${days} day${days === 1 ? '' : 's'} remaining`;
  return `Expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`;
}

function renderResults(results) {
  const panel = document.getElementById('results-panel');
  const list = document.getElementById('results-list');
  list.innerHTML = '';

  for (const r of results) {
    const card = document.createElement('div');
    card.className = 'result-card' + (r.valid ? '' : ' is-invalid');

    if (!r.valid) {
      card.innerHTML = `
        <div class="result-card-head">
          <span class="result-tag">${escapeHtml(r.tag)}</span>
          <span class="status-badge status-unknown">No data</span>
        </div>
        <p class="result-error">${escapeHtml(r.error || 'No warranty information found for this service tag.')}</p>
      `;
      list.appendChild(card);
      continue;
    }

    const rows = r.entitlements
      .map(
        (e) => `
        <tr>
          <td>${escapeHtml(e.serviceLevelDescription)}</td>
          <td>${escapeHtml(e.startDate || '—')}</td>
          <td>${escapeHtml(e.endDate || '—')}</td>
        </tr>`
      )
      .join('');

    card.innerHTML = `
      <div class="result-card-head">
        <div>
          <span class="result-tag">${escapeHtml(r.tag)}</span>
          <div class="result-model">${escapeHtml(r.model || 'Unknown model')}</div>
        </div>
        <span class="status-badge status-${r.status}">${statusLabel(r.status)}</span>
      </div>
      <p class="result-meta">
        ${r.shipDate ? `Shipped ${escapeHtml(r.shipDate)}. ` : ''}
        ${r.warrantyEndDate ? `Warranty through ${escapeHtml(r.warrantyEndDate)} (${escapeHtml(formatDaysRemaining(r.daysRemaining))}).` : 'No warranty end date on file.'}
      </p>
      ${
        rows
          ? `<table class="entitlement-table">
              <thead><tr><th>Coverage</th><th>Start</th><th>End</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>`
          : ''
      }
    `;
    list.appendChild(card);
  }

  panel.hidden = results.length === 0;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

async function runLookup() {
  const raw = document.getElementById('tags-input').value;
  const tags = parseTags(raw);
  setError('');

  if (tags.length === 0) {
    setError('Enter at least one service tag.');
    return;
  }
  if (tags.length > 20) {
    setError('Enter at most 20 service tags per lookup.');
    return;
  }

  const btn = document.getElementById('lookup-btn');
  btn.disabled = true;
  const originalLabel = btn.innerHTML;
  btn.innerHTML = 'Looking up…';

  try {
    const url = `/api/warranty/${state.vendor}?tags=${encodeURIComponent(tags.join(','))}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || `Lookup failed (${res.status}).`);
      document.getElementById('results-panel').hidden = true;
      return;
    }
    renderResults(data.results || []);
  } catch (err) {
    setError('Could not reach the warranty service. Check your connection and try again.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
}

function init() {
  initTheme();
  renderVendorTabs();
  renderVendorPanel();

  document.getElementById('lookup-btn').addEventListener('click', runLookup);
  document.getElementById('tags-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      runLookup();
    }
  });
  document.getElementById('clear-btn').addEventListener('click', () => {
    document.getElementById('tags-input').value = '';
    setError('');
    document.getElementById('results-panel').hidden = true;
  });
}

init();
