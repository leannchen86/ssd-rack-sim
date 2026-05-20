// ui.js — DOM-based UI panels
// Server selector, bay config, workload, RAID, drive palette, stats, insights, drive info
import { EventBus, RAID_MODES, buildBays } from './state.js';

// NVMe is backwards compatible — PCIe 4 drives work in PCIe 5 bays
function interfaceCompatible(driveIf, bayIf) {
  if (driveIf === bayIf) return true;
  // NVMe PCIe 4 drive in NVMe PCIe 5 bay — OK (runs at Gen4 speed)
  if (driveIf === 'NVMe PCIe 4' && bayIf === 'NVMe PCIe 5') return true;
  if (driveIf === 'NVMe PCIe 3' && (bayIf === 'NVMe PCIe 4' || bayIf === 'NVMe PCIe 5')) return true;
  return false;
}

export class UI {
  constructor(state, computeStatsFn, generateInsightsFn, computeFitnessFn) {
    this.state = state;
    this.computeStats = computeStatsFn;
    this.generateInsights = generateInsightsFn;
    this.computeFitness = computeFitnessFn;

    this.els = {
      serverSelect: document.getElementById('server-select'),
      bayConfigSelect: document.getElementById('bay-config-select'),
      bayConfigGroup: document.getElementById('bay-config-group'),
      raidSelect: document.getElementById('raid-select'),
      workloadSelect: document.getElementById('workload-select'),
      moduleToggle: document.getElementById('module-toggle'),
      moduleInfo: document.getElementById('module-info'),
      drivePalette: document.getElementById('drive-palette'),
      statsPanel: document.getElementById('stats-panel'),
      fitnessPanel: document.getElementById('fitness-panel'),
      insightsPanel: document.getElementById('insights-panel'),
      driveInfo: document.getElementById('drive-info'),
      fillAll: document.getElementById('fill-all-btn'),
      clearAll: document.getElementById('clear-all-btn'),
    };

    this._initServerSelect();
    this._initBayConfigSelect();
    this._initRaidSelect();
    this._initWorkloadSelect();
    this._initModuleToggle();
    this._initButtons();
    this._initDrivePalette();

    EventBus.on('state:change', () => this.refresh());
    EventBus.on('bay:update', () => this.refresh());
    EventBus.on('server:change', () => this.refresh());
    EventBus.on('modules:change', () => this.refresh());
  }

  // === SERVER ===
  _initServerSelect() {
    const sel = this.els.serverSelect;
    sel.innerHTML = '<option value="">— pick a server —</option>';

    // Group by owned vs new
    const owned = this.state.serverCatalog.filter(s => s.owned);
    const available = this.state.serverCatalog.filter(s => !s.owned);

    if (owned.length) {
      const g = document.createElement('optgroup');
      g.label = 'EXISTING FLEET (owned)';
      owned.forEach(s => {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = `${s.name}  (${s.formUnit}, ${s.bays[0].count}× ${s.bays[0].formFactor})`;
        g.appendChild(o);
      });
      sel.appendChild(g);
    }

    if (available.length) {
      const g = document.createElement('optgroup');
      g.label = 'NEW SERVERS';
      available.forEach(s => {
        const bays = s.bayConfigs ? s.bayConfigs[0].name : `${s.bays[0].count}× ${s.bays[0].formFactor}`;
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = `${s.name}  ($${s.priceUSD.toLocaleString()}, ${bays})`;
        g.appendChild(o);
      });
      sel.appendChild(g);
    }

    sel.addEventListener('change', () => {
      const server = this.state.serverCatalog.find(s => s.id === sel.value) || null;
      this.state.server = server;
      this.state.modules = [];
      this.state.activeBayConfig = server?.bayConfigs ? server.bayConfigs[0].id : null;
      this._rebuildBays();
      this._updateBayConfigSelect();
      this._updateModuleToggle();
      this._updateDrivePaletteFilter();
      EventBus.emit('server:change');
    });
  }

  // === BAY CONFIG (for R7725-type servers) ===
  _initBayConfigSelect() {
    this.els.bayConfigSelect.addEventListener('change', () => {
      this.state.activeBayConfig = this.els.bayConfigSelect.value;
      this._rebuildBays();
      this._updateDrivePaletteFilter();
      EventBus.emit('server:change');
    });
  }

  _updateBayConfigSelect() {
    const server = this.state.server;
    const group = this.els.bayConfigGroup;
    const sel = this.els.bayConfigSelect;

    if (!server?.bayConfigs) {
      group.style.display = 'none';
      return;
    }

    group.style.display = 'block';
    sel.innerHTML = '';
    server.bayConfigs.forEach(c => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      if (c.id === this.state.activeBayConfig) o.selected = true;
      sel.appendChild(o);
    });
  }

  // === RAID ===
  _initRaidSelect() {
    const sel = this.els.raidSelect;
    Object.entries(RAID_MODES).forEach(([key, mode]) => {
      const o = document.createElement('option');
      o.value = key;
      o.textContent = `${mode.name}  — ${mode.description}`;
      if (key === this.state.raidMode) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      this.state.raidMode = sel.value;
      EventBus.emit('raid:change');
    });
  }

  // === WORKLOAD ===
  _initWorkloadSelect() {
    const sel = this.els.workloadSelect;
    sel.innerHTML = '<option value="">— no workload target —</option>';
    this.state.workloadCatalog.forEach(w => {
      const o = document.createElement('option');
      o.value = w.id;
      o.textContent = `${w.name}`;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      this.state.workload = this.state.workloadCatalog.find(w => w.id === sel.value) || null;
      this._updateDrivePaletteFilter();
      EventBus.emit('workload:change');
    });
  }

  // === MODULE (AIC) ===
  _initModuleToggle() {
    this.els.moduleToggle.addEventListener('change', (e) => {
      const mod = this.state.moduleCatalog[0]; // Apex X16
      if (e.target.checked && mod) {
        // Check if server has a free slot
        if (!this.state.server) { e.target.checked = false; return; }
        const freeSlot = this.state.server.pcieSlotsRear?.find(s => !s.occupied && s.type === 'x16');
        if (!freeSlot) {
          e.target.checked = false;
          this.els.moduleInfo.textContent = 'No free x16 PCIe slot available on this server.';
          this.els.moduleInfo.className = 'text-xs text-red-400 mt-1 font-mono';
          return;
        }
        this.state.modules = [mod];
      } else {
        this.state.modules = [];
      }
      this._rebuildBays();
      this._updateModuleInfo();
      this._updateDrivePaletteFilter();
      EventBus.emit('modules:change');
    });
  }

  _updateModuleToggle() {
    const toggle = this.els.moduleToggle;
    toggle.checked = this.state.modules.length > 0;
    this._updateModuleInfo();

    if (!this.state.server) {
      toggle.disabled = true;
      return;
    }
    const freeSlot = this.state.server.pcieSlotsRear?.find(s => !s.occupied && s.type === 'x16');
    toggle.disabled = !freeSlot;
  }

  _updateModuleInfo() {
    const el = this.els.moduleInfo;
    if (this.state.modules.length === 0) {
      if (!this.state.server) {
        el.textContent = '';
      } else {
        const freeSlots = this.state.server.pcieSlotsRear?.filter(s => !s.occupied && s.type === 'x16').length || 0;
        el.textContent = freeSlots > 0 ? `${freeSlots} free x16 slot(s) — can install AIC` : 'No free x16 slot';
        el.className = `text-xs ${freeSlots > 0 ? 'text-gray-500' : 'text-gray-600'} mt-1 font-mono`;
      }
      return;
    }
    const mod = this.state.modules[0];
    const hostGen = this.state.server?.pcieGen || 3;
    const perf = mod.performanceByHostGen?.[hostGen];
    el.innerHTML = `<span class="text-purple-400">${mod.name}</span> · $${mod.priceUSD.toLocaleString()} · ${mod.provides.count} M.2 slots` +
      (perf ? `<br><span class="${hostGen < 5 ? 'text-yellow-400' : 'text-green-400'}">${perf.note}</span>` : '');
    el.className = 'text-xs mt-1 font-mono';
  }

  // === DRIVE PALETTE ===
  _retailConsumerDrives() {
    return this.state.drives.filter(d => d.category === 'consumer' && d.priceUSD > 0);
  }

  _initDrivePalette() {
    this._renderDrivePalette(this._retailConsumerDrives());
  }

  _updateDrivePaletteFilter() {
    const pool = this._retailConsumerDrives();
    if (!this.state.server) {
      this._renderDrivePalette(pool);
      return;
    }

    const compat = pool.filter(d => this._driveCompatWithBays(d));
    const incompat = pool.filter(d => !this._driveCompatWithBays(d));
    this._renderDrivePalette(compat, incompat);
  }

  _renderDrivePalette(compatible, incompatible = []) {
    const container = this.els.drivePalette;
    container.innerHTML = '';

    if (compatible.length === 0 && incompatible.length === 0) {
      container.innerHTML = '<div class="text-gray-500 text-sm p-2 font-mono">No drives loaded</div>';
      return;
    }

    compatible.forEach(d => container.appendChild(this._createDriveCard(d, false)));

    if (incompatible.length > 0) {
      const div = document.createElement('div');
      div.className = 'text-gray-600 text-xs px-2 py-1 border-t border-gray-800 mt-2 pt-2 font-mono';
      div.textContent = 'INCOMPATIBLE WITH CONFIG';
      container.appendChild(div);
      incompatible.forEach(d => container.appendChild(this._createDriveCard(d, true)));
    }
  }

  _createDriveCard(drive, disabled) {
    const card = document.createElement('div');
    card.className = `drive-card group flex items-center gap-2 p-2 rounded border bg-gray-900/30 transition-colors
      ${disabled ? 'opacity-25 cursor-not-allowed border-transparent' : 'hover:bg-gray-800/70 border-gray-800 cursor-pointer'}`;
    card.dataset.driveId = drive.id;
    card.title = `${drive.name} · ${drive.capacityTB}TB · ${drive.interface} · ${drive.supplyRisk} supply risk`;

    const mini = document.createElement('div');
    mini.className = 'relative flex-shrink-0 rounded-sm border border-gray-700 shadow-inner';
    mini.style.width = drive.formFactor === 'M.2 2280' ? '18px' : '24px';
    mini.style.height = '42px';
    mini.style.background = `linear-gradient(160deg, ${drive.color}, #0b1020 88%)`;
    mini.innerHTML = `
      <div class="absolute left-1 right-1 top-1 rounded-sm" style="height:4px;background:rgba(255,255,255,.18)"></div>
      <div class="absolute left-1 right-1 bottom-2 rounded-sm" style="height:3px;background:rgba(0,0,0,.32)"></div>
      <div class="absolute left-1 bottom-1 rounded-full" style="width:3px;height:3px;background:#4fc3f7;box-shadow:0 0 5px #4fc3f7"></div>
    `;

    const info = document.createElement('div');
    info.className = 'flex-1 min-w-0';
    const price = drive.priceUSD
      ? `$${drive.priceUSD.toLocaleString()}`
      : '<span class="text-yellow-600">Unpriced</span>';
    const read = drive.seqReadMBs >= 1000
      ? `${(drive.seqReadMBs / 1000).toFixed(1)}GB/s`
      : `${drive.seqReadMBs}MB/s`;
    info.innerHTML = `
      <div class="text-xs font-mono text-gray-200 truncate">${drive.name}</div>
      <div class="flex items-center gap-1 text-xs font-mono text-gray-500 whitespace-nowrap">
        <span class="text-gray-300">${drive.capacityTB}TB</span>
        <span>${drive.formFactor}</span>
        <span>·</span>
        <span>${drive.interface === 'SATA III' ? 'SATA' : drive.interface.replace('NVMe PCIe ', 'Gen')}</span>
      </div>
      <div class="flex items-center justify-between gap-2 text-xs font-mono">
        <span class="text-gray-500">${read}</span>
        <span class="${drive.priceUSD ? 'text-gray-400' : 'text-yellow-600'}">${price}</span>
      </div>
    `;

    const risk = document.createElement('div');
    risk.className = 'flex-shrink-0 self-stretch flex flex-col items-center justify-between py-1';
    const rc = {
      low: 'background:#4caf50;box-shadow:0 0 6px rgba(76,175,80,.75)',
      medium: 'background:#ff9800;box-shadow:0 0 6px rgba(255,152,0,.7)',
      high: 'background:#f44336;box-shadow:0 0 7px rgba(244,67,54,.85)'
    }[drive.supplyRisk];
    risk.innerHTML = `
      <div class="rounded-full" style="width:7px;height:7px;${rc}" title="Supply: ${drive.supplyRisk}"></div>
      <div class="text-gray-700 font-mono" style="font-size:8px;writing-mode:vertical-rl;letter-spacing:0">${drive.nandType}</div>
    `;

    card.append(mini, info, risk);

    if (!disabled) {
      card.draggable = true;
      card.addEventListener('dragstart', (e) => {
        this.state.dragDrive = drive;
        e.dataTransfer.setData('text/plain', drive.id);
        e.dataTransfer.effectAllowed = 'copy';
      });
      card.addEventListener('dragend', () => { this.state.dragDrive = null; });
      card.addEventListener('click', () => {
        const bay = this.state.selectedBay;
        if (bay >= 0 && this.state.bays[bay]) {
          const b = this.state.bays[bay];
          if (b.formFactor === drive.formFactor && interfaceCompatible(drive.interface, b.interface)) {
            b.drive = drive;
            const next = this.state.bays.findIndex((b2, i) =>
              i > bay && !b2.drive && b2.formFactor === drive.formFactor && interfaceCompatible(drive.interface, b2.interface)
            );
            this.state.selectedBay = next >= 0 ? next : -1;
            EventBus.emit('bay:update');
          }
        }
      });
    }

    return card;
  }

  _initButtons() {
    this.els.fillAll?.addEventListener('click', () => {
      if (!this.state.server) return;
      for (const bay of this.state.bays) {
        if (bay.drive) continue;
        const compat = this.state.drives.filter(d =>
          d.formFactor === bay.formFactor && interfaceCompatible(d.interface, bay.interface) &&
          d.category === 'consumer' && d.priceUSD > 0
        );
        if (compat.length > 0) {
          // Prefer cheapest compatible drive (exclude unpriced)
          compat.sort((a, b) => (a.priceUSD / a.capacityTB) - (b.priceUSD / b.capacityTB));
          bay.drive = compat[0];
        }
      }
      EventBus.emit('bay:update');
    });

    this.els.clearAll?.addEventListener('click', () => {
      this.state.bays.forEach(b => { b.drive = null; });
      this.state.selectedBay = -1;
      EventBus.emit('bay:update');
    });
  }

  _driveCompatWithBays(drive) {
    return this.state.bays.some(b =>
      b.formFactor === drive.formFactor && interfaceCompatible(drive.interface, b.interface)
    );
  }

  _rebuildBays() {
    this.state.bays = buildBays(this.state.server, this.state.activeBayConfig, this.state.modules);
    this.state.selectedBay = -1;
    this.state.hoveredBay = -1;
  }

  _escapeHtml(value) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value ?? '').replace(/[&<>"']/g, ch => map[ch]);
  }

  _clampPercent(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, value));
  }

  _money(value) {
    const n = Number(value) || 0;
    if (Math.abs(n) >= 1000000) return `$${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}M`;
    if (Math.abs(n) >= 10000) return `$${Math.round(n / 1000)}k`;
    if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`;
    return `$${Math.round(n).toLocaleString()}`;
  }

  _compactNumber(value, digits = 1) {
    const n = Number(value) || 0;
    if (Math.abs(n) >= 1000000) return `${(n / 1000000).toFixed(digits)}M`;
    if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : digits)}K`;
    return n.toFixed(digits).replace(/\.0$/, '');
  }

  _meter(value, max, color, title = '') {
    const pct = max > 0 ? this._clampPercent((value / max) * 100) : 0;
    return this._meterPercent(pct, color, title);
  }

  _meterPercent(pct, color, title = '') {
    return `
      <div class="meter" title="${this._escapeHtml(title)}">
        <div class="meter-fill" style="width:${this._clampPercent(pct).toFixed(1)}%;background:${color}"></div>
      </div>
    `;
  }

  _splitBar(segments) {
    const visible = segments.filter(s => s.value > 0);
    const total = visible.reduce((sum, s) => sum + s.value, 0);
    if (total <= 0) return '<div class="split-bar"></div>';
    return `
      <div class="split-bar">
        ${visible.map(s => `
          <div class="split-segment" style="width:${((s.value / total) * 100).toFixed(1)}%;background:${s.color}" title="${this._escapeHtml(s.label)}"></div>
        `).join('')}
      </div>
    `;
  }

  _countBy(items, getKey) {
    return items.reduce((counts, item) => {
      const key = getKey(item) || 'Unknown';
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {});
  }

  _topEntries(counts, limit = 3) {
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);
  }

  _riskTone(risk) {
    return {
      low: { color: '#22c55e', text: 'text-green-400', label: 'LOW' },
      medium: { color: '#f59e0b', text: 'text-yellow-400', label: 'MED' },
      high: { color: '#ef4444', text: 'text-red-400', label: 'HIGH' },
    }[risk] || { color: '#64748b', text: 'text-gray-500', label: 'UNK' };
  }

  _chip(label, value, color = '#64748b', title = '') {
    const hasValue = value !== undefined && value !== null && value !== '';
    const text = label && hasValue ? `${label} ${value}` : (hasValue ? String(value) : label);
    return `
      <span class="info-chip" title="${this._escapeHtml(title || text)}">
        <span class="chip-dot" style="background:${color}"></span>
        ${this._escapeHtml(text)}
      </span>
    `;
  }

  _fitnessTone(status) {
    return {
      green: { color: '#22c55e', text: 'text-green-400', label: 'OK' },
      yellow: { color: '#f59e0b', text: 'text-yellow-400', label: 'WATCH' },
      red: { color: '#ef4444', text: 'text-red-400', label: 'GAP' },
    }[status] || { color: '#64748b', text: 'text-gray-500', label: 'N/A' };
  }

  _severityMeta(severity) {
    return {
      critical: { mark: '!!', color: '#ef4444', border: 'border-red-900', text: 'text-red-400', label: 'critical' },
      warning: { mark: '!', color: '#f59e0b', border: 'border-yellow-900', text: 'text-yellow-400', label: 'watch' },
      suggestion: { mark: 'i', color: '#3b82f6', border: 'border-blue-900', text: 'text-blue-400', label: 'idea' },
      info: { mark: '.', color: '#64748b', border: 'border-gray-800', text: 'text-gray-500', label: 'info' },
    }[severity] || { mark: '.', color: '#64748b', border: 'border-gray-800', text: 'text-gray-500', label: 'info' };
  }

  _shortMessage(message, max = 118) {
    const text = String(message || '').replace(/\s+/g, ' ').trim();
    const stop = text.indexOf('. ');
    const first = stop > 0 ? text.slice(0, stop + 1) : text;
    return first.length > max ? `${first.slice(0, max - 3).trim()}...` : first;
  }

  // === REFRESH ALL PANELS ===
  refresh() {
    this.updateStats();
    this.updateFitness();
    this.updateDriveInfo();
    this.updateInsights();
  }

  updateStats() {
    const stats = this.computeStats(this.state);
    const panel = this.els.statsPanel;
    if (!panel || !this.state.server) {
      if (panel) panel.innerHTML = '<div class="text-gray-600 text-xs font-mono p-4 text-center">Select a server to begin</div>';
      return stats;
    }

    const workload = this.state.workload;
    const capTarget = workload?.requirements?.minUsableTB || stats.rawTB || 1;
    const capTitle = workload?.requirements?.minUsableTB
      ? `${stats.usableTB.toFixed(1)} TB usable vs ${workload.requirements.minUsableTB} TB target`
      : `${stats.usableTB.toFixed(1)} TB usable from ${stats.rawTB.toFixed(1)} TB raw`;
    const capColor = workload?.requirements?.minUsableTB && stats.usableTB < workload.requirements.minUsableTB ? '#f59e0b' : '#4fc3f7';

    const riskMeta = stats.supplyRiskScore < 30
      ? { text: 'text-green-400', color: '#22c55e', label: 'LOW' }
      : stats.supplyRiskScore < 60
        ? { text: 'text-yellow-400', color: '#f59e0b', label: 'MED' }
        : { text: 'text-red-400', color: '#ef4444', label: 'HIGH' };
    const raidMeta = stats.raidValid
      ? { text: 'text-green-400', color: '#22c55e', label: 'VALID' }
      : { text: 'text-red-400', color: '#ef4444', label: stats.raidError || 'INVALID' };
    const raidShort = stats.raidValid ? 'VALID' : 'CHECK';

    const bwMax = Math.max(
      stats.realisticReadGBs,
      stats.realisticWriteGBs,
      workload?.requirements?.minSeqWriteGBs || 0,
      1
    );
    const powerCeiling = Math.max(
      300,
      (this.state.server.powerBaseW || 0) +
      this.state.bays.length * 25 +
      this.state.modules.reduce((s, m) => s + (m.thermalLoadW || 0), 0)
    );
    const rebuildCeiling = Math.max(24, stats.rebuildTimeHours || 0);

    const costSegments = [
      { label: `Drives: $${stats.driveCost.toLocaleString()}`, value: stats.driveCost, color: '#4fc3f7' },
      { label: stats.chassisCost > 0 ? `Server: $${stats.chassisCost.toLocaleString()}` : 'Server: owned', value: stats.chassisCost, color: '#8b5cf6' },
      { label: `AIC: $${stats.moduleCost.toLocaleString()}`, value: stats.moduleCost, color: '#22c55e' },
    ];

    const vendorColors = ['#4fc3f7', '#8b5cf6', '#22c55e', '#f97316', '#64748b'];
    const vendorEntries = Object.entries(stats.vendorConcentration).sort((a, b) => b[1] - a[1]);
    const vendorSegments = vendorEntries.map(([vendor, count], i) => ({
      label: `${vendor}: ${((count / stats.driveCount) * 100).toFixed(0)}%`,
      value: count,
      color: vendorColors[i % vendorColors.length],
    }));
    const topVendor = vendorEntries[0]
      ? `${vendorEntries[0][0]} ${((vendorEntries[0][1] / stats.driveCount) * 100).toFixed(0)}%`
      : 'empty';
    const bayFillPct = this.state.bays.length ? (stats.driveCount / this.state.bays.length) * 100 : 0;
    const rebuildTone = stats.rebuildWarning ? '#ef4444' : stats.rebuildDegraded ? '#f59e0b' : '#22c55e';
    const rebuildLabel = stats.rebuildWarning ? 'no rebuild safety' : stats.rebuildDegraded ? 'degraded window' : 'mirror copy';
    const supplyLabel = stats.driveCount ? riskMeta.label : 'NONE';

    panel.innerHTML = `
      <div class="stats-shell">
        <div class="stat-hero-grid">
          <div class="stat-hero">
            <div class="flex items-center justify-between gap-2">
              <div class="stat-label">CAPACITY</div>
              <span class="status-pill ${capColor === '#f59e0b' ? 'text-yellow-400' : 'text-blue-300'}">${workload?.requirements?.minUsableTB ? 'TARGET' : 'USABLE'}</span>
            </div>
            <div class="flex items-end justify-between gap-3">
              <div class="stat-value">${stats.usableTB.toFixed(1)} <span class="text-sm text-gray-500">TB</span></div>
              <div class="stat-sub text-gray-500">${stats.rawTB.toFixed(1)} raw</div>
            </div>
            ${this._meter(stats.usableTB, capTarget, capColor, capTitle)}
          </div>
          <div class="stat-hero">
            <div class="flex items-center justify-between gap-2">
              <div class="stat-label">COST</div>
              ${stats.priceIncomplete ? '<span class="status-pill text-yellow-400" title="One or more drives are missing prices">LOWER</span>' : ''}
            </div>
            <div class="flex items-end justify-between gap-3">
              <div class="stat-value">${this._money(stats.totalCost)}${stats.priceIncomplete ? '<span class="text-yellow-500 text-sm">+?</span>' : ''}</div>
              <div class="stat-sub text-gray-500">$${stats.costPerUsableTB.toFixed(0)}/TB</div>
            </div>
            ${this._splitBar(costSegments)}
            <div class="stat-sub text-gray-500">$${stats.costPerUsableTBYear5.toFixed(0)}/TB yr</div>
          </div>
        </div>

        <div class="stat-row">
          <div class="stat-label">RAID</div>
          <div class="stat-row-main">${RAID_MODES[this.state.raidMode].name.replace(/\s+\(.+\)/, '')}</div>
          <span class="status-pill ${raidMeta.text}" title="${this._escapeHtml(raidMeta.label)}">${raidShort}</span>
        </div>

        <div class="stat-row">
          <div class="stat-label">B/W</div>
          <div class="min-w-0 space-y-1">
            <div class="metric-pair">
              <span>R</span>
              ${this._meter(stats.realisticReadGBs, bwMax, '#4fc3f7', `${stats.realisticReadGBs.toFixed(1)} GB/s read`)}
              <span class="text-gray-300 text-right">${stats.realisticReadGBs.toFixed(1)}</span>
            </div>
            <div class="metric-pair">
              <span>W</span>
              ${this._meter(stats.realisticWriteGBs, bwMax, '#22c55e', `${stats.realisticWriteGBs.toFixed(1)} GB/s write`)}
              <span class="text-gray-300 text-right">${stats.realisticWriteGBs.toFixed(1)}</span>
            </div>
          </div>
          ${stats.busSaturated ? '<span class="status-pill text-yellow-400" title="Drive bandwidth exceeds chassis bus cap">BUS CAP</span>' : '<span class="stat-sub text-gray-500">GB/s</span>'}
        </div>

        <div class="stat-mini-grid">
          <div class="stat-mini">
            <div class="stat-label">POWER</div>
            <div class="stat-value-sm">${stats.totalPowerW.toFixed(0)} W</div>
            ${this._meter(stats.totalPowerW, powerCeiling, '#a78bfa', `${stats.totalPowerW.toFixed(0)} W estimated`)}
          </div>
          <div class="stat-mini">
            <div class="stat-label">REBUILD</div>
            <div class="stat-value-sm">${stats.rebuildTimeHours.toFixed(1)} h</div>
            ${this._meter(stats.rebuildTimeHours, rebuildCeiling, rebuildTone, stats.rebuildWarning || (stats.rebuildDegraded ? 'Array vulnerable during rebuild' : 'Mirror rebuild estimate'))}
            <div class="stat-sub ${stats.rebuildWarning ? 'text-red-400' : stats.rebuildDegraded ? 'text-yellow-500' : 'text-gray-500'}">${rebuildLabel}</div>
          </div>
          <div class="stat-mini">
            <div class="stat-label">SUPPLY</div>
            <div class="stat-value-sm ${stats.driveCount ? riskMeta.text : 'text-gray-500'}">${stats.supplyRiskScore.toFixed(0)}/100</div>
            ${this._meterPercent(stats.supplyRiskScore, stats.driveCount ? riskMeta.color : '#64748b', `${supplyLabel} supply risk`)}
            <div class="stat-sub text-gray-500">${supplyLabel}${stats.highRiskCount ? ` · ${stats.highRiskCount} high` : ''}</div>
          </div>
          <div class="stat-mini">
            <div class="stat-label">BAYS</div>
            <div class="stat-value-sm">${stats.driveCount}/${this.state.bays.length}</div>
            ${this._meterPercent(bayFillPct, '#4fc3f7', `${stats.driveCount} of ${this.state.bays.length} bays filled`)}
            <div class="stat-sub text-gray-500" title="${this._escapeHtml(vendorEntries.map(([v, c]) => `${v}: ${c}`).join(' · '))}">${topVendor}</div>
          </div>
        </div>
      </div>
    `;

    return stats;
  }

  updateFitness() {
    const panel = this.els.fitnessPanel;
    if (!panel) return;

    const workload = this.state.workload;
    if (!workload || !this.state.server) {
      panel.innerHTML = '';
      return;
    }

    const stats = this.computeStats(this.state);
    const filled = this.state.bays.filter(b => b.drive);
    if (filled.length === 0) {
      panel.innerHTML = `<div class="text-xs font-mono text-gray-600 p-2">Add drives to see ${this._escapeHtml(workload.name)} fitness</div>`;
      return;
    }

    const drives = filled.map(b => b.drive);
    const fit = this.computeFitness(stats, workload, drives);
    if (!fit) return;

    const reqs = workload.requirements || {};
    const aggIOPS = drives.reduce((s, d) => s + d.random4KReadIOPS, 0);
    const minDWPD = drives.length ? Math.min(...drives.map(d => d.dwpd || 0)) : 0;
    const rows = [];

    if (reqs.minUsableTB) {
      rows.push({
        label: 'CAP',
        value: stats.usableTB,
        target: reqs.minUsableTB,
        display: `${stats.usableTB.toFixed(1)}/${reqs.minUsableTB} TB`,
        status: fit.capacity,
        detail: fit.capacityDetail,
      });
    }
    if (reqs.minSeqWriteGBs) {
      rows.push({
        label: 'WRITE',
        value: stats.realisticWriteGBs,
        target: reqs.minSeqWriteGBs,
        display: `${stats.realisticWriteGBs.toFixed(1)}/${reqs.minSeqWriteGBs} GB/s`,
        status: fit.seqWrite,
        detail: fit.seqWriteDetail,
      });
    }
    if (reqs.minRandomReadIOPS) {
      rows.push({
        label: 'IOPS',
        value: aggIOPS,
        target: reqs.minRandomReadIOPS,
        display: `${this._compactNumber(aggIOPS, 0)}/${this._compactNumber(reqs.minRandomReadIOPS, 0)}`,
        status: fit.randomRead,
        detail: fit.randomReadDetail,
      });
    }
    if (reqs.minDWPD) {
      rows.push({
        label: 'DWPD',
        value: minDWPD,
        target: reqs.minDWPD,
        display: `${minDWPD}/${reqs.minDWPD}`,
        status: fit.endurance,
        detail: fit.enduranceDetail,
      });
    }

    const rank = { red: 3, yellow: 2, green: 1 };
    const worst = rows.reduce((acc, row) => rank[row.status] > rank[acc] ? row.status : acc, 'green');
    const overall = this._fitnessTone(worst);
    const dominant = Object.entries(workload.priorities || {}).find(([, v]) => v === 'critical')?.[0] || 'mixed';

    panel.innerHTML = `
      <div class="fitness-card">
        <div class="flex items-center justify-between gap-2 mb-2">
          <div class="text-xs font-mono text-gray-300 truncate">${this._escapeHtml(workload.name)}</div>
          <span class="status-pill ${overall.text}">${overall.label}</span>
        </div>
        <div class="space-y-1">
          ${rows.map(row => {
            const tone = this._fitnessTone(row.status);
            return `
              <div class="fitness-row" title="${this._escapeHtml(row.detail)}">
                <span>${row.label}</span>
                ${this._meter(row.value, row.target, tone.color, row.detail)}
                <span class="text-gray-400 text-right">${this._escapeHtml(row.display)}</span>
              </div>
            `;
          }).join('')}
        </div>
        <div class="mt-2 pt-2 border-t border-gray-800 flex items-center justify-between text-xs font-mono">
          <span class="text-gray-600">dominant</span>
          <span class="text-gray-400">${this._escapeHtml(dominant)}</span>
        </div>
      </div>
    `;
  }

  updateInsights() {
    const panel = this.els.insightsPanel;
    if (!panel) return;

    const stats = this.computeStats(this.state);
    const insights = this.generateInsights(this.state, stats, this.state.workload);

    if (insights.length === 0) {
      panel.innerHTML = '<div class="text-xs font-mono text-gray-600 p-2">Configure a build to see tradeoff analysis</div>';
      return;
    }

    const counts = insights.reduce((acc, ins) => {
      acc[ins.severity] = (acc[ins.severity] || 0) + 1;
      return acc;
    }, {});
    const categoryCounts = insights.reduce((acc, ins) => {
      acc[ins.category] = (acc[ins.category] || 0) + 1;
      return acc;
    }, {});
    const categoryEntries = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const visible = insights.slice(0, 4);
    const hidden = insights.slice(4);
    const severityOrder = ['critical', 'warning', 'suggestion', 'info'];
    const renderCard = (ins, compact = false) => {
      const meta = this._severityMeta(ins.severity);
      const message = this._shortMessage(ins.message, compact ? 92 : 118);
      return `
        <div class="insight-card insight-compact mb-1 rounded border ${meta.border} bg-gray-900/50 text-xs font-mono" title="${this._escapeHtml(ins.message)}">
          <div class="flex items-start gap-2">
            <div class="flex-shrink-0 ${meta.text} font-bold mt-px">${meta.mark}</div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center justify-between gap-2">
                <span class="text-gray-200 truncate">${this._escapeHtml(ins.title)}</span>
                <span class="text-gray-600 flex-shrink-0">${this._escapeHtml(ins.category)}</span>
              </div>
              <div class="text-gray-500 mt-0.5 leading-snug line-clamp-2">${this._escapeHtml(message)}</div>
            </div>
          </div>
        </div>
      `;
    };

    panel.innerHTML = `
      <div class="mb-2 rounded border border-gray-800 bg-gray-900/40 p-2">
        <div class="flex items-center gap-2 mb-2">
          ${severityOrder.filter(sev => counts[sev]).map(sev => {
            const meta = this._severityMeta(sev);
            return `<span class="status-pill ${meta.text}" style="border-color:${meta.color}55">${counts[sev]} ${meta.label}</span>`;
          }).join('')}
        </div>
        <div class="category-chips">
          ${categoryEntries.map(([cat, count]) => `<span class="category-chip" title="${this._escapeHtml(cat)}">${this._escapeHtml(cat)} ${count}</span>`).join('')}
        </div>
      </div>
      ${visible.map(ins => renderCard(ins)).join('')}
      ${hidden.length > 0 ? `
        <details class="compact-details mt-1">
          <summary>+ ${hidden.length} more tradeoff${hidden.length > 1 ? 's' : ''}</summary>
          ${hidden.map(ins => renderCard(ins, true)).join('')}
        </details>
      ` : ''}
    `;
  }

  updateDriveInfo() {
    const bay = this.state.selectedBay >= 0 ? this.state.bays[this.state.selectedBay] : null;
    this.showDriveInfo(bay?.drive || null);
  }

  showDriveInfo(drive) {
    const el = this.els.driveInfo;
    if (!el) return;
    const filled = this.state.bays.filter(b => b.drive);

    if (!this.state.server) {
      el.innerHTML = '';
      return;
    }

    if (!drive) {
      if (filled.length === 0) {
        el.innerHTML = `
          <div class="makeup-card">
            <div class="flex items-center justify-between gap-2 mb-2">
              <div class="section-title mb-0">Drive Makeup</div>
              <span class="status-pill text-gray-500">0/${this.state.bays.length}</span>
            </div>
            <div class="chip-row">
              ${this._chip('NAND', 'pending', '#64748b', 'Install drives to see NAND type and source')}
              ${this._chip('Supply', 'pending', '#64748b', 'Install drives to see replacement risk')}
              ${this._chip('Interface', 'pending', '#64748b', 'Install drives to see active interface mix')}
            </div>
          </div>
        `;
        return;
      }

      const drives = filled.map(b => b.drive);
      const total = drives.length;
      const ifaceName = d => d.interface === 'SATA III' ? 'SATA' : d.interface.replace('NVMe PCIe ', 'Gen');
      const nandTypeChips = this._topEntries(this._countBy(drives, d => d.nandType), 2)
        .map(([type, count]) => this._chip(type, `x${count}`, type === 'QLC' ? '#f59e0b' : type === 'SLC' ? '#22c55e' : '#4fc3f7', `${count} ${type} drive${count > 1 ? 's' : ''}`));
      const nandSourceChips = this._topEntries(this._countBy(drives, d => d.nandVendor), 2)
        .map(([vendor, count]) => this._chip('NAND', `${vendor} x${count}`, '#8b5cf6', `${count} drive${count > 1 ? 's' : ''} using ${vendor} NAND`));
      const interfaceChips = this._topEntries(this._countBy(drives, ifaceName), 2)
        .map(([iface, count]) => this._chip(iface, `x${count}`, iface === 'SATA' ? '#3b82f6' : '#a855f7', `${count} ${iface} drive${count > 1 ? 's' : ''}`));
      const supplyChips = this._topEntries(this._countBy(drives, d => d.supplyRisk), 3)
        .map(([risk, count]) => {
          const tone = this._riskTone(risk);
          return this._chip('Supply', `${tone.label} x${count}`, tone.color, `${count} ${risk} supply-risk drive${count > 1 ? 's' : ''}`);
        });
      el.innerHTML = `
        <div class="makeup-card">
          <div class="flex items-center justify-between gap-2 mb-2">
            <div class="section-title mb-0">Drive Makeup</div>
            <span class="status-pill text-gray-400">${total}/${this.state.bays.length} bays</span>
          </div>
          <div class="chip-row">
            ${[...nandTypeChips, ...nandSourceChips, ...interfaceChips, ...supplyChips].join('')}
          </div>
        </div>
      `;
      return;
    }

    const risk = this._riskTone(drive.supplyRisk);
    const read = drive.seqReadMBs >= 1000 ? `${(drive.seqReadMBs / 1000).toFixed(1)} GB/s` : `${drive.seqReadMBs} MB/s`;
    const write = drive.seqWriteMBs >= 1000 ? `${(drive.seqWriteMBs / 1000).toFixed(1)} GB/s` : `${drive.seqWriteMBs} MB/s`;
    const iface = drive.interface === 'SATA III' ? 'SATA' : drive.interface.replace('NVMe PCIe ', 'Gen');
    const price = drive.priceUSD
      ? `$${drive.priceUSD.toLocaleString()} · $${(drive.priceUSD / drive.capacityTB).toFixed(0)}/TB`
      : 'Unpriced';

    el.innerHTML = `
      <div class="makeup-card">
        <div class="flex items-start justify-between gap-2 mb-2">
          <div class="min-w-0">
            <div class="section-title mb-1">Selected Drive</div>
            <div class="text-xs font-mono text-gray-200 font-bold truncate">${this._escapeHtml(drive.name)}</div>
          </div>
          <span class="status-pill ${risk.text}" title="${this._escapeHtml(drive.supplyNote)}">${risk.label}</span>
        </div>
        <div class="chip-row">
          ${this._chip('', `${drive.capacityTB}TB`, '#4fc3f7')}
          ${this._chip('', drive.formFactor, '#64748b')}
          ${this._chip('', iface, iface === 'SATA' ? '#3b82f6' : '#a855f7')}
          ${this._chip('NAND', drive.nandType, drive.nandType === 'QLC' ? '#f59e0b' : drive.nandType === 'SLC' ? '#22c55e' : '#4fc3f7')}
          ${this._chip('Source', drive.nandVendor, '#8b5cf6')}
          ${this._chip('Ctrl', drive.controllerVendor || drive.controller, '#f97316', drive.controller)}
          ${this._chip('R/W', `${read}/${write}`, '#22c55e')}
          ${this._chip('DWPD', drive.dwpd, '#eab308', `${drive.tbw.toLocaleString()} TBW`)}
          ${this._chip('', price, drive.priceUSD ? '#64748b' : '#f59e0b')}
        </div>
        <div class="text-xs font-mono text-gray-500 mt-2 line-clamp-2" title="${this._escapeHtml(drive.supplyNote)}">${this._escapeHtml(drive.supplyNote)}</div>
        ${drive.middlewareRequired ? '<div class="text-green-400 text-xs font-mono mt-1">aiDAPTIV+ middleware</div>' : ''}
      </div>
    `;
  }
}
