const THEME_KEY = 'warranty:v1:theme';
const THEME_VALUES = ['system', 'light', 'dark'];

const VENDORS = [
  {
    id: 'apple',
    name: 'Apple',
    status: 'active',
    tagNoun: 'serial number',
    tagExample: 'e.g.\nC02XXXXXXL8\nFVFXXXXXXL8',
    note: 'Apple lookups can take a while the first time, since they page through your organisation’s full device list — later lookups are faster.',
  },
  { id: 'dell', name: 'Dell', status: 'active', tagNoun: 'service tag', tagExample: 'e.g.\n7XJ4K52\n9P2QR13' },
  { id: 'lenovo', name: 'Lenovo', status: 'coming-soon' },
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
}

function initTheme() {
  const theme = currentTheme();
  applyTheme(theme);
  const select = document.getElementById('theme-select');
  select.value = theme;
  select.addEventListener('change', (e) => {
    localStorage.setItem(THEME_KEY, e.target.value);
    applyTheme(e.target.value);
  });
}

function initDialogs() {
  const settingsDialog = document.getElementById('settings-dialog');
  const releaseNotesDialog = document.getElementById('release-notes-dialog');
  const helpDialog = document.getElementById('help-dialog');

  // Native <dialog> already closes on Escape and traps focus — this only
  // adds click-outside-to-close, since that's not built in.
  function closeOnBackdropClick(dialog) {
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
  }

  // Opens a dialog that's nested under the Settings pop-out (Release
  // Notes, Help) — closes Settings first so dialogs don't stack.
  function openFromSettings(dialog) {
    settingsDialog.close();
    dialog.showModal();
  }

  document.getElementById('settings-menu-btn').addEventListener('click', () => settingsDialog.showModal());
  document.getElementById('settings-dialog-close').addEventListener('click', () => settingsDialog.close());
  closeOnBackdropClick(settingsDialog);

  document.getElementById('release-notes-btn').addEventListener('click', () => openFromSettings(releaseNotesDialog));
  document.getElementById('version-badge-btn').addEventListener('click', () => releaseNotesDialog.showModal());
  document.getElementById('release-notes-close').addEventListener('click', () => releaseNotesDialog.close());
  closeOnBackdropClick(releaseNotesDialog);

  document.getElementById('help-btn').addEventListener('click', () => openFromSettings(helpDialog));
  document.getElementById('help-dialog-close').addEventListener('click', () => helpDialog.close());
  closeOnBackdropClick(helpDialog);
}

function initPWA() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch(() => {});
    });
  }

  // Chrome/Edge fire this when the site qualifies for installation;
  // Safari/iOS never fires it, so the button just stays hidden there and
  // Add to Home Screen (Share sheet) is the only install path, as before.
  let deferredInstallPrompt = null;
  const installBtn = document.getElementById('install-app-btn');

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installBtn.hidden = false;
  });

  installBtn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installBtn.hidden = true;
  });

  window.addEventListener('appinstalled', () => {
    installBtn.hidden = true;
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
    const activeNames = VENDORS.filter((v) => v.status === 'active').map((v) => v.name);
    comingSoonPanel.hidden = false;
    lookupPanel.hidden = true;
    resultsPanel.hidden = true;
    document.getElementById('coming-soon-heading').textContent = `${vendor.name} information lookup`;
    document.getElementById('coming-soon-message').textContent =
      `${vendor.name} isn't wired up yet — ${formatList(activeNames)} supported right now. Check back once ${vendor.name} support ships.`;
    return;
  }

  comingSoonPanel.hidden = true;
  lookupPanel.hidden = false;
  document.getElementById('lookup-heading').textContent = `${vendor.name} information lookup`;
  document.getElementById('lookup-hint').textContent =
    `Enter one or more ${vendor.name} ${vendor.tagNoun}s — one per line, or separated by commas/spaces. Up to 20 at a time.`;
  document.getElementById('tags-input').placeholder = vendor.tagExample;

  const noteEl = document.getElementById('lookup-note');
  noteEl.textContent = vendor.note || '';
  noteEl.hidden = !vendor.note;
}

function formatList(items) {
  if (items.length <= 1) return `${items[0] || 'Nothing'} is`;
  if (items.length === 2) return `${items[0]} and ${items[1]} are`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]} are`;
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

// Worker responses use ISO (YYYY-MM-DD) throughout — only converted to
// UK style (DD/MM/YYYY) here, at the point of display.
function formatDateUK(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
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
        <p class="result-error">${escapeHtml(r.error || 'No matching device found.')}</p>
      `;
      list.appendChild(card);
      continue;
    }

    const rows = r.entitlements
      .map(
        (e) => `
        <tr>
          <td>${escapeHtml(e.serviceLevelDescription)}</td>
          <td>${escapeHtml(formatDateUK(e.startDate) || '—')}</td>
          <td>${escapeHtml(formatDateUK(e.endDate) || '—')}</td>
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
        ${r.orgName ? `Found in ${escapeHtml(r.orgName)}. ` : ''}
        ${r.shipDate ? `Shipped ${escapeHtml(formatDateUK(r.shipDate))}. ` : ''}
        ${r.warrantyEndDate ? `Warranty through ${escapeHtml(formatDateUK(r.warrantyEndDate))} (${escapeHtml(formatDaysRemaining(r.daysRemaining))}).` : 'No warranty end date on file.'}
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
    setError('Could not reach the lookup service. Check your connection and try again.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
}

function init() {
  initTheme();
  initDialogs();
  initPWA();
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
