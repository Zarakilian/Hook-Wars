// One-off devnet setup for the Limited-item store. Dry run by default: it prints what it would do
// and builds the transactions without sending them. Add --send to do it for real on devnet.
//
//   node --env-file=.env server/economy/setupDevnet.ts          (dry run)
//   node --env-file=.env server/economy/setupDevnet.ts --send   (devnet only, costs a little devnet SOL)
//
// It needs ECONOMY_KEYPAIR_PATH, TREASURY_ADDRESS and USDC_MINT (see .env.example) and does two things:
//   1. creates the treasury's USDC token account if it does not exist (the fee payer pays the rent)
//   2. creates the Metaplex Core collection "Hook Wars Limited" with a 5% Royalties plugin paid to
//      the treasury, with this server's key as update authority, and prints CORE_COLLECTION
// It refuses to run against anything that is not devnet (checked by genesis hash).
import { isSolanaAddress, MARKET_FEE_BPS } from '../../shared/economy.ts';
import { DEFAULT_DEVNET_RPC } from './config.ts';
import { hmacSha256 } from './crypto.ts';
import { DEVNET_GENESIS_HASH, readKeypairFile } from './solanaDevnet.ts';

const send = process.argv.includes('--send');
const env = process.env;
const rpcUrl = (env.SOLANA_RPC_URL ?? '').trim() || DEFAULT_DEVNET_RPC;
const keypairPath = (env.ECONOMY_KEYPAIR_PATH ?? '').trim();
const treasury = (env.TREASURY_ADDRESS ?? '').trim();
const usdcMint = (env.USDC_MINT ?? '').trim();

function die(msg: string): never {
  console.error(`setup: ${msg}`);
  process.exit(1);
}

if (!keypairPath) die('ECONOMY_KEYPAIR_PATH is not set.');
if (!isSolanaAddress(treasury)) die('TREASURY_ADDRESS is missing or not a Solana address.');
if (!isSolanaAddress(usdcMint)) die('USDC_MINT is missing or not a Solana address.');

const [web3, spl, umiLib, bundle, core] = await Promise.all([
  import('@solana/web3.js'),
  import('@solana/spl-token'),
  import('@metaplex-foundation/umi'),
  import('@metaplex-foundation/umi-bundle-defaults'),
  import('@metaplex-foundation/mpl-core'),
]);

const secret = readKeypairFile(keypairPath);
const feePayer = web3.Keypair.fromSecretKey(secret);
const conn = new web3.Connection(rpcUrl, 'confirmed');
const genesis = await conn.getGenesisHash();
if (genesis !== DEVNET_GENESIS_HASH) die(`SOLANA_RPC_URL is not devnet (genesis ${genesis}). Mainnet stays off.`);
const lamports = await conn.getBalance(feePayer.publicKey, 'confirmed');
console.log(`fee payer   ${feePayer.publicKey.toBase58()}  (${lamports / 1e9} devnet SOL)`);
if (lamports < 20_000_000 && send) die('the fee payer needs at least 0.02 devnet SOL. Airdrop some first (docs/economy.md, "Devnet setup").');

// 1. treasury USDC account
const mint = new web3.PublicKey(usdcMint);
const owner = new web3.PublicKey(treasury);
const ata = spl.getAssociatedTokenAddressSync(mint, owner, true);
const ataInfo = await conn.getAccountInfo(ata, 'confirmed');
console.log(`treasury    ${treasury}`);
console.log(`USDC acct   ${ata.toBase58()}  ${ataInfo ? '(exists)' : '(missing)'}`);
if (!ataInfo) {
  const tx = new web3.Transaction().add(spl.createAssociatedTokenAccountIdempotentInstruction(feePayer.publicKey, ata, owner, mint));
  if (send) {
    const sig = await web3.sendAndConfirmTransaction(conn, tx, [feePayer], { commitment: 'confirmed' });
    console.log(`            created: ${sig}`);
  } else {
    console.log('            dry run: would create it (createAssociatedTokenAccountIdempotent, paid by the fee payer)');
  }
}

// 2. Core collection (deterministic address from the server key, so a second run finds it)
const umi = bundle.createUmi(rpcUrl).use(core.mplCore());
umi.use(umiLib.keypairIdentity(umi.eddsa.createKeypairFromSecretKey(secret)));
const collection = umiLib.createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSeed(hmacSha256(secret.slice(0, 32), 'hookwars-core-collection|v1')));
const existing = await core.safeFetchCollectionV1(umi, collection.publicKey);
if (existing) {
  console.log(`collection  ${String(collection.publicKey)}  (exists, update authority ${String(existing.updateAuthority)})`);
} else {
  const builder = core.createCollection(umi, {
    collection,
    name: 'Hook Wars Limited',
    uri: (env.NFT_METADATA_BASE_URL ?? '').trim().replace(/\/+$/, '') ? `${(env.NFT_METADATA_BASE_URL ?? '').trim().replace(/\/+$/, '')}/collection.json` : '',
    plugins: [{ type: 'Royalties', basisPoints: MARKET_FEE_BPS, creators: [{ address: umiLib.publicKey(treasury), percentage: 100 }], ruleSet: core.ruleSet('None') }],
  });
  if (send) {
    await builder.sendAndConfirm(umi, { send: { commitment: 'confirmed' }, confirm: { commitment: 'confirmed' } });
    console.log(`collection  ${String(collection.publicKey)}  (created)`);
  } else {
    console.log(`collection  ${String(collection.publicKey)}  dry run: would create "Hook Wars Limited", Royalties ${MARKET_FEE_BPS / 100}% to the treasury (${builder.getInstructions().length} instruction)`);
  }
}
console.log(`\nPut this in .env:\nCORE_COLLECTION=${String(collection.publicKey)}`);
if (!send) console.log('\nNothing was sent. Run again with --send to do it on devnet.');
