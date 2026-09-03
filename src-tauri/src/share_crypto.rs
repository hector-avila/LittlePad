//! End-to-end encryption for shared documents (PLAN: real-time file sharing).
//!
//! The relay server never sees a document's content or its password — it
//! only relays whatever opaque `ciphertext`/`iv` bytes this module produces.
//! The AES key is derived from **both** the instance's Share API key and the
//! document's password (see `derive_key`): knowing only one of the two is
//! not enough to derive it, even though the API key itself does travel to
//! the server (as the tenant-grouping credential) — the password never does.
//!
//! A wrong password simply makes `decrypt` fail (the GCM authentication tag
//! won't verify): that failure *is* the password check. There is no
//! server-side validation step for it.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::Argon2;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use rand::RngCore;

const KEY_LEN: usize = 32; // AES-256
const NONCE_LEN: usize = 12; // 96-bit GCM nonce
const SALT_LEN: usize = 16;

/// A fresh random salt for `derive_key`, base64-encoded. Generated once by
/// whoever creates a share, then sent alongside the encrypted snapshot so
/// joiners can derive the same key from their own copy of the password.
pub fn generate_salt() -> String {
    let mut salt = [0u8; SALT_LEN];
    rand::rng().fill_bytes(&mut salt);
    B64.encode(salt)
}

/// Derives the AES-256 key for a share from the Share API key and the
/// document password, using Argon2id (memory-hard, so a captured ciphertext
/// doesn't make brute-forcing the password cheap). Run once per share, on
/// creation or on join — never per edit, since Argon2id is deliberately
/// slow.
pub fn derive_key(api_key: &str, password: &str, salt_b64: &str) -> Result<String, String> {
    let salt = B64.decode(salt_b64).map_err(|e| e.to_string())?;
    // NUL-separated so a boundary shift between the two secrets (e.g. "ab"+"c"
    // vs "a"+"bc") can't collide onto the same input keying material.
    let ikm = format!("{api_key}\0{password}");
    let mut key = [0u8; KEY_LEN];
    Argon2::default()
        .hash_password_into(ikm.as_bytes(), &salt, &mut key)
        .map_err(|e| e.to_string())?;
    Ok(B64.encode(key))
}

/// Encrypts `plaintext` with `key` (base64, from `derive_key`), returning
/// `(ciphertext, iv)`, both base64. A fresh random nonce is generated for
/// every call — reusing a nonce with the same key breaks AES-GCM's
/// confidentiality guarantees, so callers must never cache/reuse the `iv`.
pub fn encrypt(key_b64: &str, plaintext: &str) -> Result<(String, String), String> {
    let cipher = load_cipher(key_b64)?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok((B64.encode(ciphertext), B64.encode(nonce_bytes)))
}

/// Decrypts a `(ciphertext, iv)` pair produced by `encrypt` with the same
/// key. Fails (deliberately, generically) if the key/password was wrong or
/// the data was tampered with — GCM's authentication tag doesn't verify in
/// either case, and there's no way (or need) to tell them apart.
pub fn decrypt(key_b64: &str, ciphertext_b64: &str, iv_b64: &str) -> Result<String, String> {
    let cipher = load_cipher(key_b64)?;
    let nonce_bytes = B64.decode(iv_b64).map_err(|e| e.to_string())?;
    let ciphertext = B64.decode(ciphertext_b64).map_err(|e| e.to_string())?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_slice())
        .map_err(|_| "decryption failed: wrong password or corrupted data".to_string())?;
    String::from_utf8(plaintext).map_err(|e| e.to_string())
}

fn load_cipher(key_b64: &str) -> Result<Aes256Gcm, String> {
    let key_bytes = B64.decode(key_b64).map_err(|e| e.to_string())?;
    Aes256Gcm::new_from_slice(&key_bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_with_matching_key() {
        let salt = generate_salt();
        let key = derive_key("api-key", "correct horse", &salt).unwrap();
        let (ciphertext, iv) = encrypt(&key, "hello, shared world").unwrap();
        assert_eq!(decrypt(&key, &ciphertext, &iv).unwrap(), "hello, shared world");
    }

    #[test]
    fn fails_with_wrong_password() {
        let salt = generate_salt();
        let key = derive_key("api-key", "correct horse", &salt).unwrap();
        let wrong_key = derive_key("api-key", "wrong horse", &salt).unwrap();
        let (ciphertext, iv) = encrypt(&key, "hello, shared world").unwrap();
        assert!(decrypt(&wrong_key, &ciphertext, &iv).is_err());
    }

    #[test]
    fn fails_with_wrong_api_key() {
        let salt = generate_salt();
        let key = derive_key("api-key-a", "same password", &salt).unwrap();
        let wrong_key = derive_key("api-key-b", "same password", &salt).unwrap();
        let (ciphertext, iv) = encrypt(&key, "hello, shared world").unwrap();
        assert!(decrypt(&wrong_key, &ciphertext, &iv).is_err());
    }
}
