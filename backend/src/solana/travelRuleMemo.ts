/**
 * Parses the raw Travel Rule memo string (spec-001.md Move/transfer flow,
 * check 2) back into its four MT103-tagged fields, and further splits the
 * :50K:/:59: party fields into their `<clientId>:<identityHash>` parts —
 * used by the Transaction Evidence view to display exactly what's on-chain
 * and to know which two Postgres records to re-verify against.
 */
export const MEMO_PROGRAM_V1 = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
export const MEMO_PROGRAM_V3 = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

const TRAVEL_RULE_MEMO_TAGS = [":20:", ":50K:", ":59:", ":70:"];

export interface TravelRulePartyField {
  clientId: string;
  identityHash: string;
}

export interface ParsedTravelRuleMemo {
  raw: string;
  reference: string;
  ordering: TravelRulePartyField;
  beneficiary: TravelRulePartyField;
  remittance: string;
}

function parsePartyField(content: string): TravelRulePartyField | null {
  const parts = content.split(":");
  if (parts.length !== 2) return null;
  const [clientId, identityHash] = parts;
  if (clientId.length === 0 || identityHash.length === 0) return null;
  return { clientId, identityHash };
}

/** Returns null if `text` isn't a well-formed Travel Rule memo (same
 * four-tag, "|"-delimited shape the compliance-hook program itself
 * requires) — used to tell a real transfer's memo apart from anything
 * else that might show up in transaction logs. */
export function parseTravelRuleMemo(text: string): ParsedTravelRuleMemo | null {
  const fields = text.split("|");
  if (fields.length !== TRAVEL_RULE_MEMO_TAGS.length) return null;

  const contents = fields.map((field, i) =>
    field.startsWith(TRAVEL_RULE_MEMO_TAGS[i]) ? field.slice(TRAVEL_RULE_MEMO_TAGS[i].length) : null,
  );
  if (contents.some((c) => c === null || c.length === 0)) return null;
  const [reference, orderingRaw, beneficiaryRaw, remittance] = contents as string[];

  const ordering = parsePartyField(orderingRaw);
  const beneficiary = parsePartyField(beneficiaryRaw);
  if (!ordering || !beneficiary) return null;

  return { raw: text, reference, ordering, beneficiary, remittance };
}
