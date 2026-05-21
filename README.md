# SSD Rack Simulator

A browser-only planning tool for exploring SSD choices in real server chassis. Pick an owned or new server, choose a workload, place compatible consumer SSDs into bays, and see capacity, cost, bandwidth, endurance, risk, and workload fit update live.

Live demo: [leannchen86.github.io/ssd-rack-sim](https://leannchen86.github.io/ssd-rack-sim/)

## Quick Start

Run from the project root:

```bash
source .venv/bin/activate
python3 -m http.server 8080
```

Open [http://localhost:8080](http://localhost:8080).

The main app has no build step. Tailwind is loaded from a CDN, and the JavaScript is plain ES modules.

## What You Can Model

- Owned Dell fleet reuse vs new Dell/Supermicro purchase options that match the consumer-retail drive catalog
- Server bay configs, form factors, SATA/NVMe compatibility, PCIe generation fallback, and 2.5" SATA drives in 3.5" bays via tray/carrier
- Background protection math for usable capacity and write penalties
- Optional 16-slot M.2 NVMe PCIe expansion card when a server has a free x16 slot
- Workload profiles for archive, search/web serving, low-latency app data, and AI scratch
- Bottleneck path, power/cooling cost, rebuild exposure, and supply concentration
- Auto-fill strategies: workload fit, lowest $/TB, largest drive, sustained write, random read, endurance, or a specific model

The results are planning signals, not benchmark results or live procurement quotes. Retail prices are snapshots from the `priceSource` fields in the drive catalog.

## Main Screens

- `index.html`: the primary rack simulator with a left control panel, center canvas rack view, live stat strip, and right-side tradeoff analysis.
- `lego.html`: a playful brick-style chassis sandbox that uses the same drive/server/module data and is covered by Playwright tests.

## Catalog Snapshot

| Data file | Contents |
| --- | --- |
| `data/drives.json` | 19 consumer SSDs: SATA, Gen4 M.2, and Gen5 M.2 |
| `data/servers.json` | 10 server records; the default selector hides U.2/E3.S-only options until an enterprise drive catalog is enabled |
| `data/workloads.json` | 4 workload profiles with requirements, assumptions, priorities, and anti-patterns |
| `data/controllers.json` | 11 SSD controller reference entries |
| `data/modules.json` | 1 PCIe add-in card module |
| `data/chassis.json` | 5 reference chassis templates |

## Repo Map

```text
index.html          Main simulator shell and layout styles
lego.html           Brick-style chassis sandbox
js/app.js           Loads JSON, wires UI/state/renderer, starts render loop
js/state.js         Reactive state, event bus, bay builder, stat computation
js/renderer.js      Canvas 2D chassis and drive-bay renderer
js/ui.js            DOM controls, drive palette, stats, fitness, insights panels
js/insights.js      Tradeoff and workload-fit reasoning engine
data/*.json         Drive, server, controller, module, workload, and chassis data
tests/lego.spec.js  Playwright coverage for the Lego sandbox
```

## Running Tests

Playwright is only needed for tests:

```bash
source .venv/bin/activate
npm install
npm test
```

`npm test` runs the `lego.html` tests and starts or reuses a local server on port `8080`.

## Adding Data

Add drives in `data/drives.json`. The active palette shows drives where `category` is `consumer` and `priceUSD` is greater than `0`. Include specs for capacity, interface, form factor, pricing source, performance, NAND/controller, endurance, power, supply risk, and display color.

Add servers in `data/servers.json`. Use `owned: true` and `priceUSD: 0` for existing fleet hardware. Define `bays` or `bayConfigs`, PCIe slots, bandwidth caps, network assumptions, power, and thermal design.

Add workloads in `data/workloads.json`. Define `requirements`, `modelAssumptions`, `priorities`, and `antiPatterns`; the fitness panel and insights engine use these fields directly.

Add expansion cards in `data/modules.json`. The UI currently models one add-in card at a time and expects a free rear x16 slot.

## Modeling Caveats

- Thermal, p99 latency, AFR, rebuild exposure, and post-cache sustained writes are heuristics.
- PCIe expansion checks slot availability, but lane sharing is still simplified.
- There is no hot/cold tiering model or live marketplace price refresh.
- Consumer SSD replacement risk is intentionally surfaced because marketplace supply can move quickly.

## License

ISC, per `package.json`.
