# SSD Rack Simulator

Interactive single-page web app for visualizing SSD procurement decisions in data center environments. Drag drives into server bays, select use-case presets, and see real-time cost, performance, and supply chain analysis.

Built to help infrastructure engineers understand the tradeoffs between SATA vs NVMe, TLC vs QLC, retail sourcing risk, and legacy fleet vs new hardware — without spreadsheets.

**🔗 Live demo: [leannchen86.github.io/ssd-rack-sim](https://leannchen86.github.io/ssd-rack-sim/)**

## Quick Start

Run locally from the project root:

```bash
python3 -m http.server 8080
```

Open [http://localhost:8080](http://localhost:8080). No build step, no dependencies to install.

## What It Does

**Pick a server** from the catalog (Dell PowerEdge, Supermicro) — including legacy owned fleet and new purchase options with different bay configurations.

**Drag SSDs into bays** from the drive palette. The simulator enforces form factor and interface compatibility (2.5" SATA, M.2 NVMe, U.2, E3.S) with PCIe backwards compatibility (Gen4 drives work in Gen5 bays).

**Select a use case** (bulk storage, search/web serving, database/app data, AI training scratch) and the fitness panel shows green/yellow/red for each metric against that preset's requirements.

**See live stats** as you configure:
- Raw and usable capacity (RAID-adjusted)
- Aggregate read, burst write, and estimated sustained post-cache write bandwidth
- Realistic throughput with RAID write penalties (RAID5 = 4x write amplification, RAID10 = 2x)
- RAID rebuild time plus approximate degraded-window second-failure exposure
- Cost breakdown: drives + chassis + expansion modules, $/TB, amortized $/TB/year
- Power consumption, estimated power/cooling cost, bottleneck path, supply risk scoring, vendor/controller/NAND concentration
- Use-case-driven wear lifespan and heuristic p99 read latency class

**Read contextual insights** — the reasoning engine generates tradeoff analysis based on your configuration: use-case anti-patterns, SATA-to-NVMe migration advice, expansion-card economics, supply chain warnings, and data-protection recommendations.

## Data Catalog

| Category | Count | Details |
|----------|-------|---------|
| Drives | 19 | Consumer retail SSDs only: SATA, Gen4 M.2, and Gen5 M.2 options sourced from Amazon/eBay-style channels |
| Servers | 10 | Dell T620/T630/R740xd/R750xd (owned), R7725 (5 bay configs), R7725xd, Supermicro ASG/SSG |
| Use cases | 4 | Bulk Storage / Archive, Search / Web Serving, Database / Low-Latency App, AI Training Scratch |
| Controllers | 11 | Phison S11 through X2, Samsung MKX/Pascal, Silicon Motion SM2259 |
| Expansion modules | 1 | Generic 16x M.2 NVMe PCIe card with PCIe-gen-aware bandwidth caps |

### Pricing Integrity

All drive prices include a `priceSource` field documenting where the price came from. The active drive palette is limited to consumer drives with non-zero retail pricing. Current sourcing:

- **Retail marketplaces** — Amazon, eBay, Newegg, Best Buy, B&H, and public price trackers as of May 2026
- **Excluded** — enterprise, industrial, specialized AI, and unpriced drives

## Architecture

```
index.html          Single page, Tailwind CSS (CDN), 4-column layout
js/
  state.js          Proxy-based reactive state, EventBus pub/sub, stat computation
  renderer.js       Canvas 2D rack renderer (60fps rAF), chassis + module sections
  ui.js             DOM panels: selectors, drive palette, stats, fitness, insights
  insights.js       Reasoning engine: use-case fit, anti-patterns, tradeoff analysis
  app.js            Glue: loads JSON data, wires events, runs render loop
data/
  drives.json       Drive catalog (consumer retail SSDs with full specs)
  servers.json      Server catalog (bay configs, PCIe lanes, bandwidth limits)
  controllers.json  SSD controller specs (Phison, Samsung, Silicon Motion)
  modules.json      PCIe expansion cards
  workloads.json    Use-case profiles (requirements, priorities, anti-patterns)
```

**Stack**: Vanilla JS (ES modules), Canvas 2D, Tailwind CSS via CDN. No framework. No build step. No node_modules.

### Key Design Decisions

- **Canvas for rack visualization** — 60fps render loop draws drive bays with hit testing for mouse interaction. DOM updates only fire on state changes via EventBus.
- **Proxy-based reactivity** — `state.raidMode = 'RAID5'` auto-emits `state:raidMode` event. Nested mutations (bay assignments) require manual `EventBus.emit('bay:update')`.
- **SATA bandwidth model** — Each drive gets a dedicated 600 MB/s SATA link (not a shared bus), total capped by HBA controller throughput. This matches real hardware behavior.
- **RAID write penalties** — Applied multiplicatively: RAID5 effective write = 25% of raw, RAID10 = 50%. Rebuild times vary by mode (RAID10: 200 MB/s mirror-pair, RAID5: 60 MB/s degrading with array size).
- **Realism approximations** — Consumer SSDs are adjusted for post-SLC-cache sustained writes, low-queue-depth IOPS, heuristic p99 read latency, TBW burn-down from use-case writes/day, server/network bottlenecks, background thermal pressure, energy cost with PUE, and simple AFR-based rebuild exposure. These are planning signals, not benchmark replacements.

## Adding Data

**Drive**: Add an entry to `data/drives.json` — auto-picked up by the app. Required fields: `id`, `name`, `vendor`, `capacityTB`, `interface`, `formFactor`, `priceUSD`, `priceSource`, `seqReadMBs`, `seqWriteMBs`, `random4KReadIOPS`, `random4KWriteIOPS`, `nandType`, `controller`, `controllerVendor`, `tbw`, `dwpd`, `powerW`, `supplyRisk`, `category`, `color`. Drives only appear in the active palette when `category` is `consumer` and `priceUSD` is greater than 0.

**Server**: Add to `data/servers.json`. Set `owned: true` and `priceUSD: 0` for existing fleet. Define `bays` array with `count`, `formFactor`, `interface`, `perDriveMaxMBs` (600 for SATA). Set `maxBandwidthGBs` for controller cap.

**Use case**: Add to `data/workloads.json`. Define `requirements` (min capacity, IOPS, DWPD), `modelAssumptions` (write TB/day, write amplification, network Gbps, target p99 latency, typical queue depth), `priorities` per metric, and `antiPatterns` array for the insights engine.

## Known Limitations

These are documented critique points from accuracy audits. The simulator is a pedagogical tool, not a procurement engine — some behaviors are simplified or still being improved.

**Still to fix:**
- Thermal behavior is still heuristic and profile-based, not a vendor fan-curve or CFD model
- PCIe lane budget not enforced (expansion cards + NVMe bays can oversubscribe host lanes)
- No hot/cold data tiering support (can't express "100TB QLC cold + 4TB TLC hot" architectures)
- AI training scratch DWPD threshold is a planning default; sustained training pipelines may require a stricter endurance target
- Retail SSD pricing moves quickly, especially on marketplace listings; use `priceSource` as a snapshot, not a live quote

**Already addressed:**
- ✓ RAID write penalty applied to bandwidth calculations (RAID5 = 25%, RAID10 = 50%)
- ✓ SATA bandwidth modeled as per-drive dedicated links capped by HBA controller (not shared bus)
- ✓ Burst vs sustained write estimates model consumer SLC-cache cliffs
- ✓ Low-queue-depth IOPS and latency-class estimates make websearch less throughput-only
- ✓ Use-case write rate estimates TBW lifespan over time
- ✓ Bottleneck path compares SSD pool speed, server bus/HBA limits, and modeled network exposure
- ✓ Power/cooling cost included in annualized TCO signal
- ✓ Thermal pressure is modeled in the background and only surfaces when a build is likely to throttle
- ✓ Rebuild time varies by RAID mode (RAID10 mirror-pair vs RAID5 whole-array degradation)
- ✓ Rebuild exposure includes approximate second-failure and read-error risk signals
- ✓ Supply risk uses worst-case across the array (not averaged)
- ✓ TCO amortization split: drives 3.5yr, chassis/expansion 5yr
- ✓ NVMe price parity computed from catalog (not hardcoded)
- ✓ Active palette excludes unpriced, enterprise, industrial, and specialized drives

## License

MIT
