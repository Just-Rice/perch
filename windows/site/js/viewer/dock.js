// Where the Dock can sit: eight places around the screen (each edge's middle and each corner), which one a drop or an
// arrow key leads to, and what that place means for the picture. Pure functions (tested in Node); viewer.js moves the
// Dock itself.

export const ANCHORS = ['top-left', 'top', 'top-right', 'left', 'right', 'bottom-left', 'bottom', 'bottom-right'];

// Each place as a column and row of a 3×3 grid (the middle is the picture).
const GRID = {
  'top-left': [0, 0], top: [1, 0], 'top-right': [2, 0],
  left: [0, 1], right: [2, 1],
  'bottom-left': [0, 2], bottom: [1, 2], 'bottom-right': [2, 2],
};
const AT = new Map(Object.entries(GRID).map(([k, [c, r]]) => [`${c},${r}`, k]));

export const isAnchor = a => typeof a === 'string' && a in GRID;

// The place nearest to a point of the screen (W×H), as fractions of each side, so a tall phone and a wide monitor
// behave alike. A drop in the middle third of an edge goes to that edge's middle.
export function nearestAnchor(x, y, W, H) {
  const fx = W > 0 ? Math.min(1, Math.max(0, x / W)) : 0.5, fy = H > 0 ? Math.min(1, Math.max(0, y / H)) : 0.5;
  let best = 'top', bestD = Infinity;
  for (const [name, [c, r]] of Object.entries(GRID)) {
    const d = (fx - c / 2) ** 2 + (fy - r / 2) ** 2;
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
}

// One step with an arrow key (dx, dy of −1, 0 or 1), stepping over the middle.
export function stepAnchor(at, dx, dy) {
  const [c, r] = GRID[at] ?? GRID.top;
  let nc = Math.min(2, Math.max(0, c + dx)), nr = Math.min(2, Math.max(0, r + dy));
  if (nc === 1 && nr === 1) {
    nc = Math.min(2, Math.max(0, nc + dx));
    nr = Math.min(2, Math.max(0, nr + dy));
  }
  return AT.get(`${nc},${nr}`) ?? at;
}

// Standing up (the left and right middles) or lying along an edge.
export const isVertical = at => at === 'left' || at === 'right';

// The edge a place belongs to: where a Dock that tucks itself away goes, and which side of the picture makes room.
export function anchorEdge(at) {
  if (at === 'left' || at === 'right') return at;
  return String(at).startsWith('bottom') ? 'bottom' : 'top';
}

// Which side of the screen it is on, for things that should open on the other side (Tweaks).
export const onRight = at => at === 'right' || at === 'top-right' || at === 'bottom-right';
