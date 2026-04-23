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
        category: 'Workload Fit',
        title: 'Insufficient capacity',
        message: `${workload.name} needs ≥${reqs.minUsableTB} TB usable. You have ${stats.usableTB.toFixed(1)} TB.`,
        metric: 'capacity'
      });
    }

    if (reqs.maxUsableTB && stats.usableTB > reqs.maxUsableTB * 1.5) {
      insights.push({
        severity: 'warning',
        category: 'Workload Fit',
        title: 'Over-provisioned capacity',
        message: `${workload.name} needs ${reqs.minUsableTB || 0}–${reqs.maxUsableTB} TB. You have ${stats.usableTB.toFixed(1)} TB — money wasted on unneeded capacity.`,
        metric: 'capacity'
      });
    }

    if (reqs.minRandomReadIOPS) {
      const aggIOPS = drives.reduce((s, d) => s + d.random4KReadIOPS, 0);
      if (aggIOPS < reqs.minRandomReadIOPS) {
        insights.push({
          severity: 'critical',
          category: 'Workload Fit',
          title: 'Random read IOPS too low',
          message: `${workload.name} needs ≥${(reqs.minRandomReadIOPS / 1000).toFixed(0)}K random read IOPS. Your config delivers ${(aggIOPS / 1000).toFixed(0)}K.`,
          metric: 'iops'
        });
      }
    }

    if (reqs.minSeqWriteGBs && stats.realisticWriteGBs < reqs.minSeqWriteGBs) {
      insights.push({
        severity: 'warning',
        category: 'Workload Fit',
        title: 'Sequential write bandwidth low',
        message: `${workload.name} wants ≥${reqs.minSeqWriteGBs} GB/s write. Realistic: ${stats.realisticWriteGBs.toFixed(1)} GB/s.`,
        metric: 'write-bw'
      });
    }

    if (reqs.minDWPD) {
      const minDriveDWPD = Math.min(...drives.map(d => d.dwpd || 0));
      if (minDriveDWPD < reqs.minDWPD) {
        insights.push({
          severity: reqs.minDWPD >= 10 ? 'critical' : 'warning',
          category: 'Workload Fit',
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
            triggered = true; // We don't model GPUs yet — always flag for aiDAPTIV+
            break;
        }
        if (triggered) {
          insights.push({
            severity: 'warning',
            category: 'Workload Anti-pattern',
            title: ap.condition.replace(/([A-Z])/g, ' $1').trim(),
            message: ap.message,
          });
        }
      }
    }
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

  // === MODULE (AIC) INSIGHTS ===
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
            category: 'AIC Retrofit',
            title: `PCIe Gen${hostGen} bottleneck`,
            message: `${mod.name} is rated for Gen${mod.requires.optimalPcieGen} but this server has Gen${hostGen} slots. ${perf.note}`,
          });
        }
      }

      // No hot-swap
      if (mod.provides && !mod.provides.hotSwap) {
        insights.push({
          severity: 'warning',
          category: 'AIC Retrofit',
          title: 'No hot-swap on AIC drives',
          message: `${mod.name}: 16 drives on one card = server downtime on any drive failure. Breaks the "walk to datacenter and pull a failed drive" model. RAID10 mitigates data loss but not downtime.`,
        });
      }

      // Thermal
      if (mod.thermalLoadW && server.thermalDesign !== 'nvme-optimized') {
        insights.push({
          severity: 'warning',
          category: 'AIC Retrofit',
          title: 'Thermal concern',
          message: `${mod.name} dumps ~${mod.thermalLoadW}W into a chassis designed for ${server.thermalDesign} airflow. Expect throttling without additional cooling.`,
        });
      }

      // Why it was recommended
      if (mod.whyRecommended) {
        insights.push({
          severity: 'info',
          category: 'AIC Retrofit',
          title: 'Why this was recommended',
          message: mod.whyRecommended,
        });
      }

      // Cost comparison with new chassis
      const aicTotalCost = (mod.priceUSD || 0) + (server.priceUSD || 0);
      const newChassisCost = 25000; // R7725xd baseline
      if (mod.priceUSD && aicTotalCost < newChassisCost * 0.5) {
        insights.push({
          severity: 'info',
          category: 'AIC Retrofit',
          title: 'Cost advantage vs new chassis',
          message: `AIC retrofit: ~$${mod.priceUSD.toLocaleString()} into existing server. New R7725xd: ~$${newChassisCost.toLocaleString()}. Saves $${(newChassisCost - mod.priceUSD).toLocaleString()} but with caveats (no hot-swap, lane limits, thermal).`,
        });
      }

      // Lane contention
      insights.push({
        severity: 'info',
        category: 'AIC Retrofit',
        title: 'PCIe lane budget impact',
        message: `${mod.name} consumes a full x16 slot (16 lanes). Server has ${server.pcieSlotsRear.filter(s => !s.occupied).length} free slots remaining after install.`,
      });
    }
  }

  // === SUPPLY CHAIN ===
  // Worst-case: any high-risk drive compromises the whole array
  if (stats.highRiskCount > 0) {
    insights.push({
      severity: 'warning',
      category: 'Supply Chain',
      title: `${stats.highRiskCount} high-risk drive${stats.highRiskCount > 1 ? 's' : ''} in config`,
      message: `Worst-case supply risk score: ${stats.supplyRiskScore.toFixed(0)}/100. Failure of any of these ${stats.highRiskCount} drive${stats.highRiskCount > 1 ? 's' : ''} may be hard to replace with the same SKU — plan for substitution or spares on hand.`,
    });
  } else if (stats.supplyRiskScore >= 40) {
    insights.push({
      severity: 'suggestion',
      category: 'Supply Chain',
      title: 'Medium supply risk drives present',
      message: `Worst-case supply risk score: ${stats.supplyRiskScore.toFixed(0)}/100. Some drives have constrained supply. Consider keeping spares.`,
    });
  }

  // Single-vendor concentration
  for (const [vendor, count] of Object.entries(stats.vendorConcentration)) {
    const pct = count / stats.driveCount;
    if (pct >= 0.8 && stats.driveCount >= 4) {
      insights.push({
        severity: 'suggestion',
        category: 'Supply Chain',
        title: `${vendor} concentration: ${(pct * 100).toFixed(0)}%`,
        message: `${(pct * 100).toFixed(0)}% of drives from ${vendor}. If ${vendor} has supply issues, you have no fallback. Consider diversifying.`,
      });
    }
  }

  // NAND vendor concentration
  for (const [vendor, count] of Object.entries(stats.nandVendorConcentration)) {
    const pct = count / stats.driveCount;
    if (pct >= 0.8 && stats.driveCount >= 4) {
      const note = vendor === 'Kioxia' ? ' Kioxia 2026 production already sold out.' :
                   vendor === 'Micron' ? ' Micron is exiting consumer market.' :
                   vendor === 'Samsung' ? ' Samsung allocating 90% of capex to HBM, not NAND.' : '';
      insights.push({
        severity: 'warning',
        category: 'Supply Chain',
        title: `NAND source: ${(pct * 100).toFixed(0)}% ${vendor}`,
        message: `All NAND from one fab.${note} A single-fab disruption takes down your entire resupply pipeline.`,
      });
    }
  }

  // === RAID INSIGHTS ===
  if (state.raidMode === 'RAID5' && stats.driveCount >= 8) {
    const maxTB = Math.max(...drives.map(d => d.capacityTB));
    if (maxTB >= 4) {
      insights.push({
        severity: 'warning',
        category: 'RAID',
        title: 'RAID5 rebuild risk with large drives',
        message: `RAID5 rebuild of ${maxTB}TB drives takes ~${stats.rebuildTimeHours.toFixed(0)} hours. During rebuild, another failure = total data loss. Array is vulnerable the entire time. RAID10 rebuild is faster and safer.`,
      });
    }
  }

  if (state.raidMode === 'RAID5') {
    insights.push({
      severity: 'suggestion',
      category: 'RAID',
      title: 'RAID5 write amplification',
      message: 'RAID5 has write amplification (every write requires reading + rewriting parity). Slower writes and harder expansion/rebalancing vs RAID10. Diffbot trending toward RAID10 for newer builds.',
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
      title: 'All-SATA config for non-bulk workload',
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
    const ratio = stats.realisticWriteGBs / reqs.minSeqWriteGBs;
    fitness.seqWrite = ratio >= 1.0 ? 'green' : ratio >= 0.7 ? 'yellow' : 'red';
    fitness.seqWriteDetail = `${stats.realisticWriteGBs.toFixed(1)} / ${reqs.minSeqWriteGBs} GB/s`;
  }

  // Random read IOPS
  if (reqs.minRandomReadIOPS && drives.length > 0) {
    const aggIOPS = drives.reduce((s, d) => s + d.random4KReadIOPS, 0);
    const ratio = aggIOPS / reqs.minRandomReadIOPS;
    fitness.randomRead = ratio >= 1.0 ? 'green' : ratio >= 0.5 ? 'yellow' : 'red';
    fitness.randomReadDetail = `${(aggIOPS / 1000).toFixed(0)}K / ${(reqs.minRandomReadIOPS / 1000).toFixed(0)}K IOPS`;
  }

  // DWPD
  if (reqs.minDWPD && drives.length > 0) {
    const minDWPD = Math.min(...drives.map(d => d.dwpd || 0));
    const ratio = minDWPD / reqs.minDWPD;
    fitness.endurance = ratio >= 1.0 ? 'green' : ratio >= 0.5 ? 'yellow' : 'red';
    fitness.enduranceDetail = `${minDWPD} / ${reqs.minDWPD} DWPD`;
  }

  return fitness;
}
