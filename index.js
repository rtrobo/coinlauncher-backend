require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, Keypair } = require('@solana/web3.js');
const { createMint, TOKEN_PROGRAM_ID } = require('@solana/spl-token');

const app = express();
app.use(cors());
app.use(express.json());

const SOLANA_RPC = "https://solana-mainnet.g.alchemy.com/v2/Y5lBPx2CUbYj1mlvV2yt6rzAkk5Hcxj-";
const connection = new Connection(SOLANA_RPC, "confirmed");

const payerJson = process.env.PAYER_JSON;
if (!payerJson) throw new Error("PAYER_JSON not set in environment variables");

// Parse JSON string into an array and convert to Uint8Array
let payerSecretKey;
try {
  payerSecretKey = new Uint8Array(JSON.parse(payerJson));
} catch (error) {
  throw new Error("Invalid PAYER_JSON format: must be a JSON array of numbers (e.g., [129, 152, ...])");
}
const payer = Keypair.fromSecretKey(payerSecretKey);

const BASE_FEE = 0.08;
const ADDON_FEE = 0.03;

app.post('/calculate-fee', async (req, res) => {
  const { revokeMint, revokeFreeze, revokeMetadata, customMetadata } = req.body;
  let totalFee = BASE_FEE;
  if (revokeMint) totalFee += ADDON_FEE;
  if (revokeFreeze) totalFee += ADDON_FEE;
  if (revokeMetadata) totalFee += ADDON_FEE;
  if (customMetadata) totalFee += ADDON_FEE;
  res.json({ totalFee });
});

app.post('/generate-payment', async (req, res) => {
  const { userWallet, totalFee } = req.body;
  const userPublicKey = new PublicKey(userWallet);
  const feeLamports = Math.round(totalFee * LAMPORTS_PER_SOL);

  const instruction = SystemProgram.transfer({
    fromPubkey: userPublicKey,
    toPubkey: payer.publicKey,
    lamports: feeLamports,
  });

  res.json({
    instruction: {
      programId: instruction.programId.toBase58(),
      keys: instruction.keys.map(k => ({
        pubkey: k.pubkey.toBase58(),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      data: Array.from(instruction.data),
    },
  });
});

app.post('/verify-payment', async (req, res) => {
  const { userWallet, expectedFee } = req.body;
  const userPublicKey = new PublicKey(userWallet);
  const expectedLamports = Math.round(expectedFee * LAMPORTS_PER_SOL);

  try {
    const signatures = await connection.getSignaturesForAddress(userPublicKey, { limit: 10 });
    for (const sig of signatures) {
      const tx = await connection.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
      if (tx && !tx.meta.err) {
        const transfer = tx.transaction.message.instructions.find(
          (i) => i.programId.equals(SystemProgram.programId) &&
                 i.parsed?.type === 'transfer' &&
                 i.parsed.info.destination === payer.publicKey.toBase58() &&
                 i.parsed.info.source === userPublicKey.toBase58()
        );
        if (transfer && transfer.parsed.info.lamports === expectedLamports) {
          return res.json({ paid: true });
        }
      }
    }
    res.json({ paid: false });
  } catch (error) {
    console.error("Verification error:", error);
    res.status(500).json({ error: "Failed to verify payment" });
  }
});

app.post('/create-token', async (req, res) => {
  console.log("⚙️ /create-token called with:", req.body);
  const { name, symbol, decimals, supply, options, metadataURI, userWallet, paymentSignature, expectedFee } = req.body;

  try {
    console.log("🔍 Verifying payment...");
    const userPublicKey = new PublicKey(userWallet);
    const expectedLamports = Math.round(expectedFee * LAMPORTS_PER_SOL);
    const tx = await connection.getParsedTransaction(paymentSignature, { maxSupportedTransactionVersion: 0 });
    if (!tx || tx.meta.err) throw new Error("Transaction not found or failed");

    const transfer = tx.transaction.message.instructions.find(
      (i) => i.programId.equals(SystemProgram.programId) &&
             i.parsed?.type === 'transfer' &&
             i.parsed.info.destination === payer.publicKey.toBase58() &&
             i.parsed.info.source === userPublicKey.toBase58()
    );
    if (!transfer || transfer.parsed.info.lamports !== expectedLamports) {
      throw new Error("Payment not verified");
    }
    console.log("✅ Payment verified. Proceeding to create token...");

    // Create the mint (v0.3.x syntax, returns the mint public key directly)
    const mint = await createMint(
      connection,
      payer,
      payer.publicKey, // Mint authority
      options.revokeFreeze ? null : payer.publicKey, // Freeze authority (null if revoked)
      decimals
    );

    console.log("✅ Mint created:", mint.toBase58());

    // Additional token creation logic (e.g., minting supply, setting metadata) can go here

    res.json({ mint: mint.toBase58() });
  } catch (error) {
    console.error("❌ Token creation error:", error);
    res.status(500).json({ error: `Token creation failed: ${error.message}` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Token Creator backend running on port ${PORT}`);
});