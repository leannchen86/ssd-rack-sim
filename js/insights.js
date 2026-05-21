// insights.js — Reasoning engine that surfaces tradeoffs, warnings, and second-order effects
// Generates contextual insights based on current configuration + selected workload

const SEVERITY = { info: 0, suggestion: 1, warning: 2, critical: 3 };

export function generateInsights(state, stats, workload) {
  const insights = [];
  if (!state.server || stats.driveCount === 0) return insights;

  const server = state.server;
  const filled = state.bays.filter(b => b.drive);
  const drives = filled.map(b => b.drive);
  const hasModule = state.modules.length > 0;
  const moduleSlots = state.modules.flatMap(m => m.provides ? [m] : []);

  // === WORKLOAD FIT ===
  if (workload) {
    const reqs = workload.requirements;

    if (reqs.minUsableTB && stats.usableTB < reqs.minUsableTB) {
      insights.push({
        severity: 'critical',
        category: 'Use Case Fit',
        title: 'Insufficient capacity',
        message: `${workload.name} needs ≥${reqs.minUsableTB} TB usable. You have ${stats.usableTB.toFixed(1)} TB.`,
        metric: 'capacity'
      });
    }

    if (reqs.maxUsableTB && stats.usableTB > reqs.maxUsableTB * 1.5) {
      insights.push({
        severity: 'warning',
        category: 'Use Case Fit',
        title: 'Over-provisioned capacity',
        message: `${workload.name} needs ${reqs.minUsableTB || 0}–${reqs.maxUsableTB} TB. You have ${stats.usableTB.toFixed(1)} TB — money wasted on unneeded capacity.`,
        metric: 'capacity'
      });
    }

    if (reqs.minRandomReadIOPS) {
      const aggIOPS = stats.lowQueueReadIOPS || drives.reduce((s, d) => s + d.random4KReadIOPS, 0);
      if (aggIOPS < reqs.minRandomReadIOPS) {
        insights.push({
          severity: 'critical',
          category: 'Use Case Fit',
          title: 'Low-QD random IOPS too low',
          message: `${workload.name} needs ≥${(reqs.minRandomReadIOPS / 1000).toFixed(0)}K random read IOPS. Estimated QD${workload.modelAssumptions?.typicalQueueDepth || 4}: ${(aggIOPS / 1000).toFixed(0)}K.`,
          metric: 'iops'
        });
      }
    }

    if (reqs.minSeqWriteGBs && stats.realisticSustainedWriteGBs < reqs.minSeqWriteGBs) {
      insights.push({
        severity: 'warning',
        category: 'Use Case Fit',
        title: 'Sustained write bandwidth low',
        message: `${workload.name} wants ≥${reqs.minSeqWriteGBs} GB/s write. Estimated post-cache sustained: ${stats.realisticSustainedWriteGBs.toFixed(1)} GB/s.`,
        metric: 'write-bw'
      });
    }

    if (workload.modelAssumptions?.targetP99ReadMs && stats.estimatedP99ReadMs > workload.modelAssumptions.targetP99ReadMs) {
      insights.push({
        severity: workload.priorities?.latency === 'critical' ? 'critical' : 'warning',
        category: 'Use Case Fit',
        title: 'Latency class mismatch',
        message: `${workload.name} targets ~${workload.modelAssumptions.targetP99ReadMs} ms p99 reads. This build estimates ~${stats.estimatedP99ReadMs.toFixed(1)} ms from interface/NAND class.`,
        metric: 'latency'
      });
    }

    if (reqs.minDWPD) {
      const minDriveDWPD = Math.min(...drives.map(d => d.dwpd || 0));
      if (minDriveDWPD < reqs.minDWPD) {
        insights.push({
          severity: reqs.minDWPD >= 10 ? 'critical' : 'warning',
          category: 'Use Case Fit',
          title: 'Drive endurance insufficient',
          message: `${workload.name} needs ≥${reqs.minDWPD} DWPD. Your lowest drive is ${minDriveDWPD} DWPD.`,
          metric: 'endurance'
        });
      }
    }

    // Anti-patterns from workload definition
    if (workload.antiPatterns) {
      for (const ap of workload.antiPatterns) {
        let triggered = false;
        switch (ap.condition) {
          case 'hasU2Drives':
            triggered = drives.some(d => d.formFactor === 'U.2');
            break;
          case 'hasE3SDrives':
            triggered = drives.some(d => d.formFactor === 'E3.S');
            break;
          case 'qlcDrives':
            triggered = drives.some(d => d.nandType === 'QLC');
            break;
          case 'industrialDrives':
            triggered = drives.some(d => d.category === 'industrial');
            break;
          case 'allSATA':
            triggered = drives.every(d => d.interface === 'SATA III');
            break;
          case 'overCapacity':
            triggered = workload.requirements.maxUsableTB && stats.usableTB > workload.requirements.maxUsableTB * 2;
            break;
          case 'tlcDrives':
            triggered = drives.some(d => d.nandType === 'TLC');
            break;
          case 'noGPU':
            triggered = true; // We do not model GPUs yet.
            break;
        }
        if (triggered) {
          insights.push({
            severity: 'warning',
            category: 'Use Case Anti-pattern',
            title: ap.condition.replace(/([A-Z])/g, ' $1').trim(),
            message: ap.message,
          });
        }
      }
    }
  }

  // === REALISM APPROXIMATIONS ===
  if (stats.driveCount > 0 && Number.isFinite(stats.cacheExhaustMinutes) && stats.writeCliffRatio < 0.65) {
    insights.push({
      severity: stats.writeCliffRatio < 0.35 ? 'warning' : 'suggestion',
      category: 'Performance Reality',
      title: 'Write cliff after SLC cache',
      message: `Burst write is ${stats.realisticWriteGBs.toFixed(1)} GB/s, but estimated sustained write is ${stats.realisticSustainedWriteGBs.toFixed(1)} GB/s after roughly ${stats.cacheExhaustMinutes.toFixed(1)} minutes at burst rate.`,
    });
  }

  if (stats.workloadWriteTBPerDay > 0 && Number.isFinite(stats.minEnduranceYears) && stats.minEnduranceYears < 3.5) {
    insights.push({
      severity: stats.minEnduranceYears < 2 ? 'critical' : 'warning',
      category: 'Lifecycle',
      title: 'TBW lifespan under use case',
      message: `At ${stats.workloadWriteTBPerDay} TB/day and RAID ${state.raidMode.replace('RAID', '')} write amplification, the weakest drive reaches TBW in ~${stats.minEnduranceYears.toFixed(1)} years.`,
    });
  }

  if (stats.energyCostPerYear > 0 && stats.energyCostPerYear > Math.max(500, stats.driveCost * 0.08)) {
    insights.push({
      severity: 'info',
      category: 'TCO',
      title: 'Power is material to TCO',
      message: `Estimated power + cooling cost is ~$${stats.energyCostPerYear.toFixed(0)}/year at $${stats.electricityUSDPerKWh.toFixed(2)}/kWh and ${stats.pue.toFixed(1)} PUE.`,
    });
  }

  if (stats.thermalBudgetW > 0 && stats.thermalPressure > 1) {
    insights.push({
      severity: stats.thermalPressure > 1.25 ? 'warning' : 'suggestion',
      category: 'Thermal',
      title: 'Cooling envelope exceeded',
      message: `Modeled storage heat is ~${stats.thermalLoadW.toFixed(0)}W against a ${stats.thermalBudgetW.toFixed(0)}W ${stats.coolingProfile || 'stock'} cooling budget. Sustained write is derated to ${(stats.thermalThrottleFactor * 100).toFixed(0)}% to approximate throttling.`,
    });
  } else if (stats.thermalBudgetW > 0 && stats.thermalPressure > 0.82) {
    insights.push({
      severity: 'info',
      category: 'Thermal',
      title: 'Thermal headroom is getting tight',
      message: `Modeled storage heat uses ${(stats.thermalPressure * 100).toFixed(0)}% of the selected cooling profile. A higher fan profile or purpose-built NVMe chassis gives more sustained-write margin.`,
    });
  }

  if (stats.expectedFailuresPerYear >= 0.25) {
    insights.push({
      severity: stats.expectedFailuresPerYear >= 0.5 ? 'warning' : 'info',
      category: 'Reliability',
      title: 'Expected drive swaps',
      message: `Consumer AFR heuristic predicts ~${stats.expectedFailuresPerYear.toFixed(2)} drive failure${stats.expectedFailuresPerYear >= 1 ? 's' : ''}/year for this populated chassis.`,
    });
  }

  if (stats.rebuildSecondFailureRiskPct > 0.05 || stats.ureDuringRebuildRiskPct > 0.5) {
    insights.push({
      severity: stats.rebuildSecondFailureRiskPct > 0.25 || stats.ureDuringRebuildRiskPct > 2 ? 'warning' : 'suggestion',
      category: 'Reliability',
      title: 'Degraded-window exposure',
      message: `Approximate risk during rebuild: ${stats.rebuildSecondFailureRiskPct.toFixed(2)}% second-failure exposure and ${stats.ureDuringRebuildRiskPct.toFixed(2)}% read-error exposure.`,
    });
  }

  // === BUS SATURATION ===
  if (stats.busSaturated) {
    const waste = ((stats.aggSeqReadGBs - stats.chassisMaxBWGBs) / stats.aggSeqReadGBs * 100).toFixed(0);
    insights.push({
      severity: 'warning',
      category: 'Architecture',
      title: 'Bus saturated',
      message: `Drives can push ${stats.aggSeqReadGBs.toFixed(1)} GB/s but chassis bus caps at ${stats.chassisMaxBWGBs.toFixed(1)} GB/s. ${waste}% of drive bandwidth is wasted.`,
      metric: 'bandwidth'
    });
  }

  if (stats.networkBottleneck) {
    insights.push({
      severity: 'suggestion',
      category: 'Architecture',
      title: 'Network caps usable disk speed',
      message: `Estimated server-side read is ${stats.realisticReadGBs.toFixed(1)} GB/s, while the modeled network path is ~${stats.networkLimitGBs.toFixed(1)} GB/s. Extra disk bandwidth may not be visible to users.`,
      metric: 'network'
    });
  }

  // === SATA vs NVMe PRICE PARITY ===
  // Compute from catalog (priced drives only), not hardcoded
  const pricedDrives = state.drives.filter(d => d.priceUSD > 0);
  const sataConsumer = pricedDrives.filter(d => d.interface === 'SATA III' && d.category === 'consumer');
  const nvmeConsumer = pricedDrives.filter(d => d.interface.startsWith('NVMe') && d.category === 'consumer' && d.formFactor.startsWith('M.2'));
  const satadrives = drives.filter(d => d.interface === 'SATA III');
  const pricedSataInConfig = satadrives.filter(d => d.priceUSD > 0);

  if (pricedSataInConfig.length > 0 && sataConsumer.length > 0 && nvmeConsumer.length > 0) {
    const sataCatalogCostPerTB = sataConsumer.reduce((s, d) => s + d.priceUSD, 0) / sataConsumer.reduce((s, d) => s + d.capacityTB, 0);
    const nvmeCatalogCostPerTB = nvmeConsumer.reduce((s, d) => s + d.priceUSD, 0) / nvmeConsumer.reduce((s, d) => s + d.capacityTB, 0);
    const ratio = nvmeCatalogCostPerTB / sataCatalogCostPerTB;
    const verdict = ratio <= 1.15 ? 'reached parity' : ratio <= 1.5 ? 'approaching parity' : 'still a premium';
    insights.push({
      severity: 'info',
      category: 'Market',
      title: `SATA vs NVMe pricing: NVMe ${verdict}`,
      message: `Consumer SATA: $${sataCatalogCostPerTB.toFixed(0)}/TB · Consumer NVMe M.2: $${nvmeCatalogCostPerTB.toFixed(0)}/TB (${ratio.toFixed(2)}x). For new builds, NVMe offers ~25x bandwidth at ${ratio <= 1.2 ? 'similar' : 'modestly higher'} cost. Existing SATA servers still can't use NVMe without chassis replacement.`,
    });
  }

  // === EXPANSION INSIGHTS ===
  for (const mod of state.modules) {
    if (mod.type === 'aic') {
      // PCIe generation mismatch
      const hostGen = server.pcieGen;
      const perfByGen = mod.performanceByHostGen;
      if (perfByGen && perfByGen[hostGen]) {
        const perf = perfByGen[hostGen];
        if (hostGen < (mod.requires.optimalPcieGen || 5)) {
          insights.push({
            severity: 'warning',
            category: 'Expansion',
            title: `PCIe Gen${hostGen} bottleneck`,
            message: `The NVMe expansion card is rated for Gen${mod.requires.optimalPcieGen} but this server has Gen${hostGen} slots. ${perf.note}`,
          });
        }
      }

      // No hot-swap
      if (mod.provides && !mod.provides.hotSwap) {
        insights.push({
          severity: 'warning',
          category: 'Expansion',
          title: 'No hot-swap on expansion drives',
          message: 'M.2 drives on this expansion card are not hot-swappable in the model. RAID10 mitigates data loss, but a drive swap may still require downtime.',
        });
      }

      // Thermal
      if (mod.thermalLoadW && server.thermalDesign !== 'nvme-optimized') {
        insights.push({
          severity: 'warning',
          category: 'Expansion',
          title: 'Thermal concern',
          message: `The NVMe expansion card adds ~${mod.thermalLoadW}W inside a chassis designed for ${server.thermalDesign} airflow. Expect throttling without additional cooling.`,
        });
      }

      // Why it was recommended
      if (mod.whyRecommended) {
        insights.push({
          severity: 'info',
          category: 'Expansion',
          title: 'Why expansion might help',
          message: mod.whyRecommended,
        });
      }

      // Cost comparison with new chassis
      const expansionTotalCost = (mod.priceUSD || 0) + (server.priceUSD || 0);
      const newChassisCost = 25000; // R7725xd baseline
      if (mod.priceUSD && expansionTotalCost < newChassisCost * 0.5) {
        insights.push({
          severity: 'info',
          category: 'Expansion',
          title: 'Cost advantage vs new chassis',
          message: `Expansion card: ~$${mod.priceUSD.toLocaleString()} into an existing server. Purpose-built NVMe chassis: roughly $${newChassisCost.toLocaleString()} before drives. Cheaper, but with hot-swap, lane, thermal, and support caveats.`,
        });
      }

      // Lane contention
      insights.push({
        severity: 'info',
        category: 'Expansion',
        title: 'PCIe lane budget impact',
        message: `The expansion card consumes a full x16 slot (16 lanes). Server has ${server.pcieSlotsRear.filter(s => !s.occupied).length} free slots remaining after install.`,
      });
    }
  }

  // Single-vendor concentration
  for (const [vendor, count] of Object.entries(stats.vendorConcentration)) {
    const pct = count / stats.driveCount;
    if (pct >= 0.8 && stats.driveCount >= 4) {
      insights.push({
        severity: 'suggestion',
        category: 'Concentration',
        title: `${vendor} concentration: ${(pct * 100).toFixed(0)}%`,
        message: `${(pct * 100).toFixed(0)}% of drives are from ${vendor}. That can simplify qualification, but it reduces substitution flexibility if you later change models.`,
      });
    }
  }

  // NAND vendor concentration
  for (const [vendor, count] of Object.entries(stats.nandVendorConcentration)) {
    const pct = count / stats.driveCount;
    if (pct >= 0.8 && stats.driveCount >= 4) {
      insights.push({
        severity: 'warning',
        category: 'Concentration',
        title: `NAND source: ${(pct * 100).toFixed(0)}% ${vendor}`,
        message: `Most drives rely on ${vendor} NAND. This is a concentration signal, not a live market-availability claim.`,
      });
    }
  }

  // Controller vendor concentration
  for (const [vendor, count] of Object.entries(stats.controllerVendorConcentration || {})) {
    const pct = count / stats.driveCount;
    if (pct >= 0.8 && stats.driveCount >= 4) {
      insights.push({
        severity: 'suggestion',
        category: 'Concentration',
        title: `Controller source: ${(pct * 100).toFixed(0)}% ${vendor}`,
        message: `Controller concentration is separate from NAND concentration. A firmware issue or qualification miss in ${vendor} controllers can affect most of the pool at once.`,
      });
    }
  }

  // === RAID INSIGHTS ===
  if (state.raidMode === 'RAID5' && stats.driveCount >= 8) {
    const maxTB = Math.max(...drives.map(d => d.capacityTB));
    if (maxTB >= 4) {
      insights.push({
        severity: 'warning',
        category: 'Data Protection',
        title: 'RAID5 rebuild risk with large drives',
        message: `RAID5 rebuild of ${maxTB}TB drives takes ~${stats.rebuildTimeHours.toFixed(0)} hours. During rebuild, another failure = total data loss. Array is vulnerable the entire time. RAID10 rebuild is faster and safer.`,
      });
    }
  }

  if (state.raidMode === 'RAID5') {
    insights.push({
      severity: 'suggestion',
        category: 'Data Protection',
      title: 'RAID5 write amplification',
      message: 'RAID5 has write amplification (every write requires reading + rewriting parity). Slower writes and harder expansion/rebalancing vs RAID10.',
    });
  }

  // === LEGACY SERVER FLAGS ===
  if (server.generation === 'legacy' && server.owned) {
    if (server.id === 'dell-t620-legacy') {
      insights.push({
        severity: 'warning',
        category: 'Server',
        title: 'Known backplane issues (amun3)',
        message: 'T620 backplane cannot identify which drive has failed. Drive replacement requires manual troubleshooting.',
      });
    }

    insights.push({
      severity: 'info',
      category: 'Server',
      title: 'Existing server — $0 chassis cost',
      message: `This server is already owned. Drive-only cost: $${(stats.totalCost - (server.priceUSD || 0)).toLocaleString()}. But it's locked into ${server.bays[0]?.interface || 'SATA'} by backplane hardware.`,
    });
  }

  // === STRATEGIC ===
  if (satadrives.length === drives.length && drives.length > 0 && workload?.id !== 'gi-bulk') {
    insights.push({
      severity: 'suggestion',
      category: 'Strategy',
      title: 'All-SATA config for non-bulk use case',
      message: 'With SATA-NVMe price parity at 4TB, consider NVMe for new performance-sensitive builds. Existing SATA servers can stay as-is for bulk storage.',
    });
  }

  // E3.S economics flag
  if (drives.some(d => d.formFactor === 'E3.S')) {
    insights.push({
      severity: 'info',
      category: 'Architecture',
      title: 'E3.S form factor premium',
      message: 'E3.S is ~12% more $/TB than U.2. Economics will improve once E3.S reaches volume parity, but today it\'s a premium form factor.',
    });
  }

  // Sort by severity (critical first)
  insights.sort((a, b) => (SEVERITY[b.severity] || 0) - (SEVERITY[a.severity] || 0));

  return insights;
}

// Generate workload fitness scores (green/yellow/red)
export function computeWorkloadFitness(stats, workload, drives) {
  if (!workload || !workload.requirements) return null;

  const reqs = workload.requirements;
  const fitness = {};

  // Capacity
  if (reqs.minUsableTB) {
    const ratio = stats.usableTB / reqs.minUsableTB;
    fitness.capacity = ratio >= 1.0 ? 'green' : ratio >= 0.7 ? 'yellow' : 'red';
    fitness.capacityDetail = `${stats.usableTB.toFixed(1)} / ${reqs.minUsableTB} TB`;
  }

  // Over-capacity check
  if (reqs.maxUsableTB && stats.usableTB > reqs.maxUsableTB * 1.5) {
    fitness.capacity = 'yellow';
    fitness.capacityDetail += ` (over-provisioned, max ${reqs.maxUsableTB} TB)`;
  }

  // Sequential write
  if (reqs.minSeqWriteGBs) {
    const steadyWrite = stats.realisticSustainedWriteGBs ?? stats.realisticWriteGBs;
    const ratio = steadyWrite / reqs.minSeqWriteGBs;
    fitness.seqWrite = ratio >= 1.0 ? 'green' : ratio >= 0.7 ? 'yellow' : 'red';
    fitness.seqWriteDetail = `${steadyWrite.toFixed(1)} / ${reqs.minSeqWriteGBs} GB/s sustained`;
  }

  // Random read IOPS
  if (reqs.minRandomReadIOPS && drives.length > 0) {
    const aggIOPS = stats.lowQueueReadIOPS || drives.reduce((s, d) => s + d.random4KReadIOPS, 0);
    const ratio = aggIOPS / reqs.minRandomReadIOPS;
    fitness.randomRead = ratio >= 1.0 ? 'green' : ratio >= 0.5 ? 'yellow' : 'red';
    fitness.randomReadDetail = `${(aggIOPS / 1000).toFixed(0)}K / ${(reqs.minRandomReadIOPS / 1000).toFixed(0)}K low-QD IOPS`;
  }

  // DWPD
  if (reqs.minDWPD && drives.length > 0) {
    const minDWPD = Math.min(...drives.map(d => d.dwpd || 0));
    const ratio = minDWPD / reqs.minDWPD;
    fitness.endurance = ratio >= 1.0 ? 'green' : ratio >= 0.5 ? 'yellow' : 'red';
    fitness.enduranceDetail = `${minDWPD} / ${reqs.minDWPD} DWPD`;
  }

  if (workload.modelAssumptions?.targetP99ReadMs && drives.length > 0) {
    const target = workload.modelAssumptions.targetP99ReadMs;
    const ratio = target / (stats.estimatedP99ReadMs || Infinity);
    fitness.latency = ratio >= 1.0 ? 'green' : ratio >= 0.5 ? 'yellow' : 'red';
    fitness.latencyDetail = `${(stats.estimatedP99ReadMs || 0).toFixed(1)} / ${target} ms estimated p99`;
  }

  return fitness;
}
