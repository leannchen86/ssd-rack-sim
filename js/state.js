// state.js — Reactive state with event bus
// Extended for servers, workloads, expansion modules, bay configs

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

const DEFAULT_ELECTRICITY_USD_KWH = 0.12;
const DEFAULT_PUE = 1.4;
const DEFAULT_CONSUMER_AFR = 0.01;
const DEFAULT_UBER = 1e-16;
const DEFAULT_COOLING_PROFILE = 'stock';
const COOLING_PROFILE_MULTIPLIERS = {
  constrained: 0.75,
  stock: 1,
  boosted: 1.3,
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function coolingProfileMultiplier(profile) {
  return COOLING_PROFILE_MULTIPLIERS[profile] || COOLING_PROFILE_MULTIPLIERS[DEFAULT_COOLING_PROFILE];
}

function bayThermalBudgetW(server, bay) {
  const design = server?.thermalDesign || 'standard';
  const isNvme = String(bay.interface || '').startsWith('NVMe');
  const table = isNvme
    ? {
        tower: 7,
        standard: 8,
        'enterprise-optimized': 12,
        'nvme-optimized': bay.formFactor === 'E3.S' ? 15 : 16,
      }
    : {
        tower: 4.5,
        standard: 5.5,
        'enterprise-optimized': 7,
        'nvme-optimized': 8,
      };
  return table[design] || table.standard;
}

function moduleThermalBudgetW(server) {
  const design = server?.thermalDesign || 'standard';
  return {
    tower: 60,
    standard: 45,
    'enterprise-optimized': 75,
    'nvme-optimized': 110,
  }[design] || 45;
}

function deriveThermalModel(state, drivePowerW, modulePowerW) {
  const profile = state.coolingProfile || DEFAULT_COOLING_PROFILE;
  const profileMultiplier = coolingProfileMultiplier(profile);
  const chassisBudgetW = state.bays
    .filter(b => b.source === 'chassis')
    .reduce((s, b) => s + bayThermalBudgetW(state.server, b), 0);
  const moduleBudgetW = state.modules.reduce((s) => s + moduleThermalBudgetW(state.server), 0);
  const thermalBudgetW = Math.max(1, (chassisBudgetW + moduleBudgetW) * profileMultiplier);
  const thermalLoadW = drivePowerW + modulePowerW;
  const thermalPressure = thermalLoadW / thermalBudgetW;
  const overBudget = Math.max(0, thermalPressure - 1);
  const thermalBurstThrottleFactor = overBudget > 0
    ? clamp(1 - overBudget * 0.22, 0.72, 1)
    : 1;
  const thermalSustainedThrottleFactor = overBudget > 0
    ? clamp(1 - overBudget * 0.55, 0.45, 1)
    : 1;
  const thermalStatus = thermalPressure > 1.25
    ? 'throttling'
    : thermalPressure > 1
      ? 'hot'
      : thermalPressure > 0.82
        ? 'warm'
        : 'healthy';

  return {
    coolingProfile: profile,
    thermalLoadW,
    thermalBudgetW,
    thermalHeadroomW: thermalBudgetW - thermalLoadW,
    thermalPressure,
    thermalStatus,
    thermalBurstThrottleFactor,
    thermalSustainedThrottleFactor,
  };
}

function interfaceGen(drive) {
  if (drive.interface === 'SATA III') return 0;
  const match = String(drive.interface).match(/PCIe\s+(\d+)/);
  return match ? Number(match[1]) : 0;
}

function isDramless(drive) {
  return !drive.dramCacheMB || drive.dramCacheMB <= 0;
}

function estimateSustainedWriteMBs(drive) {
  if (drive.sustainedWriteMBs) return drive.sustainedWriteMBs;

  const gen = interfaceGen(drive);
  const qlc = drive.nandType === 'QLC';
  const dramless = isDramless(drive);
  let factor;

  if (drive.interface === 'SATA III') {
    factor = qlc ? 0.35 : dramless ? 0.65 : 0.85;
  } else {
    factor = qlc ? 0.08 : dramless ? 0.18 : gen >= 5 ? 0.28 : 0.26;
  }

  const estimate = drive.seqWriteMBs * factor;
  if (drive.interface === 'SATA III') {
    return Math.max(120, Math.min(drive.seqWriteMBs, estimate));
  }
  return Math.max(500, Math.min(drive.seqWriteMBs, estimate));
}

function estimateSlcCacheGB(drive) {
  if (drive.slcCacheGB) return drive.slcCacheGB;

  const gen = interfaceGen(drive);
  const qlc = drive.nandType === 'QLC';
  const dramless = isDramless(drive);
  let perTB;
  let cap;

  if (drive.interface === 'SATA III') {
    perTB = qlc ? 20 : 35;
    cap = qlc ? 160 : 220;
  } else if (qlc) {
    perTB = 70;
    cap = 350;
  } else {
    perTB = dramless ? 55 : gen >= 5 ? 120 : 95;
    cap = dramless ? 280 : gen >= 5 ? 700 : 520;
  }

  return Math.min(cap, Math.max(16, drive.capacityTB * perTB));
}

function estimateLowQueueReadIOPS(drive) {
  if (drive.lowQueueReadIOPS) return drive.lowQueueReadIOPS;
  const qlc = drive.nandType === 'QLC';
  const dramless = isDramless(drive);
  const factor = drive.interface === 'SATA III'
    ? (qlc ? 0.34 : dramless ? 0.38 : 0.48)
    : (qlc ? 0.13 : dramless ? 0.18 : 0.22);
  return Math.round(drive.random4KReadIOPS * factor);
}

function estimateReadP99Ms(drive) {
  if (drive.p99ReadMs) return drive.p99ReadMs;
  if (drive.interface === 'SATA III') {
    return (drive.nandType === 'QLC' ? 9.0 : 6.0) + (isDramless(drive) ? 1.5 : 0);
  }
  const gen = interfaceGen(drive);
  return (gen >= 5 ? 1.1 : 1.6) + (drive.nandType === 'QLC' ? 1.6 : 0) + (isDramless(drive) ? 0.5 : 0);
}

function estimateDriveAfr(drive) {
  if (drive.afrPct) return drive.afrPct / 100;
  let afr = DEFAULT_CONSUMER_AFR;
  if (drive.nandType === 'QLC') afr += 0.003;
  if (isDramless(drive)) afr += 0.002;
  if (drive.supplyRisk === 'high') afr += 0.002;
  return afr;
}

function raidWearFactor(mode) {
  return {
    RAID0: 1,
    JBOD: 1,
    RAID1: 2,
    RAID10: 2,
    RAID5: 4,
  }[mode] || 1;
}

function degradedRiskMembers(mode, driveCount) {
  if (mode === 'RAID5') return Math.max(0, driveCount - 1);
  if (mode === 'RAID1' || mode === 'RAID10') return driveCount >= 2 ? 1 : 0;
  return 0;
}

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
    networkGbpsOverride: null,
    coolingProfile: DEFAULT_COOLING_PROFILE,
    fillStrategy: 'use-case',
    fillDriveId: null,
    bays: [],                // { drive: driveObj | null, bayIndex, source: 'chassis'|'module', interfaceType, formFactor }
    modules: [],             // installed expansion modules
    workload: null,          // selected workload profile

    // UI state
    hoveredBay: -1,
    selectedBay: -1,
    dragDrive: null,
    dragStart: null,
    paletteDragging: false,
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
        perDriveMaxMBs: spec.perDriveMaxMBs || 0,
      });
    }
  }

  // Expansion module bays
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
      raidValid: false, raidError: '', supplyRiskScore: 0, highRiskCount: 0,
      vendorConcentration: {}, nandVendorConcentration: {},
      driveCost: 0, chassisCost: 0, moduleCost: 0,
      costPerUsableTBYear5: 0,
      chassisBays: 0, moduleBays: 0,
      unpricedDrives: 0, priceIncomplete: false,
      realisticSustainedWriteGBs: 0, writeCliffRatio: 1, slcCacheGB: 0, cacheExhaustMinutes: 0,
      lowQueueReadIOPS: 0, estimatedP99ReadMs: 0,
      drivePotentialReadGBs: 0, platformReadGBs: 0, bottleneckReadGBs: 0,
      energyCostPerYear: 0, electricityUSDPerKWh: DEFAULT_ELECTRICITY_USD_KWH, pue: DEFAULT_PUE,
      workloadWriteTBPerDay: 0, minEnduranceYears: Infinity, medianEnduranceYears: Infinity,
      expectedFailuresPerYear: 0, rebuildSecondFailureRiskPct: 0, ureDuringRebuildRiskPct: 0,
      controllerVendorConcentration: {}, networkGbps: 0, networkLimitGBs: 0, networkBottleneck: false,
      coolingProfile: DEFAULT_COOLING_PROFILE, thermalLoadW: 0, thermalBudgetW: 0, thermalHeadroomW: 0,
      thermalPressure: 0, thermalStatus: 'empty', thermalThrottleFactor: 1, thermalBurstThrottleFactor: 1,
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
  // Drives: 3.5yr (warranty-aligned), chassis + expansion: 5yr
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

  // Chassis drives — SATA uses per-drive dedicated links capped by controller.
  const bayReadMBs = (bay) => bay.perDriveMaxMBs > 0
    ? Math.min(bay.drive.seqReadMBs, bay.perDriveMaxMBs)
    : bay.drive.seqReadMBs;
  const bayPeakWriteMBs = (bay) => bay.perDriveMaxMBs > 0
    ? Math.min(bay.drive.seqWriteMBs, bay.perDriveMaxMBs)
    : bay.drive.seqWriteMBs;
  const baySustainedWriteMBs = (bay) => bay.perDriveMaxMBs > 0
    ? Math.min(estimateSustainedWriteMBs(bay.drive), bay.perDriveMaxMBs)
    : estimateSustainedWriteMBs(bay.drive);

  let chassisReadGBs = chassisFilled.reduce((s, b) => s + bayReadMBs(b) / 1000, 0);
  let chassisWriteGBs = chassisFilled.reduce((s, b) => s + bayPeakWriteMBs(b) / 1000, 0);
  let chassisSustainedWriteGBs = chassisFilled.reduce((s, b) => s + baySustainedWriteMBs(b) / 1000, 0);

  // Determine chassis max BW (may vary by bay config)
  let chassisMaxBW = server.maxBandwidthGBs;
  if (server.maxBandwidthByConfig && state.activeBayConfig) {
    chassisMaxBW = server.maxBandwidthByConfig[state.activeBayConfig] || chassisMaxBW;
  }

  const cappedChassisRead = Math.min(chassisReadGBs, chassisMaxBW);
  const cappedChassisWrite = Math.min(chassisWriteGBs, chassisMaxBW);
  const cappedChassisSustainedWrite = Math.min(chassisSustainedWriteGBs, chassisMaxBW);

  aggSeqReadGBs = cappedChassisRead;
  aggSeqWriteGBs = cappedChassisWrite;
  let aggSustainedWriteGBs = cappedChassisSustainedWrite;
  let modulePotentialReadGBs = 0;

  // Module drives — capped by module's performance at host PCIe gen
  for (const mod of state.modules) {
    const modDrives = moduleFilled.filter(b => b.moduleId === mod.id);
    if (modDrives.length === 0) continue;
    const modReadGBs = modDrives.reduce((s, b) => s + b.drive.seqReadMBs / 1000, 0);
    const modWriteGBs = modDrives.reduce((s, b) => s + b.drive.seqWriteMBs / 1000, 0);
    const modSustainedWriteGBs = modDrives.reduce((s, b) => s + estimateSustainedWriteMBs(b.drive) / 1000, 0);
    modulePotentialReadGBs += modReadGBs;

    let modMaxBW = mod.maxSeqReadGBs || Infinity;
    // Cap by host PCIe gen
    if (mod.performanceByHostGen && server.pcieGen) {
      const perf = mod.performanceByHostGen[server.pcieGen];
      if (perf) modMaxBW = perf.maxGBs;
    }

    aggSeqReadGBs += Math.min(modReadGBs, modMaxBW);
    aggSeqWriteGBs += Math.min(modWriteGBs, modMaxBW);
    aggSustainedWriteGBs += Math.min(modSustainedWriteGBs, modMaxBW);
  }

  const preThermalReadGBs = aggSeqReadGBs * server.realisticBandwidthRatio;
  const preThermalWriteGBs = aggSeqWriteGBs * server.realisticBandwidthRatio * raid.raidWritePenalty;
  const preThermalSustainedWriteGBs = aggSustainedWriteGBs * server.realisticBandwidthRatio * raid.raidWritePenalty;
  const busSaturated = chassisReadGBs > chassisMaxBW;

  // Power
  const drivePower = filled.reduce((s, b) => s + b.drive.powerW, 0);
  const modulePower = state.modules.reduce((s, m) => s + (m.thermalLoadW || 0), 0);
  const totalPowerW = server.powerBaseW + drivePower + modulePower;
  const electricityUSDPerKWh = state.workload?.modelAssumptions?.electricityUSDPerKWh || DEFAULT_ELECTRICITY_USD_KWH;
  const pue = state.workload?.modelAssumptions?.pue || DEFAULT_PUE;
  const energyCostPerYear = (totalPowerW / 1000) * 24 * 365 * electricityUSDPerKWh * pue;

  const thermal = deriveThermalModel(state, drivePower, modulePower);
  const drivePotentialReadGBs = (chassisReadGBs + modulePotentialReadGBs) * server.realisticBandwidthRatio * thermal.thermalBurstThrottleFactor;
  const realisticReadGBs = preThermalReadGBs * thermal.thermalBurstThrottleFactor;
  const realisticWriteGBs = preThermalWriteGBs * thermal.thermalBurstThrottleFactor;
  const realisticSustainedWriteGBs = preThermalSustainedWriteGBs * thermal.thermalSustainedThrottleFactor;

  // Consumer SSD realism approximations. These are planning signals, not lab measurements.
  const slcCacheGB = filled.reduce((s, b) => s + estimateSlcCacheGB(b.drive), 0);
  const writeCliffRatio = realisticWriteGBs > 0 ? realisticSustainedWriteGBs / realisticWriteGBs : 1;
  const cacheFillGBs = Math.max(0, realisticWriteGBs - realisticSustainedWriteGBs);
  const cacheExhaustMinutes = cacheFillGBs > 0 ? slcCacheGB / cacheFillGBs / 60 : Infinity;
  const lowQueueReadIOPS = Math.round(
    filled.reduce((s, b) => s + estimateLowQueueReadIOPS(b.drive), 0) * thermal.thermalBurstThrottleFactor
  );
  const baseP99ReadMs = filled.length ? Math.max(...filled.map(b => estimateReadP99Ms(b.drive))) : 0;
  const estimatedP99ReadMs = baseP99ReadMs
    * (busSaturated ? 1.35 : 1)
    * (state.raidMode === 'RAID5' ? 1.15 : 1)
    * (1 + (1 - thermal.thermalBurstThrottleFactor) * 1.8);

  const networkOverride = state.networkGbpsOverride;
  const networkGbps = networkOverride === 'local'
    ? Infinity
    : Number.isFinite(networkOverride)
      ? networkOverride
      : state.workload?.modelAssumptions?.networkGbps || server.networkGbps || Infinity;
  const networkLimitGBs = Number.isFinite(networkGbps) ? (networkGbps / 8) * 0.92 : Infinity;
  const networkBottleneck = realisticReadGBs > networkLimitGBs * 1.15;
  const bottleneckReadGBs = Math.min(realisticReadGBs, networkLimitGBs);

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

  const modelAssumptions = state.workload?.modelAssumptions || {};
  const workloadWriteTBPerDay = modelAssumptions.writeTBPerDay || 0;
  const workloadWriteAmp = modelAssumptions.writeAmplification || 1;
  const physicalWriteTBPerDay = workloadWriteTBPerDay * workloadWriteAmp * raidWearFactor(state.raidMode);
  const enduranceYears = filled.map(b => {
    if (!physicalWriteTBPerDay || !b.drive.tbw || driveCount === 0) return Infinity;
    const perDriveTBPerDay = physicalWriteTBPerDay / driveCount;
    return b.drive.tbw / (perDriveTBPerDay * 365);
  }).sort((a, b) => a - b);
  const minEnduranceYears = enduranceYears[0] ?? Infinity;
  const medianEnduranceYears = enduranceYears.length
    ? enduranceYears[Math.floor(enduranceYears.length / 2)]
    : Infinity;

  const expectedFailuresPerYear = filled.reduce((s, b) => s + estimateDriveAfr(b.drive), 0);
  const rebuildWindowYears = rebuildTimeHours / (24 * 365);
  const riskMembers = degradedRiskMembers(state.raidMode, driveCount);
  const avgAfr = driveCount > 0 ? expectedFailuresPerYear / driveCount : DEFAULT_CONSUMER_AFR;
  const rebuildSecondFailureRiskPct = riskMembers > 0
    ? (1 - Math.exp(-riskMembers * avgAfr * rebuildWindowYears)) * 100
    : 0;
  const bitsReadDuringRebuild = state.raidMode === 'RAID5'
    ? Math.max(0, rawTB - maxDriveTB) * 8e12
    : maxDriveTB * 8e12;
  const ureDuringRebuildRiskPct = (state.raidMode === 'RAID5' || state.raidMode === 'RAID1' || state.raidMode === 'RAID10')
    ? (1 - Math.exp(-bitsReadDuringRebuild * DEFAULT_UBER)) * 100
    : 0;

  // Supply risk — worst-case, not averaged
  // A single high-risk drive compromises the whole array (any failure requires that SKU)
  const riskMap = { low: 10, medium: 40, high: 80 };
  const supplyRiskScore = filled.reduce((s, b) => Math.max(s, riskMap[b.drive.supplyRisk] || 50), 0);
  const highRiskCount = filled.filter(b => b.drive.supplyRisk === 'high').length;

  // Vendor concentration
  const vendorConcentration = {};
  const nandVendorConcentration = {};
  const controllerVendorConcentration = {};
  filled.forEach(b => {
    vendorConcentration[b.drive.vendor] = (vendorConcentration[b.drive.vendor] || 0) + 1;
    nandVendorConcentration[b.drive.nandVendor] = (nandVendorConcentration[b.drive.nandVendor] || 0) + 1;
    controllerVendorConcentration[b.drive.controllerVendor] = (controllerVendorConcentration[b.drive.controllerVendor] || 0) + 1;
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
    realisticSustainedWriteGBs, writeCliffRatio, slcCacheGB, cacheExhaustMinutes,
    lowQueueReadIOPS, estimatedP99ReadMs,
    drivePotentialReadGBs,
    platformReadGBs: realisticReadGBs,
    bottleneckReadGBs,
    chassisMaxBWGBs: chassisMaxBW,
    busSaturated, totalPowerW, energyCostPerYear, electricityUSDPerKWh, pue,
    coolingProfile: thermal.coolingProfile,
    thermalLoadW: thermal.thermalLoadW,
    thermalBudgetW: thermal.thermalBudgetW,
    thermalHeadroomW: thermal.thermalHeadroomW,
    thermalPressure: thermal.thermalPressure,
    thermalStatus: thermal.thermalStatus,
    thermalThrottleFactor: thermal.thermalSustainedThrottleFactor,
    thermalBurstThrottleFactor: thermal.thermalBurstThrottleFactor,
    rebuildTimeHours, rebuildDegraded, rebuildWarning,
    raidValid, raidError, supplyRiskScore, highRiskCount,
    expectedFailuresPerYear, rebuildSecondFailureRiskPct, ureDuringRebuildRiskPct,
    workloadWriteTBPerDay, minEnduranceYears, medianEnduranceYears,
    vendorConcentration, nandVendorConcentration, controllerVendorConcentration,
    chassisBays, moduleBays,
    unpricedDrives, priceIncomplete,
    networkGbps, networkLimitGBs, networkBottleneck,
  };
}
