const express = require('express');
const { Connection, PublicKey, Keypair, Transaction, LAMPORTS_PER_SOL, SystemProgram } = require('@solana/web3.js');
const { Token, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// CONFIGURABLE VARIABLES
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const DEV_WALLET = new PublicKey('86tXdBQuoD2cR9SXJMJSZLsZotkLUFqT7kZkwd9nLChm');
const BASE_FEE_SOL = 0.08;
const EXTRA_OPTION_FEE_SOL = 0.03;
const connection = new Connection(SOLANA_RPC);

// 1️⃣ API: Calculate Fees
app.post('/calculate-fee', (req, res) => {
  const { revokeMint, revokeFreeze, revokeMetadata, customMetadata } = req.body;
  let totalFee = BASE_FEE_SOL;
  if (revokeMint) totalFee += EXTRA_OPTION_FEE_SOL;
  if (revokeFreeze) totalFee += EXTRA_OPTION_FEE_SOL;
  if (revokeMetadata) totalFee += EXTRA_OPTION_FEE_SOL;
  if (customMetadata) totalFee += EXTRA_OPTION_FEE_SOL;
  res.json({ totalFee });
});

// 2️⃣ API: Generate Payment Transaction
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

// 3️⃣ API: Verify Payment
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

// 4️⃣ API: Create Token (WITH PAYMENT VERIFICATION!)
app.post('/create-token', async (req, res) => {
  const { payerSecret, name, symbol, decimals, supply, options, metadataURI, userWallet, paymentSignature, expectedFee } = req.body;

  try {
    // 🔐 STEP 1: Verify Payment Transaction
    const txn = await connection.getTransaction(paymentSignature, { commitment: "confirmed" });
    if (!txn || !txn.meta) {
      return res.status(400).json({ error: "Invalid payment transaction." });
    }

    // Extract sender, receiver, amount
    const sender = txn.transaction.message.accountKeys[0].toBase58();
    const receiver = txn.transaction.message.accountKeys[1].toBase58();
    const lamports = txn.meta.preBalances[0] - txn.meta.postBalances[0];

    // Check conditions
    if (sender !== userWallet) {
      return res.status(400).json({ error: "Payment sender does not match wallet." });
    }
    if (receiver !== DEV_WALLET.toBase58()) {
      return res.status(400).json({ error: "Payment receiver does not match dev wallet." });
    }
    if (lamports < expectedFee * LAMPORTS_PER_SOL) {
      return res.status(400).json({ error: "Incorrect payment amount." });
    }

    // ✅ Payment verified → Proceed to mint token

    const payer = Keypair.fromSecretKey(Uint8Array.from(payerSecret));

    // Create Mint
    const mint = await Token.createMint(
      connection,
      payer,
      payer.publicKey,
      payer.publicKey,
      decimals,
      TOKEN_PROGRAM_ID
    );

    // Create Token Account
    const tokenAccount = await mint.getOrCreateAssociatedAccountInfo(payer.publicKey);

    // Mint Tokens
    await mint.mintTo(tokenAccount.address, payer.publicKey, [], supply);

    // Revoke Authorities if toggled
    if (options.revokeMint) {
      await mint.setAuthority(mint.publicKey, null, 'MintTokens', payer.publicKey, []);
    }
    if (options.revokeFreeze) {
      await mint.setAuthority(mint.publicKey, null, 'FreezeAccount', payer.publicKey, []);
    }

    // Attach Metadata (Optional – Placeholder)

    res.json({
      mint: mint.publicKey.toBase58(),
      tokenAccount: tokenAccount.address.toBase58(),
      message: 'Token created successfully!'
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Token creation failed.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Token Creator backend running on port ${PORT}`));
