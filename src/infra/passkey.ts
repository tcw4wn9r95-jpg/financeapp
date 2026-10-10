/**
 * Face ID / Touch ID unlock through a passkey with the WebAuthn PRF
 * extension (D-44). The authenticator returns a 32-byte secret for a given
 * salt only after biometric verification; the vault uses it to unwrap the
 * data key. Nothing here leaves the device: no server, the challenge is
 * random and never checked (no assertion is verified, only the PRF output
 * matters, and a wrong one simply fails to decrypt).
 */

export class PasskeyError extends Error {
  constructor(public readonly code: 'unsupported' | 'noPrf' | 'cancelled' | 'failed') {
    super(code);
  }
}

const RP_NAME = 'CasaresSan Finances';

function random(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

function bytes(b: ArrayBuffer | ArrayBufferView | undefined): Uint8Array | undefined {
  if (!b) return undefined;
  return b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

function ab(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(u.byteLength);
  out.set(u);
  return out;
}

function b64url(u: Uint8Array): string {
  let s = '';
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A platform authenticator (Face ID, Touch ID, Windows Hello…) is available. PRF support is only known after trying. */
export async function passkeysAvailable(): Promise<boolean> {
  try {
    return typeof PublicKeyCredential !== 'undefined' && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

function wrapError(e: unknown): PasskeyError {
  if (e instanceof PasskeyError) return e;
  if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError')) return new PasskeyError('cancelled');
  if (e instanceof DOMException && e.name === 'NotSupportedError') return new PasskeyError('unsupported');
  return new PasskeyError('failed');
}

interface PrfResults {
  enabled?: boolean;
  results?: { first?: ArrayBuffer | ArrayBufferView };
}

/** Ask for Face ID and return the PRF output of one of these passkeys. */
export async function evaluatePasskey(slots: readonly { credentialId: Uint8Array; prfSalt: Uint8Array }[]): Promise<{ credentialId: Uint8Array; prf: Uint8Array }> {
  try {
    const cred = (await navigator.credentials.get({
      publicKey: {
        challenge: random(32),
        allowCredentials: slots.map((s) => ({ type: 'public-key' as const, id: ab(s.credentialId), transports: ['internal' as const, 'hybrid' as const] })),
        userVerification: 'required',
        timeout: 60_000,
        extensions: { prf: { evalByCredential: Object.fromEntries(slots.map((s) => [b64url(s.credentialId), { first: ab(s.prfSalt) }])) } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (!cred) throw new PasskeyError('cancelled');
    const prf = bytes((cred.getClientExtensionResults() as { prf?: PrfResults }).prf?.results?.first);
    if (!prf) throw new PasskeyError('noPrf');
    return { credentialId: new Uint8Array(cred.rawId), prf };
  } catch (e) {
    throw wrapError(e);
  }
}

/**
 * Create a passkey for this vault and get its PRF output. Some browsers
 * return the PRF result at creation; others only report support, so a
 * second Face ID prompt fetches it.
 */
export async function registerPasskey(label: string): Promise<{ credentialId: Uint8Array; prfSalt: Uint8Array; prf: Uint8Array }> {
  const prfSalt = random(32);
  let credentialId: Uint8Array;
  let prf: Uint8Array | undefined;
  try {
    const cred = (await navigator.credentials.create({
      publicKey: {
        rp: { name: RP_NAME },
        user: { id: random(16), name: label, displayName: label },
        challenge: random(32),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
        timeout: 60_000,
        extensions: { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (!cred) throw new PasskeyError('cancelled');
    credentialId = new Uint8Array(cred.rawId);
    const ext = (cred.getClientExtensionResults() as { prf?: PrfResults }).prf;
    if (ext && ext.enabled === false) throw new PasskeyError('noPrf');
    prf = bytes(ext?.results?.first);
  } catch (e) {
    throw wrapError(e);
  }
  if (!prf) prf = (await evaluatePasskey([{ credentialId, prfSalt }])).prf;
  return { credentialId, prfSalt, prf };
}
