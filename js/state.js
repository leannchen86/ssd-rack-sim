// state.js — Reactive state with event bus
// Extended for servers, workloads, modules (AIC), bay configs

export const EventBus = {
  _listeners: {},
  on(event, fn) {
    (this._listeners[event] ||= []).push(fn);
  },
  off(event, fn) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter(f => f !== fn);
  },
  emit(event, data) {
    (this._listeners[event] || []).forEach(fn => fn(data));
  }
};

export const RAID_MODES = {
  RAID0:  { name: 'RAID 0 (Stripe)',         usableRatio: 1.0,  minDrives: 2, redundancy: 0, raidWritePenalty: 1.0, raidReadBoost: true, description: 'Max speed, no safety net' },
  RAID1:  { name: 'RAID 1 (Mirror)',          usableRatio: 0.5,  minDrives: 2, redundancy: 1, raidWritePenalty: 0.5, raidReadBoost: false, description: 'Mirror pairs, 50% usable' },
  RAID5:  { name: 'RAID 5 (Parity)',          usableRatio: null,  minDrives: 3, redundancy: 1, raidWritePenalty: 0.25, raidReadBoost: false, description: 'N-1 usable, slow rebuilds' },
  RAID10: { name: 'RAID 10 (Mirror+Stripe)',  usableRatio: 0.5,  minDrives: 4, redundancy: 1, raidWritePenalty: 0.5, raidReadBoost: true, description: 'Best perf + redundancy' },
  JBOD:   { name: 'JBOD (No RAID)',           usableRatio: 1.0,  minDrives: 1, redundancy: 0, raidWritePenalty: 1.0, raidReadBoost: false, description: 'Just a bunch of disks' },
};

export function createState() {
  const state = {
    // Catalogs
    drives: [],
    serverCatalog: [],
    moduleCatalog: [],
    workloadCatalog: [],

    // Selected config
    server: null,
    activeBayConfig: null,   // for servers with multiple bay configs (R7725)
    raidMode: 'RAID10',
    bays: [],                // { drive: driveObj | null, bayIndex, source: 'chassis'|'module', interfaceType, formFactor }
    modules: [],             // installed AIC modules
    workload: null,          // selected workload profile

    // UI state
    hoveredBay: -1,
    selectedBay: -1,
    dragDrive: null,
  };

  return new Proxy(state, {
    set(target, prop, value) {
      const old = target[prop];
      target[prop] = value;
      if (old !== value) {
        EventBus.emit('state:change', { prop, value, old });
        EventBus.emit(`state:${prop}`, { value, old });
      }
      return true;
    }
  });
}

// Build bays array from server + active bay config + installed modules
export function buildBays(server, activeBayConfig, modules) {
  const bays = [];
  if (!server) return bays;

  // Get bay specs — use active config if server has bayConfigs
  let baySpecs;
  if (activeBayConfig && server.bayConfigs) {
    const config = server.bayConfigs.find(c => c.id === activeBayConfig);
    baySpecs = config ? config.bays : server.bays;
  } else {
    baySpecs = server.bays;
  }

  // Chassis bays
  let idx = 0;
  for (const spec of baySpecs) {
    for (let i = 0; i < spec.count; i++) {
      bays.push({
        drive: null,
        bayIndex: idx++,
        source: 'chassis',
        formFactor: spec.formFactor,
        interface: spec.interface,
        hotSwap: spec.hotSwap,
        lanesPerDrive: spec.lanesPerDrive || 0,
      });
    }
  }

  // Module bays (AIC)
  for (const mod of modules) {
    if (mod.provides) {
      for (let i = 0; i < mod.provides.count; i++) {
        bays.push({
          drive: null,
          bayIndex: idx++,
          source: 'module',
          moduleId: mod.id,
          moduleName: mod.name,
          formFactor: mod.provides.formFactor,
          interface: mod.provides.interface,
          hotSwap: mod.provides.hotSwap,
        });
      }
    }
  }

  return bays;
}

export function computeStats(state) {
  const filled = state.bays.filter(b => b.drive !== null);
  const driveCount = filled.length;

  if (driveCount === 0 || !state.server) {
    return {
      driveCount: 0, rawTB: 0, usableTB: 0, totalCost: 0, costPerUsableTB: 0,
      aggSeqReadGBs: 0, aggSeqWriteGBs: 0, realisticReadGBs: 0, realisticWriteGBs: 0,
      chassisMaxBWGBs: 0, busSaturated: false, totalPowerW: 0, rebuildTimeHours: 0, rebuildDegraded: false, rebuildWarning: '',
      raidValid: false, raidError: '', supplyRiskScore: 0,
      vendorConcentration: {}, nandVendorConcentration: {},
      driveCost: 0, chassisCost: 0, moduleCost: 0,
      costPerUsableTBYear5: 0,
      chassisBays: 0, moduleBays: 0,
    };
  }

  const raid = RAID_MODES[state.raidMode];
  const server = state.server;

  // RAID validity
  let raidValid = driveCount >= raid.minDrives;
  let raidError = '';
  if (!raidValid) {
    raidError = `${raid.name} requires at least ${raid.minDrives} drives`;
  }
  if (state.raidMode === 'RAID10' && driveCount % 2 !== 0) {
    raidValid = false;
    raidError = 'RAID 10 requires an even number of drives';
  }

  // Capacity
  const rawTB = filled.reduce((s, b) => s + b.drive.capacityTB, 0);
  let usableRatio = raid.usableRatio;
  if (state.raidMode === 'RAID5') {
    usableRatio = (driveCount - 1) / driveCount;
  }
  const usableTB = rawTB * (usableRatio ?? 1);

  // Cost breakdown
  const driveCost = filled.reduce((s, b) => s + b.drive.priceUSD, 0);
  const chassisCost = server.priceUSD || 0;
  const moduleCost = state.modules.reduce((s, m) => s + (m.priceUSD || 0), 0);
  const totalCost = driveCost + chassisCost + moduleCost;
  const costPerUsableTB = usableTB > 0 ? totalCost / usableTB : 0;

  // TCO amortization — drives have shorter replacement cycle than chassis
  // Drives: 3.5yr (warranty-aligned), chassis + AIC: 5yr
  const DRIVE_AMORT_YEARS = 3.5;
  const CHASSIS_AMORT_YEARS = 5;
  const annualCost = (driveCost / DRIVE_AMORT_YEARS) + ((chassisCost + moduleCost) / CHASSIS_AMORT_YEARS);
  const costPerUsableTBYear5 = usableTB > 0 ? annualCost / usableTB : 0;

  // Price completeness — count drives with priceUSD === 0 (TBD)
  const unpricedDrives = filled.filter(b => !b.drive.priceUSD).length;
  const priceIncomplete = unpricedDrives > 0;

  // Bandwidth — compute per source
  // Chassis bays use server bandwidth limits
  // Module bays use module's performance cap (affected by host PCIe gen)
  let aggSeqReadGBs = 0;
  let aggSeqWriteGBs = 0;

  const chassisFilled = filled.filter(b => b.source === 'chassis');
  const moduleFilled = filled.filter(b => b.source === 'module');

  // Chassis drives — SATA uses per-drive dedicated links capped by controller
  // Get bay specs for per-drive max
  let activeBaySpecs;
  if (state.activeBayConfig && server.bayConfigs) {
    const config = server.bayConfigs.find(c => c.id === state.activeBayConfig);
    activeBaySpecs = config ? config.bays : server.bays;
  } else {
    activeBaySpecs = server.bays;
  }
  const perDriveMaxMBs = (activeBaySpecs && activeBaySpecs[0] && activeBaySpecs[0].perDriveMaxMBs) || 0;

  let chassisReadGBs, chassisWriteGBs;
  if (perDriveMaxMBs > 0) {
    // SATA: each drive gets min(driveSpeed, perDriveLink), total capped by controller
    chassisReadGBs = chassisFilled.reduce((s, b) => s + Math.min(b.drive.seqReadMBs, perDriveMaxMBs) / 1000, 0);
    chassisWriteGBs = chassisFilled.reduce((s, b) => s + Math.min(b.drive.seqWriteMBs, perDriveMaxMBs) / 1000, 0);
  } else {
    chassisReadGBs = chassisFilled.reduce((s, b) => s + b.drive.seqReadMBs / 1000, 0);
    chassisWriteGBs = chassisFilled.reduce((s, b) => s + b.drive.seqWriteMBs / 1000, 0);
  }

  // Determine chassis max BW (may vary by bay config)
  let chassisMaxBW = server.maxBandwidthGBs;
  if (server.maxBandwidthByConfig && state.activeBayConfig) {
    chassisMaxBW = server.maxBandwidthByConfig[state.activeBayConfig] || chassisMaxBW;
  }

  const cappedChassisRead = Math.min(chassisReadGBs, chassisMaxBW);
  const cappedChassisWrite = Math.min(chassisWriteGBs, chassisMaxBW);

  aggSeqReadGBs = cappedChassisRead;
  aggSeqWriteGBs = cappedChassisWrite;

  // Module drives — capped by module's performance at host PCIe gen
  for (const mod of state.modules) {
    const modDrives = moduleFilled.filter(b => b.moduleId === mod.id);
    if (modDrives.length === 0) continue;
    const modReadGBs = modDrives.reduce((s, b) => s + b.drive.seqReadMBs / 1000, 0);
    const modWriteGBs = modDrives.reduce((s, b) => s + b.drive.seqWriteMBs / 1000, 0);

    let modMaxBW = mod.maxSeqReadGBs || Infinity;
    // Cap by host PCIe gen
    if (mod.performanceByHostGen && server.pcieGen) {
      const perf = mod.performanceByHostGen[server.pcieGen];
      if (perf) modMaxBW = perf.maxGBs;
    }

    aggSeqReadGBs += Math.min(modReadGBs, modMaxBW);
    aggSeqWriteGBs += Math.min(modWriteGBs, modMaxBW);
  }

  const realisticReadGBs = aggSeqReadGBs * server.realisticBandwidthRatio;
  const realisticWriteGBs = aggSeqWriteGBs * server.realisticBandwidthRatio * raid.raidWritePenalty;
  const busSaturated = chassisReadGBs > chassisMaxBW;

  // Power
  const drivePower = filled.reduce((s, b) => s + b.drive.powerW, 0);
  const modulePower = state.modules.reduce((s, m) => s + (m.thermalLoadW || 0), 0);
  const totalPowerW = server.powerBaseW + drivePower + modulePower;

  // Rebuild time — varies significantly by RAID mode
  let rebuildTimeHours = 0;
  let rebuildDegraded = false;
  let rebuildWarning = '';
  const maxDriveTB = driveCount > 0 ? Math.max(...filled.map(b => b.drive.capacityTB)) : 0;

  if (state.raidMode === 'RAID0' || state.raidMode === 'JBOD') {
    // No rebuild possible — data is lost on drive failure
    rebuildTimeHours = 0;
    rebuildWarning = state.raidMode === 'RAID0'
      ? 'RAID 0: Any drive failure destroys the entire array. No rebuild possible.'
      : 'JBOD: Failed drive data is lost. No rebuild.';
  } else if (state.raidMode === 'RAID10' || state.raidMode === 'RAID1') {
    // Mirror rebuild — isolated to mirror pair, ~200 MB/s (read one drive, write one)
    rebuildTimeHours = maxDriveTB * 1024 / (200 * 3.6);
    rebuildDegraded = state.raidMode === 'RAID10'; // RAID10: specific mirror pair is vulnerable
  } else if (state.raidMode === 'RAID5') {
    // Must read ALL remaining drives; parity computation slows things down
    // Baseline 60 MB/s, reduced by 20% for every 8 drives above 8
    let effectiveSpeed = 60;
    if (driveCount > 8) {
      const extraGroups = Math.floor((driveCount - 8) / 8);
      effectiveSpeed = effectiveSpeed * Math.pow(0.8, extraGroups);
    }
    rebuildTimeHours = maxDriveTB * 1024 / (effectiveSpeed * 3.6);
    rebuildDegraded = true; // Array is vulnerable during entire rebuild
  }

  // Supply risk — worst-case, not averaged
  // A single high-risk drive compromises the whole array (any failure requires that SKU)
  const riskMap = { low: 10, medium: 40, high: 80 };
  const supplyRiskScore = filled.reduce((s, b) => Math.max(s, riskMap[b.drive.supplyRisk] || 50), 0);
  const highRiskCount = filled.filter(b => b.drive.supplyRisk === 'high').length;

  // Vendor concentration
  const vendorConcentration = {};
  const nandVendorConcentration = {};
  filled.forEach(b => {
    vendorConcentration[b.drive.vendor] = (vendorConcentration[b.drive.vendor] || 0) + 1;
    nandVendorConcentration[b.drive.nandVendor] = (nandVendorConcentration[b.drive.nandVendor] || 0) + 1;
  });

  // Bay counts by source
  const chassisBays = state.bays.filter(b => b.source === 'chassis').length;
  const moduleBays = state.bays.filter(b => b.source === 'module').length;

  return {
    driveCount, rawTB, usableTB,
    totalCost, driveCost, chassisCost, moduleCost,
    costPerUsableTB, costPerUsableTBYear5,
    aggSeqReadGBs, aggSeqWriteGBs,
    realisticReadGBs, realisticWriteGBs,
    chassisMaxBWGBs: chassisMaxBW,
    busSaturated, totalPowerW, rebuildTimeHours, rebuildDegraded, rebuildWarning,
    raidValid, raidError, supplyRiskScore, highRiskCount,
    vendorConcentration, nandVendorConcentration,
    chassisBays, moduleBays,
    unpricedDrives, priceIncomplete,
  };
}
