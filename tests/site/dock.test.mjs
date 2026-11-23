// Where the Dock can sit (site/js/viewer/dock.js) and how the Command palette finds actions (viewer/palette.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ANCHORS, nearestAnchor, stepAnchor, isVertical, anchorEdge, onRight, isAnchor } from '../../site/js/viewer/dock.js';
import { matchScore, filterActions } from '../../site/js/viewer/palette.js';

test('the Dock snaps to the nearest of eight places, judged as fractions of the screen', () => {
  assert.equal(ANCHORS.length, 8);
  const W = 1280, H = 800;
  assert.equal(nearestAnchor(640, 5, W, H), 'top');
  assert.equal(nearestAnchor(640, 795, W, H), 'bottom');
  assert.equal(nearestAnchor(10, 400, W, H), 'left');
  assert.equal(nearestAnchor(1270, 400, W, H), 'right');
  assert.equal(nearestAnchor(40, 760, W, H), 'bottom-left');
  assert.equal(nearestAnchor(1250, 20, W, H), 'top-right');
  // A tall phone: the same fractions, so a drop near the bottom right corner goes there.
  assert.equal(nearestAnchor(370, 820, 390, 844), 'bottom-right');
  assert.equal(nearestAnchor(195, 830, 390, 844), 'bottom');
  // Off the screen (a drag past the edge) still lands somewhere sensible.
  assert.equal(nearestAnchor(-50, -50, W, H), 'top-left');
  assert.ok(isAnchor('top') && !isAnchor('middle') && !isAnchor(null));
});

test('arrow keys step to the next place that way, over the middle', () => {
  assert.equal(stepAnchor('bottom-left', 1, 0), 'bottom');
  assert.equal(stepAnchor('bottom', 0, -1), 'top', 'up from the bottom middle skips the picture');
  assert.equal(stepAnchor('left', 1, 0), 'right');
  assert.equal(stepAnchor('top-left', -1, 0), 'top-left', 'stays at the edge');
  assert.equal(stepAnchor('top-right', 0, 1), 'right');
});

test('what each place means: standing up, its edge, its side', () => {
  assert.deepEqual(ANCHORS.filter(isVertical), ['left', 'right']);
  assert.equal(anchorEdge('top-left'), 'top');
  assert.equal(anchorEdge('bottom-right'), 'bottom');
  assert.equal(anchorEdge('left'), 'left');
  assert.deepEqual(ANCHORS.filter(onRight), ['top-right', 'right', 'bottom-right']);
});

test('the Command palette: every word must match; label starts rank first; hidden actions are left out', () => {
  const A = [
    { id: 'tm', group: 'Session', label: 'Open Task Manager', hint: 'Ctrl+Shift+Esc', keywords: 'force quit kill' },
    { id: 'paste', group: 'Clipboard', label: 'Paste on the PC' },
    { id: 'q', group: 'Picture', label: 'Quality: Sharp', keywords: 'resolution' },
    { id: 'gone', group: 'Picture', label: 'Fit this window', when: () => false },
  ];
  assert.equal(matchScore(A[0], ''), 0);
  assert.equal(matchScore(A[0], 'open'), 0);
  assert.equal(matchScore(A[0], 'open task'), 1, 'one word at the start of the label, one at the start of a word');
  assert.ok(matchScore(A[0], 'task') < matchScore(A[0], 'anag'), 'a word start beats the middle of a word');
  assert.ok(matchScore(A[0], 'kill') > 0, 'keywords count, but less');
  assert.equal(matchScore(A[0], 'task zebra'), null, 'every word must be found');
  assert.equal(matchScore(A[1], 'PASTE'), 0, 'case does not matter');
  assert.deepEqual(filterActions(A, '').map(a => a.id), ['tm', 'paste', 'q']);
  assert.deepEqual(filterActions(A, 'quit').map(a => a.id), ['tm']);
  assert.deepEqual(filterActions(A, 'resolution').map(a => a.id), ['q']);
  assert.deepEqual(filterActions(A, 'fit').map(a => a.id), []);
});
