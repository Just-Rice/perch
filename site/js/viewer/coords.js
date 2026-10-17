// Where a finger or the mouse is on the Mac's screen.
//
// The video fills its box with `object-fit: contain`, so a picture with a different shape from the window gets black
// bars (letterboxing) and only the middle part is the Mac's screen. On top of that the viewer can zoom in locally
// (pinch on a phone): the box is moved and scaled with a CSS transform `translate(x, y) scale(s)` whose origin is the
// box's top-left corner. These pure functions undo both, turning a pointer position in page (client) pixels into
// display coordinates from 0 to 1, origin top-left, as docs/PROTOCOL.md ("Input and pointer channels") asks for.

export const IDENTITY = Object.freeze({ scale: 1, x: 0, y: 0 });
export const MAX_ZOOM = 5;

// The rectangle the picture occupies inside a box of `width × height` when shown with object-fit: contain.
// Until the first frame arrives the picture size is unknown (0): treat it as filling the whole box.
export function containRect(width, height, videoWidth, videoHeight) {
  if (!(videoWidth > 0 && videoHeight > 0) || !(width > 0 && height > 0)) return { x: 0, y: 0, width, height };
  const scale = Math.min(width / videoWidth, height / videoHeight);
  const w = videoWidth * scale, h = videoHeight * scale;
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Page pixels → display coordinates. `box` is the untransformed box ({left, top, width, height}, what
// getBoundingClientRect() gives for the element that holds the zoomed wrapper), `view` the local zoom and pan.
// Returns {x, y, inside}: x and y are clamped to 0..1 so a drag that leaves the picture still ends on the edge.
export function toDisplay(clientX, clientY, box, videoWidth, videoHeight, view = IDENTITY) {
  const localX = (clientX - box.left - view.x) / view.scale;
  const localY = (clientY - box.top - view.y) / view.scale;
  const pic = containRect(box.width, box.height, videoWidth, videoHeight);
  const nx = pic.width > 0 ? (localX - pic.x) / pic.width : 0;
  const ny = pic.height > 0 ? (localY - pic.y) / pic.height : 0;
  const inside = nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1;
  return { x: round(clamp(nx, 0, 1)), y: round(clamp(ny, 0, 1)), inside };
}

// Display coordinates → page pixels (the inverse, used to place things over the picture and in tests).
export function fromDisplay(x, y, box, videoWidth, videoHeight, view = IDENTITY) {
  const pic = containRect(box.width, box.height, videoWidth, videoHeight);
  return {
    x: box.left + view.x + (pic.x + x * pic.width) * view.scale,
    y: box.top + view.y + (pic.y + y * pic.height) * view.scale,
  };
}

// Six decimal places is far finer than any screen (a 6K display is 6016 pixels wide) and keeps messages short.
const round = v => Math.round(v * 1e6) / 1e6;

// Keeps a zoomed view covering the whole box: you can't pan the picture away into empty space.
export function clampView(view, box) {
  const scale = clamp(view.scale, 1, MAX_ZOOM);
  if (scale === 1) return IDENTITY;
  return {
    scale,
    x: clamp(view.x, box.width * (1 - scale), 0),
    y: clamp(view.y, box.height * (1 - scale), 0),
  };
}

// Zooms by `factor` keeping the spot under (clientX, clientY) where it is, like pinching a photo.
export function zoomAround(view, factor, clientX, clientY, box) {
  const scale = clamp(view.scale * factor, 1, MAX_ZOOM);
  const px = clientX - box.left, py = clientY - box.top;
  // The local point under the fingers before the zoom must stay under them after it.
  const lx = (px - view.x) / view.scale, ly = (py - view.y) / view.scale;
  return clampView({ scale, x: px - lx * scale, y: py - ly * scale }, box);
}

export function panView(view, dx, dy, box) {
  return clampView({ scale: view.scale, x: view.x + dx, y: view.y + dy }, box);
}

export const isZoomed = view => view.scale > 1.001;

// The CSS transform for the wrapper (transform-origin: 0 0).
export const viewTransform = view =>
  isZoomed(view) ? `translate(${view.x.toFixed(2)}px, ${view.y.toFixed(2)}px) scale(${view.scale.toFixed(4)})` : '';
