import crypto from "node:crypto";

const INGEST_SIGNING_SECRET = (process.env.RELAY_SECRET ?? process.env.SIGNING_SECRET ?? "").trim();

function sha256HexUpper(body: string) {
  return crypto.createHash("sha256").update(body, "utf8").digest("hex").toUpperCase();
}

function hmacHexUpper(secret: string, payload: string) {
  return crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex").toUpperCase();
}

export function hasSigningSecret() {
  return INGEST_SIGNING_SECRET.length > 0;
}

export function verifySignedBody(opts: {
  canonicalPath: string;
  bodyText: string;
  ts: string;
  nonce: string;
  signature: string;
}) {
  if (!INGEST_SIGNING_SECRET) return true;
  if (!opts.ts || !opts.nonce || !opts.signature) return false;

  const bodyHash = sha256HexUpper(opts.bodyText);
  const stringToSign = `POST\n${opts.canonicalPath}\n${opts.ts}\n${opts.nonce}\n${bodyHash}`;
  const expected = hmacHexUpper(INGEST_SIGNING_SECRET, stringToSign);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(opts.signature.toUpperCase()));
}