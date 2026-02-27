import crypto from 'crypto';

/**
 * Encrypt a plaintext MT5 password using AES-256-GCM.
 * Matches the cryptography.hazmat.primitives.ciphers.aead.AESGCM implementation in Python.
 * 
 * @param plaintext The MT5 password
 * @param masterKeyB64 Base64 encoded 32-byte master key
 * @returns { ciphertextB64: string, nonceB64: string }
 */
export function encryptMT5Password(plaintext: string, masterKeyB64: string) {
  const key = Buffer.from(masterKeyB64, 'base64');
  if (key.length !== 32) {
    throw new Error(`Master key must be 32 bytes, got ${key.length}`);
  }

  // Generate 12-byte nonce (96 bits)
  const nonce = crypto.randomBytes(12);
  
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Python's AESGCM appends the 16-byte tag to the ciphertext
  const ciphertextWithTag = Buffer.concat([encrypted, tag]);

  return {
    ciphertextB64: ciphertextWithTag.toString('base64'),
    nonceB64: nonce.toString('base64'),
  };
}
