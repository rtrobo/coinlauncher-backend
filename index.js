require('dotenv').config();
const express = require('express');
const cors = require('cors');
const {
  Connection,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Keypair,
  ComputeBudgetProgram,
} = require('@solana/web3.js');
const {
  createMint,
  mintTo,
  TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');

const app = express();
app.use(cors());
app.use(express.json());

// === 🔗 SOLANA RPC ===
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const connection = new Connection(SOLANA_RPC, "confirmed");

// === 🔐 LOAD PAYER WALLET ===
const payerJson = process.env.PAYER_JSON;
if (!payerJson) throw new Error("❌ PAYER_JSON not set in .env file");
let payerSecretKey;
try {
  payerSecretKey = new Uint8Array(JSON.parse(payerJson));
} catch {
  throw new Error("❌ Invalid PAYER_JSON format");
}
const payer = Keypair.fromSecretKey(payerSecretKey);

// === 💸 FEES ===
const BASE_FEE = 0.08;
const ADDON_FEE = 0.03;

// === ⏳ UTILITY ===
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// === 📦 1. Calculate Fee ===
app.post('/calculate-fee', async (req, res) => {
  const { revokeMint, revokeFreeze, revokeMetadata, customMetadata } = req.body;
  let totalFee = BASE_FEE;
  if (revokeMint) totalFee += ADDON_FEE;
  if (revokeFreeze) totalFee += ADDON_FEE;
  if (revokeMetadata) totalFee += ADDON_FEE;
  if (customMetadata) totalFee += ADDON_FEE;
  res.json({ totalFee });
});

// === 💳 2. Generate Payment Transaction ===
app.post('/generate-payment', async (req, res) => {
  const { userWallet, totalFee } = req.body;
  try {
    const userPublicKey = new PublicKey(userWallet);
    const feeLamports = Math.round(totalFee * LAMPORTS_PER_SOL);

    const priorityFee = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 20000,
    });

    const payment = SystemProgram.transfer({
      fromPubkey: userPublicKey,
      toPubkey: payer.publicKey,
      lamports: feeLamports,
    });

    const { blockhash } = await connection.getLatestBlockhash('confirmed');

    res.json({
      instructions: [
        {
          programId: priorityFee.programId.toBase58(),
          keys: priorityFee.keys.map(k => ({
            pubkey: k.pubkey.toBase58(),
            isSigner: k.isSigner,
            isWritable: k.isWritable,
          })),
          data: Array.from(priorityFee.data),
        },
        {
          programId: payment.programId.toBase58(),
          keys: payment.keys.map(k => ({
            pubkey: k.pubkey.toBase58(),
            isSigner: k.isSigner,
            isWritable: k.isWritable,
          })),
          data: Array.from(payment.data),
        },
      ],
      blockhash,
    });
  } catch (err) {
    console.error("❌ generate-payment error:", err.message);
    res.status(500).json({ error: "Failed to generate payment" });
  }
});

// === 🪙 3. Create Token ===
app.post('/create-token', async (req, res) => {
  console.log("⚙️ /create-token called with:", req.body);
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
    const userPublicKey = new PublicKey(userWallet);
    const expectedLamports = Math.round(expectedFee * LAMPORTS_PER_SOL);

    // 💰 Check payer balance
    const payerBalance = await connection.getBalance(payer.publicKey);
    if (payerBalance < 0.01 * LAMPORTS_PER_SOL)
      throw new Error("Payer wallet needs at least 0.01 SOL");

    // 🔍 Verify payment
    let tx;
    for (let attempt = 1; attempt <= 30; attempt++) {
      try {
        tx = await connection.getParsedTransaction(paymentSignature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
        if (tx && !tx.meta.err) break;
        await delay(2000);
      } catch (err) {
        console.log(`Retry ${attempt}:`, err.message);
        await delay(2000);
      }
    }

    if (!tx) throw new Error("Payment transaction not found");
    if (tx.meta.err) throw new Error("Payment transaction failed");

    const match = tx.transaction.message.instructions.find(
      (i) =>
        i.programId.equals(SystemProgram.programId) &&
        i.parsed?.info?.destination === payer.publicKey.toBase58() &&
        i.parsed?.info?.source === userPublicKey.toBase58() &&
        i.parsed?.info?.lamports === expectedLamports
    );

    if (!match) throw new Error("❌ Payment verification failed");

    console.log("✅ Payment verified");

    // 🧱 Create mint
    const mint = await createMint(
      connection,
      payer,
      options.revokeMint ? null : payer.publicKey,
      options.revokeFreeze ? null : payer.publicKey,
      decimals
    );

    console.log("✅ Mint created:", mint.toBase58());

    // 💸 Mint to user
    await mintTo(
      connection,
      payer,
      mint,
      userPublicKey,
      payer.publicKey,
      BigInt(supply) * BigInt(10 ** decimals)
    );

    console.log("✅ Supply minted");

    res.json({ mint: mint.toBase58() });
  } catch (error) {
    console.error("❌ create-token error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// === 🚀 Start Server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
