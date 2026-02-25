import crypto from 'crypto';

/** GitHub public keys endpoint for Copilot Extensions */
const GITHUB_KEYS_URI = 'https://api.github.com/meta/public_keys/copilot_api';

interface PublicKey {
  key_identifier: string;
  key: string;
  is_current: boolean;
}

// Simple in-memory cache — refreshed hourly
let cachedKeys: PublicKey[] = [];
let cacheExpiry = 0;

async function fetchPublicKeys(): Promise<PublicKey[]> {
  if (Date.now() < cacheExpiry && cachedKeys.length > 0) {
    return cachedKeys;
  }

  const response = await fetch(GITHUB_KEYS_URI, {
    headers: { 'User-Agent': 'java-backend-copilot-extension/1.0' },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch GitHub public keys: ${response.status}`);
  }

  const body = (await response.json()) as { public_keys: PublicKey[] };
  cachedKeys = body.public_keys;
  cacheExpiry = Date.now() + 60 * 60 * 1000; // 1 hour
  return cachedKeys;
}

/**
 * Verifies the ECDSA-P256-SHA256 signature that GitHub attaches to every
 * Copilot Extension request.
 *
 * Headers required:
 *   X-GitHub-Public-Key-Identifier  → keyId
 *   X-GitHub-Public-Key-Signature   → signature (base64)
 */
export async function verifySignature(
  rawBody: Buffer,
  keyId: string,
  signature: string,
): Promise<boolean> {
  try {
    const keys = await fetchPublicKeys();
    const key = keys.find((k) => k.key_identifier === keyId);
    if (!key) {
      console.warn(`[verify] Unknown key identifier: ${keyId}`);
      return false;
    }

    const verifier = crypto.createVerify('SHA256');
    verifier.update(rawBody);
    return verifier.verify(
      { key: key.key, format: 'pem' },
      Buffer.from(signature, 'base64'),
    );
  } catch (err) {
    console.error('[verify] Signature verification error:', err);
    return false;
  }
}
