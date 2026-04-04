import type { SessionInfo } from '../../../../packages/shared/src/contracts';
import { ApiError } from './errors';

const COOKIE_NAME = 'new_api_cf_session';
const SESSION_TTL_SECONDS = 60 * 60 * 12;

type SessionPayload = {
  sub: 'admin';
  exp: number;
};

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

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
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

async function importSigningKey(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function signPayload(payload: string, secret: string): Promise<string> {
  const key = await importSigningKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return toBase64Url(new Uint8Array(signature));
}

async function verifyPayload(payload: string, signature: string, secret: string): Promise<boolean> {
  const key = await importSigningKey(secret);
  const signatureBytes = fromBase64Url(signature);
  return crypto.subtle.verify(
    'HMAC',
    key,
    toArrayBuffer(signatureBytes),
    new TextEncoder().encode(payload)
  );
}

function encodePayload(payload: SessionPayload): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

function decodePayload(payload: string): SessionPayload {
  const decoded = new TextDecoder().decode(fromBase64Url(payload));
  const parsed = JSON.parse(decoded) as SessionPayload;
  if (parsed.sub !== 'admin' || typeof parsed.exp !== 'number') {
    throw new ApiError(401, 'INVALID_SESSION', 'session payload is invalid');
  }
  return parsed;
}

function parseCookieHeader(cookieHeader: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!cookieHeader) {
    return cookies;
  }

  for (const item of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = item.trim().split('=');
    if (!rawName || rawValue.length === 0) {
      continue;
    }
    cookies.set(rawName, rawValue.join('='));
  }

  return cookies;
}

function buildCookieFlags(isSecure: boolean): string {
  return isSecure ? 'Path=/; HttpOnly; SameSite=Lax; Secure' : 'Path=/; HttpOnly; SameSite=Lax';
}

export async function createSessionCookie(secret: string, isSecure: boolean): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = encodePayload({
    sub: 'admin',
    exp: expiresAt
  });
  const signature = await signPayload(payload, secret);
  const token = `${payload}.${signature}`;

  return `${COOKIE_NAME}=${token}; ${buildCookieFlags(isSecure)}; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function createLogoutCookie(isSecure: boolean): string {
  return `${COOKIE_NAME}=; ${buildCookieFlags(isSecure)}; Max-Age=0`;
}

export async function readSessionFromCookie(
  cookieHeader: string | undefined,
  secret: string | undefined
): Promise<SessionInfo | null> {
  if (!secret) {
    return null;
  }

  const token = parseCookieHeader(cookieHeader).get(COOKIE_NAME);
  if (!token) {
    return null;
  }

  const [payload, signature] = token.split('.');
  if (!payload || !signature) {
    return null;
  }

  const verified = await verifyPayload(payload, signature, secret);
  if (!verified) {
    return null;
  }

  const decoded = decodePayload(payload);
  if (decoded.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }

  return {
    authenticated: true,
    authMode: 'session',
    userId: decoded.sub,
    role: 'admin'
  };
}
