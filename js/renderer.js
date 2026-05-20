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

  _drawBays(ctx, state, bays, x, y, w, h) {
    if (bays.length === 0) return;

    const groups = this._groupBays(bays);
    const slotGap = 4;
    const groupGap = 18;
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
    const totalH = layouts.reduce((acc, L) =>
      acc + L.gridH + (showLabels ? labelH : 0), 0)
      + (layouts.length - 1) * groupGap;

    // Scale to fit available rect (never upscale)
    const scale = Math.min(1, (w - 4) / maxGroupW, h / totalH);

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

  // Draw a single bay slot (rectangular). slotNum is 1-based within its group.
  _drawSlot(ctx, state, bay, bx, by, sw, sh, slotNum) {
    const globalIdx = bay.bayIndex;
    const isHovered = state.hoveredBay === globalIdx;
    const isSelected = state.selectedBay === globalIdx;
    const hasDrive = bay.drive !== null;
    const minDim = Math.min(sw, sh);

    // Background
    if (hasDrive) {
      ctx.fillStyle = bay.drive.color || '#2962ff';
      ctx.globalAlpha = isHovered ? 0.95 : 0.85;
    } else {
      ctx.fillStyle = isHovered ? COLORS.bayHover : COLORS.bayEmpty;
      ctx.globalAlpha = 1;
    }
    this._roundRect(ctx, bx, by, sw, sh, 3);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Border
    ctx.strokeStyle = isSelected
      ? COLORS.accent
      : isHovered ? '#ffffff44'
      : (bay.source === 'module' ? '#4a3a8c66' : COLORS.bayEmptyBorder);
    ctx.lineWidth = isSelected ? 2 : 1;
    this._roundRect(ctx, bx, by, sw, sh, 3);
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (hasDrive) {
      const d = bay.drive;
      const pad = 3;
      const maxTextW = sw - pad * 2;

      // Drive name — clipped to slot width
      ctx.fillStyle = '#ffffffcc';
      ctx.font = `bold ${Math.max(7, minDim * 0.22)}px "JetBrains Mono", monospace`;
      this._clippedText(ctx, this._abbrev(d.name), bx + sw / 2, by + sh * 0.20, maxTextW);

      // Capacity — hero text, vertical center
      ctx.fillStyle = '#ffffffee';
      ctx.font = `bold ${Math.max(10, minDim * 0.36)}px "JetBrains Mono", monospace`;
      const capLabel = d.capacityTB >= 1 ? `${d.capacityTB}T` : `${(d.capacityTB * 1024).toFixed(0)}G`;
      ctx.fillText(capLabel, bx + sw / 2, by + sh * 0.46);

      // Interface shorthand
      ctx.fillStyle = '#ffffff66';
      ctx.font = `${Math.max(6, minDim * 0.18)}px "JetBrains Mono", monospace`;
      const ifShort = d.interface === 'SATA III' ? 'SATA' : d.interface.replace('NVMe PCIe ', 'G');
      ctx.fillText(ifShort, bx + sw / 2, by + sh * 0.68);

      // Price
      ctx.fillStyle = '#ffffff55';
      ctx.font = `${Math.max(6, minDim * 0.18)}px "JetBrains Mono", monospace`;
      const priceLabel = d.priceUSD
        ? (d.priceUSD >= 1000 ? `$${(d.priceUSD / 1000).toFixed(1)}k` : `$${d.priceUSD}`)
        : 'TBD';
      ctx.fillText(priceLabel, bx + sw / 2, by + sh * 0.84);

      // Supply risk pulse — top-right corner
      if (d.supplyRisk === 'high') {
        const pulse = Math.sin(this.pulsePhase) * 0.3 + 0.7;
        ctx.fillStyle = `rgba(244, 67, 54, ${pulse})`;
        ctx.beginPath();
        ctx.arc(bx + sw - 5, by + 5, Math.max(2.5, minDim * 0.07), 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // Empty slot — interface stripe at bottom + small slot number at top
      const ifColor = bay.interface === 'SATA III' ? '#2196f3'
        : bay.interface.includes('NVMe') ? '#9c27b0'
        : '#607d8b';
      ctx.fillStyle = ifColor;
      ctx.globalAlpha = 0.4;
      ctx.fillRect(bx + 3, by + sh - 3, sw - 6, 1.5);
      ctx.globalAlpha = 1;

      ctx.fillStyle = COLORS.textDim;
      ctx.font = `${Math.max(7, minDim * 0.22)}px "JetBrains Mono", monospace`;
      ctx.fillText(String(slotNum).padStart(2, '0'), bx + sw / 2, by + sh * 0.5);
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
