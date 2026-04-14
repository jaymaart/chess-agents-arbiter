import crypto from "crypto";

export function hashData(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function signData(data: string, privateKeyPem: string): string {
  const sig = crypto.sign(null, Buffer.from(data), privateKeyPem);
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
