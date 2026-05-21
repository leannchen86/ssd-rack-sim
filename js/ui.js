// ui.js — DOM-based UI panels
// Server selector, bay config, workload, RAID, drive palette, stats, insights, drive info
import { EventBus, RAID_MODES, buildBays } from './state.js?v=34';

// NVMe is backwards compatible — PCIe 4 drives work in PCIe 5 bays
function interfaceCompatible(driveIf, bayIf) {
  if (driveIf === bayIf) return true;
  // NVMe PCIe 4 drive in NVMe PCIe 5 bay — OK (runs at Gen4 speed)
  if (driveIf === 'NVMe PCIe 4' && bayIf === 'NVMe PCIe 5') return true;
  if (driveIf === 'NVMe PCIe 3' && (bayIf === 'NVMe PCIe 4' || bayIf === 'NVMe PCIe 5')) return true;
  return false;
}

function formFactorCompatible(drive, bay) {
  if (drive.formFactor === bay.formFactor) return true;
  return drive.formFactor === '2.5"' && bay.formFactor === '3.5"' && drive.interface === 'SATA III' && bay.interface === 'SATA III';
}

function driveCompatibleWithBay(drive, bay) {
  return formFactorCompatible(drive, bay) && interfaceCompatible(drive.interface, bay.interface);
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
      expansionSelect: document.getElementById('expansion-select'),
      networkSelect: document.getElementById('network-select'),
      coolingSelect: document.getElementById('cooling-select'),
      fillStrategySelect: document.getElementById('fill-strategy-select'),
      fillDriveSelect: document.getElementById('fill-drive-select'),
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
    this._initExpansionSelect();
    this._initNetworkSelect();
    this._initCoolingSelect();
    this._initFillControls();
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
    const visibleServers = this._retailCompatibleServers();
    const owned = visibleServers.filter(s => s.owned);
    const available = visibleServers.filter(s => !s.owned);

    if (owned.length) {
      const g = document.createElement('optgroup');
      g.label = 'REUSE / OWNED SERVERS';
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
      g.label = 'NEW PURCHASE OPTIONS';
      available.forEach(s => {
        const firstConfig = this._supportedBayConfigs(s)[0];
        const bays = firstConfig ? firstConfig.name : `${s.bays[0].count}× ${s.bays[0].formFactor}`;
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
      this.state.activeBayConfig = this._defaultBayConfig(server);
      this._rebuildBays();
      this._updateBayConfigSelect();
      this._updateExpansionSelect();
      this._updateNetworkSelect();
      this._updateFillControls();
      this._updateDrivePaletteFilter();
      EventBus.emit('server:change');
    });
  }

  // === BAY CONFIG (for R7725-type servers) ===
  _initBayConfigSelect() {
    this.els.bayConfigSelect.addEventListener('change', () => {
      this.state.activeBayConfig = this.els.bayConfigSelect.value;
      this._rebuildBays();
      this._updateFillControls();
      this._updateDrivePaletteFilter();
      EventBus.emit('server:change');
    });
  }

  _updateBayConfigSelect() {
    const server = this.state.server;
    const group = this.els.bayConfigGroup;
    const sel = this.els.bayConfigSelect;
    const configs = this._supportedBayConfigs(server);

    if (!configs.length) {
      group.style.display = 'none';
      return;
    }

    group.style.display = 'block';
    sel.innerHTML = '';
    if (!configs.some(c => c.id === this.state.activeBayConfig)) {
      this.state.activeBayConfig = configs[0].id;
    }
    configs.forEach(c => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      if (c.id === this.state.activeBayConfig) o.selected = true;
      sel.appendChild(o);
    });
  }

  _retailCompatibleServers() {
    return this.state.serverCatalog.filter(server => {
      if (server.bayConfigs) return this._supportedBayConfigs(server).length > 0;
      return this._baySpecsRetailCompatible(server.bays || []);
    });
  }

  _supportedBayConfigs(server) {
    if (!server?.bayConfigs) return [];
    return server.bayConfigs.filter(config => this._baySpecsRetailCompatible(config.bays || []));
  }

  _defaultBayConfig(server) {
    if (!server?.bayConfigs) return null;
    return this._supportedBayConfigs(server)[0]?.id || null;
  }

  _baySpecsRetailCompatible(baySpecs) {
    return baySpecs.length > 0 && baySpecs.every(spec =>
      this._retailConsumerDrives().some(drive => driveCompatibleWithBay(drive, spec))
    );
  }

  // === RAID ===
  _initRaidSelect() {
    const sel = this.els.raidSelect;
    if (!sel) return;
    const labels = {
      RAID10: {
        label: 'Mirror / Balanced',
        detail: 'RAID10 - safer rebuilds, 50% usable',
      },
      RAID5: {
        label: 'Parity / More Capacity',
        detail: 'RAID5 - more usable TB, slower rebuilds',
      },
      RAID1: {
        label: 'Mirror Pair',
        detail: 'RAID1 - simple two-drive mirror',
      },
      RAID0: {
        label: 'Stripe / No Redundancy',
        detail: 'RAID0 - fastest, any drive loss breaks array',
      },
      JBOD: {
        label: 'Replicated Elsewhere',
        detail: 'JBOD - individual disks, no local array protection',
      },
    };
    Object.entries(RAID_MODES).forEach(([key]) => {
      const meta = labels[key] || { label: key, detail: RAID_MODES[key].description };
      const o = document.createElement('option');
      o.value = key;
      o.textContent = `${meta.label}  — ${meta.detail}`;
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
    sel.innerHTML = '<option value="">— freeform build —</option>';
    this.state.workloadCatalog.forEach(w => {
      const o = document.createElement('option');
      o.value = w.id;
      o.textContent = `${w.name}`;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      this.state.workload = this.state.workloadCatalog.find(w => w.id === sel.value) || null;
      this._updateNetworkSelect();
      this._updateDrivePaletteFilter();
      EventBus.emit('workload:change');
    });
  }

  // === EXPANSION ===
  _initExpansionSelect() {
    const sel = this.els.expansionSelect;
    sel.innerHTML = `
      <option value="none">No expansion</option>
      <option value="nvme-card">Add NVMe PCIe card (+16 M.2 slots)</option>
    `;
    sel.addEventListener('change', () => {
      const mod = this.state.moduleCatalog[0];
      if (sel.value === 'nvme-card' && mod) {
        if (!this.state.server) {
          sel.value = 'none';
          this.state.modules = [];
          this._updateModuleInfo();
          return;
        }
        const freeSlot = this.state.server.pcieSlotsRear?.find(s => !s.occupied && s.type === 'x16');
        if (!freeSlot) {
          sel.value = 'none';
          this.state.modules = [];
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
      this._updateFillControls();
      this._updateDrivePaletteFilter();
      EventBus.emit('modules:change');
    });
    this._updateExpansionSelect();
  }

  _updateExpansionSelect() {
    const sel = this.els.expansionSelect;
    if (!sel) return;
    const hasFreeSlot = this.state.server?.pcieSlotsRear?.some(s => !s.occupied && s.type === 'x16');
    sel.value = this.state.modules.length > 0 ? 'nvme-card' : 'none';
    sel.disabled = !this.state.server;
    const nvmeOption = sel.querySelector('option[value="nvme-card"]');
    if (nvmeOption) nvmeOption.disabled = !!this.state.server && !hasFreeSlot;
    this._updateModuleInfo();
  }

  // === NETWORK ===
  _initNetworkSelect() {
    const sel = this.els.networkSelect;
    if (!sel) return;
    sel.addEventListener('change', () => {
      const value = sel.value;
      this.state.networkGbpsOverride = value === 'auto'
        ? null
        : value === 'local'
          ? 'local'
          : Number(value);
      EventBus.emit('network:change');
    });
    this._updateNetworkSelect();
  }

  _updateNetworkSelect() {
    const sel = this.els.networkSelect;
    if (!sel) return;
    const defaultGbps = this.state.workload?.modelAssumptions?.networkGbps || this.state.server?.networkGbps || 25;
    const selected = this.state.networkGbpsOverride === null
      ? 'auto'
      : String(this.state.networkGbpsOverride);
    sel.innerHTML = `
      <option value="auto">Use case default (${defaultGbps}GbE)</option>
      <option value="25">25GbE</option>
      <option value="100">100GbE</option>
      <option value="200">200GbE</option>
      <option value="local">Local only / no cap</option>
    `;
    sel.value = selected;
  }

  // === COOLING ===
  _initCoolingSelect() {
    const sel = this.els.coolingSelect;
    if (!sel) return;
    sel.innerHTML = `
      <option value="stock">Stock chassis airflow</option>
      <option value="boosted">High airflow / fan shroud</option>
      <option value="constrained">Quiet / constrained airflow</option>
    `;
    sel.value = this.state.coolingProfile || 'stock';
    sel.addEventListener('change', () => {
      this.state.coolingProfile = sel.value;
      EventBus.emit('cooling:change');
    });
  }

  // === FILL STRATEGY ===
  _initFillControls() {
    const strategy = this.els.fillStrategySelect;
    if (!strategy) return;
    strategy.innerHTML = `
      <option value="use-case">Best fit for use case</option>
      <option value="value">Lowest $/TB</option>
      <option value="capacity">Largest drive size</option>
      <option value="sustained-write">Fastest sustained write</option>
      <option value="random-read">Highest random read IOPS</option>
      <option value="endurance">Highest endurance</option>
      <option value="specific">Specific drive model</option>
    `;
    strategy.value = this.state.fillStrategy || 'use-case';
    strategy.addEventListener('change', () => {
      this.state.fillStrategy = strategy.value;
      this._updateFillControls();
    });

    this.els.fillDriveSelect?.addEventListener('change', () => {
      this.state.fillDriveId = this.els.fillDriveSelect.value || null;
    });

    this._updateFillControls();
  }

  _updateFillControls() {
    const strategy = this.els.fillStrategySelect;
    const driveSelect = this.els.fillDriveSelect;
    if (!strategy || !driveSelect) return;

    strategy.value = this.state.fillStrategy || 'use-case';
    const specific = strategy.value === 'specific';
    driveSelect.style.display = specific ? 'block' : 'none';
    driveSelect.disabled = !specific;

    const drives = this._retailConsumerDrives()
      .filter(d => !this.state.server || this._driveCompatWithBays(d))
      .sort((a, b) =>
        a.formFactor.localeCompare(b.formFactor) ||
        a.interface.localeCompare(b.interface) ||
        (a.priceUSD / a.capacityTB) - (b.priceUSD / b.capacityTB)
      );

    driveSelect.innerHTML = drives.length
      ? drives.map(d => `
        <option value="${this._escapeHtml(d.id)}">
          ${this._escapeHtml(`${this._driveDisplayName(d)} · ${this._driveCapacityLabel(d)} · ${d.interface === 'SATA III' ? 'SATA' : d.interface.replace('NVMe PCIe ', 'Gen')} · $${Math.round(d.priceUSD / d.capacityTB)}/TB`)}
        </option>
      `).join('')
      : '<option value="">No compatible drives</option>';

    const current = drives.some(d => d.id === this.state.fillDriveId)
      ? this.state.fillDriveId
      : drives[0]?.id || null;
    this.state.fillDriveId = current;
    driveSelect.value = current || '';
  }

  _updateModuleInfo() {
    const el = this.els.moduleInfo;
    if (this.state.modules.length === 0) {
      if (!this.state.server) {
        el.textContent = 'Select a server to see compatible expansion options.';
        el.className = 'text-xs text-gray-600 mt-1 font-mono';
      } else {
        const freeSlots = this.state.server.pcieSlotsRear?.filter(s => !s.occupied && s.type === 'x16').length || 0;
        el.textContent = freeSlots > 0 ? `${freeSlots} free x16 slot(s) for PCIe expansion` : 'No free x16 PCIe slot';
        el.className = `text-xs ${freeSlots > 0 ? 'text-gray-500' : 'text-gray-600'} mt-1 font-mono`;
      }
      return;
    }
    const mod = this.state.modules[0];
    const hostGen = this.state.server?.pcieGen || 3;
    const perf = mod.performanceByHostGen?.[hostGen];
    el.innerHTML = `<span class="text-purple-400">NVMe PCIe expansion</span> · $${mod.priceUSD.toLocaleString()} · ${mod.provides.count} M.2 slots` +
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

    if (compatible.length === 0 && incompatible.length > 0) {
      const div = document.createElement('div');
      div.className = 'text-yellow-500 text-xs p-2 rounded border border-yellow-900/60 bg-yellow-950/20 font-mono leading-relaxed';
      div.textContent = this._noCompatibleDriveReason();
      container.appendChild(div);
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

  _noCompatibleDriveReason() {
    const bays = this.state.bays || [];
    const formFactors = new Set(bays.map(b => b.formFactor));
    if (formFactors.has('E3.S')) {
      return 'No direct consumer-retail E3.S SSDs in this catalog. E3.S is mostly an enterprise/datacenter form factor, so this server needs enterprise SSD sourcing or a different bay config.';
    }
    if (formFactors.has('U.2')) {
      return 'No direct consumer-retail U.2 SSDs in this catalog. Consumer NVMe is mostly M.2; U.2 bays usually mean enterprise/datacenter drives.';
    }
    if (formFactors.has('M.2 2280')) {
      return 'No compatible M.2 retail SSDs match this expansion or bay interface.';
    }
    return 'No compatible consumer-retail SSDs match this server bay layout.';
  }

  _createDriveCard(drive, disabled) {
    const card = document.createElement('div');
    card.className = `drive-card group flex items-center gap-2 p-2 rounded border bg-gray-900/30 transition-colors
      ${disabled ? 'opacity-25 cursor-not-allowed border-transparent' : 'hover:bg-gray-800/70 border-gray-800 cursor-pointer'}`;
    card.dataset.driveId = drive.id;
    const displayName = this._driveDisplayName(drive);
    const capacityLabel = this._driveCapacityLabel(drive);
    card.setAttribute('aria-label', `${displayName}, ${capacityLabel}, ${drive.interface}, ${drive.nandType}`);

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
      <div class="text-xs font-mono text-gray-200 truncate">${this._escapeHtml(displayName)}</div>
      <div class="flex items-center gap-1 text-xs font-mono text-gray-500 whitespace-nowrap">
        <span class="text-gray-300">${this._escapeHtml(capacityLabel)}</span>
        <span>${drive.formFactor}</span>
        <span>·</span>
        <span>${drive.interface === 'SATA III' ? 'SATA' : drive.interface.replace('NVMe PCIe ', 'Gen')}</span>
        <span>·</span>
        <span>${drive.nandType}</span>
      </div>
      <div class="flex items-center justify-between gap-2 text-xs font-mono">
        <span class="text-gray-500">${read}</span>
        <span class="${drive.priceUSD ? 'text-gray-400' : 'text-yellow-600'}">${price}</span>
      </div>
    `;

    card.append(mini, info);

    if (!disabled) {
      card.draggable = true;
      card.classList.add('can-drag');
      card.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        this.state.dragDrive = drive;
        this.state.dragStart = { x: e.clientX, y: e.clientY };
        this.state.paletteDragging = false;
      });
      card.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        this.state.dragDrive = drive;
        this.state.dragStart = { x: e.clientX, y: e.clientY };
        this.state.paletteDragging = false;
      });
      card.addEventListener('dragstart', (e) => {
        this.state.dragDrive = drive;
        this.state.dragStart = { x: e.clientX, y: e.clientY };
        this.state.paletteDragging = true;
        e.dataTransfer.setData('application/x-drive-id', drive.id);
        e.dataTransfer.setData('text/plain', drive.id);
        e.dataTransfer.effectAllowed = 'copy';
      });
      card.addEventListener('dragend', () => {
        requestAnimationFrame(() => {
          this.state.dragDrive = null;
          this.state.dragStart = null;
          this.state.paletteDragging = false;
        });
      });
      card.addEventListener('click', () => {
        let bay = this.state.selectedBay;
        if (bay < 0 || !this.state.bays[bay]) {
          bay = this.state.bays.findIndex(b => !b.drive && driveCompatibleWithBay(drive, b));
        }
        if (bay >= 0 && this.state.bays[bay]) {
          const b = this.state.bays[bay];
          if (driveCompatibleWithBay(drive, b)) {
            b.drive = drive;
            const next = this.state.bays.findIndex((b2, i) =>
              i > bay && !b2.drive && driveCompatibleWithBay(drive, b2)
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
      let filled = 0;
      for (const bay of this.state.bays) {
        if (bay.drive) continue;
        const drive = this._pickFillDriveForBay(bay);
        if (drive) {
          bay.drive = drive;
          filled += 1;
        }
      }
      if (filled > 0) EventBus.emit('bay:update');
    });

    this.els.clearAll?.addEventListener('click', () => {
      this.state.bays.forEach(b => { b.drive = null; });
      this.state.selectedBay = -1;
      EventBus.emit('bay:update');
    });
  }

  _compatibleDrivesForBay(bay) {
    return this._retailConsumerDrives().filter(d => driveCompatibleWithBay(d, bay));
  }

  _estimateFillSustainedMBs(drive) {
    if (drive.sustainedWriteMBs) return drive.sustainedWriteMBs;
    if (drive.interface === 'SATA III') {
      const factor = drive.nandType === 'QLC' ? 0.35 : (!drive.dramCacheMB ? 0.65 : 0.85);
      return Math.max(120, Math.min(drive.seqWriteMBs, drive.seqWriteMBs * factor));
    }
    const gen = Number(String(drive.interface).match(/PCIe\s+(\d+)/)?.[1] || 4);
    const factor = drive.nandType === 'QLC' ? 0.08 : (!drive.dramCacheMB ? 0.18 : gen >= 5 ? 0.28 : 0.26);
    return Math.max(500, Math.min(drive.seqWriteMBs, drive.seqWriteMBs * factor));
  }

  _fillSortValue(drive, strategy, candidates) {
    const costPerTB = drive.priceUSD / drive.capacityTB;
    const sustained = this._estimateFillSustainedMBs(drive);
    const max = (getValue) => Math.max(1, ...candidates.map(getValue));
    const min = (getValue) => Math.min(...candidates.map(getValue).filter(v => Number.isFinite(v) && v > 0));
    const norm = (value, maxValue) => maxValue > 0 ? value / maxValue : 0;

    if (strategy === 'specific') return drive.id === this.state.fillDriveId ? 1 : -Infinity;
    if (strategy === 'value') return min(d => d.priceUSD / d.capacityTB) / costPerTB;
    if (strategy === 'capacity') return drive.capacityTB + (1 / costPerTB);
    if (strategy === 'sustained-write') return sustained + (drive.dwpd || 0) * 100;
    if (strategy === 'random-read') return (drive.random4KReadIOPS || 0) + (drive.interface === 'SATA III' ? 0 : 50000);
    if (strategy === 'endurance') return (drive.dwpd || 0) * 1000000 + (drive.tbw || 0);

    const priorities = this.state.workload?.priorities || {};
    const weight = (key, fallback) => ({
      critical: 4,
      high: 3,
      moderate: 2,
      low: 1,
    }[priorities[key]] || fallback);
    const weights = {
      value: weight('costPerTB', 2.5),
      capacity: weight('capacity', 1.5),
      sustained: weight('seqWrite', 1),
      random: weight('randomRead', 1),
      endurance: weight('endurance', 1),
      latency: weight('latency', 1),
    };
    const qlcSensitive = weights.sustained + weights.endurance + weights.latency >= 5;
    const qlcFactor = drive.nandType === 'QLC' ? (qlcSensitive ? 0.72 : 0.9) : 1;
    const nvmeFactor = drive.interface === 'SATA III' ? 0.82 : 1;

    const score =
      weights.value * (min(d => d.priceUSD / d.capacityTB) / costPerTB) +
      weights.capacity * norm(drive.capacityTB, max(d => d.capacityTB)) +
      weights.sustained * norm(sustained, max(d => this._estimateFillSustainedMBs(d))) +
      weights.random * norm(drive.random4KReadIOPS || 0, max(d => d.random4KReadIOPS || 0)) +
      weights.endurance * norm(drive.dwpd || 0, max(d => d.dwpd || 0)) +
      weights.latency * norm(drive.random4KReadIOPS || 0, max(d => d.random4KReadIOPS || 0)) * nvmeFactor;

    return score * qlcFactor;
  }

  _pickFillDriveForBay(bay) {
    const candidates = this._compatibleDrivesForBay(bay);
    if (candidates.length === 0) return null;
    const strategy = this.state.fillStrategy || 'use-case';
    if (strategy === 'specific') {
      return candidates.find(d => d.id === this.state.fillDriveId) || null;
    }
    const ranked = [...candidates].sort((a, b) => {
      const diff = this._fillSortValue(b, strategy, candidates) - this._fillSortValue(a, strategy, candidates);
      if (diff !== 0) return diff;
      return (a.priceUSD / a.capacityTB) - (b.priceUSD / b.capacityTB);
    });
    return ranked[0] || null;
  }

  _driveCompatWithBays(drive) {
    return this.state.bays.some(b => driveCompatibleWithBay(drive, b));
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

  _driveCapacityLabel(drive) {
    const tb = Number(drive?.capacityTB) || 0;
    if (tb > 0 && tb < 1) return `${Math.round(tb * 1000)}GB`;
    return `${Number.isInteger(tb) ? tb.toFixed(0) : tb.toString()}TB`;
  }

  _driveDisplayName(drive) {
    const name = String(drive?.name || '');
    const tb = Number(drive?.capacityTB) || 0;
    const tokens = new Set([
      this._driveCapacityLabel(drive),
      `${tb}TB`,
      `${Number.isInteger(tb) ? tb.toFixed(0) : tb.toString()} TB`,
      `${Math.round(tb * 1000)}GB`,
      `${Math.round(tb * 1000)} GB`,
    ]);
    let display = name;
    for (const token of tokens) {
      if (!token || token === '0TB') continue;
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
      display = display.replace(new RegExp(`\\s+${escaped}$`, 'i'), '');
    }
    return display.trim() || name;
  }

  _term(label, title, body, rows = [], variant = '') {
    const rowHtml = rows
      .filter(row => row && row.length >= 2)
      .map(([key, value]) => `
        <span class="term-popover-row">
          <span>${this._escapeHtml(key)}</span>
          <span>${this._escapeHtml(value)}</span>
        </span>
      `)
      .join('');
    const classes = ['term-anchor', variant ? `term-${variant}` : ''].filter(Boolean).join(' ');
    return `
      <span class="${classes}" tabindex="0" aria-label="${this._escapeHtml(`${title}: ${body}`)}">
        <span class="term-label-text">${this._escapeHtml(label)}</span>
        <span class="term-popover" role="tooltip" aria-hidden="true">
          <span class="term-popover-title">${this._escapeHtml(title)}</span>
          <span class="term-popover-body">${this._escapeHtml(body)}</span>
          ${rowHtml ? `<span class="term-popover-rows">${rowHtml}</span>` : ''}
        </span>
      </span>
    `;
  }

  _fitnessTerm(label, detail = '') {
    const terms = {
      CAP: ['Capacity target', 'Usable capacity compared with the selected use-case target.'],
      WRITE: ['Sustained write target', 'Steady write bandwidth after consumer SSD cache behavior and RAID penalties.'],
      IOPS: ['Read IOPS target', 'Small random read operations per second, estimated at low queue depth instead of vendor max queue depth.'],
      DWPD: ['Drive writes per day', 'Endurance rating: how many full-drive writes per day the SSD is rated for during its warranty window.'],
      P99: ['Tail latency target', 'Estimated 99th percentile read latency. Lower is better for serving use cases.'],
    };
    const [title, body] = terms[label] || [label, detail || 'Use-case fit signal.'];
    return this._term(label, title, body, detail ? [['Current check', detail]] : [], 'compact');
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

  _formatGBs(value, digits = 1) {
    if (!Number.isFinite(value)) return 'no cap';
    return `${value.toFixed(digits)} GB/s`;
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
      info: { mark: 'i', color: '#64748b', border: 'border-gray-800', text: 'text-gray-500', label: 'info' },
    }[severity] || { mark: '.', color: '#64748b', border: 'border-gray-800', text: 'text-gray-500', label: 'info' };
  }

  _severityRank(severity) {
    return { critical: 4, warning: 3, suggestion: 2, info: 1 }[severity] || 0;
  }

  _shortMessage(message, max = 118) {
    const text = String(message || '').replace(/\s+/g, ' ').trim();
    const stop = text.indexOf('. ');
    const first = stop > 0 ? text.slice(0, stop + 1) : text;
    return first.length > max ? `${first.slice(0, max - 3).trim()}...` : first;
  }

  _compactInsightTitle(title) {
    return String(title || '')
      .replace(/\s+in config$/i, '')
      .replace(/^all S A T A$/i, 'All-SATA')
      .replace(/^NAND source:\s*/i, 'NAND ')
      .replace(/\s+concentration:\s+/i, ' ')
      .replace(/^SATA vs NVMe pricing:\s*NVMe reached parity$/i, 'NVMe price parity')
      .replace(/^SATA vs NVMe pricing:\s*/i, 'SATA/NVMe ')
      .replace(/^All-SATA config for non-bulk use case$/i, 'All-SATA strategy')
      .replace(/^All-SATA config for non-bulk workload$/i, 'All-SATA strategy')
      .replace(/^Existing server\s+—\s+/i, '');
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

    const raidMeta = stats.raidValid
      ? { text: 'text-green-400', color: '#22c55e', label: 'VALID' }
      : { text: 'text-red-400', color: '#ef4444', label: stats.raidError || 'INVALID' };
    const raidShort = stats.raidValid ? 'VALID' : 'CHECK';
    const protectionLabels = {
      RAID10: 'Mirror / Balanced',
      RAID5: 'Parity / Capacity',
      RAID1: 'Mirror Pair',
      RAID0: 'No Redundancy',
      JBOD: 'Replicated Elsewhere',
    };
    const protectionLabel = protectionLabels[this.state.raidMode] || RAID_MODES[this.state.raidMode].name;

    const bwMax = Math.max(
      stats.realisticReadGBs,
      stats.realisticWriteGBs,
      stats.realisticSustainedWriteGBs || 0,
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
      { label: `Expansion: $${stats.moduleCost.toLocaleString()}`, value: stats.moduleCost, color: '#22c55e' },
    ];

    const vendorEntries = Object.entries(stats.vendorConcentration).sort((a, b) => b[1] - a[1]);
    const topVendor = vendorEntries[0]
      ? `${vendorEntries[0][0]} ${((vendorEntries[0][1] / stats.driveCount) * 100).toFixed(0)}%`
      : 'empty';
    const bayFillPct = this.state.bays.length ? (stats.driveCount / this.state.bays.length) * 100 : 0;
    const rebuildTone = stats.rebuildWarning ? '#ef4444' : stats.rebuildDegraded ? '#f59e0b' : '#22c55e';
    const rebuildLabel = stats.rebuildWarning ? 'no rebuild safety' : stats.rebuildDegraded ? 'degraded window' : 'mirror copy';
    const enduranceYears = Number.isFinite(stats.minEnduranceYears) ? stats.minEnduranceYears : 0;
    const enduranceLabel = stats.workloadWriteTBPerDay
      ? `${stats.minEnduranceYears.toFixed(1)} yr`
      : 'N/A';
    const enduranceTone = !stats.workloadWriteTBPerDay ? '#64748b' : stats.minEnduranceYears < 2 ? '#ef4444' : stats.minEnduranceYears < 3.5 ? '#f59e0b' : '#22c55e';
    const p99Target = workload?.modelAssumptions?.targetP99ReadMs || Math.max(10, stats.estimatedP99ReadMs || 1);
    const p99Tone = workload?.modelAssumptions?.targetP99ReadMs && stats.estimatedP99ReadMs > p99Target
      ? '#f59e0b'
      : '#22c55e';
    const networkFinite = Number.isFinite(stats.networkLimitGBs);
    const networkGbpsLabel = networkFinite ? `${stats.networkGbps}GbE` : 'local';
    const busLimited = stats.drivePotentialReadGBs > stats.platformReadGBs * 1.15;
    const bottleneckMeta = !stats.driveCount
      ? { label: 'EMPTY', color: '#64748b', text: 'text-gray-500' }
      : stats.networkBottleneck
        ? { label: 'NETWORK', color: '#f59e0b', text: 'text-yellow-400' }
        : busLimited
          ? { label: 'BUS', color: '#f59e0b', text: 'text-yellow-400' }
          : { label: 'CLEAR', color: '#22c55e', text: 'text-green-400' };
    const pathStages = [
      { label: 'SSD', value: stats.drivePotentialReadGBs, display: this._formatGBs(stats.drivePotentialReadGBs), color: '#4fc3f7' },
      { label: 'Bus', value: stats.platformReadGBs, display: this._formatGBs(stats.platformReadGBs), color: busLimited ? '#f59e0b' : '#22c55e' },
      {
        label: 'Net',
        value: networkFinite ? stats.networkLimitGBs : Math.max(stats.platformReadGBs, stats.drivePotentialReadGBs, 1),
        display: networkFinite ? this._formatGBs(stats.networkLimitGBs) : 'local',
        color: stats.networkBottleneck ? '#f59e0b' : '#22c55e',
      },
    ];
    const bottleneckMax = Math.max(1, ...pathStages.map(stage => Number.isFinite(stage.value) ? stage.value : 0));
    const bottleneckRows = pathStages.map(stage => `
      <div class="metric-pair bottleneck-row">
        <span class="text-gray-500">${stage.label}</span>
        ${this._meter(stage.value, bottleneckMax, stage.color, `${stage.label}: ${stage.display}`)}
        <span class="text-gray-300 text-right">${this._escapeHtml(stage.display.replace(' GB/s', ''))}</span>
      </div>
    `).join('');
    const qd = workload?.modelAssumptions?.typicalQueueDepth || 4;
    const statTerms = {
      capacity: this._term('CAPACITY', 'Usable capacity', 'Capacity after RAID overhead. Raw capacity is the sum of drive sizes; usable is what remains for data.', [
        ['Usable', `${stats.usableTB.toFixed(1)} TB`],
        ['Raw', `${stats.rawTB.toFixed(1)} TB`],
        ['Protection', protectionLabel],
      ]),
      cost: this._term('COST', 'Purchase and amortized cost', 'Estimated hardware purchase cost plus a simple TB-year view for comparing dense builds.', [
        ['Purchase', this._money(stats.totalCost)],
        ['Drive spend', this._money(stats.driveCost)],
        ['TB-year', `$${stats.costPerUsableTBYear5.toFixed(0)}/TB yr`],
      ]),
      raid: this._term('PROTECTION', 'Data protection', 'How the drives are grouped for redundancy and performance. Parity and mirroring reduce usable capacity but change failure behavior.', [
        ['Layout', protectionLabel],
        ['Technical', RAID_MODES[this.state.raidMode].name.replace(/\s+\(.+\)/, '')],
        ['Status', stats.raidValid ? 'valid' : (stats.raidError || 'invalid')],
        ['Protected', stats.raidValid ? `${stats.driveCount} drives` : 'check drive count'],
      ]),
      bandwidth: this._term('B/W', 'Bandwidth', 'Estimated sequential throughput after chassis limits and RAID effects. W is burst write; S is sustained write after cache behavior.', [
        ['Read', `${stats.realisticReadGBs.toFixed(1)} GB/s`],
        ['Write', `${stats.realisticWriteGBs.toFixed(1)} GB/s burst`],
        ['Sustained', `${stats.realisticSustainedWriteGBs.toFixed(1)} GB/s`],
      ]),
      bottleneck: this._term('PATH', 'Bottleneck path', 'Compares the SSD pool, server bus, and modeled network path. The smallest segment is what users can actually feel.', [
        ['SSD pool', this._formatGBs(stats.drivePotentialReadGBs)],
        ['Server bus', this._formatGBs(stats.platformReadGBs)],
        ['Network', networkFinite ? `${this._formatGBs(stats.networkLimitGBs)} ${networkGbpsLabel}` : 'local/no cap'],
        ['Visible read', this._formatGBs(stats.bottleneckReadGBs)],
      ]),
      read: this._term('R', 'Read bandwidth', 'Estimated sequential read throughput after chassis bus limits.', [
        ['Current', `${stats.realisticReadGBs.toFixed(1)} GB/s`],
      ], 'compact'),
      write: this._term('W', 'Burst write bandwidth', 'Estimated write throughput before the consumer SSD SLC cache cliff is exhausted.', [
        ['Current', `${stats.realisticWriteGBs.toFixed(1)} GB/s`],
      ], 'compact'),
      sustained: this._term('S', 'Sustained write bandwidth', 'Estimated write throughput after SLC cache exhaustion. This is usually the safer planning number for long writes.', [
        ['Current', `${stats.realisticSustainedWriteGBs.toFixed(1)} GB/s`],
        ['Write cliff', `${(stats.writeCliffRatio * 100).toFixed(0)}% of burst`],
      ], 'compact'),
      power: this._term('POWER', 'Power and cooling cost', 'Estimated server plus SSD power draw, with yearly electricity cost including the modeled PUE cooling overhead.', [
        ['Draw', `${stats.totalPowerW.toFixed(0)} W`],
        ['Energy', `$${stats.energyCostPerYear.toFixed(0)}/yr`],
        ['PUE', stats.pue.toFixed(1)],
      ]),
      rebuild: this._term('REBUILD', 'Rebuild window', 'Estimated time to restore redundancy after a drive failure. During this window, another fault can be more serious.', [
        ['Time', `${stats.rebuildTimeHours.toFixed(1)} h`],
        ['2nd fault', `${stats.rebuildSecondFailureRiskPct.toFixed(2)}%`],
        ['URE risk', `${stats.ureDuringRebuildRiskPct.toFixed(2)}%`],
      ]),
      wear: this._term('WEAR', 'SSD endurance', 'Estimated lifespan under the selected use-case write rate. Without a use case, there is no write-rate model to project.', [
        ['Use case', stats.workloadWriteTBPerDay ? `${stats.workloadWriteTBPerDay} TB/day` : 'none selected'],
        ['Minimum', stats.workloadWriteTBPerDay ? enduranceLabel : 'N/A'],
        ['Median', stats.workloadWriteTBPerDay ? `${stats.medianEnduranceYears.toFixed(1)} yr` : 'N/A'],
      ]),
      latency: this._term('LATENCY', 'Tail latency', 'Heuristic p99 read latency class. This catches cases where aggregate IOPS looks fine but a SATA or QLC-heavy build may still feel slow.', [
        ['P99', `${stats.estimatedP99ReadMs ? stats.estimatedP99ReadMs.toFixed(1) : '0.0'} ms`],
        ['QD', `queue depth ${qd}`],
        ['IOPS', `${this._compactNumber(stats.lowQueueReadIOPS, 0)} low-QD`],
      ]),
      qd: this._term(`QD${qd}`, 'Queue depth', 'How many storage requests are outstanding at once. Vendor max IOPS often assumes much higher queue depth than real apps.', [
        ['Modeled', `QD${qd}`],
      ], 'compact'),
      iops: this._term(`${this._compactNumber(stats.lowQueueReadIOPS, 0)} IOPS`, 'Low-queue-depth IOPS', 'Estimated random read operations per second at app-like queue depth, not best-case vendor lab queue depth.', [
        ['Current', this._compactNumber(stats.lowQueueReadIOPS, 0)],
      ], 'compact'),
      bays: this._term('BAYS', 'Bay usage', 'How many physical drive slots are filled, with a quick hint of vendor concentration in the current build.', [
        ['Filled', `${stats.driveCount}/${this.state.bays.length}`],
        ['Top brand', topVendor],
      ]),
    };

    panel.innerHTML = `
      <div class="stats-strip">
        <div class="strip-card">
          <div class="flex items-center justify-between gap-2">
            <div class="stat-label">${statTerms.capacity}</div>
            <span class="status-pill ${capColor === '#f59e0b' ? 'text-yellow-400' : 'text-blue-300'}">${workload?.requirements?.minUsableTB ? 'TARGET' : 'USABLE'}</span>
          </div>
          <div class="strip-value">${stats.usableTB.toFixed(1)} <span class="text-sm text-gray-500">TB</span></div>
          ${this._meter(stats.usableTB, capTarget, capColor, capTitle)}
          <div class="stat-sub text-gray-500">${stats.rawTB.toFixed(1)} raw</div>
        </div>

        <div class="strip-card">
          <div class="flex items-center justify-between gap-2">
            <div class="stat-label">${statTerms.cost}</div>
            ${stats.priceIncomplete ? '<span class="status-pill text-yellow-400" title="One or more drives are missing prices">LOWER</span>' : ''}
          </div>
          <div class="strip-value">${this._money(stats.totalCost)}${stats.priceIncomplete ? '<span class="text-yellow-500 text-sm">+?</span>' : ''}</div>
          ${this._splitBar(costSegments)}
          <div class="stat-sub text-gray-500">$${stats.costPerUsableTB.toFixed(0)}/TB · $${stats.costPerUsableTBYear5.toFixed(0)}/TB yr</div>
        </div>

        <div class="strip-card">
          <div class="flex items-center justify-between gap-2">
            <div class="stat-label">${statTerms.raid}</div>
            <span class="status-pill ${raidMeta.text}" title="${this._escapeHtml(raidMeta.label)}">${raidShort}</span>
          </div>
          <div class="strip-value-sm">${protectionLabel}</div>
          ${this._meter(stats.raidValid ? 100 : 35, 100, raidMeta.color, raidMeta.label)}
          <div class="stat-sub ${stats.raidValid ? 'text-gray-500' : 'text-red-400'}">${stats.raidValid ? `${stats.driveCount} drives protected` : raidMeta.label}</div>
        </div>

        <div class="strip-card">
          <div class="flex items-center justify-between gap-2">
            <div class="stat-label">${statTerms.bandwidth}</div>
            ${stats.busSaturated ? '<span class="status-pill text-yellow-400" title="Drive bandwidth exceeds chassis bus cap">BUS CAP</span>' : '<span class="stat-sub text-gray-500">GB/s</span>'}
          </div>
          <div class="space-y-1 mt-1">
            <div class="metric-pair">
              <span>${statTerms.read}</span>
              ${this._meter(stats.realisticReadGBs, bwMax, '#4fc3f7', `${stats.realisticReadGBs.toFixed(1)} GB/s read`)}
              <span class="text-gray-300 text-right">${stats.realisticReadGBs.toFixed(1)}</span>
            </div>
            <div class="metric-pair">
              <span>${statTerms.write}</span>
              ${this._meter(stats.realisticWriteGBs, bwMax, '#22c55e', `${stats.realisticWriteGBs.toFixed(1)} GB/s write`)}
              <span class="text-gray-300 text-right">${stats.realisticWriteGBs.toFixed(1)}</span>
            </div>
            <div class="metric-pair">
              <span>${statTerms.sustained}</span>
              ${this._meter(stats.realisticSustainedWriteGBs, bwMax, '#f59e0b', `${stats.realisticSustainedWriteGBs.toFixed(1)} GB/s sustained write`)}
              <span class="text-gray-300 text-right">${stats.realisticSustainedWriteGBs.toFixed(1)}</span>
            </div>
          </div>
        </div>

        <div class="strip-card">
          <div class="flex items-center justify-between gap-2">
            <div class="stat-label">${statTerms.bottleneck}</div>
            <span class="status-pill ${bottleneckMeta.text}">${bottleneckMeta.label}</span>
          </div>
          <div class="space-y-1 mt-1">${bottleneckRows}</div>
          <div class="stat-sub text-gray-500">${this._formatGBs(stats.bottleneckReadGBs)} visible · ${networkGbpsLabel} assumed</div>
        </div>

        <div class="strip-card">
          <div class="stat-label">${statTerms.power}</div>
          <div class="strip-value-sm">${stats.totalPowerW.toFixed(0)} W</div>
          ${this._meter(stats.totalPowerW, powerCeiling, '#a78bfa', `${stats.totalPowerW.toFixed(0)} W estimated`)}
          <div class="stat-sub text-gray-500">$${stats.energyCostPerYear.toFixed(0)}/yr incl PUE</div>
        </div>

        <div class="strip-card">
          <div class="stat-label">${statTerms.rebuild}</div>
          <div class="strip-value-sm">${stats.rebuildTimeHours.toFixed(1)} h</div>
          ${this._meter(stats.rebuildTimeHours, rebuildCeiling, rebuildTone, stats.rebuildWarning || (stats.rebuildDegraded ? 'Array vulnerable during rebuild' : 'Mirror rebuild estimate'))}
          <div class="stat-sub ${stats.rebuildWarning ? 'text-red-400' : stats.rebuildDegraded ? 'text-yellow-500' : 'text-gray-500'}">${rebuildLabel} · ${stats.rebuildSecondFailureRiskPct.toFixed(2)}%</div>
        </div>

        <div class="strip-card">
          <div class="stat-label">${statTerms.wear}</div>
          <div class="strip-value-sm">${enduranceLabel}</div>
          ${this._meter(enduranceYears, 5, enduranceTone, stats.workloadWriteTBPerDay ? `${stats.workloadWriteTBPerDay} TB/day logical use-case writes` : 'Select a use case for lifecycle estimate')}
          <div class="stat-sub text-gray-500">${stats.workloadWriteTBPerDay ? `${stats.workloadWriteTBPerDay} TB/day` : 'use case needed'}</div>
        </div>

        <div class="strip-card">
          <div class="stat-label">${statTerms.latency}</div>
          <div class="strip-value-sm">${stats.estimatedP99ReadMs ? stats.estimatedP99ReadMs.toFixed(1) : '0.0'} ms</div>
          ${this._meter(stats.estimatedP99ReadMs || 0, p99Target, p99Tone, 'Heuristic p99 read latency class')}
          <div class="stat-sub text-gray-500">${statTerms.qd} · ${statTerms.iops}</div>
        </div>

        <div class="strip-card">
          <div class="stat-label">${statTerms.bays}</div>
          <div class="strip-value-sm">${stats.driveCount}/${this.state.bays.length}</div>
          ${this._meterPercent(bayFillPct, '#4fc3f7', `${stats.driveCount} of ${this.state.bays.length} bays filled`)}
          <div class="stat-sub text-gray-500" title="${this._escapeHtml(vendorEntries.map(([v, c]) => `${v}: ${c}`).join(' · '))}">${topVendor}</div>
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
    const aggIOPS = stats.lowQueueReadIOPS || drives.reduce((s, d) => s + d.random4KReadIOPS, 0);
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
        value: stats.realisticSustainedWriteGBs,
        target: reqs.minSeqWriteGBs,
        display: `${stats.realisticSustainedWriteGBs.toFixed(1)}/${reqs.minSeqWriteGBs} GB/s`,
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
    if (workload.modelAssumptions?.targetP99ReadMs) {
      rows.push({
        label: 'P99',
        value: workload.modelAssumptions.targetP99ReadMs / Math.max(stats.estimatedP99ReadMs, 0.1),
        target: 1,
        display: `${stats.estimatedP99ReadMs.toFixed(1)}/${workload.modelAssumptions.targetP99ReadMs} ms`,
        status: fit.latency,
        detail: fit.latencyDetail,
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
          <div class="flex items-center gap-1 min-w-0">
            <span class="text-xs font-mono text-gray-600 truncate">${this._escapeHtml(dominant)}</span>
            <span class="status-pill ${overall.text}">${overall.label}</span>
          </div>
        </div>
        <div class="fitness-compact-grid">
          ${rows.map(row => {
            const tone = this._fitnessTone(row.status);
            return `
              <div class="fit-tile">
                <div class="fit-tile-head">
                  <span>${this._fitnessTerm(row.label, row.detail)}</span>
                  <span class="${tone.text}">${tone.label}</span>
                </div>
                <div class="fit-value">${this._escapeHtml(row.display)}</div>
                ${this._meter(row.value, row.target, tone.color, row.detail)}
              </div>
            `;
          }).join('')}
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
    const severityOrder = ['critical', 'warning', 'suggestion', 'info'];
    const total = insights.length;
    const categoryEntries = Object.entries(categoryCounts)
      .map(([category, count]) => {
        const related = insights.filter(ins => ins.category === category);
        const worst = related.reduce((acc, ins) =>
          this._severityRank(ins.severity) > this._severityRank(acc) ? ins.severity : acc, 'info');
        return {
          category,
          count,
          severity: worst,
          share: total > 0 ? (count / total) * 100 : 0,
        };
      })
      .sort((a, b) => this._severityRank(b.severity) - this._severityRank(a.severity) || b.count - a.count);
    const severitySegments = severityOrder.map(sev => {
      const meta = this._severityMeta(sev);
      return {
        label: `${counts[sev] || 0} ${meta.label}`,
        value: counts[sev] || 0,
        color: meta.color,
      };
    });

    const renderCluster = (entry) => {
      const meta = this._severityMeta(entry.severity);
      const related = insights
        .filter(ins => ins.category === entry.category)
        .sort((a, b) => this._severityRank(b.severity) - this._severityRank(a.severity));
      const primary = related[0];
      const markers = related.slice(0, 6).map(ins => this._severityMeta(ins.severity));
      const hiddenCount = Math.max(0, related.length - markers.length);
      const tooltip = related
        .map(ins => `${this._compactInsightTitle(ins.title)}: ${ins.message}`)
        .join('\n');
      return `
        <div class="issue-cluster" style="--issue-color:${meta.color}" title="${this._escapeHtml(tooltip || entry.category)}">
          <div class="issue-cluster-head">
            <span class="issue-name">${this._escapeHtml(entry.category)}</span>
            <span class="issue-count">${entry.count}</span>
          </div>
          <div class="issue-primary">${this._escapeHtml(this._compactInsightTitle(primary?.title || entry.category))}</div>
          <div class="issue-markers">
            ${markers.map(marker => `<span class="issue-dot" style="--dot-color:${marker.color}" title="${this._escapeHtml(marker.label)}"></span>`).join('')}
            ${hiddenCount ? `<span class="issue-more">+${hiddenCount}</span>` : ''}
          </div>
        </div>
      `;
    };

    panel.innerHTML = `
      <div class="insight-dashboard">
        <div class="flex items-center justify-between gap-2 mb-2">
          <div class="section-title mb-0">${total} signals</div>
          <span class="status-pill text-gray-400">${Object.keys(categoryCounts).length} areas</span>
        </div>
        ${this._splitBar(severitySegments)}
        <div class="severity-grid">
          ${severityOrder.map(sev => {
            const meta = this._severityMeta(sev);
            const count = counts[sev] || 0;
            return `
              <div class="severity-tally" style="border-color:${count ? `${meta.color}66` : '#26314d'}">
                <div class="severity-count ${count ? meta.text : 'text-gray-700'}">${count}</div>
                <div class="severity-label">${meta.label}</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
      <div class="issue-board">
        ${categoryEntries.map(entry => renderCluster(entry)).join('')}
      </div>
    `;
  }

  updateDriveInfo() {
    const bay = this.state.selectedBay >= 0 ? this.state.bays[this.state.selectedBay] : null;
    this.showDriveInfo(bay?.drive || null, bay);
  }

  showDriveInfo(drive, bay = null) {
    const el = this.els.driveInfo;
    if (!el) return;

    if (!this.state.server) {
      el.innerHTML = '';
      return;
    }

    if (!drive) {
      el.innerHTML = '';
      return;
    }

    const read = drive.seqReadMBs >= 1000 ? `${(drive.seqReadMBs / 1000).toFixed(1)} GB/s` : `${drive.seqReadMBs} MB/s`;
    const write = drive.seqWriteMBs >= 1000 ? `${(drive.seqWriteMBs / 1000).toFixed(1)} GB/s` : `${drive.seqWriteMBs} MB/s`;
    const iface = drive.interface === 'SATA III' ? 'SATA' : drive.interface.replace('NVMe PCIe ', 'Gen');
    const displayName = this._driveDisplayName(drive);
    const capacityLabel = this._driveCapacityLabel(drive);
    const price = drive.priceUSD
      ? `$${(drive.priceUSD / drive.capacityTB).toFixed(0)}/TB`
      : 'Unpriced';
    const bayLabel = bay ? `${bay.source === 'module' ? 'Expansion' : 'Bay'} ${bay.bayIndex + 1}` : 'Selected bay';
    const controller = drive.controllerVendor || drive.controller || 'Unknown';
    const adapterNote = bay && bay.formFactor === '3.5"' && drive.formFactor === '2.5"'
      ? '<div class="text-blue-300 text-xs font-mono mt-1">Uses 2.5&quot;-to-3.5&quot; tray/carrier</div>'
      : '';

    el.innerHTML = `
      <div class="makeup-card selected-drive-card">
        <div class="drive-detail-head">
          <div class="drive-swatch" style="background:linear-gradient(160deg, ${drive.color}, #0b1020 88%)"></div>
          <div class="min-w-0">
            <div class="section-title mb-1">Drive</div>
            <div class="text-xs font-mono text-gray-200 font-bold truncate">${this._escapeHtml(displayName)}</div>
            <div class="text-xs font-mono text-gray-600 truncate">${this._escapeHtml(bayLabel)} · ${this._escapeHtml(capacityLabel)} · ${this._escapeHtml(drive.formFactor)}</div>
          </div>
        </div>
        <div class="drive-token-strip">
          ${this._chip('NAND', `${drive.nandType} · ${drive.nandVendor}`, drive.nandType === 'QLC' ? '#f59e0b' : drive.nandType === 'SLC' ? '#22c55e' : '#4fc3f7')}
          ${this._chip('Ctrl', controller, '#f97316', drive.controller)}
          ${this._chip('', iface, iface === 'SATA' ? '#3b82f6' : '#a855f7')}
          ${this._chip('', price, drive.priceUSD ? '#64748b' : '#f59e0b', drive.priceUSD ? `$${drive.priceUSD.toLocaleString()}` : 'Unpriced')}
          ${this._chip('R/W', `${read}/${write}`, '#22c55e')}
          ${this._chip('DWPD', drive.dwpd, '#eab308', `${drive.tbw.toLocaleString()} TBW`)}
        </div>
        ${drive.middlewareRequired ? '<div class="text-green-400 text-xs font-mono mt-1">AI storage middleware</div>' : ''}
        ${adapterNote}
      </div>
    `;
  }
}
