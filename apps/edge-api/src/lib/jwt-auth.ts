import type { SessionInfo } from '../../../../packages/shared/src/contracts';
import type { RuntimeConfig } from './config';

type JwtPayload = {
  sub?: string;
  role?: string;
  exp?: number;
  iss?: string;
  aud?: string | string[];
};

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function importSigningKey(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
}

async function verifySignature(payload: string, signature: string, secret: string): Promise<boolean> {
  const key = await importSigningKey(secret);
  return crypto.subtle.verify(
    'HMAC',
    key,
    toArrayBuffer(fromBase64Url(signature)),
    new TextEncoder().encode(payload)
  );
}

function decodeJson<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(fromBase64Url(value))) as T;
}

function isAudienceValid(expectedAudience: string | undefined, audience: JwtPayload['aud']): boolean {
  if (!expectedAudience) {
    return true;
  }

  if (typeof audience === 'string') {
    return audience === expectedAudience;
  }

  return Array.isArray(audience) ? audience.includes(expectedAudience) : false;
}

export async function readSessionFromJwt(
  authorizationHeader: string | undefined,
  config: RuntimeConfig
): Promise<SessionInfo | null> {
  try {
    if (!config.adminJwtSecret || !authorizationHeader) {
      return null;
    }

    const [scheme, token] = authorizationHeader.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      return null;
    }

    const [headerPart, payloadPart, signaturePart] = token.split('.');
    if (!headerPart || !payloadPart || !signaturePart) {
      return null;
    }

    const header = decodeJson<{ alg?: string; typ?: string }>(headerPart);
    if (header.alg !== 'HS256') {
      return null;
    }

    const verified = await verifySignature(`${headerPart}.${payloadPart}`, signaturePart, config.adminJwtSecret);
    if (!verified) {
      return null;
    }

    const payload = decodeJson<JwtPayload>(payloadPart);
    if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }

    if (config.adminJwtIssuer && payload.iss !== config.adminJwtIssuer) {
      return null;
    }

    if (!isAudienceValid(config.adminJwtAudience, payload.aud)) {
      return null;
    }

    const isAdmin = payload.role === 'admin' || payload.sub === 'admin';
    if (!isAdmin) {
      return null;
    }

    return {
      authenticated: true,
      authMode: 'jwt',
      userId: payload.sub || 'admin',
      role: 'admin'
    };
  } catch {
    return null;
  }
}
