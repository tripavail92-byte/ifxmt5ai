"""
crypto_utils.py
IFX MT5 Runtime — AES-256-GCM password decryption.

NEVER log or print the decrypted password.
"""

import base64
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def decrypt_mt5_password(
    ciphertext_b64: str,
    nonce_b64: str,
    master_key_b64: str,
) -> str:
    """
    Decrypt an MT5 account password stored as AES-256-GCM ciphertext.

    Args:
        ciphertext_b64:  Base64-encoded ciphertext (from DB field password_ciphertext_b64)
        nonce_b64:       Base64-encoded 12-byte nonce (from DB field password_nonce_b64)
        master_key_b64:  Base64-encoded 32-byte master key (from env MT5_CREDENTIALS_MASTER_KEY_B64)

    Returns:
        Plaintext password as a string.

    Raises:
        ValueError:  If key length is not 32 bytes after decoding.
        cryptography.exceptions.InvalidTag: If ciphertext is tampered / wrong key.
    """
    key = base64.b64decode(master_key_b64)
    if len(key) != 32:
        raise ValueError(
            f"Master key must be 32 bytes after base64 decode, got {len(key)} bytes."
        )

    nonce = base64.b64decode(nonce_b64)
    ciphertext = base64.b64decode(ciphertext_b64)

    aesgcm = AESGCM(key)
    plaintext_bytes = aesgcm.decrypt(nonce, ciphertext, None)
    return plaintext_bytes.decode("utf-8")


def encrypt_mt5_password(plaintext: str, master_key_b64: str) -> tuple[str, str]:
    """
    Encrypt a plaintext MT5 password.
    Returns (ciphertext_b64, nonce_b64).

    Use this ONLY in the admin tool / credential registration flow.
    NEVER call from the worker or poller.
    """
    import os

    key = base64.b64decode(master_key_b64)
    if len(key) != 32:
        raise ValueError(
            f"Master key must be 32 bytes after base64 decode, got {len(key)} bytes."
        )

    nonce = os.urandom(12)  # 96-bit nonce for GCM
    aesgcm = AESGCM(key)
    ciphertext = aesgcm.encrypt(nonce, plaintext.encode("utf-8"), None)

    return base64.b64encode(ciphertext).decode(), base64.b64encode(nonce).decode()
