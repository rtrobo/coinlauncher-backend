require("dotenv").config();
const express = require("express");
const cors = require("cors");
const {
  Connection,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Keypair,
  ComputeBudgetProgram,
} = require("@solana/web3.js");
const {
  createMint,
  mintTo,
  TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ✅ Use a public non-rate-limited RPC
const SOLANA_RPC = "https://mainnet.genesysgo.net";
const connection = new Connection(SOLANA_RPC, {
  commitment: "confirmed",
  disableRetryOnRateLimit: false,
});

const payerJson = process.env.PAYER_JSON;
if (!payerJson) throw new Error("PAYER_JSON not set in environment variables");

let payerSecretKey;
try {
  payerSecretKey = new Uint8Array(JSON.parse(payerJson));
} catch (error) {
  throw new Error("Invalid PAYER_JSON format: must be a JSON array");
}
const payer = Keypair.fromSecretKey(payerSecretKey);

const BASE_FEE = 0.08;
const ADDON_FEE = 0.03;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.post("/calculate-fee", async (req, res) => {
  const { revokeMint, revokeFreeze, revokeMetadata, customMetadata } = req.body;
  let totalFee = BASE_FEE;
  if (revokeMint) totalFee += ADDON_FEE;
  if (revokeFreeze) totalFee += ADDON_FEE;
  if (revokeMetadata) totalFee += ADDON_FEE;
  if (customMetadata) totalFee += ADDON_FEE;
  res.json({ totalFee });
});

app.post("/generate-payment", async (req, res) => {
  const { userWallet, totalFee } = req.body;
  try {
    const userPublicKey = new PublicKey(userWallet);
    const feeLamports = Math.round(totalFee * LAMPORTS_PER_SOL);

    const priorityFeeInstruction = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 20000,
    });

    const paymentInstruction = SystemProgram.transfer({
      fromPubkey: userPublicKey,
      toPubkey: payer.publicKey,
      lamports: feeLamports,
    });

    const { blockhash } = await connection.getLatestBlockhash("confirmed");

    res.json({
      instructions: [
        {
          programId: priorityFeeInstruction.programId.toBase58(),
          keys: priorityFeeInstruction.keys.map((k) => ({
            pubkey: k.pubkey.toBase58(),
            isSigner: k.isSigner,
            isWritable: k.isWritable,
          })),
          data: Array.from(priorityFeeInstruction.data),
        },
        {
          programId: paymentInstruction.programId.toBase58(),
          keys: paymentInstruction.keys.map((k) => ({
            pubkey: k.pubkey.toBase58(),
            isSigner: k.isSigner,
            isWritable: k.isWritable,
          })),
          data: Array.from(paymentInstruction.data),
        },
      ],
      blockhash,
    });
  } catch (error) {
    console.error("❌ generate-payment error:", error.message);
    res.status(500).json({ error: "Failed to generate payment" });
  }
});

app.post("/create-token", async (req, res) => {
  console.log("⚙️  /create-token called");
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

    console.log("🔍 Checking payer balance...");
    const payerBalance = await connection.getBalance(payer.publicKey);
    if (payerBalance < 0.01 * LAMPORTS_PER_SOL)
      throw new Error("Payer wallet has insufficient funds.");

    console.log(`🔍 Verifying payment signature: ${paymentSignature}`);
    let tx;
    for (let i = 1; i <= 20; i++) {
      try {
        tx = await connection.getParsedTransaction(paymentSignature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
        if (tx && !tx.meta.err) break;
        console.log(`⏳ Retry ${i}/20 - Waiting for payment to finalize...`);
        await delay(1500);
      } catch (err) {
        console.warn(`Retry ${i} failed:`, err.message);
        await delay(1500);
      }
    }

    if (!tx) throw new Error("❌ Payment transaction not found");
    if (tx.meta.err) throw new Error("❌ Payment transaction failed");

    const transfer = tx.transaction.message.instructions.find(
      (i) =>
        i.programId.equals(SystemProgram.programId) &&
        i.parsed?.type === "transfer" &&
        i.parsed.info.destination === payer.publicKey.toBase58() &&
        i.parsed.info.source === userPublicKey.toBase58() &&
        i.parsed.info.lamports === expectedLamports
    );

    if (!transfer) throw new Error("❌ Payment not verified");

    console.log("✅ Payment verified. Creating mint...");

    const mint = await createMint(
      connection,
      payer,
      options.revokeMint ? null : payer.publicKey,
      options.revokeFreeze ? null : payer.publicKey,
      decimals
    );

    await mintTo(
      connection,
      payer,
      mint,
      userPublicKey,
      payer.publicKey,
      BigInt(supply) * BigInt(10 ** decimals)
    );

    console.log("✅ Token created:", mint.toBase58());

    res.json({ mint: mint.toBase58() });
  } catch (err) {
    console.error("❌ /create-token error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Token Creator backend running on port ${PORT}`);
});
