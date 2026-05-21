# SSD Rack Simulator

A browser-based planning tool for exploring SSD choices in real server chassis. Pick an owned or new server, choose workload and RAID assumptions, place compatible consumer SSDs into bays, and see capacity, cost, bandwidth, endurance, risk, and workload fit update live.

Live demo: [leannchen86.github.io/ssd-rack-sim](https://leannchen86.github.io/ssd-rack-sim/)

## Quick Start

Run from the project root:

```bash
source .venv/bin/activate
python3 -m http.server 8080
```

Open [http://localhost:8080](http://localhost:8080).

There is no build step for the app. It uses plain ES modules, Canvas 2D, and Tailwind from a CDN.

## What It Models

- Owned Dell fleet reuse vs new Dell/Supermicro purchase options
- SATA and NVMe bay compatibility, including PCIe generation fallback
- RAID0, RAID1, RAID5, RAID10, and JBOD capacity/performance tradeoffs
- Optional M.2 NVMe PCIe expansion cards when a server has a free x16 slot
- Workload fit for archive, search/web serving, low-latency app data, and AI scratch use cases
- Cost, power/cooling, rebuild exposure, supply risk, controller/NAND/vendor concentration, and bottlenecks
- Auto-fill strategies for quickly comparing value, capacity, write speed, random read, endurance, or specific drives

The simulator is meant for planning and comparison, not final procurement or benchmarking. Retail prices are snapshots from the catalog data and may drift quickly.

## Development

Most changes are data or vanilla JavaScript edits:

- App shell: `index.html`
- State and calculations: `js/state.js`
- Canvas rack rendering: `js/renderer.js`
- DOM controls and panels: `js/ui.js`
- Tradeoff analysis: `js/insights.js`
- Catalog data: `data/*.json`

If you add or update SSDs, servers, workloads, or expansion modules, edit the matching JSON file and reload the page.

## License

ISC, per `package.json`.
