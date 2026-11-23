// Setting the backup sign-in password with OPAQUE (@serenity-kit/opaque), run here in the page so the password
// itself never leaves it: the Mac only ever receives a registration request and, at the end, a registration record
// (a verifier it can check sign-ins against, which can't be turned back into the password).
// Steps: client.startRegistration -> Mac's backupRegisterStart -> client.finishRegistration -> backupRegisterFinish.

let loading = null;

// The OPAQUE module is about 430 KB with its WebAssembly inside, so it's only fetched when it's needed (or when the
// password box is first used, to have it ready by the time Save is pressed).
export function loadOpaque() {
  loading ??= import('/vendor/opaque/index.js')
    .then(async (opaque) => { await opaque.ready; return opaque; })
    .catch((e) => {
      loading = null;
      console.warn('Setup: OPAQUE failed to load', e);
      throw new Error('Couldn\'t load the part of Setup that protects your password. Reload the page and try again.');
    });
  return loading;
}

// `post(action, body)` sends one request to Perch and resolves to its result.
export async function registerBackupPassword(password, post) {
  const opaque = await loadOpaque();
  const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({ password });
  const { registrationResponse } = await post('backupRegisterStart', { registrationRequest });
  let registrationRecord;
  try {
    ({ registrationRecord } = opaque.client.finishRegistration({ clientRegistrationState, registrationResponse, password }));
  } catch (e) {
    console.warn('Setup: finishRegistration failed', e);
    throw new Error('The password couldn\'t be saved. Please try again.');
  }
  await post('backupRegisterFinish', { registrationRecord });
}
