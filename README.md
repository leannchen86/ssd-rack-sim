# SSD Rack Simulator

Interactive single-page web app for visualizing SSD procurement decisions in data center environments. Drag drives into server bays, select workload profiles, and see real-time cost, performance, and supply chain analysis.

Built to help infrastructure engineers understand the tradeoffs between SATA vs NVMe, consumer vs enterprise, QLC vs TLC, and legacy fleet vs new hardware — without spreadsheets.

## Quick Start

```bash
python3 -m http.server 8080
```

Open [http://localhost:8080](http://localhost:8080). No build step, no dependencies to install.

## What It Does

**Pick a server** from the catalog (Dell PowerEdge, Supermicro) — including legacy owned fleet and new purchase options with different bay configurations.

**Drag SSDs into bays** from the drive palette. The simulator enforces form factor and interface compatibility (2.5" SATA, M.2 NVMe, U.2, E3.S) with PCIe backwards compatibility (Gen4 drives work in Gen5 bays).

**Select a workload profile** (bulk storage, websearch, knowledge graph, LLM fine-tuning) and the fitness panel shows green/yellow/red for each metric against that workload's requirements.

**See live stats** as you configure:
- Raw and usable capacity (RAID-adjusted)
- Aggregate sequential read/write bandwidth (per-drive SATA link modeling, HBA controller caps)
- Realistic throughput with RAID write penalties (RAID5 = 4x write amplification, RAID10 = 2x)
- RAID rebuild time estimates (RAID10 mirror-pair rebuild vs RAID5 whole-array degradation)
- Cost breakdown: drives + chassis + AIC modules, $/TB, amortized $/TB/year
- Power consumption, supply risk scoring, vendor concentration

**Read contextual insights** — the reasoning engine generates tradeoff analysis based on your configuration: workload anti-patterns, SATA-to-NVMe migration advice, AIC retrofit economics, supply chain warnings, and RAID recommendations.

## Data Catalog

| Category | Count | Details |
|----------|-------|---------|
| Drives | 25 | 20 with Phison controllers. Pascari SA50/SA53P enterprise SATA, consumer/flagship NVMe (E28, E31T), Samsung, aiDAPTIV+ AI SLC |
| Servers | 10 | Dell T620/T630/R740xd/R750xd (owned), R7725 (5 bay configs), R7725xd, Supermicro ASG/SSG |
| Workloads | 4 | GI Bulk, Websearch, KG/Couchbase, LLM Fine-tuning |
| Controllers | 11 | Phison S11 through X2, Samsung MKX/Pascal, Silicon Motion SM2259 |
| AIC Modules | 1 | Apex X16 Gen5 (16x M.2, PCIe gen-aware bandwidth caps) |

### Pricing Integrity

All drive prices include a `priceSource` field documenting where the price came from. Drives without verified pricing show **"Price TBD"** in the UI rather than estimates. Current sourcing:

- **Phison sales quotes** — Pascari SA53P series (April 2026)
- **Distributor listings** — Pascari SA50 series (esaitech/DNL Trading 2025)
- **Official retail** — Samsung, Corsair, Crucial, Kingston (retailer prices as of early 2026)
- **TBD** — Enterprise NVMe (X201/D201/D205V), industrial, and specialized drives with no public pricing

## Architecture

```
index.html          Single page, Tailwind CSS (CDN), 4-column layout
js/
  state.js          Proxy-based reactive state, EventBus pub/sub, stat computation
  renderer.js       Canvas 2D rack renderer (60fps rAF), chassis + module sections
  ui.js             DOM panels: selectors, drive palette, stats, fitness, insights
  insights.js       Reasoning engine: workload fit, anti-patterns, tradeoff analysis
  app.js            Glue: loads JSON data, wires events, runs render loop
data/
  drives.json       Drive catalog (25 SSDs with full specs)
  servers.json      Server catalog (bay configs, PCIe lanes, bandwidth limits)
  controllers.json  SSD controller specs (Phison, Samsung, Silicon Motion)
  modules.json      PCIe add-in cards (Apex X16 Gen5)
  workloads.json    Workload profiles (requirements, priorities, anti-patterns)
```

**Stack**: Vanilla JS (ES modules), Canvas 2D, Tailwind CSS via CDN. No framework. No build step. No node_modules.

### Key Design Decisions

- **Canvas for rack visualization** — 60fps render loop draws drive bays with hit testing for mouse interaction. DOM updates only fire on state changes via EventBus.
- **Proxy-based reactivity** — `state.raidMode = 'RAID5'` auto-emits `state:raidMode` event. Nested mutations (bay assignments) require manual `EventBus.emit('bay:update')`.
- **SATA bandwidth model** — Each drive gets a dedicated 600 MB/s SATA link (not a shared bus), total capped by HBA controller throughput. This matches real hardware behavior.
- **RAID write penalties** — Applied multiplicatively: RAID5 effective write = 25% of raw, RAID10 = 50%. Rebuild times vary by mode (RAID10: 200 MB/s mirror-pair, RAID5: 60 MB/s degrading with array size).

## Adding Data

**Drive**: Add an entry to `data/drives.json` — auto-picked up by the app. Required fields: `id`, `name`, `vendor`, `capacityTB`, `interface`, `formFactor`, `priceUSD` (use `0` if unknown), `priceSource`, `seqReadMBs`, `seqWriteMBs`, `random4KReadIOPS`, `random4KWriteIOPS`, `nandType`, `controller`, `controllerVendor`, `tbw`, `dwpd`, `powerW`, `supplyRisk`, `category`, `color`.

**Server**: Add to `data/servers.json`. Set `owned: true` and `priceUSD: 0` for existing fleet. Define `bays` array with `count`, `formFactor`, `interface`, `perDriveMaxMBs` (600 for SATA). Set `maxBandwidthGBs` for controller cap.

**Workload**: Add to `data/workloads.json`. Define `requirements` (min capacity, IOPS, DWPD), `priorities` per metric, and `antiPatterns` array for the insights engine.

## Known Limitations

These are documented critique points from accuracy audits:

- No SLC cache exhaustion or thermal throttle modeling — drives show peak specs only
- PCIe lane budget not enforced (AIC + NVMe bays can oversubscribe lanes)
- Supply risk uses averaging instead of worst-case across the array
- TCO amortization is flat 5-year (should be 3.5yr for drives, 5yr for chassis)
- No hot/cold data tiering support
- Some drives in the catalog may have inaccurate specs (e.g., Inland QN446 4TB Gen5 variant may not exist as described)

## License

MIT
