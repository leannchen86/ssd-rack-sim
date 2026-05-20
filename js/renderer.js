// renderer.js — Canvas 2D rack renderer
// Draws server chassis with drive bays (chassis + module bays), animated

const COLORS = {
  bg: '#070b12',
  bgGrid: '#0f1726',
  chassisBg: '#121927',
  chassisFace: '#151d2d',
  chassisLip: '#202b3d',
  chassisRecess: '#070b12',
  chassisBorder: '#2a3456',
  rackEar: '#0c111c',
  screw: '#526078',
  moduleBg: '#1b1530',
  moduleBorder: '#3a2a6c',
  bayEmpty: '#1a2138',
  bayEmptyBorder: '#2e3a5c',
  bayHover: '#2a3a5c',
  baySelected: '#3a4a7c',
  text: '#c8d0e0',
  textDim: '#6b7894',
  accent: '#4fc3f7',
  warning: '#ff9800',
  danger: '#f44336',
  success: '#4caf50',
};

export class RackRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
    this.bayRects = [];
    this.pulsePhase = 0;
    this._resize();
    this._resizeHandler = () => this._resize();
    window.addEventListener('resize', this._resizeHandler);
  }

  _resize() {
    const parent = this.canvas.parentElement;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    this.canvas.width = w * this.dpr;
    this.canvas.height = h * this.dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.width = w;
    this.height = h;
  }

  hitTest(x, y) {
    for (const r of this.bayRects) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r.index;
    }
    return -1;
  }

  render(state, stats) {
    const ctx = this.ctx;
    const W = this.width;
    const H = this.height;
    this.pulsePhase = (this.pulsePhase + 0.02) % (Math.PI * 2);

    this._drawCanvasBackdrop(ctx, W, H);

    if (!state.server) {
      this._drawCenteredText(ctx, W, H, 'Select a server to begin', COLORS.textDim, 18);
      return;
    }

    const padding = 20;
    this.bayRects = [];

    // Separate chassis bays and module bays
    const chassisBays = state.bays.filter(b => b.source === 'chassis');
    const moduleBays = state.bays.filter(b => b.source === 'module');
    const hasModules = moduleBays.length > 0;
    const isTower = this._isTower(state.server);

    // Layout real chassis proportions instead of stretching every rack to
    // the full canvas height. A 2U server should read as a wide appliance;
    // tower/4U systems are allowed to occupy more vertical space.
    const availableH = H - padding * 2 - 60;
    const chassisTarget = this._targetSectionHeight(state.server, W - padding * 2, H);
    const chassisWidth = isTower
      ? Math.min(W - padding * 2, Math.max(440, Math.min(660, (W - padding * 2) * 0.55)))
      : W - padding * 2;
    const chassisX = isTower ? (W - chassisWidth) / 2 : padding;
    const chassisHeight = hasModules
      ? Math.min(chassisTarget, availableH * 0.62)
      : Math.min(chassisTarget, availableH);
    const moduleHeight = hasModules
      ? Math.min(220, Math.max(150, availableH - chassisHeight - padding))
      : 0;
    const stackHeight = chassisHeight + (hasModules ? padding + moduleHeight : 0);

    // === CHASSIS SECTION ===
    const chassisY = Math.max(54, (H - stackHeight) * 0.43);
    if (isTower) {
      this._drawTowerSection(ctx, chassisX, chassisY, chassisWidth, chassisHeight,
        state.server.name, `${chassisBays.filter(b => b.drive).length}/${chassisBays.length} bays`
      );
    } else {
      this._drawSection(ctx, chassisX, chassisY, chassisWidth, chassisHeight,
        state.server.name, `${chassisBays.filter(b => b.drive).length}/${chassisBays.length} bays`,
        COLORS.chassisBg, COLORS.chassisBorder,
        ''
      );
    }

    this._drawChassisFront(ctx, state, chassisBays, chassisX, chassisY, chassisWidth, chassisHeight);

    // === MODULE SECTION ===
    if (hasModules) {
      const modY = chassisY + chassisHeight + padding;
      const mod = state.modules[0]; // Support first module for now
      this._drawSection(ctx, padding, modY, W - padding * 2, moduleHeight,
        `AIC: ${mod.name}`, `${moduleBays.filter(b => b.drive).length}/${moduleBays.length} slots`,
        COLORS.moduleBg, COLORS.moduleBorder,
        mod.provides?.hotSwap === false ? '⚠ NO HOT-SWAP' : ''
      );

      this._drawBays(ctx, state, moduleBays, padding + 38, modY + 26, W - padding * 2 - 76, moduleHeight - 52);
    }

    // Drop zone
    if (state.dragDrive && state.hoveredBay >= 0) {
      const r = this.bayRects.find(r => r.index === state.hoveredBay);
      if (r) {
        ctx.strokeStyle = COLORS.accent;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        this._roundRect(ctx, r.x - 2, r.y - 2, r.w + 4, r.h + 4, 6);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  _targetSectionHeight(server, availableW, H) {
    const unit = server?.formUnit || '';

    if (unit.includes('1U')) {
      return Math.min(280, Math.max(210, availableW * 0.18));
    }
    if (unit.includes('2U')) {
      return Math.min(520, Math.max(360, availableW * 0.30));
    }
    if (unit.includes('4U')) {
      return Math.min(500, Math.max(340, Math.min(H * 0.62, availableW * 0.62)));
    }
    if (unit.includes('5U') || unit.toLowerCase().includes('tower')) {
      return Math.min(620, Math.max(420, Math.min(H * 0.72, availableW * 0.78)));
    }

    return Math.min(360, Math.max(240, availableW * 0.44));
  }

  _isTower(server) {
    const unit = server?.formUnit || '';
    return unit.toLowerCase().includes('tower') || unit.includes('5U');
  }

  _drawCanvasBackdrop(ctx, W, H) {
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.strokeStyle = COLORS.bgGrid;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.28;
    for (let x = 0; x <= W; x += 32) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    for (let y = 0; y <= H; y += 32) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    const glow = ctx.createRadialGradient(W * 0.52, H * 0.48, 0, W * 0.52, H * 0.48, Math.max(W, H) * 0.62);
    glow.addColorStop(0, 'rgba(79, 195, 247, 0.06)');
    glow.addColorStop(0.5, 'rgba(79, 195, 247, 0.015)');
    glow.addColorStop(1, 'rgba(0, 0, 0, 0.18)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  _drawSection(ctx, x, y, w, h, titleLeft, titleRight, bgColor, borderColor, badge) {
    const earW = Math.min(20, Math.max(12, w * 0.018));
    const bodyX = x + earW;
    const bodyW = w - earW * 2;

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = bgColor;
    this._roundRect(ctx, x, y, w, h, 10);
    ctx.fill();
    ctx.restore();

    // Rack ears with screw holes.
    this._drawRackEar(ctx, x, y, earW, h, 'left');
    this._drawRackEar(ctx, x + w - earW, y, earW, h, 'right');

    const faceGrad = ctx.createLinearGradient(0, y, 0, y + h);
    faceGrad.addColorStop(0, COLORS.chassisLip);
    faceGrad.addColorStop(0.07, COLORS.chassisFace);
    faceGrad.addColorStop(0.82, COLORS.chassisBg);
    faceGrad.addColorStop(1, '#0b101a');
    ctx.fillStyle = faceGrad;
    this._roundRect(ctx, bodyX, y, bodyW, h, 8);
    ctx.fill();

    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1.5;
    this._roundRect(ctx, bodyX, y, bodyW, h, 8);
    ctx.stroke();

    // Subtle top and bottom chassis lips.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
    this._roundRect(ctx, bodyX + 8, y + 8, bodyW - 16, 4, 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    this._roundRect(ctx, bodyX + 8, y + h - 11, bodyW - 16, 4, 2);
    ctx.fill();

    // Side ventilation texture, kept faint so the bay geometry stays primary.
    this._drawVentField(ctx, bodyX + 12, y + 26, 34, Math.max(24, h - 54));
    this._drawVentField(ctx, bodyX + bodyW - 46, y + 26, 34, Math.max(24, h - 54));

    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.fillStyle = COLORS.textDim;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(titleLeft.toUpperCase(), x + 12, y - 6);

    ctx.textAlign = 'right';
    ctx.fillText(titleRight, x + w - 12, y - 6);

    if (badge) {
      ctx.fillStyle = badge.startsWith('⚠') ? COLORS.warning : COLORS.textDim;
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(badge, x + w - 16, y + h - 10);
    }
  }

  _drawTowerSection(ctx, x, y, w, h, titleLeft, titleRight) {
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.48)';
    ctx.shadowBlur = 22;
    ctx.shadowOffsetY = 14;
    const bodyGrad = ctx.createLinearGradient(x, y, x + w, y + h);
    bodyGrad.addColorStop(0, '#222b3d');
    bodyGrad.addColorStop(0.12, COLORS.chassisFace);
    bodyGrad.addColorStop(0.72, '#101725');
    bodyGrad.addColorStop(1, '#080d16');
    ctx.fillStyle = bodyGrad;
    this._roundRect(ctx, x, y, w, h, 12);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = COLORS.chassisBorder;
    ctx.lineWidth = 1.5;
    this._roundRect(ctx, x, y, w, h, 12);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    this._roundRect(ctx, x + 12, y + 10, w - 24, 5, 3);
    ctx.fill();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.34)';
    this._roundRect(ctx, x + 12, y + h - 14, w - 24, 5, 3);
    ctx.fill();

    const sideW = Math.max(18, w * 0.055);
    const sideGrad = ctx.createLinearGradient(x, y, x + sideW, y);
    sideGrad.addColorStop(0, '#060910');
    sideGrad.addColorStop(1, 'rgba(20, 28, 44, 0.35)');
    ctx.fillStyle = sideGrad;
    this._roundRect(ctx, x, y, sideW, h, 12);
    ctx.fill();

    const rightGrad = ctx.createLinearGradient(x + w - sideW, y, x + w, y);
    rightGrad.addColorStop(0, 'rgba(20, 28, 44, 0.25)');
    rightGrad.addColorStop(1, '#060910');
    ctx.fillStyle = rightGrad;
    this._roundRect(ctx, x + w - sideW, y, sideW, h, 12);
    ctx.fill();

    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.fillStyle = COLORS.textDim;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(titleLeft.toUpperCase(), x, y - 8);

    ctx.textAlign = 'right';
    ctx.fillText(titleRight, x + w, y - 8);
  }

  _drawRackEar(ctx, x, y, w, h, side) {
    const grad = ctx.createLinearGradient(x, y, x + w, y);
    if (side === 'left') {
      grad.addColorStop(0, '#060910');
      grad.addColorStop(1, COLORS.rackEar);
    } else {
      grad.addColorStop(0, COLORS.rackEar);
      grad.addColorStop(1, '#060910');
    }

    ctx.fillStyle = grad;
    this._roundRect(ctx, x, y, w, h, 8);
    ctx.fill();
    ctx.strokeStyle = '#1b2538';
    ctx.lineWidth = 1;
    this._roundRect(ctx, x, y, w, h, 8);
    ctx.stroke();

    const screwX = x + w / 2;
    const screwYs = [y + 22, y + h / 2, y + h - 22];
    for (const sy of screwYs) {
      ctx.fillStyle = '#172033';
      ctx.beginPath();
      ctx.arc(screwX, sy, Math.max(2.8, Math.min(4.2, w * 0.22)), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = COLORS.screw;
      ctx.lineWidth = 0.8;
      ctx.stroke();

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
      ctx.beginPath();
      ctx.moveTo(screwX - 2, sy);
      ctx.lineTo(screwX + 2, sy);
      ctx.stroke();
    }
  }

  _drawVentField(ctx, x, y, w, h) {
    ctx.save();
    ctx.fillStyle = 'rgba(107, 120, 148, 0.18)';
    const stepX = 8;
    const stepY = 10;
    for (let cy = y + 4; cy < y + h - 2; cy += stepY) {
      for (let cx = x + 3; cx < x + w - 2; cx += stepX) {
        ctx.fillRect(cx, cy, 3, 1.2);
      }
    }
    ctx.restore();
  }

  _drawChassisFront(ctx, state, bays, x, y, w, h) {
    if (bays.length === 0) return;

    const server = state.server;
    const unit = server?.formUnit || '';
    const isTower = this._isTower(server);

    if (isTower) {
      this._drawTowerFront(ctx, state, bays, x, y, w, h);
      return;
    }

    const earW = Math.min(20, Math.max(12, w * 0.018));
    const bodyX = x + earW;
    const bodyY = y;
    const bodyW = w - earW * 2;
    const bodyH = h;
    const pad = Math.max(12, Math.min(24, bodyW * 0.012));
    const isOneU = unit.includes('1U');

    const leftRailW = Math.min(isOneU ? 120 : 145, Math.max(isOneU ? 72 : 94, bodyW * 0.08));
    const rightRailW = Math.min(isOneU ? 116 : 135, Math.max(isOneU ? 64 : 82, bodyW * 0.07));
    const topH = isOneU ? Math.max(20, bodyH * 0.16) : Math.min(108, Math.max(68, bodyH * 0.22));
    const bottomPad = isOneU ? 14 : 20;

    const bayAreaX = bodyX + leftRailW;
    const bayAreaY = bodyY + topH;
    const bayAreaW = bodyW - leftRailW - rightRailW;
    const bayAreaH = bodyH - topH - bottomPad;

    if (!isOneU) {
      this._drawTopPerforatedGrille(ctx, bodyX + pad, bodyY + 18, bodyW - pad * 2, Math.max(34, topH - 34));
    } else {
      this._drawFrontPerforation(ctx, bodyX + pad + leftRailW, bodyY + 17, bodyW - leftRailW - rightRailW - pad * 2, 14, 0.32);
    }

    this._drawControlStrip(ctx, bodyX + pad, bodyY + topH + 4, Math.max(36, leftRailW - pad * 1.7), Math.max(48, bayAreaH - 8), server?.vendor);
    this._drawPortStack(ctx, bodyX + bodyW - rightRailW + pad * 0.35, bodyY + topH + 8, Math.max(34, rightRailW - pad * 1.1), Math.max(48, bayAreaH - 16));

    const cagePad = isOneU ? 10 : 13;
    const cageX = bayAreaX + cagePad;
    const cageY = bayAreaY + (isOneU ? 4 : 2);
    const cageW = bayAreaW - cagePad * 2;
    const cageH = bayAreaH - (isOneU ? 8 : 4);

    const cageGrad = ctx.createLinearGradient(cageX, cageY, cageX, cageY + cageH);
    cageGrad.addColorStop(0, '#05080d');
    cageGrad.addColorStop(0.08, '#121824');
    cageGrad.addColorStop(0.5, '#070b12');
    cageGrad.addColorStop(1, '#03060a');
    ctx.fillStyle = cageGrad;
    this._roundRect(ctx, cageX, cageY, cageW, cageH, 4);
    ctx.fill();
    ctx.strokeStyle = 'rgba(110, 130, 170, 0.34)';
    ctx.lineWidth = 1;
    this._roundRect(ctx, cageX, cageY, cageW, cageH, 4);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.fillRect(cageX + 5, cageY + 5, cageW - 10, 1);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
    ctx.fillRect(cageX + 5, cageY + cageH - 7, cageW - 10, 2);

    this._drawBayBank(ctx, state, bays, cageX + 12, cageY + 12, cageW - 24, cageH - 24);
  }

  _drawTowerFront(ctx, state, bays, x, y, w, h) {
    const pad = Math.max(16, Math.min(24, w * 0.045));
    const topH = Math.min(70, Math.max(48, h * 0.105));
    const bottomH = Math.max(24, h * 0.06);
    const leftW = Math.min(70, Math.max(44, w * 0.11));
    const rightW = Math.min(36, Math.max(22, w * 0.055));

    this._drawTopPerforatedGrille(ctx, x + pad, y + pad, w - pad * 2, topH - 14);

    const controlX = x + pad;
    const controlY = y + topH + pad * 0.45;
    const controlH = h - topH - bottomH - pad * 1.2;
    this._drawControlStrip(ctx, controlX, controlY, leftW - pad * 0.35, controlH, state.server?.vendor);

    const serviceX = x + w - rightW - pad * 0.55;
    const serviceY = controlY;
    this._drawPortStack(ctx, serviceX, serviceY, rightW, controlH);

    const cageX = x + leftW + pad * 1.1;
    const cageY = y + topH + pad * 0.6;
    const cageW = w - leftW - rightW - pad * 2.1;
    const cageH = h - topH - bottomH - pad * 1.15;

    const cageGrad = ctx.createLinearGradient(cageX, cageY, cageX, cageY + cageH);
    cageGrad.addColorStop(0, '#05080d');
    cageGrad.addColorStop(0.08, '#111827');
    cageGrad.addColorStop(0.52, '#070b12');
    cageGrad.addColorStop(1, '#03060a');
    ctx.fillStyle = cageGrad;
    this._roundRect(ctx, cageX, cageY, cageW, cageH, 5);
    ctx.fill();
    ctx.strokeStyle = 'rgba(110, 130, 170, 0.34)';
    ctx.lineWidth = 1;
    this._roundRect(ctx, cageX, cageY, cageW, cageH, 5);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.fillRect(cageX + 6, cageY + 6, cageW - 12, 1);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
    ctx.fillRect(cageX + 6, cageY + cageH - 8, cageW - 12, 2);

    this._drawBayBank(ctx, state, bays, cageX + 12, cageY + 14, cageW - 24, cageH - 28);
  }

  _drawTopPerforatedGrille(ctx, x, y, w, h) {
    const grad = ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, '#101826');
    grad.addColorStop(0.38, '#05080e');
    grad.addColorStop(1, '#111827');
    ctx.fillStyle = grad;
    this._roundRect(ctx, x, y, w, h, 3);
    ctx.fill();
    ctx.strokeStyle = 'rgba(95, 110, 140, 0.28)';
    this._roundRect(ctx, x, y, w, h, 3);
    ctx.stroke();

    this._drawFrontPerforation(ctx, x + 10, y + 8, w - 20, h - 16, 0.45);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.fillRect(x + 12, y + 6, w - 24, 1);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.34)';
    ctx.fillRect(x + 12, y + h - 7, w - 24, 2);
  }

  _drawFrontPerforation(ctx, x, y, w, h, alpha = 0.36) {
    ctx.save();
    ctx.fillStyle = `rgba(108, 122, 148, ${alpha})`;
    const dot = Math.max(1.1, Math.min(2.2, h * 0.07));
    const stepX = 8;
    const stepY = 6;
    for (let cy = y + 3; cy < y + h - 2; cy += stepY) {
      const offset = Math.floor((cy - y) / stepY) % 2 ? stepX / 2 : 0;
      for (let cx = x + 3 + offset; cx < x + w - 2; cx += stepX) {
        ctx.fillRect(cx, cy, dot, dot);
      }
    }
    ctx.restore();
  }

  _drawControlStrip(ctx, x, y, w, h, vendor) {
    const grad = ctx.createLinearGradient(x, y, x + w, y);
    grad.addColorStop(0, '#070b12');
    grad.addColorStop(0.55, '#111827');
    grad.addColorStop(1, '#070b12');
    ctx.fillStyle = grad;
    this._roundRect(ctx, x, y, w, h, 3);
    ctx.fill();
    ctx.strokeStyle = 'rgba(98, 116, 148, 0.28)';
    this._roundRect(ctx, x, y, w, h, 3);
    ctx.stroke();

    this._drawFrontPerforation(ctx, x + 7, y + 10, Math.max(10, w - 14), Math.max(18, h * 0.42), 0.34);

    const panelW = Math.max(22, Math.min(38, w * 0.42));
    const panelX = x + Math.max(5, (w - panelW) / 2);
    const panelY = y + h - Math.max(72, h * 0.30);
    const panelH = Math.min(66, h - 18);
    ctx.fillStyle = '#05080d';
    this._roundRect(ctx, panelX, panelY, panelW, panelH, 3);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120, 140, 175, 0.34)';
    this._roundRect(ctx, panelX, panelY, panelW, panelH, 3);
    ctx.stroke();

    const ledX = panelX + panelW / 2;
    const brandColor = vendor === 'Dell' ? COLORS.accent : '#7ee787';
    this._drawTinyLed(ctx, ledX, panelY + 12, brandColor, 0.9);
    this._drawTinyLed(ctx, ledX, panelY + 30, COLORS.success, 0.75);
    this._drawTinyLed(ctx, ledX, panelY + 48, '#73819a', 0.55);
  }

  _drawPortStack(ctx, x, y, w, h) {
    const grad = ctx.createLinearGradient(x, y, x + w, y);
    grad.addColorStop(0, '#080c13');
    grad.addColorStop(0.5, '#111827');
    grad.addColorStop(1, '#05080d');
    ctx.fillStyle = grad;
    this._roundRect(ctx, x, y, w, h, 3);
    ctx.fill();
    ctx.strokeStyle = 'rgba(98, 116, 148, 0.24)';
    this._roundRect(ctx, x, y, w, h, 3);
    ctx.stroke();

    this._drawFrontPerforation(ctx, x + 6, y + 10, Math.max(12, w - 12), Math.max(20, h * 0.42), 0.28);

    const cx = x + w / 2;
    this._drawTinyLed(ctx, cx, y + h * 0.56, COLORS.success, 0.8);
    this._drawTinyLed(ctx, cx, y + h * 0.72, COLORS.accent, 0.9);

    const portW = Math.max(16, Math.min(28, w * 0.38));
    const portH = Math.max(24, Math.min(42, h * 0.17));
    const portX = cx - portW / 2;
    const portY = y + h - portH - 12;
    ctx.fillStyle = '#03060a';
    this._roundRect(ctx, portX, portY, portW, portH, 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(150, 165, 195, 0.34)';
    this._roundRect(ctx, portX, portY, portW, portH, 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(120, 150, 190, 0.22)';
    ctx.fillRect(portX + 4, portY + 7, portW - 8, 3);
    ctx.fillRect(portX + 4, portY + portH - 10, portW - 8, 3);
  }

  _drawTinyLed(ctx, x, y, color, alpha) {
    ctx.save();
    ctx.shadowColor = this._alpha(color, alpha);
    ctx.shadowBlur = 6;
    ctx.fillStyle = this._alpha(color, alpha);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Slot pixel geometry per form factor (real-drive aspect ratios)
  _slotGeometry(ff) {
    switch (ff) {
      case 'M.2 2280': return { w: 26, h: 96 };
      case 'U.2':      return { w: 36, h: 92 };
      case 'E3.S':     return { w: 24, h: 86 };
      case '3.5"':     return { w: 50, h: 110 };
      case '2.5"':
      default:         return { w: 34, h: 92 };
    }
  }

  // Rows × cols layout matching real chassis density
  _layoutFor(count, ff) {
    if (count <= 8)   return { rows: 1, cols: count };
    if (count === 12) return { rows: 1, cols: 12 };
    if (count <= 16) return { rows: 2, cols: Math.ceil(count / 2) };
    if (count <= 24) return { rows: 2, cols: Math.ceil(count / 2) };
    if (count === 32) {
      // Towers (T620/T630) pack 4×8 SATA; rack 32× E3.S is 2×16
      if (ff === '2.5"' || ff === '3.5"') return { rows: 4, cols: 8 };
      return { rows: 2, cols: 16 };
    }
    if (count <= 36) return { rows: 4, cols: 9 };
    if (count <= 40) return { rows: 2, cols: 20 };
    return { rows: 4, cols: Math.ceil(count / 4) };
  }

  // Group consecutive bays by (formFactor, interface, lanesPerDrive)
  _groupBays(bays) {
    const groups = [];
    for (const bay of bays) {
      const sig = `${bay.formFactor}|${bay.interface}|${bay.lanesPerDrive || 0}`;
      const last = groups[groups.length - 1];
      if (last && last.sig === sig) {
        last.bays.push(bay);
      } else {
        groups.push({
          sig,
          formFactor: bay.formFactor,
          interface: bay.interface,
          lanesPerDrive: bay.lanesPerDrive || 0,
          bays: [bay],
        });
      }
    }
    return groups;
  }

  _frontLayoutFor(server, bays) {
    const count = bays.length;
    const unit = server?.formUnit || '';
    const firstFF = bays[0]?.formFactor || '2.5"';
    const hasOnlyE3S = bays.every(b => b.formFactor === 'E3.S');
    const hasOnlyM2 = bays.every(b => b.formFactor === 'M.2 2280');

    if (hasOnlyM2) {
      return { rows: count <= 8 ? 1 : 2, cols: count <= 8 ? count : Math.ceil(count / 2), groupEvery: 4, geometry: { w: 30, h: 104 }, gapX: 8, gapY: 8, groupGapX: 18 };
    }

    if (hasOnlyE3S) {
      if (unit.includes('1U') || count <= 16) {
        return { rows: 4, cols: Math.ceil(count / 4), groupEvery: 1, geometry: { w: 86, h: 20 }, gapX: 6, gapY: 5, groupGapX: 18, edsff: true };
      }
      return { rows: 4, cols: Math.ceil(count / 4), groupEvery: 4, geometry: { w: 78, h: 22 }, gapX: 6, gapY: 6, groupGapX: 18, edsff: true };
    }

    if (firstFF === '3.5"') {
      if (unit.includes('2U')) {
        return { rows: 2, cols: Math.ceil(count / 2), groupEvery: 3, geometry: { w: 84, h: 104 }, gapX: 8, gapY: 10, groupGapX: 18 };
      }
      return { rows: 4, cols: Math.ceil(count / 4), groupEvery: 3, geometry: { w: 78, h: 94 }, gapX: 8, gapY: 8, groupGapX: 16 };
    }

    if (this._isTower(server) && count >= 24) {
      return { rows: 4, cols: Math.ceil(count / 4), groupEvery: 4, geometry: { w: 56, h: 112 }, gapX: 7, gapY: 9, groupGapX: 16 };
    }

    if (count <= 12) {
      return { rows: 1, cols: count, groupEvery: 4, geometry: { w: 56, h: 112 }, gapX: 8, gapY: 8, groupGapX: 18 };
    }

    return { rows: 2, cols: Math.ceil(count / 2), groupEvery: 4, geometry: { w: 56, h: 112 }, gapX: 8, gapY: 10, groupGapX: 18 };
  }

  _frontGridWidth(cols, slotW, gapX, groupEvery, groupGapX) {
    const breakCount = groupEvery ? Math.floor((cols - 1) / groupEvery) : 0;
    return cols * slotW + Math.max(0, cols - 1) * gapX + breakCount * groupGapX;
  }

  _frontColOffset(col, slotW, gapX, groupEvery, groupGapX) {
    const breakCount = groupEvery ? Math.floor(col / groupEvery) : 0;
    return col * (slotW + gapX) + breakCount * groupGapX;
  }

  _drawBayBank(ctx, state, bays, x, y, w, h) {
    if (!bays.length) return;

    const spec = this._frontLayoutFor(state.server, bays);
    const { rows, cols, groupEvery, geometry, gapX, gapY, groupGapX } = spec;
    const gridW = this._frontGridWidth(cols, geometry.w, gapX, groupEvery, groupGapX);
    const gridH = rows * geometry.h + Math.max(0, rows - 1) * gapY;
    const scale = Math.min(w / gridW, h / gridH);
    const sw = geometry.w * scale;
    const sh = geometry.h * scale;
    const sx = gapX * scale;
    const sy = gapY * scale;
    const sg = groupGapX * scale;
    const drawnW = this._frontGridWidth(cols, sw, sx, groupEvery, sg);
    const drawnH = rows * sh + Math.max(0, rows - 1) * sy;
    const gx = x + (w - drawnW) / 2;
    const gy = y + (h - drawnH) / 2;

    if (rows > 1 && !spec.edsff) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 1;
      const railY = gy + sh + sy / 2;
      ctx.beginPath();
      ctx.moveTo(gx, railY);
      ctx.lineTo(gx + drawnW, railY);
      ctx.stroke();
    }

    for (let col = groupEvery; col < cols; col += groupEvery) {
      const dividerX = gx + this._frontColOffset(col, sw, sx, groupEvery, sg) - (sg + sx) / 2;
      ctx.fillStyle = 'rgba(120, 135, 165, 0.18)';
      ctx.fillRect(dividerX, gy - 5, Math.max(1, scale), drawnH + 10);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.fillRect(dividerX + Math.max(1, scale), gy - 5, Math.max(1, scale), drawnH + 10);
    }

    for (let i = 0; i < bays.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const bx = gx + this._frontColOffset(col, sw, sx, groupEvery, sg);
      const by = gy + row * (sh + sy);
      const bay = bays[i];
      this.bayRects.push({ x: bx, y: by, w: sw, h: sh, index: bay.bayIndex });
      this._drawSlot(ctx, state, bay, bx, by, sw, sh, bay.bayIndex + 1);
    }
  }

  _drawBays(ctx, state, bays, x, y, w, h) {
    if (bays.length === 0) return;

    const groups = this._groupBays(bays);
    const slotGap = 5;
    const groupGap = 24;
    const labelH = 14;
    const showLabels = groups.length > 1; // single-group sections inherit the section header

    // Layout each group at nominal geometry
    const layouts = groups.map(g => {
      const { rows, cols } = this._layoutFor(g.bays.length, g.formFactor);
      const { w: sw, h: sh } = this._slotGeometry(g.formFactor);
      return {
        ...g, rows, cols, slotW: sw, slotH: sh,
        gridW: cols * sw + (cols - 1) * slotGap,
        gridH: rows * sh + (rows - 1) * slotGap,
      };
    });

    // Total nominal dimensions
    const maxGroupW = Math.max(...layouts.map(L => L.gridW));
    const maxSlotH = Math.max(...layouts.map(L => L.slotH));
    const totalH = layouts.reduce((acc, L) =>
      acc + L.gridH + (showLabels ? labelH : 0), 0)
      + (layouts.length - 1) * groupGap;

    // Scale to fill the available rect. Soft-cap so slots don't get
    // absurd on very large viewports.
    const MAX_SLOT_H = 168;
    const scale = Math.min(
      MAX_SLOT_H / maxSlotH,
      (w - 8) / maxGroupW,
      h / totalH
    );

    let cy = y + (h - totalH * scale) / 2;
    for (const L of layouts) {
      const sw = L.slotW * scale;
      const sh = L.slotH * scale;
      const sg = slotGap * scale;
      const gridW = L.cols * sw + (L.cols - 1) * sg;
      const gx = x + (w - gridW) / 2;

      if (showLabels) {
        ctx.font = `${Math.max(9, 11 * scale)}px "JetBrains Mono", monospace`;
        ctx.fillStyle = COLORS.textDim;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        const laneNote = L.lanesPerDrive ? ` · x${L.lanesPerDrive}` : '';
        ctx.fillText(
          `${L.bays.length}× ${L.formFactor} · ${L.interface}${laneNote}`,
          gx, cy + labelH * scale - 2
        );
        cy += labelH * scale + 2;
      }

      for (let i = 0; i < L.bays.length; i++) {
        const col = i % L.cols;
        const row = Math.floor(i / L.cols);
        const bx = gx + col * (sw + sg);
        const by = cy + row * (sh + sg);
        const bay = L.bays[i];
        this.bayRects.push({ x: bx, y: by, w: sw, h: sh, index: bay.bayIndex });
        this._drawSlot(ctx, state, bay, bx, by, sw, sh, i + 1);
      }
      cy += L.gridH * scale + groupGap * scale;
    }
  }

  // Draw a single bay slot. slotNum is 1-based within its group.
  _drawSlot(ctx, state, bay, bx, by, sw, sh, slotNum) {
    if (bay.formFactor === 'M.2 2280') {
      this._drawM2Slot(ctx, state, bay, bx, by, sw, sh, slotNum);
      return;
    }
    if (bay.formFactor === 'E3.S' && sw > sh * 1.8) {
      this._drawEdsffSlot(ctx, state, bay, bx, by, sw, sh, slotNum);
      return;
    }
    this._drawCaddySlot(ctx, state, bay, bx, by, sw, sh, slotNum);
  }

  _drawCaddySlot(ctx, state, bay, bx, by, sw, sh, slotNum) {
    const globalIdx = bay.bayIndex;
    const isHovered = state.hoveredBay === globalIdx;
    const isSelected = state.selectedBay === globalIdx;
    const hasDrive = bay.drive !== null;
    const minDim = Math.min(sw, sh);

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.30)';
    ctx.shadowBlur = 3;
    ctx.shadowOffsetY = 1;

    // Outer hot-swap sled frame.
    const frameGrad = ctx.createLinearGradient(0, by, 0, by + sh);
    frameGrad.addColorStop(0, '#26324a');
    frameGrad.addColorStop(0.12, '#182136');
    frameGrad.addColorStop(1, '#0b111e');
    ctx.fillStyle = frameGrad;
    this._roundRect(ctx, bx, by, sw, sh, 4);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = isSelected
      ? COLORS.accent
      : isHovered ? '#ffffff55'
      : (bay.source === 'module' ? '#4a3a8c88' : '#33415f');
    ctx.lineWidth = isSelected ? 2 : 1;
    this._roundRect(ctx, bx, by, sw, sh, 4);
    ctx.stroke();

    const inset = Math.max(4, sw * 0.08);
    const faceX = bx + inset;
    const faceY = by + inset;
    const faceW = sw - inset * 2;
    const faceH = sh - inset * 2;

    if (hasDrive) {
      const d = bay.drive;
      const driveColor = d.color || COLORS.accent;
      const bodyGrad = ctx.createLinearGradient(faceX, faceY, faceX + faceW, faceY + faceH);
      bodyGrad.addColorStop(0, this._shade(driveColor, 18));
      bodyGrad.addColorStop(0.45, driveColor);
      bodyGrad.addColorStop(1, this._shade(driveColor, -28));
      ctx.fillStyle = bodyGrad;
      ctx.globalAlpha = isHovered ? 0.98 : 0.92;
      this._roundRect(ctx, faceX, faceY, faceW, faceH, 3);
      ctx.fill();
      ctx.globalAlpha = 1;

      // Metal latch and pull-tab details.
      ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
      this._roundRect(ctx, faceX + faceW * 0.18, faceY + 5, faceW * 0.64, Math.max(3, faceH * 0.035), 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
      this._roundRect(ctx, faceX + 4, faceY + faceH - Math.max(11, faceH * 0.13), faceW - 8, Math.max(6, faceH * 0.055), 2);
      ctx.fill();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const pad = 4;
      const maxTextW = faceW - pad * 2;

      ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.beginPath();
      ctx.arc(faceX + faceW * 0.28, faceY + faceH * 0.16, Math.max(2, minDim * 0.045), 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.font = `700 ${Math.max(10, Math.min(18, faceW * 0.31, minDim * 0.34))}px "JetBrains Mono", monospace`;
      const capLabel = this._capacityLabel(d.capacityTB);
      this._clippedText(ctx, capLabel, faceX + faceW / 2, faceY + faceH * 0.45, maxTextW);

      ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
      ctx.font = `${Math.max(6, Math.min(9, minDim * 0.145))}px "JetBrains Mono", monospace`;
      const ifShort = d.interface === 'SATA III' ? 'SATA' : d.interface.replace('NVMe PCIe ', 'GEN');
      ctx.fillText(ifShort, faceX + faceW / 2, faceY + faceH * 0.62);

      ctx.fillStyle = 'rgba(255, 255, 255, 0.48)';
      ctx.font = `${Math.max(6, Math.min(8, minDim * 0.125))}px "JetBrains Mono", monospace`;
      ctx.fillText(bay.formFactor.replace('2280', ''), faceX + faceW / 2, faceY + faceH * 0.76);

      // Supply and activity indicators: green/amber/red like a chassis face.
      this._drawStatusLed(ctx, bx + sw - inset * 0.72, by + sh - inset * 0.72, d.supplyRisk);
      this._drawActivityLed(ctx, bx + inset * 0.72, by + sh - inset * 0.72, driveColor);
    } else {
      const recessGrad = ctx.createLinearGradient(faceX, faceY, faceX, faceY + faceH);
      recessGrad.addColorStop(0, isHovered ? '#263452' : '#111827');
      recessGrad.addColorStop(0.5, isHovered ? '#1c2944' : COLORS.chassisRecess);
      recessGrad.addColorStop(1, '#070a10');
      ctx.fillStyle = recessGrad;
      this._roundRect(ctx, faceX, faceY, faceW, faceH, 3);
      ctx.fill();

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 1;
      this._roundRect(ctx, faceX, faceY, faceW, faceH, 3);
      ctx.stroke();

      // Empty slot rails and latch shadow.
      ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.fillRect(faceX + 3, faceY + 5, faceW - 6, 1);
      ctx.fillRect(faceX + 3, faceY + faceH - 7, faceW - 6, 1);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
      this._roundRect(ctx, faceX + 5, faceY + faceH - Math.max(12, faceH * 0.14), faceW - 10, Math.max(6, faceH * 0.06), 2);
      ctx.fill();

      const ifColor = bay.interface === 'SATA III' ? '#2196f3'
        : bay.interface.includes('NVMe') ? '#9c27b0'
        : '#607d8b';
      ctx.fillStyle = ifColor;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(faceX + 5, faceY + faceH - 4, faceW - 10, 1.5);
      ctx.globalAlpha = 1;

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = COLORS.textDim;
      ctx.font = `${Math.max(7, Math.min(12, minDim * 0.20))}px "JetBrains Mono", monospace`;
      ctx.fillText(String(slotNum).padStart(2, '0'), faceX + faceW / 2, faceY + faceH * 0.50);
    }

    if (isSelected || isHovered) {
      ctx.strokeStyle = isSelected ? COLORS.accent : 'rgba(255, 255, 255, 0.35)';
      ctx.lineWidth = isSelected ? 2 : 1;
      this._roundRect(ctx, bx - 1, by - 1, sw + 2, sh + 2, 5);
      ctx.stroke();
    }
  }

  _drawEdsffSlot(ctx, state, bay, bx, by, sw, sh, slotNum) {
    const globalIdx = bay.bayIndex;
    const isHovered = state.hoveredBay === globalIdx;
    const isSelected = state.selectedBay === globalIdx;
    const hasDrive = bay.drive !== null;
    const driveColor = hasDrive ? (bay.drive.color || COLORS.accent) : null;

    const frameGrad = ctx.createLinearGradient(bx, by, bx, by + sh);
    frameGrad.addColorStop(0, isHovered ? '#26344f' : '#1d2638');
    frameGrad.addColorStop(0.45, '#0b111d');
    frameGrad.addColorStop(1, '#05080d');
    ctx.fillStyle = frameGrad;
    this._roundRect(ctx, bx, by, sw, sh, 3);
    ctx.fill();

    ctx.strokeStyle = isSelected
      ? COLORS.accent
      : isHovered ? '#ffffff55'
      : '#34415f';
    ctx.lineWidth = isSelected ? 2 : 1;
    this._roundRect(ctx, bx, by, sw, sh, 3);
    ctx.stroke();

    const pad = Math.max(3, sh * 0.16);
    const faceX = bx + pad;
    const faceY = by + pad;
    const faceW = sw - pad * 2;
    const faceH = sh - pad * 2;

    if (hasDrive) {
      const d = bay.drive;
      const bodyGrad = ctx.createLinearGradient(faceX, faceY, faceX + faceW, faceY);
      bodyGrad.addColorStop(0, this._shade(driveColor, -24));
      bodyGrad.addColorStop(0.45, this._shade(driveColor, 4));
      bodyGrad.addColorStop(1, this._shade(driveColor, -34));
      ctx.fillStyle = bodyGrad;
      this._roundRect(ctx, faceX, faceY, faceW, faceH, 2);
      ctx.fill();

      ctx.fillStyle = 'rgba(255, 255, 255, 0.13)';
      ctx.fillRect(faceX + 5, faceY + 2, Math.max(8, faceW * 0.18), Math.max(1, faceH * 0.18));
      ctx.fillStyle = 'rgba(0, 0, 0, 0.34)';
      this._roundRect(ctx, faceX + faceW - Math.max(16, faceW * 0.16), faceY + 2, Math.max(12, faceW * 0.12), faceH - 4, 2);
      ctx.fill();

      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#f7fbff';
      ctx.font = `700 ${Math.max(8, Math.min(13, sh * 0.42))}px "JetBrains Mono", monospace`;
      const capLabel = this._capacityLabel(d.capacityTB);
      ctx.fillText(capLabel, faceX + 8, faceY + faceH / 2);

      ctx.fillStyle = 'rgba(255, 255, 255, 0.62)';
      ctx.font = `${Math.max(6, Math.min(10, sh * 0.30))}px "JetBrains Mono", monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(d.interface.replace('NVMe PCIe ', 'G'), faceX + faceW * 0.56, faceY + faceH / 2);

      this._drawStatusLed(ctx, bx + sw - pad * 1.1, by + sh / 2, d.supplyRisk);
      this._drawActivityLed(ctx, bx + pad * 1.2, by + sh / 2, driveColor);
    } else {
      const recessGrad = ctx.createLinearGradient(faceX, faceY, faceX + faceW, faceY);
      recessGrad.addColorStop(0, isHovered ? '#1f2d46' : '#0c121f');
      recessGrad.addColorStop(0.55, '#05080d');
      recessGrad.addColorStop(1, '#111827');
      ctx.fillStyle = recessGrad;
      this._roundRect(ctx, faceX, faceY, faceW, faceH, 2);
      ctx.fill();

      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.fillRect(faceX + 5, faceY + 2, faceW - 10, 1);
      ctx.fillStyle = bay.interface.includes('NVMe') ? '#9c27b0' : COLORS.accent;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(faceX + faceW - Math.max(10, faceW * 0.12), faceY + 3, Math.max(7, faceW * 0.06), faceH - 6);
      ctx.globalAlpha = 1;

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = COLORS.textDim;
      ctx.font = `${Math.max(6, Math.min(10, sh * 0.34))}px "JetBrains Mono", monospace`;
      ctx.fillText(String(slotNum).padStart(2, '0'), faceX + faceW * 0.45, faceY + faceH / 2);
    }
  }

  _drawM2Slot(ctx, state, bay, bx, by, sw, sh, slotNum) {
    const globalIdx = bay.bayIndex;
    const isHovered = state.hoveredBay === globalIdx;
    const isSelected = state.selectedBay === globalIdx;
    const hasDrive = bay.drive !== null;
    const minDim = Math.min(sw, sh);

    const frameGrad = ctx.createLinearGradient(bx, by, bx + sw, by + sh);
    frameGrad.addColorStop(0, isHovered ? '#202a45' : '#121827');
    frameGrad.addColorStop(1, '#070b12');
    ctx.fillStyle = frameGrad;
    this._roundRect(ctx, bx, by, sw, sh, 4);
    ctx.fill();

    ctx.strokeStyle = isSelected ? COLORS.accent : isHovered ? '#ffffff55' : '#33415f';
    ctx.lineWidth = isSelected ? 2 : 1;
    this._roundRect(ctx, bx, by, sw, sh, 4);
    ctx.stroke();

    const pad = Math.max(4, sw * 0.13);
    const stickX = bx + pad;
    const stickY = by + pad;
    const stickW = sw - pad * 2;
    const stickH = sh - pad * 2;

    if (!hasDrive) {
      ctx.fillStyle = '#0a101b';
      this._roundRect(ctx, stickX, stickY, stickW, stickH, 3);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      this._roundRect(ctx, stickX, stickY, stickW, stickH, 3);
      ctx.stroke();

      ctx.fillStyle = '#c99d4a';
      ctx.globalAlpha = 0.55;
      ctx.fillRect(stickX + 3, stickY + stickH - 9, stickW - 6, 5);
      ctx.globalAlpha = 1;

      ctx.fillStyle = COLORS.textDim;
      ctx.font = `${Math.max(7, Math.min(11, minDim * 0.23))}px "JetBrains Mono", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(slotNum).padStart(2, '0'), bx + sw / 2, by + sh / 2);
      return;
    }

    const d = bay.drive;
    const driveColor = d.color || COLORS.accent;
    const boardGrad = ctx.createLinearGradient(stickX, stickY, stickX + stickW, stickY + stickH);
    boardGrad.addColorStop(0, this._shade(driveColor, -18));
    boardGrad.addColorStop(1, '#0e3a3a');
    ctx.fillStyle = boardGrad;
    this._roundRect(ctx, stickX, stickY, stickW, stickH, 3);
    ctx.fill();

    ctx.fillStyle = '#d8b45d';
    ctx.fillRect(stickX + 3, stickY + stickH - 10, stickW - 6, 6);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    this._roundRect(ctx, stickX + 4, stickY + 8, stickW - 8, stickH * 0.16, 2);
    ctx.fill();
    this._drawChip(ctx, stickX + 5, stickY + stickH * 0.34, stickW - 10, stickH * 0.14);
    this._drawChip(ctx, stickX + 5, stickY + stickH * 0.53, stickW - 10, stickH * 0.14);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${Math.max(8, Math.min(13, minDim * 0.30))}px "JetBrains Mono", monospace`;
    const capLabel = this._capacityLabel(d.capacityTB);
    ctx.fillText(capLabel, stickX + stickW / 2, stickY + stickH * 0.24);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
    ctx.font = `${Math.max(6, Math.min(8, minDim * 0.16))}px "JetBrains Mono", monospace`;
    ctx.fillText(d.interface.replace('NVMe PCIe ', 'GEN'), stickX + stickW / 2, stickY + stickH * 0.75);
    this._drawStatusLed(ctx, bx + sw - pad * 0.8, by + sh - pad * 0.8, d.supplyRisk);
  }

  _drawChip(ctx, x, y, w, h) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
    this._roundRect(ctx, x, y, w, h, 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    this._roundRect(ctx, x, y, w, h, 2);
    ctx.stroke();
  }

  _drawStatusLed(ctx, x, y, risk) {
    const color = risk === 'high' ? COLORS.danger : risk === 'medium' ? COLORS.warning : COLORS.success;
    const pulse = risk === 'high' ? Math.sin(this.pulsePhase) * 0.25 + 0.75 : 0.9;
    ctx.save();
    ctx.shadowColor = this._alpha(color, pulse);
    ctx.shadowBlur = risk === 'high' ? 8 : 4;
    ctx.fillStyle = this._alpha(color, pulse);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _drawActivityLed(ctx, x, y, color) {
    const pulse = Math.sin(this.pulsePhase * 2) * 0.12 + 0.62;
    ctx.save();
    ctx.shadowColor = this._alpha(color, pulse);
    ctx.shadowBlur = 5;
    ctx.fillStyle = this._alpha(color, pulse);
    ctx.beginPath();
    ctx.arc(x, y, 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Clip text to maxWidth, truncating with ellipsis if needed
  _clippedText(ctx, text, cx, cy, maxWidth) {
    let t = text;
    let w = ctx.measureText(t).width;
    if (w <= maxWidth) {
      ctx.fillText(t, cx, cy);
      return;
    }
    while (t.length > 1 && w > maxWidth) {
      t = t.slice(0, -1);
      w = ctx.measureText(t + '…').width;
    }
    ctx.fillText(t + '…', cx, cy);
  }

  _abbrev(name) {
    return name
      .replace('Samsung ', 'S.')
      .replace('TeamGroup T-Force ', 'TG ')
      .replace('Corsair ', 'Cor ')
      .replace('ADATA XPG ', 'XPG ')
      .replace('Apacer Industrial SATA', 'Apacer')
      .replace('Phison Pascari ', 'Pasc.')
      .replace('Phison aiDAPTIV+ ', 'aiDAP ')
      .replace('Phison S12DC ', 'S12DC ')
      .replace('Pascari ', 'Pasc.')
      .replace('Kingston ', 'K.')
      .replace('Patriot ', 'Pat.')
      .replace('Inland ', 'Inl.')
      .replace('Crucial ', 'Cru.')
      .replace(' Pro', 'P')
      .replace(' XT', 'XT')
      .replace(' Elite', '')
      .replace(' Blade', 'Bl')
      .replace(' Burst', 'B')
      .replace(' (QLC)', '')
      .replace(' (E31T)', '')
      .replace(/\s+\d+(\.\d+)?TB$/, '')  // remove trailing capacity (shown separately)
      .replace(/\s+\d+GB$/, '');
  }

  _formatCapacity(tb) {
    return Number.isInteger(tb) ? String(tb) : tb.toFixed(2).replace(/\.?0+$/, '');
  }

  _capacityLabel(tb) {
    if (tb >= 0.95 && tb < 1) return '1T';
    if (tb >= 1) return `${this._formatCapacity(tb)}T`;
    return `${Math.round(tb * 1024)}G`;
  }

  _hexToRgb(hex) {
    const clean = String(hex || '#ffffff').replace('#', '');
    const normalized = clean.length === 3
      ? clean.split('').map(ch => ch + ch).join('')
      : clean.padEnd(6, 'f').slice(0, 6);
    const n = Number.parseInt(normalized, 16);
    if (Number.isNaN(n)) return { r: 255, g: 255, b: 255 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  _shade(hex, amount) {
    const { r, g, b } = this._hexToRgb(hex);
    const clamp = v => Math.max(0, Math.min(255, v));
    return `rgb(${clamp(r + amount)}, ${clamp(g + amount)}, ${clamp(b + amount)})`;
  }

  _alpha(hex, alpha) {
    const { r, g, b } = this._hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  _drawCenteredText(ctx, W, H, text, color, size) {
    ctx.fillStyle = color;
    ctx.font = `${size}px "JetBrains Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, W / 2, H / 2);
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  destroy() {
    window.removeEventListener('resize', this._resizeHandler);
  }
}
