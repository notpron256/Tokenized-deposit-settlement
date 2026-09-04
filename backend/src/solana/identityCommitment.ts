/**
 * The Travel Rule identity commitment (Move/transfer flow, check 2,
 * spec-001.md): a cryptographic commitment to a client's identity data,
 * posted on-chain alongside their reference ID so anyone with database
 * access can later prove the record hasn't changed since a given transfer.
 *
 * Extracted out of flows/transferFlow.ts (which still builds the memo
 * field from these) so the new Transaction Evidence view can recompute
 * the *exact* same hash independently, from a plain read of the current
 * Postgres row — sharing this code, not just conceptually promising the
 * same canonicalization, is what makes "recompute and compare" a real
 * verification rather than a restatement of the same claim.
 */
import crypto from "node:crypto";

export interface IdentityFields {
  name: string;
  registration_id: string;
  legal_address: string;
}

/**
 * Canonical, unambiguous byte serialization of a client's Travel Rule
 * identity fields — name, registration ID, legal address, in this fixed
 * order — for hashing (identityHash below). Each field is length-prefixed
 * (its UTF-8 byte length, decimal, then ":", then the field's own UTF-8
 * bytes) rather than joined with a plain separator character. A plain
 * separator would make the encoding ambiguous whenever a field's own
 * content happens to contain it: name="A|B", registrationId="C" would
 * hash identically to name="A", registrationId="B|C" under naive
 * "|"-joining. Length-prefixing removes that ambiguity regardless of
 * field content.
 */
export function canonicalIdentityBytes(client: IdentityFields): Buffer {
  const fields = [client.name, client.registration_id, client.legal_address];
  return Buffer.concat(
    fields.map((field) => {
      const bytes = Buffer.from(field, "utf-8");
      return Buffer.concat([Buffer.from(`${bytes.length}:`, "utf-8"), bytes]);
    }),
  );
}

/** SHA-256 of canonicalIdentityBytes, as a lowercase hex digest. */
export function identityHash(client: IdentityFields): string {
  return crypto.createHash("sha256").update(canonicalIdentityBytes(client)).digest("hex");
}
