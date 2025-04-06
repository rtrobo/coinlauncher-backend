const express = require('express');
const {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  LAMPORTS_PER_SOL,
  SystemProgram,
} = require('@solana/web3.js');
const { createMint, getOrCreateAssociatedTokenAccount, mintTo, setAuthority } = require('@solana/spl-token');
const { createCreateMetadataAccountV3Instruction } = require('@metaplex-foundation/mpl-token-metadata');
const { getPayer } = require('./payer'); // Optional: for dev wallet fallback
const bs58 = require('bs58');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const connection = new Connection(SOLANA_RPC);
const DEV_WALLET = new PublicKey('86tXdBQuoD2cR9SXJMJSZLsZotkLUFqT7kZkwd9nLChm');
const BASE_FEE_SOL = 0.08;
const EXTRA_OPTION_FEE_SOL = 0.03;

// 1️⃣ Calculate Total Fee
app.post('/calculate-fee', (req, res) => {
  const { revokeMint, revokeFreeze, revokeMetadata, customMetadata } = req.body;
  let totalFee = BASE_FEE_SOL;
  if (revokeMint) totalFee += EXTRA_OPTION_FEE_SOL;
  if (revokeFreeze) totalFee += EXTRA_OPTION_FEE_SOL;
  if (revokeMetadata) totalFee += EXTRA_OPTION_FEE_SOL;
  if (customMetadata) totalFee += EXTRA_OPTION_FEE_SOL;
  res.json({ totalFee });
});

// 2️⃣ Generate Payment Transaction
app.post('/generate-payment', async (req, res) => {
  const { userWallet, totalFee } = req.body;
  try {
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: new PublicKey(userWallet),
        toPubkey: DEV_WALLET,
        lamports: totalFee * LAMPORTS_PER_SOL,
      })
    );
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = new PublicKey(userWallet);
    const serializedTx = transaction.serialize({ requireAllSignatures: false }).toString('base64');
    res.json({ transaction: serializedTx });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate payment transaction.' });
  }
});

// 3️⃣ Verify Payment
app.post('/verify-payment', async (req, res) => {
  const { userWallet, expectedFee } = req.body;
  const signatures = await connection.getSignaturesForAddress(DEV_WALLET, { limit: 50 });
  for (let sig of signatures) {
    const txn = await connection.getTransaction(sig.signature);
    if (txn && txn.meta) {
      const sender = txn.transaction.message.accountKeys[0].toBase58();
      const lamports = txn.meta.preBalances[0] - txn.meta.postBalances[0];
      if (sender === userWallet && lamports >= expectedFee * LAMPORTS_PER_SOL) {
        return res.json({ paid: true });
      }
    }
  }
  res.json({ paid: false });
});

// 4️⃣ Create Token with Default or Custom Metadata
app.post('/create-token', async (req, res) => {
  const {
    name,
    symbol,
    decimals,
    supply,
    options,
    metadataURI,
    userWallet,
    paymentSignature,
    expectedFee,
  } = req.body;

  try {
    const txn = await connection.getTransaction(paymentSignature, { commitment: 'confirmed' });
    if (!txn || !txn.meta) return res.status(400).json({ error: 'Invalid payment transaction.' });

    const sender = txn.transaction.message.accountKeys[0].toBase58();
    const receiver = txn.transaction.message.accountKeys[1].toBase58();
    const lamports = txn.meta.preBalances[0] - txn.meta.postBalances[0];

    if (sender !== userWallet)
      return res.status(400).json({ error: 'Payment sender does not match wallet.' });
    if (receiver !== DEV_WALLET.toBase58())
      return res.status(400).json({ error: 'Payment receiver does not match dev wallet.' });
    if (lamports < expectedFee * LAMPORTS_PER_SOL)
      return res.status(400).json({ error: 'Incorrect payment amount.' });

    const payer = Keypair.generate(); // Temporary payer for tx build only

    // Create Mint
    const mint = await createMint(connection, payer, payer.publicKey, null, decimals);
    const tokenAccount = await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
    await mintTo(connection, payer, mint, tokenAccount.address, payer, supply);

    if (options.revokeMint)
      await setAuthority(connection, payer, mint, payer.publicKey, 'MintTokens', null);
    if (options.revokeFreeze)
      await setAuthority(connection, payer, mint, payer.publicKey, 'FreezeAccount', null);

    // Metaplex Metadata
    const defaultName = 'CoinLauncher';
    const defaultUri = 'https://coinlauncher.site';
    const creatorName = metadataURI?.creatorName || defaultName;
    const creatorSite = metadataURI?.creatorWebsite || defaultUri;

    const metadata = {
      name: creatorName,
      symbol: symbol,
      uri: creatorSite,
      sellerFeeBasisPoints: 0,
      creators: [{ address: DEV_WALLET, verified: true, share: 100 }],
    };

    // You would insert logic here to attach Metaplex metadata
    // (this section can be expanded based on your token standard)

    res.json({
      mint: mint.toBase58(),
      tokenAccount: tokenAccount.address.toBase58(),
      message: 'Token created successfully!',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Token creation failed.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Token Creator backend running on port ${PORT}`));