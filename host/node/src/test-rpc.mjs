// Test mode only (PERCH_TEST=1 and PERCH_TEST_RPC_FD): lets a test drive the controller of a running host over an
// extra file descriptor, one JSON object per line: {id, method, args} → {id, result} or {id, error}. This stands in
// for the Setup page, so host tests don't depend on it, and it never touches the app's stdin/stdout protocol.
//
// `extras` are test-only levers that have no place in the controller interface, such as moving the host's clock
// forward so a test can use a fresh authenticator code without waiting 30 seconds.
import net from 'node:net';

const METHODS = new Set([
  'state', 'totpStart', 'totpConfirm', 'pairStart', 'pairCancel', 'deviceRename', 'deviceRemove', 'devicesRemoveAll',
  'suggestPassword', 'backupRegisterStart', 'backupRegisterFinish', 'backupRemove', 'updateSettings', 'disconnect',
  'requestPermission', 'newMacName', 'reset', 'checkForUpdates', 'testInputEcho', 'testState', 'debug',
]);

export function startTestRpc(fd, controller, log, extras = {}) {
  const sock = new net.Socket({ fd, readable: true, writable: true });
  sock.setEncoding('utf8');
  let buf = '';
  const reply = obj => { try { sock.write(JSON.stringify(obj) + '\n'); } catch {} };
  async function handle(line) {
    let req;
    try { req = JSON.parse(line); } catch { return; }
    const { id, method, args = [] } = req ?? {};
    try {
      let result;
      if (Object.hasOwn(extras, method)) result = await extras[method](...args);
      else if (METHODS.has(method)) result = await controller[method](...args);
      else throw new Error(`no method ${method}`);
      reply({ id, result: result ?? null });
    } catch (e) {
      reply({ id, error: e.message });
    }
  }
  sock.on('data', d => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      handle(line);
    }
  });
  sock.on('error', e => log.debug(`test rpc: ${e.message}`));
  // The test closing its end must not keep the host alive or crash it.
  sock.unref();
  log.info(`test control channel on fd ${fd}`);
  return sock;
}
