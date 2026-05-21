// app.js — Main entry point
// Loads data, wires state/renderer/UI/insights, runs render loop
import { createState, computeStats, EventBus } from './state.js?v=35';
import { RackRenderer } from './renderer.js?v=35';
import { UI } from './ui.js?v=35';
import { generateInsights, computeWorkloadFitness } from './insights.js?v=35';

function interfaceCompatible(driveIf, bayIf) {
  if (driveIf === bayIf) return true;
  if (driveIf === 'NVMe PCIe 4' && bayIf === 'NVMe PCIe 5') return true;
  if (driveIf === 'NVMe PCIe 3' && (bayIf === 'NVMe PCIe 4' || bayIf === 'NVMe PCIe 5')) return true;
  return false;
}

function formFactorCompatible(drive, bay) {
  if (drive.formFactor === bay.formFactor) return true;
  return drive.formFactor === '2.5"' && bay.formFactor === '3.5"' && drive.interface === 'SATA III' && bay.interface === 'SATA III';
}

function driveCompatibleWithBay(drive, bay) {
  return formFactorCompatible(drive, bay) && interfaceCompatible(drive.interface, bay.interface);
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
  let lastBuildSignature = '';

  function buildSignature() {
    const bayDrives = state.bays.map(b => b.drive?.id || '').join(',');
    const modules = state.modules.map(m => m.id).join(',');
    return [
      state.server?.id || '',
      state.activeBayConfig || '',
      state.raidMode || '',
      state.networkGbpsOverride ?? '',
      state.coolingProfile || '',
      state.fillStrategy || '',
      state.fillDriveId || '',
      state.workload?.id || '',
      modules,
      bayDrives,
    ].join('|');
  }

  function refreshIfBuildChanged(force = false) {
    const signature = buildSignature();
    if (!force && signature === lastBuildSignature) return;
    lastBuildSignature = signature;
    ui.refresh();
  }

  function notifyBuildChanged() {
    EventBus.emit('bay:update');
    refreshIfBuildChanged(true);
  }

  function bayAtClientPoint(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const inside =
      clientX >= rect.left && clientX <= rect.right &&
      clientY >= rect.top && clientY <= rect.bottom;
    if (!inside) return -1;
    return renderer.hitTest(clientX - rect.left, clientY - rect.top);
  }

  function canvasContainsClientPoint(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return (
      clientX >= rect.left && clientX <= rect.right &&
      clientY >= rect.top && clientY <= rect.bottom
    );
  }

  function findCompatibleBay(drive, startIndex = 0) {
    if (!drive) return -1;
    const from = Math.max(0, startIndex);
    let bay = state.bays.findIndex((b, i) =>
      i >= from && !b.drive && driveCompatibleWithBay(drive, b)
    );
    if (bay >= 0) return bay;
    bay = state.bays.findIndex(b => !b.drive && driveCompatibleWithBay(drive, b));
    return bay;
  }

  function placeDriveInBay(drive, bayIndex) {
    if (!drive || bayIndex < 0 || !state.bays[bayIndex]) return false;
    const bay = state.bays[bayIndex];
    if (!driveCompatibleWithBay(drive, bay)) {
      return false;
    }

    bay.drive = drive;
    state.selectedBay = bayIndex;
    state.hoveredBay = bayIndex;
    state.dragDrive = null;
    notifyBuildChanged();
    return true;
  }

  function placeDriveFromPoint(drive, clientX, clientY) {
    if (!drive) return false;
    const exactBay = bayAtClientPoint(clientX, clientY);
    if (placeDriveInBay(drive, exactBay)) return true;
    if (!canvasContainsClientPoint(clientX, clientY)) return false;
    return placeDriveInBay(drive, findCompatibleBay(drive));
  }

  function targetBayFromPoint(drive, clientX, clientY) {
    const exactBay = bayAtClientPoint(clientX, clientY);
    if (exactBay >= 0) return exactBay;
    return canvasContainsClientPoint(clientX, clientY) ? findCompatibleBay(drive) : -1;
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
      ui.showDriveInfo(state.bays[bay]?.drive || null, state.bays[bay] || null);
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
      notifyBuildChanged();
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
    placeDriveFromPoint(drive, e.clientX, e.clientY);
  });

  canvas.addEventListener('dragleave', () => { state.hoveredBay = -1; });

  function updatePaletteDrag(e) {
    if (!state.dragDrive || !state.dragStart) return;
    const distance = Math.hypot(e.clientX - state.dragStart.x, e.clientY - state.dragStart.y);
    if (distance > 6) state.paletteDragging = true;
    if (state.paletteDragging) state.hoveredBay = targetBayFromPoint(state.dragDrive, e.clientX, e.clientY);
  }

  function finishPaletteDrag(e) {
    if (!state.dragDrive || !state.dragStart) return;
    const distance = Math.hypot(e.clientX - state.dragStart.x, e.clientY - state.dragStart.y);
    const shouldPlace = state.paletteDragging || distance > 6;
    if (shouldPlace) placeDriveFromPoint(state.dragDrive, e.clientX, e.clientY);
    state.dragDrive = null;
    state.dragStart = null;
    state.paletteDragging = false;
  }

  document.addEventListener('mousemove', updatePaletteDrag);
  document.addEventListener('pointermove', updatePaletteDrag);
  document.addEventListener('mouseup', finishPaletteDrag);
  document.addEventListener('pointerup', finishPaletteDrag);
  document.addEventListener('dragover', (e) => {
    if (!state.dragDrive || !canvasContainsClientPoint(e.clientX, e.clientY)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    state.hoveredBay = targetBayFromPoint(state.dragDrive, e.clientX, e.clientY);
  }, true);
  document.addEventListener('drop', (e) => {
    if (!state.dragDrive || !canvasContainsClientPoint(e.clientX, e.clientY)) return;
    e.preventDefault();
    e.stopPropagation();
    placeDriveFromPoint(state.dragDrive, e.clientX, e.clientY);
  }, true);

  document.addEventListener('dragend', (e) => {
    if (state.dragDrive) {
      placeDriveFromPoint(state.dragDrive, e.clientX, e.clientY);
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
    refreshIfBuildChanged();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  ui.refresh();
  refreshIfBuildChanged(true);
}

main().catch(console.error);
