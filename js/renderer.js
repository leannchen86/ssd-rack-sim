// renderer.js — Canvas 2D rack renderer
// Draws server chassis with drive bays (chassis + module bays), animated

const COLORS = {
  bg: '#0a0e17',
  chassisBg: '#151b2b',
  chassisBorder: '#2a3456',
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

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);

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

    // Layout: chassis section (top or full), module section (bottom if present)
    const chassisHeight = hasModules ? (H - padding * 3) * 0.6 : H - padding * 2 - 40;
    const moduleHeight = hasModules ? (H - padding * 3) * 0.35 : 0;

    // === CHASSIS SECTION ===
    const chassisY = 50;
    this._drawSection(ctx, padding, chassisY, W - padding * 2, chassisHeight,
      state.server.name, `${chassisBays.filter(b => b.drive).length}/${chassisBays.length} bays`,
      COLORS.chassisBg, COLORS.chassisBorder,
      state.server.owned ? '[ OWNED ]' : `$${state.server.priceUSD.toLocaleString()}`
    );

    this._drawBays(ctx, state, chassisBays, padding + 12, chassisY + 12, W - padding * 2 - 24, chassisHeight - 24);

    // === MODULE SECTION ===
    if (hasModules) {
      const modY = chassisY + chassisHeight + padding;
      const mod = state.modules[0]; // Support first module for now
      this._drawSection(ctx, padding, modY, W - padding * 2, moduleHeight,
        `AIC: ${mod.name}`, `${moduleBays.filter(b => b.drive).length}/${moduleBays.length} slots`,
        COLORS.moduleBg, COLORS.moduleBorder,
        mod.provides?.hotSwap === false ? '⚠ NO HOT-SWAP' : ''
      );

      this._drawBays(ctx, state, moduleBays, padding + 12, modY + 12, W - padding * 2 - 24, moduleHeight - 24);
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

  _drawSection(ctx, x, y, w, h, titleLeft, titleRight, bgColor, borderColor, badge) {
    ctx.fillStyle = bgColor;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 2;
    this._roundRect(ctx, x, y, w, h, 8);
    ctx.fill();
    ctx.stroke();

    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.fillStyle = COLORS.textDim;
    ctx.textAlign = 'left';
    ctx.fillText(titleLeft.toUpperCase(), x + 12, y - 6);

    ctx.textAlign = 'right';
    ctx.fillText(titleRight, x + w - 12, y - 6);

    if (badge) {
      ctx.fillStyle = badge.startsWith('⚠') ? COLORS.warning : COLORS.textDim;
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(badge, x + w - 12, y + h + 14);
    }
  }

  _drawBays(ctx, state, bays, x, y, w, h) {
    const total = bays.length;
    if (total === 0) return;

    const gap = 5;
    let cols = Math.min(8, total);
    if (total <= 4) cols = total;
    else if (total <= 16) cols = 8;
    else if (total <= 32) cols = 8;
    else cols = 10;

    const rows = Math.ceil(total / cols);
    const bayW = (w - (cols - 1) * gap) / cols;
    const bayH = (h - (rows - 1) * gap) / rows;
    const baySize = Math.min(bayW, bayH, 72);

    const gridW = cols * baySize + (cols - 1) * gap;
    const gridH = rows * baySize + (rows - 1) * gap;
    const gx = x + (w - gridW) / 2;
    const gy = y + (h - gridH) / 2;

    for (let i = 0; i < total; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const bx = gx + col * (baySize + gap);
      const by = gy + row * (baySize + gap);
      const bay = bays[i];
      const globalIdx = bay.bayIndex;

      this.bayRects.push({ x: bx, y: by, w: baySize, h: baySize, index: globalIdx });

      const isHovered = state.hoveredBay === globalIdx;
      const isSelected = state.selectedBay === globalIdx;
      const hasDrive = bay.drive !== null;

      // Background
      if (hasDrive) {
        ctx.fillStyle = bay.drive.color || '#2962ff';
        ctx.globalAlpha = isHovered ? 0.95 : 0.8;
      } else {
        ctx.fillStyle = isHovered ? COLORS.bayHover : COLORS.bayEmpty;
        ctx.globalAlpha = 1;
      }
      this._roundRect(ctx, bx, by, baySize, baySize, 4);
      ctx.fill();
      ctx.globalAlpha = 1;

      // Border
      ctx.strokeStyle = isSelected ? COLORS.accent : isHovered ? '#ffffff44' : (bay.source === 'module' ? '#4a3a8c44' : COLORS.bayEmptyBorder);
      ctx.lineWidth = isSelected ? 2 : 1;
      this._roundRect(ctx, bx, by, baySize, baySize, 4);
      ctx.stroke();

      // Interface type indicator (small bar at bottom)
      if (!hasDrive) {
        const ifColor = bay.interface === 'SATA III' ? '#2196f3' : bay.interface.includes('NVMe') ? '#9c27b0' : '#607d8b';
        ctx.fillStyle = ifColor;
        ctx.globalAlpha = 0.4;
        ctx.fillRect(bx + 4, by + baySize - 4, baySize - 8, 2);
        ctx.globalAlpha = 1;
      }

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      if (hasDrive) {
        const d = bay.drive;
        const pad = 4;
        const maxTextW = baySize - pad * 2;

        // Drive name — clipped to bay width
        ctx.fillStyle = '#ffffffcc';
        ctx.font = `bold ${Math.max(8, baySize * 0.13)}px "JetBrains Mono", monospace`;
        this._clippedText(ctx, this._abbrev(d.name), bx + baySize / 2, by + baySize * 0.28, maxTextW);

        // Capacity — largest text
        ctx.fillStyle = '#ffffffdd';
        ctx.font = `bold ${Math.max(11, baySize * 0.20)}px "JetBrains Mono", monospace`;
        const capLabel = d.capacityTB >= 1 ? `${d.capacityTB}T` : `${(d.capacityTB * 1024).toFixed(0)}G`;
        ctx.fillText(capLabel, bx + baySize / 2, by + baySize * 0.50);

        // Interface shorthand
        ctx.fillStyle = '#ffffff55';
        ctx.font = `${Math.max(7, baySize * 0.10)}px "JetBrains Mono", monospace`;
        const ifShort = d.interface === 'SATA III' ? 'SATA' : d.interface.replace('NVMe PCIe ', 'G');
        ctx.fillText(ifShort, bx + baySize / 2, by + baySize * 0.68);

        // Price
        ctx.fillStyle = '#ffffff44';
        ctx.font = `${Math.max(7, baySize * 0.10)}px "JetBrains Mono", monospace`;
        const priceLabel = d.priceUSD ? (d.priceUSD >= 1000 ? `$${(d.priceUSD / 1000).toFixed(1)}k` : `$${d.priceUSD}`) : 'TBD';
        ctx.fillText(priceLabel, bx + baySize / 2, by + baySize * 0.82);

        // Supply risk pulse
        if (d.supplyRisk === 'high') {
          const pulse = Math.sin(this.pulsePhase) * 0.3 + 0.7;
          ctx.fillStyle = `rgba(244, 67, 54, ${pulse})`;
          ctx.beginPath();
          ctx.arc(bx + baySize - 7, by + 7, 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        // Empty bay — show bay number + form factor
        ctx.fillStyle = COLORS.textDim;
        ctx.font = `${Math.max(9, baySize * 0.14)}px "JetBrains Mono", monospace`;
        ctx.fillText(`${globalIdx + 1}`, bx + baySize / 2, by + baySize * 0.4);

        ctx.fillStyle = '#ffffff33';
        ctx.font = `${Math.max(7, baySize * 0.10)}px "JetBrains Mono", monospace`;
        ctx.fillText(bay.formFactor, bx + baySize / 2, by + baySize * 0.6);
      }
    }
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
