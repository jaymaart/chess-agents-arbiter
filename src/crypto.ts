import crypto from "crypto";

export function publicKeyFromPrivate(privateKeyPem: string): string {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const publicKey = crypto.createPublicKey(privateKey);
  return publicKey.export({ type: "spki", format: "pem" }).toString();
}

export function hashData(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Sign data — auto-detects Ed25519 (null digest) vs RSA (sha256 digest).
 */
export function signData(data: string, privateKeyPem: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const alg = key.asymmetricKeyType === "rsa" ? "sha256" : null;
  const sig = crypto.sign(alg, Buffer.from(data), key);
  return sig.toString("base64");
}

export function verifyData(
  data: string,
  signatureBase64: string,
  publicKeyPem: string
): boolean {
  try {
    return crypto.verify(
      null,
      Buffer.from(data),
      publicKeyPem,
      Buffer.from(signatureBase64, "base64")
    );
  } catch {
    return false;
  }
}

/**
 * Decrypt a payload produced by the server's encryptForArbiter().
 * Expects JSON string: { encryptedKey, iv, authTag, ciphertext }.
 */
export function decryptFromServer(encryptedPayload: string, privateKeyPem: string): string {
  const { encryptedKey, iv, authTag, ciphertext } = JSON.parse(encryptedPayload);

  const aesKey = crypto.privateDecrypt(
    {
      key: privateKeyPem,
      oaepHash: "sha256",
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    },
    Buffer.from(encryptedKey, "base64")
  );

  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(authTag, "base64"));

  return (
    decipher.update(Buffer.from(ciphertext, "base64")).toString("utf8") +
    decipher.final("utf8")
  );
}
