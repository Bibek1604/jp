/**
 * script.js — PosterFrame Photo Editor
 * ======================================
 * Pure vanilla JS + HTML5 Canvas.
 * No frameworks, no libraries, no backend.
 *
 * Sections:
 *  1. CONFIGURATION — poster path + photo-area coordinates
 *  2. STATE         — all mutable application state
 *  3. POSTER LOADING
 *  4. IMAGE UPLOAD
 *  5. STEP NAVIGATION
 *  6. CANVAS RENDERING (preview loop)
 *  7. PHOTO MASKING   (clip to ellipse)
 *  8. DRAGGING        (mouse + touch/pointer events)
 *  9. ZOOMING         (slider, +/- buttons, pinch)
 * 10. RESET
 * 11. PNG EXPORT      (high-res canvas)
 * 12. DOWNLOAD
 * 13. UI HELPERS
 * 14. INIT
 */

'use strict';

/* ============================================================
   1. CONFIGURATION
   ============================================================
   photoArea: coordinates in the ORIGINAL poster image pixels.
   Change these values when you swap in a different poster.

   For the generated poster (≈ 896 × 1152 px JPG output):
   - The oval is horizontally centered at ~50% width
   - Vertically it sits roughly 28–54% from the top

   Measure your poster in any image editor and update:
     x      → left edge of the ellipse bounding box
     y      → top  edge of the ellipse bounding box
     width  → total width  of the ellipse bounding box
     height → total height of the ellipse bounding box
     shape  → "ellipse" | "rect" (rect uses rounded corners)
============================================================ */
const CONFIG = {
  posterSrc: 'image.png',

  /**
   * photoArea — bounding box of the empty photo slot.
   * All values are in the ORIGINAL (natural) poster pixel space.
   *
   * These numbers are tuned for the generated "Special Event" poster
   * where the oval sits centre-top.  Adjust if you use a different image.
   */
  photoArea: {
    x:      380,   // px from left  in original poster
    y:      300,   // px from top   in original poster
    width:  880,   // px wide
    height: 840,   // px tall
    shape:  'ellipse',
    /** Corner radius (only used when shape === 'rect') */
    radius: 40,
  },
};

/* ============================================================
   2. APPLICATION STATE
============================================================ */
const state = {
  /** The poster Image element */
  posterImg:   null,
  posterW:     0,     // natural width  of poster
  posterH:     0,     // natural height of poster

  /** The user-uploaded photo Image element */
  userImg:     null,

  /** Photo transform (in poster pixel units) */
  photo: {
    x:     0,     // x-offset of photo's top-left inside the photo area
    y:     0,     // y-offset of photo's top-left inside the photo area
    scale: 1.0,   // zoom multiplier
  },

  /** Cover-fit baselines (computed on each new image load) */
  baseW: 0,   // photo natural width  at scale=1 → cover-fit size
  baseH: 0,   // photo natural height at scale=1 → cover-fit size

  /** Drag state */
  drag: {
    active:  false,
    startX:  0,
    startY:  0,
    startPX: 0,
    startPY: 0,
    lastDist: 0,  // for pinch-zoom
  },

  /** Current UI step (1 / 2 / 3) */
  step: 1,

  /** rAF handle */
  rafId: null,

  /** Scale factor: CSS display pixels → poster natural pixels */
  displayScale: 1,
};

/* ============================================================
   3. POSTER LOADING
   Loads the poster image once on startup and caches it.
============================================================ */
function loadPoster() {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      state.posterImg = img;
      state.posterW   = img.naturalWidth;
      state.posterH   = img.naturalHeight;
      resolve(img);
    };
    img.onerror = () => reject(new Error('Could not load poster: ' + CONFIG.posterSrc));
    img.src = CONFIG.posterSrc;
  });
}

/* ============================================================
   4. IMAGE UPLOAD
   Reads the selected file and creates an Image element.
============================================================ */
function loadUserImage(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) {
      reject(new Error('Please select a valid image file.'));
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not read the selected image.'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('FileReader failed.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Called after a user image is loaded.
 * Computes the cover-fit base size and centres the photo.
 */
function applyUserImage(img) {
  state.userImg = img;

  const area = CONFIG.photoArea;

  // Compute cover-fit dimensions:
  // Scale the image so its shorter dimension fills the ellipse bounding box.
  const scaleW = area.width  / img.naturalWidth;
  const scaleH = area.height / img.naturalHeight;
  const coverScale = Math.max(scaleW, scaleH);

  state.baseW = img.naturalWidth  * coverScale;
  state.baseH = img.naturalHeight * coverScale;

  // Reset transform
  resetPhotoTransform();
}

/* ============================================================
   5. STEP NAVIGATION
============================================================ */
function goToStep(n) {
  state.step = n;

  // Hide all panels
  document.querySelectorAll('.step-panel').forEach(p => p.classList.add('hidden'));

  // Show the correct panel
  const panels = ['panelStep1', 'panelStep2', 'panelStep3'];
  document.getElementById(panels[n - 1]).classList.remove('hidden');

  // Update step dots
  [1, 2, 3].forEach(i => {
    const dot  = document.getElementById(`step${i}Dot`);
    dot.classList.remove('active', 'completed');
    if (i < n)  dot.classList.add('completed');
    if (i === n) dot.classList.add('active');
  });

  // Update connector lines
  ['line1', 'line2'].forEach((id, idx) => {
    const line = document.getElementById(id);
    line.classList.toggle('active', n > idx + 1);
  });

  // Start / stop the render loop
  if (n === 2) {
    startRenderLoop();
    sizePreviewCanvas();
  } else {
    stopRenderLoop();
  }
}

/* ============================================================
   6. CANVAS RENDERING — preview loop
   Draws the composite (poster + clipped photo) repeatedly
   so drag/zoom feedback is instant.
============================================================ */

const previewCanvas = document.getElementById('previewCanvas');
const ctx           = previewCanvas.getContext('2d');

/**
 * Size the canvas to fill its container while maintaining
 * the poster's aspect ratio.  Called on resize & step entry.
 */
function sizePreviewCanvas() {
  if (!state.posterImg) return;

  const container = document.getElementById('canvasContainer');
  const maxW = container.clientWidth  || 480;
  const maxH = window.innerHeight * 0.65;

  const aspect = state.posterW / state.posterH;
  let cw = maxW;
  let ch = cw / aspect;
  if (ch > maxH) { ch = maxH; cw = ch * aspect; }

  // The canvas internal resolution equals poster natural size
  // (so coordinates are always in poster-pixel space).
  previewCanvas.width  = state.posterW;
  previewCanvas.height = state.posterH;

  // CSS display size (scaled)
  previewCanvas.style.width  = Math.round(cw) + 'px';
  previewCanvas.style.height = Math.round(ch) + 'px';

  // Store scale so pointer events can be converted correctly
  state.displayScale = state.posterW / cw;
}

function startRenderLoop() {
  stopRenderLoop();
  function loop() {
    renderPreview();
    state.rafId = requestAnimationFrame(loop);
  }
  state.rafId = requestAnimationFrame(loop);
}

function stopRenderLoop() {
  if (state.rafId) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
}

/**
 * renderPreview — draws one frame on the preview canvas.
 *
 * Layer order (correct composition):
 *   1. Draw the full poster image as the background.
 *   2. Draw the user photo, clipped to the ellipse shape.
 *   3. Draw a "poster overlay" that has the oval PUNCHED OUT using
 *      destination-out on an offscreen canvas, then composite it on top.
 *      This lets the ornate frame that overlaps the oval sit correctly
 *      on top of the user photo, while the oval interior remains clear.
 *
 * This avoids the problem of the poster's opaque grey oval fill
 * covering the user photo.
 */
function renderPreview() {
  const W = state.posterW;
  const H = state.posterH;

  ctx.clearRect(0, 0, W, H);

  // --- Pass 1: User photo is drawn FIRST as the bottom layer ---
  // But we need the poster background too. Strategy:
  // a) draw poster fully
  // b) overwrite oval area with user photo
  // c) composite poster overlay (oval punched out) on top

  // Step A: Full poster background
  if (state.posterImg) {
    ctx.drawImage(state.posterImg, 0, 0, W, H);
  }

  // Step B: User photo clipped to oval (overwrites grey fill)
  if (state.userImg) {
    drawClippedPhoto(ctx);
  }

  // Step C: Poster overlay with oval punched out
  // This lets the ornate golden frame ring sit ON TOP of the photo
  // while the interior of the oval shows the user's photo through.
  if (state.userImg && state.posterImg) {
    const overlay = getPosterOverlayCanvas();
    ctx.drawImage(overlay, 0, 0);
  }
}

/**
 * getPosterOverlayCanvas
 * Returns (and caches) an offscreen canvas containing the poster
 * with the photo-area shape punched out using destination-out.
 * The cached version is reused unless the poster changes.
 */
let _overlayCanvas = null;
let _overlayPosterSrc = null;

function getPosterOverlayCanvas() {
  // Return cached version if poster hasn't changed
  if (_overlayCanvas && _overlayPosterSrc === CONFIG.posterSrc) {
    return _overlayCanvas;
  }

  const area = CONFIG.photoArea;
  const W = state.posterW;
  const H = state.posterH;

  const oc  = document.createElement('canvas');
  oc.width  = W;
  oc.height = H;
  const oc_ctx = oc.getContext('2d');

  // Draw the full poster
  oc_ctx.drawImage(state.posterImg, 0, 0, W, H);

  // Remove only the connected white background. The performers and headline
  // overlap the circle, so cutting out the entire shape would erase them too.
  if (area.shape === 'ellipse') {
    const imageData = oc_ctx.getImageData(0, 0, W, H);
    const pixels = imageData.data;
    const visited = new Uint8Array(W * H);
    const stack = [
      Math.floor(area.x + area.width / 2),
      Math.floor(area.y + area.height / 2),
    ];
    const rx = area.width / 2;
    const ry = area.height / 2;
    const cx = area.x + rx;
    const cy = area.y + ry;

    while (stack.length) {
      const y = stack.pop();
      const x = stack.pop();
      if (x < area.x || x >= area.x + area.width || y < area.y || y >= area.y + area.height) continue;

      const index = y * W + x;
      if (visited[index]) continue;
      visited[index] = 1;

      const ellipseX = (x - cx) / rx;
      const ellipseY = (y - cy) / ry;
      if (ellipseX * ellipseX + ellipseY * ellipseY > 1) continue;

      const pixelIndex = index * 4;
      if (pixels[pixelIndex] < 220 || pixels[pixelIndex + 1] < 220 || pixels[pixelIndex + 2] < 220) continue;

      pixels[pixelIndex + 3] = 0;
      stack.push(x - 1, y, x + 1, y, x, y - 1, x, y + 1);
    }

    oc_ctx.putImageData(imageData, 0, 0);
  } else {
    oc_ctx.globalCompositeOperation = 'destination-out';
    const r = area.radius || 0;
    const x = area.x, y = area.y, w = area.width, h = area.height;
    oc_ctx.beginPath();
    oc_ctx.moveTo(x + r, y);
    oc_ctx.arcTo(x + w, y,     x + w, y + h, r);
    oc_ctx.arcTo(x + w, y + h, x,     y + h, r);
    oc_ctx.arcTo(x,     y + h, x,     y,     r);
    oc_ctx.arcTo(x,     y,     x + w, y,     r);
    oc_ctx.closePath();
    oc_ctx.fill();
    oc_ctx.globalCompositeOperation = 'source-over';
  }

  _overlayCanvas  = oc;
  _overlayPosterSrc = CONFIG.posterSrc;
  return oc;
}

/* ============================================================
   7. PHOTO MASKING
   Clips the user photo to the configured photo area shape.
============================================================ */

/**
 * drawClippedPhoto — renders the user photo inside the configured clip shape.
 * @param {CanvasRenderingContext2D} targetCtx - the canvas context to draw into
 */
function drawClippedPhoto(targetCtx) {
  const area  = CONFIG.photoArea;
  const photo = state.photo;

  targetCtx.save();

  // --- Build the clip path ---
  targetCtx.beginPath();

  if (area.shape === 'ellipse') {
    // Canvas ellipse: centre, radii x/y, rotation, startAngle, endAngle
    targetCtx.ellipse(
      area.x + area.width  / 2,   // cx
      area.y + area.height / 2,   // cy
      area.width  / 2,            // rx
      area.height / 2,            // ry
      0,                          // rotation
      0, Math.PI * 2              // full circle
    );
  } else {
    // Rounded rectangle
    const r = area.radius || 0;
    const x = area.x, y = area.y, w = area.width, h = area.height;
    targetCtx.moveTo(x + r, y);
    targetCtx.arcTo(x + w, y,     x + w, y + h, r);
    targetCtx.arcTo(x + w, y + h, x,     y + h, r);
    targetCtx.arcTo(x,     y + h, x,     y,     r);
    targetCtx.arcTo(x,     y,     x + w, y,     r);
    targetCtx.closePath();
  }

  targetCtx.clip();

  // --- Draw the user photo ---
  // photo.x / photo.y are offsets within the area bounding box
  const scaledW = state.baseW * photo.scale;
  const scaledH = state.baseH * photo.scale;

  targetCtx.drawImage(
    state.userImg,
    area.x + photo.x,   // canvas x
    area.y + photo.y,   // canvas y
    scaledW,
    scaledH
  );

  targetCtx.restore();
}

/* ============================================================
   8. DRAGGING — mouse + touch/pointer events
============================================================ */

/**
 * Convert a pointer event's client coordinates to
 * canvas-internal (poster-pixel) coordinates.
 */
function clientToCanvas(clientX, clientY) {
  const rect = previewCanvas.getBoundingClientRect();
  const relX  = clientX - rect.left;
  const relY  = clientY - rect.top;
  return {
    x: relX * state.displayScale,
    y: relY * state.displayScale,
  };
}

// --- Pointer down ---
function onPointerDown(e) {
  if (!state.userImg) return;

  // Two-finger pinch start
  if (e.touches && e.touches.length === 2) {
    state.drag.lastDist = getTouchDist(e.touches);
    return;
  }

  e.preventDefault();
  const { x, y } = getEventPos(e);

  state.drag.active  = true;
  state.drag.startX  = x;
  state.drag.startY  = y;
  state.drag.startPX = state.photo.x;
  state.drag.startPY = state.photo.y;
}

// --- Pointer move ---
function onPointerMove(e) {
  if (!state.userImg) return;

  // Two-finger pinch move
  if (e.touches && e.touches.length === 2) {
    const dist = getTouchDist(e.touches);
    const delta = dist - state.drag.lastDist;
    state.drag.lastDist = dist;
    adjustZoom(delta * 0.5);
    return;
  }

  if (!state.drag.active) return;
  e.preventDefault();

  const { x, y } = getEventPos(e);
  const dx = (x - state.drag.startX);
  const dy = (y - state.drag.startY);

  state.photo.x = state.drag.startPX + dx;
  state.photo.y = state.drag.startPY + dy;

  clampPhoto();
}

// --- Pointer up ---
function onPointerUp(e) {
  state.drag.active = false;
}

function getTouchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function getEventPos(e) {
  const source = e.touches ? e.touches[0] : e;
  return clientToCanvas(source.clientX, source.clientY);
}

/* ============================================================
   9. ZOOMING
============================================================ */

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4.0;
const ZOOM_STEP = 0.05;   // per button click

function setZoom(newScale) {
  newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newScale));

  // Keep the photo centred inside the area as we zoom
  const area = CONFIG.photoArea;
  const oldScale = state.photo.scale;
  const ratio    = newScale / oldScale;

  // Anchor to area centre
  const cx = area.width  / 2;
  const cy = area.height / 2;
  const relX = state.photo.x - cx;
  const relY = state.photo.y - cy;

  state.photo.x = cx + relX * ratio;
  state.photo.y = cy + relY * ratio;
  state.photo.scale = newScale;

  clampPhoto();
  syncZoomUI();
}

function adjustZoom(delta) {
  setZoom(state.photo.scale + delta);
}

/** Keep the photo filling the clip area (no empty space visible). */
function clampPhoto() {
  const area   = CONFIG.photoArea;
  const photo  = state.photo;
  const scaledW = state.baseW * photo.scale;
  const scaledH = state.baseH * photo.scale;

  // Left edge: photo.x must be ≤ 0 (photo covers left of area)
  const minX = area.width  - scaledW;
  const minY = area.height - scaledH;

  photo.x = Math.min(0, Math.max(minX, photo.x));
  photo.y = Math.min(0, Math.max(minY, photo.y));
}

function syncZoomUI() {
  const pct = Math.round(state.photo.scale * 100);
  const display = document.getElementById('zoomDisplay');
  if (display) display.textContent = pct + '%';
  // Slider range 50–300 maps to scale 0.5–3.0
  document.getElementById('zoomSlider').value = pct;
}

/* ============================================================
   10. RESET
============================================================ */
function resetPhotoTransform() {
  state.photo.x     = 0;
  state.photo.y     = 0;
  state.photo.scale = 1.0;
  clampPhoto();
  syncZoomUI();
}

/* ============================================================
   11. PNG EXPORT — high-resolution canvas render
============================================================ */

/**
 * Renders the final composite at the poster's original resolution.
 * Returns a data-URL (PNG).
 *
 * Layer order (important!):
 *   1. Poster image       ← drawn first (background)
 *   2. User photo clipped ← drawn on top (but inside oval only)
 *   3. Poster image again ← drawn last   (foreground decoration)
 *
 * The final poster overlay (step 3) causes the ornate golden frame
 * around the oval to sit ON TOP of the user photo, which looks
 * correct and intentional.
 */
function exportPoster() {
  const exportCanvas = document.getElementById('exportCanvas');
  exportCanvas.width  = state.posterW;
  exportCanvas.height = state.posterH;

  const ec = exportCanvas.getContext('2d');
  ec.clearRect(0, 0, state.posterW, state.posterH);

  // 1. Draw full poster as background (fills entire canvas including behind oval)
  ec.drawImage(state.posterImg, 0, 0, state.posterW, state.posterH);

  // 2. Draw user photo clipped to the oval mask on top of the background
  if (state.userImg) {
    drawClippedPhoto(ec);
  }

  // 3. Draw the poster overlay (oval punched out) so the ornate frame ring
  //    sits on top of the photo while the oval interior shows the photo clearly.
  const overlay = getPosterOverlayCanvas();
  ec.drawImage(overlay, 0, 0);

  return exportCanvas.toDataURL('image/png');
}

/* ============================================================
   12. DOWNLOAD
============================================================ */
function triggerDownload(dataURL) {
  const link = document.getElementById('downloadBtn');
  link.href = dataURL;
  link.download = 'my-poster.png';
  // Optionally auto-click:
  // link.click();
}

/* ============================================================
   13. UI HELPERS
============================================================ */

function showLoading(msg) {
  let el = document.getElementById('loadingOverlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'loadingOverlay';
    el.className = 'loading-overlay';
    el.innerHTML = `<div class="spinner"></div><p id="loadingMsg">${msg}</p>`;
    document.body.appendChild(el);
  } else {
    document.getElementById('loadingMsg').textContent = msg;
    el.style.display = 'flex';
  }
}

function hideLoading() {
  const el = document.getElementById('loadingOverlay');
  if (el) el.style.display = 'none';
}

function showError(msg) {
  alert('⚠️ ' + msg);
}

/* ============================================================
   14. INIT — wire everything together
============================================================ */
async function init() {
  // ---- 1. Load poster ----
  showLoading('Loading poster…');
  try {
    await loadPoster();
  } catch (err) {
    hideLoading();
    showError(err.message);
    return;
  }
  hideLoading();

  // ---- 2. Position the step-1 photo-area indicator overlay ----
  positionIndicatorOverlay();

  // ---- 3. File inputs ----
  const fileInput      = document.getElementById('fileInput');
  const fileInputStep2 = document.getElementById('fileInputStep2');

  async function handleFile(file) {
    if (!file) return;
    showLoading('Loading your photo…');
    try {
      const img = await loadUserImage(file);
      applyUserImage(img);
      hideLoading();
      goToStep(2);
    } catch (err) {
      hideLoading();
      showError(err.message);
    }
  }

  fileInput.addEventListener('change', e => handleFile(e.target.files[0]));
  fileInputStep2.addEventListener('change', e => {
    handleFile(e.target.files[0]);
    // reset value so the same file can be re-selected
    e.target.value = '';
  });

  // ---- 4. Drag-and-drop onto upload area ----
  const uploadCard = document.querySelector('.upload-area');
  uploadCard.addEventListener('dragover', e => {
    e.preventDefault();
    document.body.classList.add('drag-over');
  });
  uploadCard.addEventListener('dragleave', () => {
    document.body.classList.remove('drag-over');
  });
  uploadCard.addEventListener('drop', e => {
    e.preventDefault();
    document.body.classList.remove('drag-over');
    handleFile(e.dataTransfer.files[0]);
  });

  // ---- 5. Canvas pointer events (drag) ----
  const canvasEl = document.getElementById('previewCanvas');

  // Mouse
  canvasEl.addEventListener('mousedown',  onPointerDown);
  window.addEventListener('mousemove',    onPointerMove);
  window.addEventListener('mouseup',      onPointerUp);

  // Touch (passive: false so we can call preventDefault)
  canvasEl.addEventListener('touchstart', onPointerDown, { passive: false });
  window.addEventListener('touchmove',    onPointerMove,  { passive: false });
  window.addEventListener('touchend',     onPointerUp);

  // ---- 6. Zoom controls ----
  document.getElementById('zoomIn').addEventListener('click', () => {
    adjustZoom(ZOOM_STEP * 2);
  });

  document.getElementById('zoomOut').addEventListener('click', () => {
    adjustZoom(-ZOOM_STEP * 2);
  });

  document.getElementById('zoomSlider').addEventListener('input', e => {
    const pct = parseInt(e.target.value, 10);
    setZoom(pct / 100);
  });

  // ---- 7. Mouse-wheel zoom on canvas ----
  canvasEl.addEventListener('wheel', e => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    adjustZoom(delta);
  }, { passive: false });

  // ---- 8. Reset button ----
  document.getElementById('resetBtn').addEventListener('click', resetPhotoTransform);

  // ---- 9. Done button — export + go to step 3 ----
  document.getElementById('doneBtn').addEventListener('click', () => {
    showLoading('Rendering your poster…');
    // Run on next tick to let the loading UI paint
    setTimeout(() => {
      try {
        const dataURL = exportPoster();
        document.getElementById('finalPreviewImg').src = dataURL;
        triggerDownload(dataURL);
        hideLoading();
        goToStep(3);
      } catch (err) {
        hideLoading();
        showError('Export failed: ' + err.message);
      }
    }, 80);
  });

  // ---- 10. Start Over ----
  document.getElementById('startOverBtn').addEventListener('click', () => {
    state.userImg = null;
    fileInput.value = '';
    fileInputStep2.value = '';
    resetPhotoTransform();
    goToStep(1);
  });

  // ---- 11. Resize → re-size canvas ----
  window.addEventListener('resize', () => {
    if (state.step === 2) sizePreviewCanvas();
    positionIndicatorOverlay();
  });

  // ---- 12. Start on step 1 ----
  goToStep(1);
}

/**
 * positionIndicatorOverlay
 * Positions the dashed-oval overlay in step 1 to match
 * the photo area as a percentage of the displayed poster image.
 */
function positionIndicatorOverlay() {
  const indicator = document.getElementById('photoAreaIndicator');
  const img       = document.getElementById('posterPreviewImg');
  if (!img || !indicator) return;

  const area = CONFIG.photoArea;

  if (!state.posterW || !state.posterH) {
    // Poster not loaded yet — use approximate fallback percentages
    indicator.style.left   = '21%';
    indicator.style.top    = '25.5%';
    indicator.style.width  = '58%';
    indicator.style.height = '26.5%';
    return;
  }

  // Convert poster-pixel coordinates to percentages
  indicator.style.left   = (area.x / state.posterW * 100).toFixed(2) + '%';
  indicator.style.top    = (area.y / state.posterH * 100).toFixed(2) + '%';
  indicator.style.width  = (area.width  / state.posterW * 100).toFixed(2) + '%';
  indicator.style.height = (area.height / state.posterH * 100).toFixed(2) + '%';
}

// Start the app
init();
