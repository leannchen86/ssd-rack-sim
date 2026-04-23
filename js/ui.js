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
  _initDrivePalette() {
    this._renderDrivePalette(this.state.drives);
  }

  _updateDrivePaletteFilter() {
    if (!this.state.server) {
      this._renderDrivePalette(this.state.drives);
      return;
    }

    // Filter drives: also hide aiDAPTIV+ unless LLM workload is selected
    let pool = this.state.drives;
    if (this.state.workload?.id !== 'llm-finetune') {
      pool = pool.filter(d => d.category !== 'specialized-ai');
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
    card.className = `drive-card flex items-center gap-2 p-2 rounded transition-colors
      ${disabled ? 'opacity-25 cursor-not-allowed' : 'hover:bg-gray-800 cursor-pointer'}`;
    card.dataset.driveId = drive.id;

    const swatch = document.createElement('div');
    swatch.className = 'w-3 h-3 rounded-sm flex-shrink-0';
    swatch.style.backgroundColor = drive.color;

    const info = document.createElement('div');
    info.className = 'flex-1 min-w-0';
    const catBadge = drive.category === 'enterprise' ? ' <span class="text-purple-400">[ENT]</span>' :
                     drive.category === 'industrial' ? ' <span class="text-blue-400">[IND]</span>' :
                     drive.category === 'specialized-ai' ? ' <span class="text-green-400">[AI]</span>' : '';
    const ctrlBadge = drive.controllerVendor === 'Phison' ? '<span class="text-orange-400">P</span> ' : '';
    info.innerHTML = `
      <div class="text-xs font-mono text-gray-200 truncate">${ctrlBadge}${drive.name}${catBadge}</div>
      <div class="text-xs font-mono text-gray-500">${drive.capacityTB}TB ${drive.formFactor} · ${drive.priceUSD ? '$' + drive.priceUSD.toLocaleString() : '<span class="text-yellow-600">Price TBD</span>'}</div>
    `;

    const risk = document.createElement('div');
    risk.className = 'flex-shrink-0';
    const rc = { low: 'bg-green-500', medium: 'bg-yellow-500', high: 'bg-red-500' }[drive.supplyRisk];
    risk.innerHTML = `<div class="w-2 h-2 rounded-full ${rc}" title="Supply: ${drive.supplyRisk}"></div>`;

    card.append(swatch, info, risk);

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
          d.category !== 'specialized-ai' && d.priceUSD > 0
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

  // === REFRESH ALL PANELS ===
  refresh() {
    this.updateStats();
    this.updateFitness();
    this.updateInsights();
  }

  updateStats() {
    const stats = this.computeStats(this.state);
    const panel = this.els.statsPanel;
    if (!panel || !this.state.server) {
      if (panel) panel.innerHTML = '<div class="text-gray-600 text-xs font-mono p-4 text-center">Select a server to begin</div>';
      return stats;
    }

    const riskColor = stats.supplyRiskScore < 30 ? 'text-green-400' : stats.supplyRiskScore < 60 ? 'text-yellow-400' : 'text-red-400';
    const busWarn = stats.busSaturated ? '<span class="text-yellow-400 text-xs ml-1">BUS SAT</span>' : '';
    const raidBadge = stats.raidValid ? '<span class="text-green-400">VALID</span>' : `<span class="text-red-400">${stats.raidError || 'INVALID'}</span>`;

    let vendorHtml = '';
    for (const [v, c] of Object.entries(stats.vendorConcentration)) {
      vendorHtml += `<div class="flex justify-between"><span class="text-gray-400">${v}</span><span>${((c / stats.driveCount) * 100).toFixed(0)}%</span></div>`;
    }

    panel.innerHTML = `
      <div class="stats-grid">
        <div class="stat-group">
          <div class="stat-label">RAID</div>
          <div class="stat-value text-sm">${RAID_MODES[this.state.raidMode].name}</div>
          <div class="stat-sub">${raidBadge}</div>
        </div>
        <div class="stat-group">
          <div class="stat-label">CAPACITY</div>
          <div class="stat-value">${stats.usableTB.toFixed(1)} <span class="text-sm text-gray-500">TB</span></div>
          <div class="stat-sub text-gray-500">${stats.rawTB.toFixed(1)} TB raw</div>
        </div>
        <div class="stat-group">
          <div class="stat-label">TOTAL COST${stats.priceIncomplete ? ' <span class="text-yellow-500">⚠</span>' : ''}</div>
          <div class="stat-value">$${stats.totalCost.toLocaleString()}${stats.priceIncomplete ? '<span class="text-yellow-500 text-sm">+?</span>' : ''}</div>
          <div class="stat-sub text-gray-500" title="Amortized: drives 3.5yr, chassis/AIC 5yr">$${stats.costPerUsableTB.toFixed(0)}/TB · $${stats.costPerUsableTBYear5.toFixed(0)}/TB·yr*</div>
          ${stats.priceIncomplete ? `<div class="stat-sub text-yellow-500">${stats.unpricedDrives} drive${stats.unpricedDrives > 1 ? 's' : ''} unpriced — totals are lower bound</div>` : ''}
        </div>
        <div class="stat-group">
          <div class="stat-label">SEQ READ</div>
          <div class="stat-value">${stats.realisticReadGBs.toFixed(1)} <span class="text-sm text-gray-500">GB/s</span></div>
          <div class="stat-sub text-gray-500">${stats.aggSeqReadGBs.toFixed(1)} agg ${busWarn}</div>
        </div>
        <div class="stat-group">
          <div class="stat-label">SEQ WRITE</div>
          <div class="stat-value">${stats.realisticWriteGBs.toFixed(1)} <span class="text-sm text-gray-500">GB/s</span></div>
          ${RAID_MODES[this.state.raidMode].raidWritePenalty < 1 ? `<div class="stat-sub text-yellow-500">${(RAID_MODES[this.state.raidMode].raidWritePenalty * 100).toFixed(0)}% of raw (${this.state.raidMode} penalty)</div>` : ''}
        </div>
        <div class="stat-group">
          <div class="stat-label">POWER</div>
          <div class="stat-value">${stats.totalPowerW.toFixed(0)} <span class="text-sm text-gray-500">W</span></div>
        </div>
        <div class="stat-group">
          <div class="stat-label">REBUILD</div>
          <div class="stat-value">${stats.rebuildTimeHours.toFixed(1)} <span class="text-sm text-gray-500">hrs</span></div>
          ${stats.rebuildWarning ? `<div class="stat-sub text-red-400">${stats.rebuildWarning}</div>` : stats.rebuildDegraded ? '<div class="stat-sub text-yellow-500">Array vulnerable during rebuild</div>' : ''}
        </div>
        <div class="stat-group">
          <div class="stat-label">SUPPLY RISK</div>
          <div class="stat-value ${riskColor}">${stats.supplyRiskScore.toFixed(0)}<span class="text-sm">/100</span></div>
        </div>
      </div>
      ${stats.driveCount > 0 ? `
        <div class="mt-3 pt-2 border-t border-gray-800">
          <div class="stat-label mb-1">COST BREAKDOWN</div>
          <div class="text-xs font-mono text-gray-400">
            Drives: $${stats.driveCost.toLocaleString()}
            ${stats.chassisCost > 0 ? ` · Server: $${stats.chassisCost.toLocaleString()}` : ' · Server: owned'}
            ${stats.moduleCost > 0 ? ` · AIC: $${stats.moduleCost.toLocaleString()}` : ''}
          </div>
        </div>
        <div class="mt-2 pt-2 border-t border-gray-800">
          <div class="stat-label mb-1">VENDOR MIX</div>
          <div class="text-xs font-mono">${vendorHtml}</div>
        </div>
      ` : ''}
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
      panel.innerHTML = `<div class="text-xs font-mono text-gray-600 p-2">Add drives to see ${workload.name} fitness</div>`;
      return;
    }

    const fit = this.computeFitness(stats, workload, filled.map(b => b.drive));
    if (!fit) return;

    const dot = (color) => `<span class="inline-block w-2 h-2 rounded-full ${color === 'green' ? 'bg-green-400' : color === 'yellow' ? 'bg-yellow-400' : 'bg-red-400'} mr-1"></span>`;

    let html = `<div class="text-xs font-mono text-gray-300 mb-2">${workload.name} fitness:</div>`;
    html += '<div class="space-y-1 text-xs font-mono">';

    if (fit.capacity) html += `<div>${dot(fit.capacity)} Capacity: ${fit.capacityDetail}</div>`;
    if (fit.seqWrite) html += `<div>${dot(fit.seqWrite)} Seq Write: ${fit.seqWriteDetail}</div>`;
    if (fit.randomRead) html += `<div>${dot(fit.randomRead)} Rand Read: ${fit.randomReadDetail}</div>`;
    if (fit.endurance) html += `<div>${dot(fit.endurance)} Endurance: ${fit.enduranceDetail}</div>`;

    html += '</div>';

    // Priority legend
    html += `<div class="mt-2 pt-2 border-t border-gray-800 text-xs font-mono text-gray-600">`;
    html += `Dominant metric: <span class="text-gray-400">${Object.entries(workload.priorities).find(([, v]) => v === 'critical')?.[0] || 'mixed'}</span>`;
    html += `</div>`;

    panel.innerHTML = html;
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

    const severityIcon = {
      critical: '<span class="text-red-400 font-bold">!!</span>',
      warning: '<span class="text-yellow-400">!</span>',
      suggestion: '<span class="text-blue-400">i</span>',
      info: '<span class="text-gray-500">·</span>',
    };

    const severityBorder = {
      critical: 'border-red-900',
      warning: 'border-yellow-900',
      suggestion: 'border-blue-900',
      info: 'border-gray-800',
    };

    let html = '';
    let prevCat = '';
    for (const ins of insights) {
      if (ins.category !== prevCat) {
        html += `<div class="text-xs font-mono text-gray-600 mt-2 mb-1 uppercase tracking-wider">${ins.category}</div>`;
        prevCat = ins.category;
      }
      html += `
        <div class="insight-card p-2 mb-1 rounded border ${severityBorder[ins.severity]} bg-gray-900/50 text-xs font-mono">
          <div class="flex items-start gap-1">
            <div class="flex-shrink-0 mt-px">${severityIcon[ins.severity]}</div>
            <div>
              <span class="text-gray-200">${ins.title}</span>
              <div class="text-gray-500 mt-0.5 leading-relaxed">${ins.message}</div>
            </div>
          </div>
        </div>
      `;
    }

    panel.innerHTML = html;
  }

  showDriveInfo(drive) {
    const el = this.els.driveInfo;
    if (!el) return;
    if (!drive) {
      el.innerHTML = '<div class="text-gray-600 text-xs p-2 font-mono">Click a bay for details</div>';
      return;
    }
    el.innerHTML = `
      <div class="p-2 text-xs font-mono space-y-1">
        <div class="text-gray-200 font-bold">${drive.name}</div>
        <div class="text-gray-400">${drive.capacityTB}TB · ${drive.interface} · ${drive.formFactor}</div>
        <div class="text-gray-400">${drive.nandType} NAND by ${drive.nandVendor}</div>
        <div class="text-gray-400">Ctrl: ${drive.controller}</div>
        <div class="text-gray-400">R: ${drive.seqReadMBs >= 1000 ? (drive.seqReadMBs/1000).toFixed(1) + ' GB/s' : drive.seqReadMBs + ' MB/s'} · W: ${drive.seqWriteMBs >= 1000 ? (drive.seqWriteMBs/1000).toFixed(1) + ' GB/s' : drive.seqWriteMBs + ' MB/s'}</div>
        <div class="text-gray-400">4K IOPS R/W: ${(drive.random4KReadIOPS/1000).toFixed(0)}K / ${(drive.random4KWriteIOPS/1000).toFixed(0)}K</div>
        <div class="text-gray-400">TBW: ${drive.tbw.toLocaleString()} · DWPD: ${drive.dwpd} · ${drive.powerW}W</div>
        <div class="text-gray-400">${drive.priceUSD ? '$' + drive.priceUSD.toLocaleString() + ' · $' + (drive.priceUSD / drive.capacityTB).toFixed(0) + '/TB' : '<span class="text-yellow-600">Price TBD</span>'}</div>
        <div class="mt-1 ${drive.supplyRisk === 'high' ? 'text-red-400' : drive.supplyRisk === 'medium' ? 'text-yellow-400' : 'text-green-400'}">
          Supply: ${drive.supplyRisk.toUpperCase()} — ${drive.supplyNote}
        </div>
        ${drive.middlewareRequired ? '<div class="text-green-400 mt-1">Requires aiDAPTIV+ middleware</div>' : ''}
      </div>
    `;
  }
}
