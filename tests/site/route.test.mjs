// Naming a connection's route (site/js/shared/route.js) and finding it in a browser's stats (viewer/stats.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeOf, isPrivateAddress, ROUTE_WORDS } from '../../site/js/shared/route.js';
import { selectedRoute, statsLines } from '../../site/js/viewer/stats.js';

test('private addresses', () => {
  for (const a of ['10.0.0.4', '192.168.1.23', '172.16.0.1', '172.31.255.1', '169.254.3.3', '127.0.0.1', 'fe80::1', 'fd12::3', '[fe80::2]']) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  for (const a of ['8.8.8.8', '172.32.0.1', '2606:4700::1', 'abc.local', '', null]) assert.equal(isPrivateAddress(a), false, String(a));
});

test('the route from the chosen pair of candidates', () => {
  assert.equal(routeOf('host', 'host', '192.168.1.40'), 'lan');
  assert.equal(routeOf('host', 'host', '2606:4700::1'), 'lan', 'two host candidates share a network');
  assert.equal(routeOf('host', 'prflx', '192.168.1.40'), 'lan');
  assert.equal(routeOf('srflx', 'host', '192.168.1.23'), 'lan');
  assert.equal(routeOf('srflx', 'srflx', '203.0.113.9'), 'internet');
  assert.equal(routeOf('host', 'srflx', '203.0.113.9'), 'internet');
  assert.equal(routeOf('relay', 'host', '192.168.1.23'), 'turn');
  assert.equal(routeOf('host', 'relay', '104.30.0.1'), 'turn');
  assert.equal(routeOf(null, 'host', '1.2.3.4'), null);
  assert.equal(Object.keys(ROUTE_WORDS).length, 4);
});

test("the viewer reads its route from the browser's stats", () => {
  const report = new Map([
    ['T01', { id: 'T01', type: 'transport', selectedCandidatePairId: 'CP2' }],
    ['CP1', { id: 'CP1', type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1', state: 'failed' }],
    ['CP2', { id: 'CP2', type: 'candidate-pair', localCandidateId: 'L2', remoteCandidateId: 'R2', state: 'succeeded', nominated: true }],
    ['L1', { id: 'L1', type: 'local-candidate', candidateType: 'relay' }],
    ['R1', { id: 'R1', type: 'remote-candidate', candidateType: 'host', address: '192.168.1.23' }],
    ['L2', { id: 'L2', type: 'local-candidate', candidateType: 'host' }],
    ['R2', { id: 'R2', type: 'remote-candidate', candidateType: 'host', address: '192.168.1.23' }],
  ]);
  assert.equal(selectedRoute(report), 'lan');
  // Without a transport entry (older browsers): the nominated, succeeded pair.
  report.delete('T01');
  assert.equal(selectedRoute(report), 'lan');
  report.get('L2').candidateType = 'relay';
  assert.equal(selectedRoute(report), 'turn');
  assert.equal(selectedRoute(new Map()), null, 'not chosen yet');
  assert.deepEqual(statsLines({}, { route: 'lan' })[0], ['Route', 'Direct, on your network']);
  assert.deepEqual(statsLines({}, {})[0], ['Route', '–']);
});

test('a viewer that goes by the relay says how many addresses of each kind it found', async () => {
  const { candidateCounts } = await import('../../site/js/ui/connection.js');
  const sdp = ['v=0', 'a=candidate:1 1 udp 2122260223 192.168.1.40 61233 typ host', 'a=candidate:2 1 udp 2122260223 abc.local 5000 typ host',
    'a=candidate:3 1 udp 1686052607 203.0.113.9 61233 typ srflx raddr 192.168.1.40 rport 61233'].join('\r\n');
  assert.deepEqual(candidateCounts(sdp), { host: 2, srflx: 1, relay: 0 });
  assert.deepEqual(candidateCounts(null), { host: 0, srflx: 0, relay: 0 });
});
