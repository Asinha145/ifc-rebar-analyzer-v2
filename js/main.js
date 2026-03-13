/**
 * IFC Rebar Analyzer v2 — Main
 *
 * v2 changes vs v1:
 *   - 3D viewer now uses web-ifc WASM (BREP solid meshes, not bs8666 wireframes)
 *   - Dimension boxes prefer BREP bounding box (outer-face to outer-face)
 *   - viewer3d.js handles all Three.js + web-ifc lifecycle
 *
 * What stays the same:
 *   - ifc-parser.js for ALL metadata, classification, validation, stats
 *   - C01 rejection logic
 *   - Stagger clustering (Z_BAND = 100mm gap threshold within clustering)
 *   - Step detection (mesh bars only, 50mm XY grid, 15–300mm range)
 *   - Weight: ATK/ICOS Rebar 'Weight' pset only — never formula for cage totals
 *   - UDL: formula weight (π×r²×L×7777) — geometry-based, pset-independent
 */

let allData      = [];
let filteredData = [];
let cageAxis     = [0, 0, 1];
let cageAxisName = 'Z';

// ── Initialise viewer on page load ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    // File picker
    document.getElementById('ifc-file').addEventListener('change', e => {
        const f = e.target.files[0];
        document.getElementById('ifc-filename').textContent = f ? f.name : 'No file selected';
        document.getElementById('process-btn').disabled = !f;
    });
    document.getElementById('process-btn').addEventListener('click', processFile);

    // Drag-and-drop
    const dropZone = document.getElementById('upload-drop-zone');
    if (dropZone) {
        dropZone.addEventListener('dragover', e => {
            e.preventDefault();
            dropZone.classList.add('drag-active');
        });
        dropZone.addEventListener('dragleave', e => {
            if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('drag-active');
        });
        dropZone.addEventListener('drop', e => {
            e.preventDefault();
            dropZone.classList.remove('drag-active');
            const f = e.dataTransfer.files[0];
            if (!f) return;
            try {
                const dt = new DataTransfer();
                dt.items.add(f);
                document.getElementById('ifc-file').files = dt.files;
            } catch (_) { /* Safari */ }
            window._droppedFile = f;
            document.getElementById('ifc-filename').textContent = f.name;
            document.getElementById('process-btn').disabled = false;
        });
    }

    document.getElementById('search-input').addEventListener('input', applyFilters);
    document.getElementById('bartype-filter').addEventListener('change', applyFilters);
    document.getElementById('export-excel-btn').addEventListener('click', () => exportCSV('rebar_analysis.csv'));
    document.getElementById('export-csv-btn').addEventListener('click',   () => exportCSV('rebar_analysis.csv'));

    document.getElementById('page-prev').addEventListener('click', () => {
        if (currentPage > 1) { currentPage--; renderTable(); }
    });
    document.getElementById('page-next').addEventListener('click', () => {
        const totalPages = Math.ceil(filteredData.length / PAGE_SIZE);
        if (currentPage < totalPages) { currentPage++; renderTable(); }
    });

    const dlAllBtn = document.getElementById('download-all-samples-btn');
    if (dlAllBtn) dlAllBtn.addEventListener('click', downloadAllSamples);

    const stepBtn = document.getElementById('run-step-btn');
    if (stepBtn) stepBtn.addEventListener('click', runStepDetection);

    // Layer filter panel toggle
    const filterToggle = document.getElementById('viewer-filter-toggle');
    if (filterToggle) {
        filterToggle.addEventListener('click', () => {
            document.getElementById('viewer-filter-panel').classList.toggle('hidden');
        });
    }

    // ViewCube buttons
    document.querySelectorAll('.viewcube-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (window._viewer3d) window._viewer3d.setView(btn.dataset.view);
        });
    });

    // Initialise web-ifc Viewer3D (loads WASM once, re-used per file)
    if (typeof Viewer3D !== 'undefined' && typeof WebIFC !== 'undefined') {
        try {
            document.getElementById('viewer-col').classList.remove('hidden');
            _setViewerPlaceholder('⏳ Loading WASM engine…');
            window._viewer3d = new Viewer3D('threejs-container');
            await window._viewer3d.init();
            _setViewerPlaceholder('Drop an IFC file to load the 3D cage');
            console.log('[main] Viewer3D ready');
        } catch (e) {
            console.warn('[main] Viewer3D init failed:', e);
            window._viewer3d = null;
            _setViewerPlaceholder('3D preview unavailable — needs HTTP server');
        }
    } else {
        console.warn('[main] WebIFC or Viewer3D not loaded');
        window._viewer3d = null;
        document.getElementById('viewer-col').classList.remove('hidden');
        _setViewerPlaceholder('3D preview unavailable — web-ifc not loaded');
    }
});

// ── Step reset on new file ─────────────────────────────────────────────
function _resetClashStep() {
    const res = document.getElementById('step-results');
    if (res) { res.classList.add('hidden'); }
    const tbody = document.getElementById('step-tbody');
    if (tbody) tbody.innerHTML = '';
    const wrap = document.getElementById('step-table-wrap');
    if (wrap) wrap.style.display = 'none';
    const btn = document.getElementById('run-step-btn');
    if (btn) { btn.textContent = '▶ Re-run Step Check'; btn.disabled = false; }
    _setBox5Step(false);
}

// ── Process file ────────────────────────────────────────────────────────

async function processFile() {
    const file = document.getElementById('ifc-file').files[0] || window._droppedFile || null;
    window._droppedFile = null;
    if (!file) { alert('Please select an IFC file.'); return; }
    showProgress(); allData = [];
    _resetClashStep();

    try {
        if (typeof IFCParser === 'undefined') throw new Error('IFCParser not loaded.');

        updateProgress(15, 'Reading file…');
        const content = await readFileAsText(file);
        if (!content.includes('IFCREINFORCINGBAR'))
            throw new Error('No reinforcing bars found in this file.');

        updateProgress(40, 'Analysing cage structure…');
        const parser = new IFCParser();
        allData = await parser.parseFile(content);
        if (!allData.length) throw new Error('No bars extracted.');
        cageAxis     = parser.cageAxis;
        cageAxisName = parser.cageAxisName;

        updateProgress(70, 'Building results…');
        displayResults(parser);

        updateProgress(90, '3D geometry loading…');
        setTimeout(async () => {
            hideProgress();
            _doStepDetection();

            // Load BREP geometry into viewer
            if (window._viewer3d) {
                try {
                    const arrayBuffer = await readFileAsBuffer(file);
                    const barMap = new Map();
                    allData.forEach(b => barMap.set(parseInt(b._entityId, 10), b));
                    const dims = await window._viewer3d.loadIFC(arrayBuffer, barMap);
                    if (dims) _updateDimBoxesFromBREP(dims);
                    _buildViewerCheckboxes();
                } catch (e) {
                    console.warn('[main] BREP load error:', e);
                }
            }
        }, 100);

    } catch (err) {
        console.error(err);
        alert(`Error: ${err.message}`);
        hideProgress();
    }
}

function readFileAsText(file) {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload  = e => res(e.target.result);
        r.onerror = e => rej(e);
        r.readAsText(file);
    });
}

function readFileAsBuffer(file) {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload  = e => res(e.target.result);
        r.onerror = e => rej(e);
        r.readAsArrayBuffer(file);
    });
}

function showProgress()  { document.getElementById('progress-container').classList.remove('hidden'); }
function hideProgress()  { document.getElementById('progress-container').classList.add('hidden'); }
function updateProgress(pct, txt) {
    document.getElementById('progress-fill').style.width = pct + '%';
    document.getElementById('progress-text').textContent = txt;
}

// ── Top-level display ──────────────────────────────────────────────────

function displayResults(parser) {
    // Rejection banner
    const banner = document.getElementById('rejection-banner');
    if (parser.isRejected) {
        const reasons = [];
        if (parser.unknownCount > 0)
            reasons.push(`${parser.unknownCount} bar${parser.unknownCount > 1 ? 's' : ''} with unknown Bar_Type`);
        if (parser.missingLayerCount > 0)
            reasons.push(`${parser.missingLayerCount} bar${parser.missingLayerCount > 1 ? 's' : ''} missing Avonmouth Layer/Set`);
        if (parser.duplicateCount > 0)
            reasons.push(`${parser.duplicateCount} duplicate GlobalId${parser.duplicateCount > 1 ? 's' : ''}`);
        if (parser.missingWeightCount > 0)
            reasons.push(`${parser.missingWeightCount} bar${parser.missingWeightCount > 1 ? 's' : ''} missing ATK/ICOS Weight`);
        document.getElementById('rejection-reasons').innerHTML =
            reasons.map(r => `<li>${r}</li>`).join('');
        banner.classList.remove('hidden');
    } else {
        banner.classList.add('hidden');
    }

    // Cage axis badge
    const axisEl = document.getElementById('cage-axis-info');
    if (axisEl) axisEl.textContent = `${cageAxisName}-axis`;

    // Top stat cards
    const meshBars    = allData.filter(b => b.Bar_Type === 'Mesh');
    const nonMeshBars = allData.filter(b => b.Bar_Type !== 'Mesh' && b.Bar_Type !== 'Unknown');
    const w     = b => b.Weight || 0;
    const fw    = b => b.Formula_Weight || 0;
    const meshFW    = meshBars.reduce((s, b) => s + fw(b), 0);
    const nonMeshFW = nonMeshBars.reduce((s, b) => s + fw(b), 0);
    const udl = meshFW > 0 ? nonMeshFW / meshFW : 0;

    const guidCounts = new Map();
    allData.forEach(b => guidCounts.set(b.GlobalId, (guidCounts.get(b.GlobalId) || 0) + 1));
    const dupEntities = [...guidCounts.values()].reduce((s, c) => s + (c > 1 ? c : 0), 0);

    document.getElementById('total-count').textContent     = allData.length;
    document.getElementById('mesh-count').textContent      = meshBars.length;
    document.getElementById('unknown-count').textContent   = parser.unknownCount;
    document.getElementById('duplicate-count').textContent = dupEntities;
    document.getElementById('missing-weight-count').textContent = parser.missingWeightCount;
    document.getElementById('udl-value').textContent       = udl.toFixed(4);

    displayCageDimensionBoxes();
    displayBarTypeDistribution();
    displayMeshHorizontalStats();
    displayMeshHeightStats();
    displayLayerWeightStats();
    document.getElementById('results-section').classList.remove('hidden');
    applyFilters();
    buildC01Cards(parser);
}

// ── Cage dimension boxes (parser centreline, updated by BREP after viewer loads) ──

function displayCageDimensionBoxes() {
    const meshBars = allData.filter(b =>
        b.Bar_Type === 'Mesh' &&
        b.Mesh_Source !== 'ATK-inferred' &&
        b.Start_X !== null
    );

    const vertBars = meshBars.filter(b => b.Orientation === 'Vertical');
    const barsForHL = vertBars.length ? vertBars : meshBars;

    let minZ = Infinity, maxZ = -Infinity;
    barsForHL.forEach(b => {
        minZ = Math.min(minZ, b.Start_Z, b.End_Z);
        maxZ = Math.max(maxZ, b.Start_Z, b.End_Z);
    });
    const heightVal = isFinite(minZ) ? maxZ - minZ : null;

    let minXspan = Infinity, maxXspan = -Infinity, minYspan = Infinity, maxYspan = -Infinity;
    let minXbar = null, maxXbar = null, minYbar = null, maxYbar = null;
    meshBars.forEach(b => {
        const dia = b.Size || b.NominalDiameter_mm || 0;
        [b.Start_X, b.End_X].forEach(x => {
            if (x < minXspan) { minXspan = x; minXbar = dia; }
            if (x > maxXspan) { maxXspan = x; maxXbar = dia; }
        });
        [b.Start_Y, b.End_Y].forEach(y => {
            if (y < minYspan) { minYspan = y; minYbar = dia; }
            if (y > maxYspan) { maxYspan = y; maxYbar = dia; }
        });
    });
    const spanX = isFinite(minXspan) ? (maxXspan - minXspan) + (maxXbar / 2) + (minXbar / 2) : null;
    const spanY = isFinite(minYspan) ? (maxYspan - minYspan) + (maxYbar / 2) + (minYbar / 2) : null;
    let widthVal = null, lengthVal = null;
    if (spanX !== null && spanY !== null) {
        lengthVal = Math.max(spanX, spanY);
        widthVal  = Math.min(spanX, spanY);
    } else {
        lengthVal = spanX ?? spanY;
    }

    const fmt = v => v !== null && isFinite(v) ? Math.round(v).toLocaleString() + ' mm' : '—';
    document.getElementById('dim-width').textContent  = fmt(widthVal);
    document.getElementById('dim-length').textContent = fmt(lengthVal);
    document.getElementById('dim-height').textContent = fmt(heightVal);

    // Box4: Couplered Bars
    const hasCoupler = allData.some(b => {
        const av  = (b.Avonmouth_Layer_Set || '').toUpperCase();
        const atk = (b.ATK_Layer_Name || '').toUpperCase();
        return /^(VS|HS|LB)\d*$/.test(av) && atk.includes('CPLR');
    });
    const couplerEl = document.getElementById('dim-coupler');
    couplerEl.textContent = hasCoupler ? 'Yes' : 'No';
    couplerEl.className   = 'dim-value ' + (hasCoupler ? 'dim-yes' : 'dim-no');
}

/**
 * Called after BREP bbox is available from viewer3d.loadIFC().
 * BREP bbox is outer-face to outer-face — more accurate than centreline + half-dia.
 */
function _updateDimBoxesFromBREP(dims) {
    if (!dims) return;
    const fmt = v => v !== null && isFinite(v) ? Math.round(v).toLocaleString() + ' mm' : '—';
    document.getElementById('dim-width').textContent  = fmt(dims.width);
    document.getElementById('dim-length').textContent = fmt(dims.length);
    document.getElementById('dim-height').textContent = fmt(dims.height);
}

// ── Viewer placeholder text ────────────────────────────────────────────

function _setViewerPlaceholder(msg) {
    const el = document.getElementById('viewer-placeholder');
    if (el) el.textContent = msg;
}

// ── 3D viewer layer checkboxes ─────────────────────────────────────────

let _viewerChecked = new Set();

function _buildViewerCheckboxes() {
    if (!window._viewer3d) return;
    const layers = window._viewer3d.getLayerNames();
    const box    = document.getElementById('viewer-checkboxes');
    box.innerHTML = '';
    _viewerChecked = new Set(layers);

    layers.forEach(key => {
        const colour = window._viewer3d._barColour(
            allData.find(b => (b.Avonmouth_Layer_Set || b.Bar_Type || 'Unknown') === key) || null
        );
        const hex   = (colour >>> 0).toString(16).padStart(6, '0');
        const count = allData.filter(b => (b.Avonmouth_Layer_Set || b.Bar_Type || 'Unknown') === key).length;
        const label = document.createElement('label');
        label.className = 'viewer-cb-label';
        label.innerHTML = `
            <input type="checkbox" class="viewer-cb" data-key="${key}" checked>
            <span class="viewer-cb-dot" style="background:#${hex}"></span>
            <span>${key} <em>(${count})</em></span>`;
        box.appendChild(label);
        label.querySelector('input').addEventListener('change', _onViewerCbChange);
    });

    document.getElementById('viewer-check-all').onclick = () => {
        box.querySelectorAll('.viewer-cb').forEach(cb => { cb.checked = true; });
        _onViewerCbChange();
    };
    document.getElementById('viewer-check-none').onclick = () => {
        box.querySelectorAll('.viewer-cb').forEach(cb => { cb.checked = false; });
        _onViewerCbChange();
    };

    _buildViewerLegend(layers);
}

function _onViewerCbChange() {
    _viewerChecked = new Set(
        [...document.querySelectorAll('.viewer-cb:checked')].map(cb => cb.dataset.key)
    );
    if (window._viewer3d) {
        window._viewer3d.getLayerNames().forEach(key => {
            window._viewer3d.setLayerVisible(key, _viewerChecked.has(key));
        });
    }
    _buildViewerLegend([...window._viewer3d.getLayerNames()]);
}

function _buildViewerLegend(layers) {
    const legend = document.getElementById('viewer-legend');
    if (!legend || !window._viewer3d) return;
    legend.innerHTML = '';
    layers.filter(k => _viewerChecked.has(k)).forEach(key => {
        const colour = window._viewer3d._barColour(
            allData.find(b => (b.Avonmouth_Layer_Set || b.Bar_Type || 'Unknown') === key) || null
        );
        const hex   = (colour >>> 0).toString(16).padStart(6, '0').slice(-6);
        const count = allData.filter(b => (b.Avonmouth_Layer_Set || b.Bar_Type || 'Unknown') === key).length;
        const item  = document.createElement('div');
        item.className = 'legend-item';
        item.innerHTML = `<span class="legend-dot" style="background:#${hex}"></span>${key} (${count})`;
        legend.appendChild(item);
    });
}

// ── Helpers ────────────────────────────────────────────────────────────

function dotCage(b) {
    return Math.abs(b.Dir_X * cageAxis[0] + b.Dir_Y * cageAxis[1] + b.Dir_Z * cageAxis[2]);
}

function countUniqueHorizPositions(hBars) {
    if (!hBars.length) return { count: 0 };
    const tagged = hBars.filter(b => b.Stagger_Cluster_ID);
    if (tagged.length > 0) {
        const ids = new Set(tagged.map(b => b.Stagger_Cluster_ID));
        return { count: ids.size };
    }
    return { count: hBars.length };
}

function heightAlongAxis(bars) {
    if (!bars.length) return null;
    let mn = Infinity, mx = -Infinity;
    bars.forEach(b => {
        if (b.Start_Z === null) return;
        mn = Math.min(mn, b.Start_Z, b.End_Z);
        mx = Math.max(mx, b.Start_Z, b.End_Z);
    });
    return isFinite(mn) ? { min: mn, max: mx, height: mx - mn } : null;
}

// ── Bar type distribution ──────────────────────────────────────────────

function displayBarTypeDistribution() {
    const grid = document.getElementById('bar-types-grid');
    grid.innerHTML = '';
    const counts = {};
    allData.forEach(b => { const t = b.Bar_Type || 'Unknown'; counts[t] = (counts[t] || 0) + 1; });
    Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([type, count]) => {
        const card = document.createElement('div');
        card.className = 'bar-type-card' + (type === 'Unknown' && count > 0 ? ' danger' : '');
        card.innerHTML = `<div class="type-name">${type}</div><div class="type-count">${count}</div>`;
        grid.appendChild(card);
    });
}

// ── Block 1: Horizontal bars per mesh layer ────────────────────────────

function displayMeshHorizontalStats() {
    const container = document.getElementById('mesh-horizontal-grid');
    container.innerHTML = '';
    const layerMap = {};
    allData.forEach(bar => {
        const av = bar.Avonmouth_Layer_Set;
        if (!av || !/^[FN]\d+A$/i.test(av)) return;
        const layer = bar.Effective_Mesh_Layer;
        if (!layer) return;
        if (!layerMap[layer]) layerMap[layer] = [];
        layerMap[layer].push(bar);
    });

    const sortedLayers = Object.keys(layerMap).sort();
    sortedLayers.forEach(layer => {
        const bars  = layerMap[layer];
        const hBars = bars.filter(b => b.Orientation === 'Horizontal');
        const { count: hCount } = countUniqueHorizPositions(hBars);
        const sizes  = hBars.map(b => b.Size).filter(s => s > 0);
        const minDia = sizes.length ? Math.min(...sizes) : null;
        const maxDia = sizes.length ? Math.max(...sizes) : null;
        const diaStr = minDia === null ? '—'
            : minDia === maxDia ? `⌀${minDia}`
            : `⌀${minDia} – ⌀${maxDia}`;
        const card = document.createElement('div');
        card.className = 'mesh-stat-card';
        card.innerHTML = `
            <div class="mesh-layer-name">${layer}</div>
            <div class="mesh-stat-value">${hCount}</div>
            <div class="mesh-stat-label">horizontal bars</div>
            <div class="mesh-stat-dia">${diaStr} mm</div>`;
        container.appendChild(card);
    });
    if (!sortedLayers.length)
        container.innerHTML = '<p class="no-data">No mesh layers found.</p>';
}

// ── Block 2: Cage height per mesh layer ───────────────────────────────

function displayMeshHeightStats() {
    const container = document.getElementById('mesh-height-grid');
    container.innerHTML = '';
    const layerMap = {};
    allData.forEach(bar => {
        const av = bar.Avonmouth_Layer_Set;
        if (!av || !/^[FN]\d+A$/i.test(av)) return;
        const layer = bar.Effective_Mesh_Layer;
        if (!layer) return;
        if (!layerMap[layer]) layerMap[layer] = [];
        layerMap[layer].push(bar);
    });

    const sortedLayers = Object.keys(layerMap).sort();
    sortedLayers.forEach(layer => {
        const bars  = layerMap[layer];
        const hBars = bars.filter(b => b.Orientation === 'Horizontal');
        const vBars = bars.filter(b => b.Orientation === 'Vertical');
        const h     = heightAlongAxis(bars);

        const hSizes = hBars.map(b => b.Size).filter(s => s > 0);
        const hMin   = hSizes.length ? Math.min(...hSizes) : null;
        const hMax   = hSizes.length ? Math.max(...hSizes) : null;
        const hDia   = hMin === null ? '—'
            : hMin === hMax ? `⌀${hMin}` : `⌀${hMin}–⌀${hMax}`;

        const vSizes = vBars.map(b => b.Size).filter(s => s > 0);
        const vMin   = vSizes.length ? Math.min(...vSizes) : null;
        const vMax   = vSizes.length ? Math.max(...vSizes) : null;
        const vDia   = vMin === null ? '—'
            : vMin === vMax ? `⌀${vMin}` : `⌀${vMin}–⌀${vMax}`;

        const card = document.createElement('div');
        card.className = 'mesh-stat-card height-card';
        card.innerHTML = `
            <div class="mesh-layer-name">${layer}</div>
            <div class="mesh-stat-value">${h ? Math.round(h.height).toLocaleString() : '—'}</div>
            <div class="mesh-stat-label">mm cage height</div>
            <div class="mesh-stat-sub">
                ↓ ${h ? Math.round(h.min).toLocaleString() : '—'} &nbsp;|&nbsp; ↑ ${h ? Math.round(h.max).toLocaleString() : '—'}
            </div>
            <div class="mesh-dia-row">
                <span class="mesh-stat-dia dia-horiz" title="Horizontal bars">↔ ${hDia}</span>
                <span class="mesh-stat-dia dia-vert"  title="Vertical bars">↕ ${vDia}</span>
            </div>`;
        container.appendChild(card);
    });
    if (!sortedLayers.length)
        container.innerHTML = '<p class="no-data">No mesh layers found.</p>';
}

// ── Block 3: Weight per layer ──────────────────────────────────────────

function displayLayerWeightStats() {
    const container = document.getElementById('layer-weight-tbody');
    container.innerHTML = '';
    const layerMap = {};
    allData.forEach(bar => {
        const layer = bar.Avonmouth_Layer_Set
            || (bar.Bar_Type === 'Mesh' && bar.Effective_Mesh_Layer
                ? bar.Effective_Mesh_Layer + ' \u2691'
                : null)
            || 'Unknown';
        const isInferred = !bar.Avonmouth_Layer_Set && bar.Bar_Type === 'Mesh';
        if (!layerMap[layer]) layerMap[layer] = { count: 0, weight: 0, type: bar.Bar_Type || 'Unknown', inferred: isInferred };
        layerMap[layer].count++;
        layerMap[layer].weight += bar.Weight || 0;
    });

    const rows        = Object.entries(layerMap).sort((a, b) => a[0].localeCompare(b[0]));
    const totalWeight = rows.reduce((s, [, v]) => s + v.weight, 0);
    rows.forEach(([layer, data]) => {
        const pct        = totalWeight > 0 ? (data.weight / totalWeight * 100) : 0;
        const isUnknown  = layer === 'Unknown';
        const isInferred = !!data.inferred;
        const tr         = document.createElement('tr');
        if (isUnknown) tr.className = 'danger-row';
        else if (isInferred) tr.className = 'inferred-row';
        const displayLayer = isInferred
            ? layer.replace(' \u2691', '') + ' <span class="inferred-badge" title="ATK-inferred">\u2691 ATK-inferred</span>'
            : layer;
        tr.innerHTML = `
            <td><strong>${isInferred ? displayLayer : layer}</strong>${isUnknown ? ' ⚠' : ''}</td>
            <td><span class="bar-type-badge ${(data.type || '').toLowerCase().replace(/\s+/g, '-')}">${data.type}</span></td>
            <td>${data.count.toLocaleString()}</td>
            <td>${data.weight.toFixed(1)}</td>
            <td>
                <div class="weight-bar-wrap">
                    <div class="weight-bar-fill" style="width:${pct.toFixed(1)}%"></div>
                    <span class="weight-bar-pct">${pct.toFixed(1)}%</span>
                </div>
            </td>`;
        container.appendChild(tr);
    });
    const totalRow = document.createElement('tr');
    totalRow.className = 'total-row';
    totalRow.innerHTML = `
        <td colspan="2"><strong>TOTAL</strong></td>
        <td><strong>${allData.length.toLocaleString()}</strong></td>
        <td><strong>${totalWeight.toFixed(1)}</strong></td>
        <td></td>`;
    container.appendChild(totalRow);
}

// ── Data table ─────────────────────────────────────────────────────────

const PAGE_SIZE = 100;
let currentPage = 1;

function applyFilters() {
    const search  = document.getElementById('search-input').value.toLowerCase().trim();
    const barType = document.getElementById('bartype-filter').value;
    filteredData = allData.filter(bar => {
        if (barType !== 'all' && bar.Bar_Type !== barType) return false;
        if (search) {
            const txt = [
                bar.Shape_Code, bar.Shape_Code_Base, bar.Coupler_Suffix, bar.Coupler_Type,
                bar.Avonmouth_Layer_Set, bar.Bar_Type, bar.Size, bar.Length,
                bar.Rebar_Mark, bar.Full_Rebar_Mark, bar.Bar_Shape, bar.Orientation,
                bar.ATK_Layer_Name, bar.GlobalId, bar.Avonmouth_ID,
            ].map(v => v == null ? '' : String(v)).join(' ').toLowerCase();
            if (!txt.includes(search)) return false;
        }
        return true;
    });
    currentPage = 1;
    renderTable();
}

function renderTable() {
    const tbody = document.getElementById('results-tbody');
    tbody.innerHTML = '';

    const totalPages = Math.max(1, Math.ceil(filteredData.length / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * PAGE_SIZE;
    const slice = filteredData.slice(start, start + PAGE_SIZE);

    slice.forEach(bar => {
        const isUnknown = bar.Bar_Type === 'Unknown';
        const tr = document.createElement('tr');
        if (isUnknown) tr.className = 'danger-row';

        const baseCode     = bar.Shape_Code_Base || bar.Shape_Code || '—';
        const couplerBadge = bar.Coupler_Suffix
            ? `<span class="coupler-badge" title="${bar.Coupler_Type || bar.Coupler_Suffix}">${bar.Coupler_Suffix}</span>`
            : '';

        tr.innerHTML = `
            <td class="col-shape">${baseCode}${couplerBadge}</td>
            <td>${bar.Avonmouth_Layer_Set || '—'}</td>
            <td><span class="bar-type-badge ${(bar.Bar_Type || '').toLowerCase().replace(/\s+/g, '-')}">${bar.Bar_Type || 'Unknown'}</span></td>
            <td>${bar.Size ? bar.Size + ' mm' : '—'}</td>
            <td>${bar.Length ? Number(bar.Length).toLocaleString() + ' mm' : '—'}</td>
            <td>${bar.Rebar_Mark || '—'}</td>
            <td>${bar.Bar_Shape || '—'}</td>`;
        tbody.appendChild(tr);
    });

    const countEl = document.getElementById('result-count');
    if (countEl) countEl.textContent = `${filteredData.length} bars`;

    const pager = document.getElementById('table-pagination');
    if (!pager) return;
    if (totalPages <= 1) { pager.classList.add('hidden'); return; }
    pager.classList.remove('hidden');
    document.getElementById('page-info').textContent =
        `Page ${currentPage} of ${totalPages}  (${filteredData.length} bars)`;
    document.getElementById('page-prev').disabled = currentPage <= 1;
    document.getElementById('page-next').disabled = currentPage >= totalPages;
}

// ── Export CSV ─────────────────────────────────────────────────────────

function exportCSV(filename) {
    if (!allData.length) { alert('No data to export.'); return; }
    const headers = ['GlobalId','Name','Avonmouth_Layer','ATK_Layer_Name','Effective_Mesh_Layer',
                     'Bar_Type','Orientation','Shape_Code','Shape_Code_Base','Coupler_Suffix','Coupler_Type',
                     'Bar_Shape','Size_mm','Weight_kg','Length_mm','Rebar_Mark','Full_Rebar_Mark',
                     'Avonmouth_ID','Start_X','Start_Y','Start_Z','End_X','End_Y','End_Z',
                     'Dir_X','Dir_Y','Dir_Z','Stagger_Cluster_ID','Cage_Axis'];
    let csv = headers.join(',') + '\n';
    allData.forEach(b => {
        const row = [
            b.GlobalId||'', b.Name||'',
            b.Avonmouth_Layer_Set||'', b.ATK_Layer_Name||'', b.Effective_Mesh_Layer||'',
            b.Bar_Type||'', b.Orientation||'',
            b.Shape_Code||'', b.Shape_Code_Base||'', b.Coupler_Suffix||'', b.Coupler_Type||'',
            b.Bar_Shape||'',
            b.Size||'', b.Weight||b.Calculated_Weight||'', b.Length||'',
            b.Rebar_Mark||'', b.Full_Rebar_Mark||'',
            b.Avonmouth_ID||'',
            b.Start_X!==null?b.Start_X.toFixed(1):'', b.Start_Y!==null?b.Start_Y.toFixed(1):'', b.Start_Z!==null?b.Start_Z.toFixed(1):'',
            b.End_X!==null?b.End_X.toFixed(1):'',     b.End_Y!==null?b.End_Y.toFixed(1):'',     b.End_Z!==null?b.End_Z.toFixed(1):'',
            b.Dir_X!==null?b.Dir_X.toFixed(4):'',     b.Dir_Y!==null?b.Dir_Y.toFixed(4):'',     b.Dir_Z!==null?b.Dir_Z.toFixed(4):'',
            b.Stagger_Cluster_ID||'', cageAxisName,
        ].map(v => { const s = String(v); return s.includes(',') ? `"${s}"` : s; });
        csv += row.join(',') + '\n';
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename; a.click();
}

// ── C01 detail cards ───────────────────────────────────────────────────

function buildDetailPageURL(title, bars) {
    const rows = bars.map(b => `
        <tr>
            <td>${b.GlobalId || '—'}</td>
            <td>${b.Rebar_Mark || b.Full_Rebar_Mark || '—'}</td>
            <td>${b.Length ? Number(b.Length).toLocaleString() + ' mm' : '—'}</td>
            <td>${b.Shape_Code_Base || b.Shape_Code || '—'}${b.Coupler_Suffix ? ' <span class="badge">' + b.Coupler_Suffix + '</span>' : ''}</td>
            <td>${b.Size ? b.Size + ' mm' : '—'}</td>
            <td>${b.Avonmouth_Layer_Set || '—'}</td>
            <td>${b.ATK_Layer_Name || '—'}</td>
        </tr>`).join('');
    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>${title}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#f7f7fb;color:#222;padding:24px}h1{font-size:1.2rem;margin-bottom:4px;color:#c53030}.sub{font-size:.8rem;color:#666;margin-bottom:20px}table{width:100%;border-collapse:collapse;background:white;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}th{background:#2d3748;color:white;padding:10px 12px;font-size:.78rem;text-align:left;text-transform:uppercase;letter-spacing:.05em}td{padding:8px 12px;font-size:.82rem;border-bottom:1px solid #eee}tr:last-child td{border-bottom:none}tr:nth-child(even){background:#fafafa}.badge{display:inline-block;background:#f56565;color:white;border-radius:8px;padding:1px 6px;font-size:.68rem;font-weight:700;margin-left:4px}.count{font-weight:700;color:#c53030;font-size:1rem;margin-bottom:16px}</style></head>
<body><h1>C01 — ${title}</h1><p class="sub">IFC Rebar Analyzer v2 | ${new Date().toLocaleString()}</p>
<p class="count">${bars.length} bar${bars.length !== 1 ? 's' : ''}</p>
<table><thead><tr><th>GlobalId</th><th>Rebar Mark</th><th>Length</th><th>Shape Code</th><th>Size</th><th>Layer</th><th>ATK Layer</th></tr></thead>
<tbody>${rows}</tbody></table></body></html>`;
    return URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
}

function buildC01Cards(parser) {
    const row = document.getElementById('c01-cards-row');

    const unknownCard = document.getElementById('c01-unknown-card');
    if (parser.unknownCount > 0) {
        document.getElementById('c01-unknown-count').textContent = parser.unknownCount;
        document.getElementById('c01-unknown-link').href = buildDetailPageURL('Unknown Bars', parser.unknownBars || allData.filter(b => b.Bar_Type === 'Unknown'));
        unknownCard.classList.remove('hidden');
    } else { unknownCard.classList.add('hidden'); }

    const missingLayerCard = document.getElementById('c01-missing-layer-card');
    if (missingLayerCard) {
        if (parser.missingLayerCount > 0) {
            document.getElementById('c01-missing-layer-count').textContent = parser.missingLayerCount;
            document.getElementById('c01-missing-layer-link').href = buildDetailPageURL('Missing Avonmouth Layer', parser.missingLayerBars || allData.filter(b => !b.Avonmouth_Layer_Set));
            missingLayerCard.classList.remove('hidden');
        } else { missingLayerCard.classList.add('hidden'); }
    }

    const dupCard = document.getElementById('c01-dup-card');
    if (parser.duplicateCount > 0) {
        document.getElementById('c01-dup-count').textContent = parser.duplicateCount;
        document.getElementById('c01-dup-link').href = buildDetailPageURL('Duplicate GlobalIds', parser.duplicateBars || []);
        dupCard.classList.remove('hidden');
    } else { dupCard.classList.add('hidden'); }

    const weightCard = document.getElementById('c01-weight-card');
    if (parser.missingWeightCount > 0) {
        document.getElementById('c01-weight-count').textContent = parser.missingWeightCount;
        document.getElementById('c01-weight-link').href = buildDetailPageURL('Missing ATK Weight', parser.missingWeightBars || []);
        weightCard.classList.remove('hidden');
    } else { weightCard.classList.add('hidden'); }

    const anyVisible = parser.unknownCount > 0 || parser.missingLayerCount > 0 ||
                       parser.duplicateCount > 0 || parser.missingWeightCount > 0;
    row.classList.toggle('hidden', !anyVisible);
}

// ── Step detection ─────────────────────────────────────────────────────

function runStepDetection() {
    const btn = document.getElementById('run-step-btn');
    btn.textContent = '⏳ Running…'; btn.disabled = true;
    setTimeout(() => {
        try { _doStepDetection(); }
        finally { btn.textContent = '▶ Re-run Step Check'; btn.disabled = false; }
    }, 20);
}

function _doStepDetection() {
    const GRID     = 50;
    const STEP_THR = 15;
    const STEP_MAX = 300;

    const vertBars = allData.filter(b =>
        b.Bar_Type === 'Mesh' && b.Start_Z !== null && b.Dir_Z !== null && Math.abs(b.Dir_Z) >= 0.5
    );
    if (!vertBars.length) { _renderStepResults([], 'No vertical bars found.'); _setBox5Step(false); return; }

    const cells = new Map();
    vertBars.forEach(b => {
        const gx = Math.round(b.Start_X / GRID) * GRID;
        const gy = Math.round(b.Start_Y / GRID) * GRID;
        const key = `${gx}|${gy}`;
        if (!cells.has(key)) cells.set(key, { gx, gy, bars: [] });
        cells.get(key).bars.push(b);
    });

    const steps = [];
    cells.forEach(({ gx, gy, bars }) => {
        if (bars.length < 2) return;
        const tops   = bars.map(b => Math.max(b.Start_Z, b.End_Z));
        const minTop = Math.min(...tops);
        const maxTop = Math.max(...tops);
        const stepH  = maxTop - minTop;
        if (stepH < STEP_THR || stepH > STEP_MAX) return;
        const layers = [...new Set(bars.map(b => b.Avonmouth_Layer_Set || b.ATK_Layer_Name || '?'))].sort().join(', ');
        steps.push({ gx, gy, barCount: bars.length, minTop, maxTop, stepH, layers });
    });

    steps.sort((a, b) => b.stepH - a.stepH);
    _renderStepResults(steps, null);
    _setBox5Step(steps.length > 0);
}

function _setBox5Step(hasStep) {
    const el = document.getElementById('dim-step');
    if (!el) return;
    el.textContent = hasStep ? 'Yes' : 'No';
    el.className   = 'dim-value ' + (hasStep ? 'dim-yes' : 'dim-no');
}

function _renderStepResults(steps, errMsg) {
    const resultsDiv = document.getElementById('step-results');
    const summaryDiv = document.getElementById('step-summary');
    const tableWrap  = document.getElementById('step-table-wrap');
    const tbody      = document.getElementById('step-tbody');
    resultsDiv.classList.remove('hidden');

    if (errMsg) {
        summaryDiv.innerHTML = `<div class="clash-ok">ℹ️ ${errMsg}</div>`;
        tableWrap.style.display = 'none';
        return;
    }
    if (steps.length === 0) {
        summaryDiv.innerHTML = '<div class="clash-ok">✅ No steps detected — all vertical bars at the same XY position are within 15 mm of each other.</div>';
        tableWrap.style.display = 'none';
        return;
    }
    summaryDiv.innerHTML = `<div class="clash-fail">📐 ${steps.length} step location${steps.length > 1 ? 's' : ''} detected (bar tops differ by 15–300 mm)</div>`;
    tbody.innerHTML = '';
    steps.forEach((s, idx) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${idx + 1}</td>
            <td>${Math.round(s.gx).toLocaleString()}</td>
            <td>${Math.round(s.gy).toLocaleString()}</td>
            <td>${s.barCount}</td>
            <td>${s.layers || '—'}</td>
            <td>${Math.round(s.minTop).toLocaleString()}</td>
            <td>${Math.round(s.maxTop).toLocaleString()}</td>
            <td class="${s.stepH > 100 ? 'clash-severe' : ''}">${Math.round(s.stepH).toLocaleString()}</td>`;
        tbody.appendChild(tr);
    });
    tableWrap.style.display = '';
}

// ── Sample files ZIP download ──────────────────────────────────────────

async function downloadAllSamples() {
    const btn = document.getElementById('download-all-samples-btn');
    const origText = btn.textContent;
    btn.textContent = '⏳ Building ZIP…'; btn.disabled = true;
    const FILES = ['examples/P165_C2.txt', 'examples/P7019_C1.ifc'];
    try {
        const encoder = new TextEncoder(), parts = [];
        for (const path of FILES) {
            const res = await fetch(path);
            if (!res.ok) throw new Error(`Failed: ${path}`);
            parts.push({ name: path.split('/').pop(), data: new Uint8Array(await res.arrayBuffer()) });
        }
        const crc32Table = (() => {
            const t = new Uint32Array(256);
            for (let i = 0; i < 256; i++) {
                let c = i;
                for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                t[i] = c;
            }
            return t;
        })();
        const crc32 = d => { let c = 0xFFFFFFFF; for (let i = 0; i < d.length; i++) c = crc32Table[(c ^ d[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
        const le16  = v => [v & 0xFF, (v >> 8) & 0xFF];
        const le32  = v => [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF];
        const now   = new Date();
        const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
        const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
        const lhs   = [], offsets = [];
        parts.forEach(({ name, data }) => {
            const nb = encoder.encode(name), crc = crc32(data);
            offsets.push(lhs.reduce((s, h) => s + h.length, 0));
            lhs.push(new Uint8Array([0x50,0x4B,0x03,0x04,20,0,0,0,0,0,...le16(dosTime),...le16(dosDate),...le32(crc),...le32(data.length),...le32(data.length),...le16(nb.length),0,0,...nb,...data]));
        });
        const cds = parts.map(({ name, data }, i) => {
            const nb = encoder.encode(name), crc = crc32(data);
            return new Uint8Array([0x50,0x4B,0x01,0x02,20,0,20,0,0,0,0,0,...le16(dosTime),...le16(dosDate),...le32(crc),...le32(data.length),...le32(data.length),...le16(nb.length),0,0,0,0,0,0,0,0,0,0,0,0,...le32(offsets[i]),...nb]);
        });
        const cdOff = lhs.reduce((s, h) => s + h.length, 0);
        const cdSz  = cds.reduce((s, e) => s + e.length, 0);
        const eocd  = new Uint8Array([0x50,0x4B,0x05,0x06,0,0,0,0,...le16(parts.length),...le16(parts.length),...le32(cdSz),...le32(cdOff),0,0]);
        const total = [...lhs,...cds,eocd].reduce((s,a)=>s+a.length,0);
        const zip = new Uint8Array(total); let off = 0;
        [...lhs,...cds,eocd].forEach(a => { zip.set(a, off); off += a.length; });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
        a.download = 'ifc-analyzer-samples.zip'; a.click();
    } catch (err) {
        console.error('ZIP failed:', err);
        alert('Download failed: ' + err.message);
    } finally {
        btn.textContent = origText; btn.disabled = false;
    }
}
