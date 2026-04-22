// app.js — Main entry point
// Loads data, wires state/renderer/UI/insights, runs render loop
import { createState, computeStats, EventBus } from './state.js';
import { RackRenderer } from './renderer.js';
import { UI } from './ui.js';
import { generateInsights, computeWorkloadFitness } from './insights.js';

function interfaceCompatible(driveIf, bayIf) {
  if (driveIf === bayIf) return true;
  if (driveIf === 'NVMe PCIe 4' && bayIf === 'NVMe PCIe 5') return true;
  if (driveIf === 'NVMe PCIe 3' && (bayIf === 'NVMe PCIe 4' || bayIf === 'NVMe PCIe 5')) return true;
  return false;
}

async function loadJSON(path) {
  const res = await fetch(path);
  return res.json();
}

async function main() {
  const [drives, serverCatalog, moduleCatalog, workloadCatalog] = await Promise.all([
    loadJSON('./data/drives.json'),
    loadJSON('./data/servers.json'),
    loadJSON('./data/modules.json'),
    loadJSON('./data/workloads.json'),
  ]);

  const state = createState();
  state.drives = drives;
  state.serverCatalog = serverCatalog;
  state.moduleCatalog = moduleCatalog;
  state.workloadCatalog = workloadCatalog;

  const canvas = document.getElementById('rack-canvas');
  const renderer = new RackRenderer(canvas);

  const ui = new UI(state, computeStats, generateInsights, computeWorkloadFitness);

  // === Canvas interaction ===
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const bay = renderer.hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (bay !== state.hoveredBay) state.hoveredBay = bay;
    canvas.style.cursor = bay >= 0 ? 'pointer' : 'default';
  });

  canvas.addEventListener('mouseleave', () => {
    state.hoveredBay = -1;
    canvas.style.cursor = 'default';
  });

  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const bay = renderer.hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (bay >= 0) {
      state.selectedBay = bay;
      ui.showDriveInfo(state.bays[bay]?.drive || null);
    } else {
      state.selectedBay = -1;
      ui.showDriveInfo(null);
    }
    EventBus.emit('bay:select');
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const bay = renderer.hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (bay >= 0 && state.bays[bay]?.drive) {
      state.bays[bay].drive = null;
      EventBus.emit('bay:update');
      ui.showDriveInfo(null);
    }
  });

  canvas.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const rect = canvas.getBoundingClientRect();
    state.hoveredBay = renderer.hitTest(e.clientX - rect.left, e.clientY - rect.top);
  });

  canvas.addEventListener('drop', (e) => {
    e.preventDefault();
    const driveId = e.dataTransfer.getData('text/plain');
    const drive = drives.find(d => d.id === driveId);
    const bay = state.hoveredBay;
    if (drive && bay >= 0 && state.bays[bay]) {
      const b = state.bays[bay];
      // Only drop if compatible
      if (b.formFactor === drive.formFactor && interfaceCompatible(drive.interface, b.interface)) {
        b.drive = drive;
        state.dragDrive = null;
        EventBus.emit('bay:update');
      }
    }
  });

  canvas.addEventListener('dragleave', () => { state.hoveredBay = -1; });

  // === Render loop ===
  function frame() {
    const stats = computeStats(state);
    renderer.render(state, stats);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  ui.refresh();
}

main().catch(console.error);
