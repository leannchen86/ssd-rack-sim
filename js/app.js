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
  const res = await fetch(path, { cache: 'no-store' });
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

  function bayAtClientPoint(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const inside =
      clientX >= rect.left && clientX <= rect.right &&
      clientY >= rect.top && clientY <= rect.bottom;
    if (!inside) return -1;
    return renderer.hitTest(clientX - rect.left, clientY - rect.top);
  }

  function placeDriveInBay(drive, bayIndex) {
    if (!drive || bayIndex < 0 || !state.bays[bayIndex]) return false;
    const bay = state.bays[bayIndex];
    if (bay.formFactor !== drive.formFactor || !interfaceCompatible(drive.interface, bay.interface)) {
      return false;
    }

    bay.drive = drive;
    state.selectedBay = bayIndex;
    state.hoveredBay = bayIndex;
    state.dragDrive = null;
    EventBus.emit('bay:update');
    return true;
  }

  // === Canvas interaction ===
  canvas.addEventListener('mousemove', (e) => {
    const bay = bayAtClientPoint(e.clientX, e.clientY);
    if (bay !== state.hoveredBay) state.hoveredBay = bay;
    canvas.style.cursor = bay >= 0 ? 'pointer' : 'default';
  });

  canvas.addEventListener('mouseleave', () => {
    state.hoveredBay = -1;
    canvas.style.cursor = 'default';
  });

  canvas.addEventListener('click', (e) => {
    const bay = bayAtClientPoint(e.clientX, e.clientY);
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
    const bay = bayAtClientPoint(e.clientX, e.clientY);
    if (bay >= 0 && state.bays[bay]?.drive) {
      state.bays[bay].drive = null;
      EventBus.emit('bay:update');
      ui.showDriveInfo(null);
    }
  });

  canvas.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    state.hoveredBay = bayAtClientPoint(e.clientX, e.clientY);
  });

  canvas.addEventListener('drop', (e) => {
    e.preventDefault();
    const driveId =
      e.dataTransfer?.getData('application/x-drive-id') ||
      e.dataTransfer?.getData('text/plain') ||
      '';
    const drive = drives.find(d => d.id === driveId) || state.dragDrive;
    placeDriveInBay(drive, bayAtClientPoint(e.clientX, e.clientY));
  });

  canvas.addEventListener('dragleave', () => { state.hoveredBay = -1; });

  document.addEventListener('mousemove', (e) => {
    if (!state.dragDrive || !state.dragStart) return;
    const distance = Math.hypot(e.clientX - state.dragStart.x, e.clientY - state.dragStart.y);
    if (distance > 6) state.paletteDragging = true;
    if (state.paletteDragging) state.hoveredBay = bayAtClientPoint(e.clientX, e.clientY);
  });

  document.addEventListener('mouseup', (e) => {
    if (!state.dragDrive || !state.dragStart) return;
    const distance = Math.hypot(e.clientX - state.dragStart.x, e.clientY - state.dragStart.y);
    const shouldPlace = state.paletteDragging || distance > 6;
    if (shouldPlace) placeDriveInBay(state.dragDrive, bayAtClientPoint(e.clientX, e.clientY));
    state.dragDrive = null;
    state.dragStart = null;
    state.paletteDragging = false;
  });

  document.addEventListener('dragend', (e) => {
    if (state.dragDrive) {
      placeDriveInBay(state.dragDrive, bayAtClientPoint(e.clientX, e.clientY));
    }
    state.dragDrive = null;
    state.dragStart = null;
    state.paletteDragging = false;
    state.hoveredBay = -1;
  }, true);

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
