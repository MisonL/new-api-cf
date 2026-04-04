import { ApiError } from './errors';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toHex(new Uint8Array(digest));
}

export async function hashApiToken(token: string): Promise<string> {
  return sha256(token);
}

export function generateApiToken(): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(24));
  return `na_cf_${toBase64Url(randomBytes)}`;
}

export function last4OfToken(token: string): string {
  return token.slice(-4);
}

export function readBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) {
    return null;
  }

  const [scheme, token] = authorizationHeader.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return null;
  }

  return token;
}

export function requireBearerToken(authorizationHeader: string | undefined): string {
  const token = readBearerToken(authorizationHeader);
  if (!token) {
    throw new ApiError(401, 'UNAUTHORIZED', 'missing bearer token');
  }
  return token;
}

