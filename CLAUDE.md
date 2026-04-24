# Project Instructions

## Python Environment

Always activate the virtual environment before installing packages or running scripts:

```bash
source .venv/bin/activate
```

## Dev Server

Run from project root:

```bash
source .venv/bin/activate && python3 -m http.server 8080
```

Then open http://localhost:8080

## Architecture

- `index.html` — single page entry point, Tailwind via CDN, 4-column layout
- `js/state.js` — reactive state + event bus + stat computation + bay builder
- `js/renderer.js` — Canvas 2D rack renderer (chassis + module sections)
- `js/ui.js` — DOM panels (server/workload/RAID selectors, drive palette, stats, fitness, insights)
- `js/insights.js` — reasoning engine: generates contextual tradeoff analysis
- `js/app.js` — glue: loads data, wires events, runs render loop
- `data/drives.json` — drive catalog (12 drives: consumer/flagship NVMe, Samsung enterprise U.2, budget SATA, industrial)
- `data/controllers.json` — SSD controller catalog (Phison, Samsung, Silicon Motion)
- `data/servers.json` — server catalog (legacy owned fleet + new Dell/Supermicro)
- `data/modules.json` — PCIe add-in cards (Apex X16 Gen5)
- `data/workloads.json` — workload profiles with requirements + anti-patterns

## Stack

Vanilla JS (ES modules), Canvas 2D, Tailwind CSS (CDN). No build step. No framework.

## Adding Data

- **Drive**: add entry to `data/drives.json` — auto-picked up
- **Server**: add to `data/servers.json` — set `owned: true` for existing fleet
- **Workload**: add to `data/workloads.json` — define requirements + anti-patterns
- NVMe PCIe backwards compatibility handled (Gen4 drives work in Gen5 bays)
