/**
 * Lists every token account on-chain holding a balance of our mint, found
 * purely via `getProgramAccounts` on the Token-2022 program filtered by
 * mint — no Postgres involved. Client names aren't looked up (that would
 * mean touching Postgres); this only knows what's on-chain: ATA address,
 * owner pubkey, and balance.
 *
 * Token-2022 accounts carry variable-length extension data appended after
 * the base 165-byte SPL Token layout, so the mint/owner/amount fields stay
 * at fixed offsets (0, 32, 64) regardless of an account's total size — a
 * `dataSize` filter would wrongly exclude accounts with extensions, so only
 * the mint memcmp filter is used.
 *
 * Usage: tsx scripts/list-mint-holders.ts [mint address]
 * Defaults to the persisted mint from `npm run setup:mint` if omitted.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { RPC_URL, DECIMALS, readPersistedMintAddress } from "../src/solana/authorities.js";

async function main() {
  const mintArg = process.argv[2];
  const mint = mintArg ? new PublicKey(mintArg) : readPersistedMintAddress();
  if (!mint) {
    console.error("No mint given and none persisted — pass a mint address or run `npm run setup:mint` first.");
    process.exit(1);
  }

  const connection = new Connection(RPC_URL, "confirmed");
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Mint: ${mint.toBase58()}`);
  console.log();

  const accounts = await connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }],
  });

  if (accounts.length === 0) {
    console.log("No token accounts found for this mint.");
    return;
  }

  const rows = accounts
    .map(({ pubkey, account }) => {
      const owner = new PublicKey(account.data.subarray(32, 64));
      const rawAmount = account.data.readBigUInt64LE(64);
      return { ata: pubkey.toBase58(), owner: owner.toBase58(), rawAmount };
    })
    .sort((a, b) => (a.rawAmount < b.rawAmount ? 1 : a.rawAmount > b.rawAmount ? -1 : 0));

  let totalRaw = 0n;
  for (const row of rows) {
    const balance = (Number(row.rawAmount) / 10 ** DECIMALS).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
    });
    console.log(`ATA:   ${row.ata}`);
    console.log(`Owner: ${row.owner}`);
    console.log(`Balance: ${balance}`);
    console.log();
    totalRaw += row.rawAmount;
  }

  const total = (Number(totalRaw) / 10 ** DECIMALS).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
  console.log(`${rows.length} holder(s), total on-chain supply held: ${total}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
