/**
 * viewer3d.js — web-ifc BREP Renderer
 *
 * Replaces the old bs8666Segments wireframe approach.
 * Uses WebIFC.IfcAPI (WASM) to stream actual BREP geometry from the IFC file.
 * Each bar gets the correct solid mesh — no shape code inference needed.
 *
 * Coordinate system (web-ifc → Three.js scene):
 *   web-ifc outputs Y-up metres:
 *     engine_X = IFC_X / 1000
 *     engine_Y = IFC_Z / 1000
 *     engine_Z = -IFC_Y / 1000
 *   Three.js scene uses this directly (metres, Y-up).
 *   Bounding box for dimension display is converted back to IFC mm.
 *
 * Layer colour palette (matches ifc-cage-viewer conventions):
 *   F*A / N*A  →  Mesh layers  → blue/teal family per layer
 *   LB*        →  Loose Bar    → orange
 *   LK*        →  Link Bar     → purple
 *   VS/HS      →  Strut Bar    → green
 *   PRL/PRC    →  Preload Bar  → pink
 *   Unknown    →  red
 */
class Viewer3D {
    constructor(containerId) {
        this.container   = document.getElementById(containerId);
        this.scene       = null;
        this.camera      = null;
        this.renderer    = null;
        this.ifcapi      = null;

        // Map: layer/set string → THREE.Group
        this.layerGroups = new Map();
        // Map: expressID (int) → THREE.Mesh  (for click/highlight later)
        this.meshByExpId = new Map();

        // Bounding box of MESH bars in IFC mm (filled during loadIFC)
        this.brepBbox = null;

        // Orbit state
        this._orbit = {
            enabled   : true,
            isDown    : false,
            button    : 0,
            lastX     : 0,
            lastY     : 0,
            spherical : { theta: 0.4, phi: 1.1, radius: 20 },
            target     : new THREE.Vector3(),
        };

        this._bindOrbit();
    }

    // ── Initialise Three.js + web-ifc WASM ──────────────────────────────
    async init() {
        const w = this.container.clientWidth  || 800;
        const h = this.container.clientHeight || 420;

        // Scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0d0d1a);

        // Camera
        this.camera = new THREE.PerspectiveCamera(45, w / h, 0.001, 5000);
        this._applyOrbit();

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(w, h);
        this.container.innerHTML = '';
        this.container.appendChild(this.renderer.domElement);

        // Lights
        const ambient = new THREE.AmbientLight(0xffffff, 0.5);
        const dir1    = new THREE.DirectionalLight(0xffffff, 0.8);
        const dir2    = new THREE.DirectionalLight(0xffffff, 0.3);
        dir1.position.set(5, 10, 7);
        dir2.position.set(-5, -3, -7);
        this.scene.add(ambient, dir1, dir2);

        // Resize observer
        new ResizeObserver(() => this._onResize()).observe(this.container);

        // Animate
        const animate = () => { requestAnimationFrame(animate); this.renderer.render(this.scene, this.camera); };
        animate();

        // web-ifc WASM
        this.ifcapi = new WebIFC.IfcAPI();
        this.ifcapi.SetWasmPath('./lib/');
        await this.ifcapi.Init();
        console.log('[Viewer3D] web-ifc WASM ready');
    }

    // ── Load IFC bytes + bar map from ifc-parser ─────────────────────────
    /**
     * @param {ArrayBuffer} arrayBuffer  — raw IFC file bytes
     * @param {Map<number, Object>} barMap — Map<expressID, bar> from parser
     */
    async loadIFC(arrayBuffer, barMap) {
        // Clear previous scene geometry (keep lights)
        const lights = [];
        this.scene.traverse(o => { if (o.isLight) lights.push(o); });
        this.scene.clear();
        lights.forEach(l => this.scene.add(l));
        this.layerGroups.clear();
        this.meshByExpId.clear();

        // Reset bbox
        this.brepBbox = {
            minX: Infinity, maxX: -Infinity,
            minY: Infinity, maxY: -Infinity,
            minZ: Infinity, maxZ: -Infinity,
        };

        const data    = new Uint8Array(arrayBuffer);
        const modelID = this.ifcapi.OpenModel(data);

        let barCount = 0, geomCount = 0;

        this.ifcapi.StreamAllMeshes(modelID, (mesh) => {
            const eid = mesh.expressID;
            const bar = barMap.get(eid);
            const colour = this._barColour(bar);

            const allPos = [], allNrm = [], allIdx = [];
            let vtxOffset = 0;

            for (let gi = 0; gi < mesh.geometries.size(); gi++) {
                const geom  = mesh.geometries.get(gi);
                const flat  = this.ifcapi.GetGeometry(modelID, geom.geometryExpressID);
                const verts = this.ifcapi.GetVertexArray(flat.GetVertexData(), flat.GetVertexDataSize());
                const idxs  = this.ifcapi.GetIndexArray(flat.GetIndexData(), flat.GetIndexDataSize());
                const M     = geom.flatTransformation; // 16-element col-major float64

                for (let j = 0; j < verts.length; j += 6) {
                    const lx = verts[j],     ly = verts[j+1], lz = verts[j+2];
                    const nx = verts[j+3],   ny = verts[j+4], nz = verts[j+5];

                    // Apply 4×4 column-major transform
                    const wx = M[0]*lx + M[4]*ly + M[8] *lz + M[12];
                    const wy = M[1]*lx + M[5]*ly + M[9] *lz + M[13];
                    const wz = M[2]*lx + M[6]*ly + M[10]*lz + M[14];

                    // Normal (3×3 only — no translation)
                    const wnx = M[0]*nx + M[4]*ny + M[8] *nz;
                    const wny = M[1]*nx + M[5]*ny + M[9] *nz;
                    const wnz = M[2]*nx + M[6]*ny + M[10]*nz;

                    allPos.push(wx, wy, wz);
                    allNrm.push(wnx, wny, wnz);

                    // Bbox in web-ifc metres (Y-up); track all bars for scene fit,
                    // but only MESH bars for the dimension display
                    if (bar && (bar.Bar_Type === 'Mesh')) {
                        if (wx < this.brepBbox.minX) this.brepBbox.minX = wx;
                        if (wx > this.brepBbox.maxX) this.brepBbox.maxX = wx;
                        if (wy < this.brepBbox.minY) this.brepBbox.minY = wy;
                        if (wy > this.brepBbox.maxY) this.brepBbox.maxY = wy;
                        if (wz < this.brepBbox.minZ) this.brepBbox.minZ = wz;
                        if (wz > this.brepBbox.maxZ) this.brepBbox.maxZ = wz;
                    }
                }

                for (let j = 0; j < idxs.length; j++) allIdx.push(idxs[j] + vtxOffset);
                vtxOffset += verts.length / 6;
                flat.delete();
                geomCount++;
            }

            if (allPos.length === 0) return;

            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(allPos), 3));
            geo.setAttribute('normal',   new THREE.BufferAttribute(new Float32Array(allNrm), 3));
            geo.setIndex(new THREE.BufferAttribute(new Uint32Array(allIdx), 1));

            const mat   = new THREE.MeshPhongMaterial({ color: colour, shininess: 40 });
            const tMesh = new THREE.Mesh(geo, mat);
            tMesh.userData.expressID = eid;

            const groupKey = bar ? (bar.Avonmouth_Layer_Set || bar.Bar_Type || 'Unknown') : 'Unknown';
            if (!this.layerGroups.has(groupKey)) {
                const g = new THREE.Group();
                g.name = groupKey;
                this.scene.add(g);
                this.layerGroups.set(groupKey, g);
            }
            this.layerGroups.get(groupKey).add(tMesh);
            this.meshByExpId.set(eid, tMesh);
            barCount++;
        });

        this.ifcapi.CloseModel(modelID);
        console.log(`[Viewer3D] Loaded ${barCount} bars, ${geomCount} geometry chunks`);

        // Hide placeholder text once geometry is in the scene
        const ph = document.getElementById('viewer-placeholder');
        if (ph) ph.style.display = 'none';

        this._fitCamera();
        return this._buildDimensions();
    }

    // ── Dimensions from BREP bbox (IFC mm) ──────────────────────────────
    /**
     * web-ifc coords (metres, Y-up):
     *   wx → IFC X direction  → * 1000 mm
     *   wy → IFC Z direction  → * 1000 mm  (height for Z-up cage)
     *   wz → IFC -Y direction → * 1000 mm  (negate doesn't affect span)
     *
     * Returns { width, length, height } in mm rounded to nearest mm.
     * "height" = IFC Z span (vertical).
     * "width"  = smaller of IFC X / IFC Y span (cross section).
     * "length" = larger of IFC X / IFC Y span (cage long axis).
     */
    _buildDimensions() {
        const b = this.brepBbox;
        if (b.minX === Infinity) return null;

        const spanX = (b.maxX - b.minX) * 1000; // IFC X mm
        const spanY = (b.maxY - b.minY) * 1000; // IFC Z mm (height)
        const spanZ = (b.maxZ - b.minZ) * 1000; // IFC Y mm

        const height = Math.round(spanY);
        const width  = Math.round(Math.min(spanX, spanZ));
        const length = Math.round(Math.max(spanX, spanZ));

        return { width, length, height };
    }

    // ── Layer visibility toggle ──────────────────────────────────────────
    setLayerVisible(layerName, visible) {
        const g = this.layerGroups.get(layerName);
        if (g) g.visible = visible;
    }

    setAllLayersVisible(visible) {
        this.layerGroups.forEach(g => { g.visible = visible; });
    }

    getLayerNames() {
        return [...this.layerGroups.keys()].sort();
    }

    // ── ViewCube ─────────────────────────────────────────────────────────
    setView(view) {
        const o = this._orbit;
        const r = o.spherical.radius;
        switch (view) {
            case 'front':  o.spherical.theta = 0;         o.spherical.phi = Math.PI/2; break;
            case 'back':   o.spherical.theta = Math.PI;   o.spherical.phi = Math.PI/2; break;
            case 'left':   o.spherical.theta = -Math.PI/2;o.spherical.phi = Math.PI/2; break;
            case 'right':  o.spherical.theta =  Math.PI/2;o.spherical.phi = Math.PI/2; break;
            case 'top':    o.spherical.theta = 0;         o.spherical.phi = 0.01;      break;
            case 'bottom': o.spherical.theta = 0;         o.spherical.phi = Math.PI - 0.01; break;
        }
        this._applyOrbit();
    }

    // ── Bar colour by layer ──────────────────────────────────────────────
    _barColour(bar) {
        if (!bar) return 0x888888;

        const layer = (bar.Avonmouth_Layer_Set || '').toUpperCase();
        const type  = bar.Bar_Type || 'Unknown';

        // Mesh layers: F*A / N*A — colour by layer number
        const meshM = layer.match(/^([FN])(\d+)A$/);
        if (meshM) {
            const face  = meshM[1];
            const num   = parseInt(meshM[2], 10);
            const MESH_COLOURS = [
                0x4f7be8, // 0 (fallback)
                0x2196F3, // 1
                0x00BCD4, // 2
                0x009688, // 3
                0x4CAF50, // 4
                0x8BC34A, // 5
                0xFFEB3B, // 6
                0xFF9800, // 7
                0xFF5722, // 8
            ];
            const base = MESH_COLOURS[Math.min(num, MESH_COLOURS.length - 1)];
            // N face is slightly darker
            return face === 'N' ? this._shade(base, -30) : base;
        }

        // Bar types
        if (type === 'Link Bar')    return 0xab47bc;
        if (type === 'Loose Bar')   return 0xff7043;
        if (type === 'Strut Bar')   return 0x66bb6a;
        if (type === 'Preload Bar') return 0xec407a;
        if (type === 'Site Bar')    return 0xffd54f;
        if (type === 'Unknown')     return 0xff1744;
        return 0x9e9e9e;
    }

    _shade(hex, amount) {
        const r = Math.max(0, Math.min(255, ((hex >> 16) & 0xff) + amount));
        const g = Math.max(0, Math.min(255, ((hex >>  8) & 0xff) + amount));
        const b = Math.max(0, Math.min(255, ( hex        & 0xff) + amount));
        return (r << 16) | (g << 8) | b;
    }

    // ── Camera fit ───────────────────────────────────────────────────────
    _fitCamera() {
        // Compute scene bounding box
        const box = new THREE.Box3();
        this.scene.traverse(o => { if (o.isMesh) box.expandByObject(o); });
        if (box.isEmpty()) return;

        const centre = new THREE.Vector3();
        box.getCenter(centre);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);

        this._orbit.target.copy(centre);
        this._orbit.spherical.radius = maxDim * 1.6;
        this._orbit.spherical.theta  = 0.5;
        this._orbit.spherical.phi    = 1.1;
        this._applyOrbit();
    }

    _applyOrbit() {
        const { theta, phi, radius } = this._orbit.spherical;
        const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi);
        const t = this._orbit.target;
        this.camera.position.set(
            t.x + radius * sinPhi * Math.sin(theta),
            t.y + radius * cosPhi,
            t.z + radius * sinPhi * Math.cos(theta),
        );
        this.camera.lookAt(t);
    }

    _onResize() {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        if (!w || !h) return;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
    }

    // ── Orbit controls ───────────────────────────────────────────────────
    _bindOrbit() {
        // Use 'capture' so events reach us even when target el changes
        const el = () => this.renderer ? this.renderer.domElement : null;

        const onDown = (e) => {
            this._orbit.isDown = true;
            this._orbit.button = e.button;
            this._orbit.lastX  = e.clientX;
            this._orbit.lastY  = e.clientY;
        };
        const onMove = (e) => {
            if (!this._orbit.isDown) return;
            const dx = e.clientX - this._orbit.lastX;
            const dy = e.clientY - this._orbit.lastY;
            this._orbit.lastX = e.clientX;
            this._orbit.lastY = e.clientY;

            if (this._orbit.button === 0) {
                // Orbit
                this._orbit.spherical.theta -= dx * 0.005;
                this._orbit.spherical.phi   -= dy * 0.005;
                this._orbit.spherical.phi    = Math.max(0.05, Math.min(Math.PI - 0.05, this._orbit.spherical.phi));
            } else {
                // Pan (right-drag)
                const r = this._orbit.spherical.radius;
                const panSpeed = r * 0.001;
                const t = this._orbit.target;
                const forward = new THREE.Vector3().subVectors(this.camera.position, t).normalize();
                const right   = new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0), forward).normalize();
                const up      = new THREE.Vector3().crossVectors(forward, right);
                t.addScaledVector(right, -dx * panSpeed);
                t.addScaledVector(up,     dy * panSpeed);
            }
            this._applyOrbit();
        };
        const onUp   = ()  => { this._orbit.isDown = false; };
        const onWheel= (e) => {
            e.preventDefault();
            this._orbit.spherical.radius *= (1 + e.deltaY * 0.001);
            this._orbit.spherical.radius  = Math.max(0.1, this._orbit.spherical.radius);
            this._applyOrbit();
        };

        // Attach after init when domElement exists
        const attach = () => {
            const dom = el();
            if (!dom) return;
            dom.addEventListener('mousedown',  onDown);
            dom.addEventListener('contextmenu', e => e.preventDefault());
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup',   onUp);
            dom.addEventListener('wheel', onWheel, { passive: false });
        };

        // Defer until renderer is set up
        this._attachOrbit = attach;
    }

    // Called after renderer is created
    _finaliseOrbit() {
        if (this._attachOrbit) { this._attachOrbit(); this._attachOrbit = null; }
    }
}

// Monkey-patch init to call _finaliseOrbit after renderer is created
const _origInit = Viewer3D.prototype.init;
Viewer3D.prototype.init = async function() {
    await _origInit.call(this);
    this._finaliseOrbit();
};

window.Viewer3D = Viewer3D;
