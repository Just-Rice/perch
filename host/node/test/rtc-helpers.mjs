// Two werift peers on this Mac: the host's HostPeer and a soft viewer's answering peer, joined without rendezvous.
import { HostPeer } from '../src/rtc.mjs';
import { SoftViewer } from './soft-viewer.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function connect({ tamperAnswer } = {}) {
  const host = new HostPeer({ iceServers: [], iceLoopback: true });
  const viewer = new SoftViewer({ brokers: [] });
  const pc = viewer._peer();
  const offer = await host.createOffer();
  await pc.setRemoteDescription({ type: 'offer', sdp: offer });
  await pc.setLocalDescription(await pc.createAnswer());
  for (let i = 0; i < 100 && pc.iceGatheringState !== 'complete'; i++) await sleep(20);
  const answer = pc.localDescription.sdp;
  await host.acceptAnswer(tamperAnswer ? tamperAnswer(answer) : answer);
  return { host, viewer, pc, offer, answer };
}

export function waitConnected(host, ms = 8000) {
  return new Promise(resolve => {
    if (host.connectionState === 'connected') return resolve('connected');
    const timer = setTimeout(() => resolve(`timeout (${host.connectionState})`), ms);
    host.onConnectionState(s => {
      if (s === 'connected' || s === 'failed' || s === 'closed') { clearTimeout(timer); resolve(s); }
    });
  });
}
