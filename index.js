require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Connection, PublicKey, SystemProgram, LAMPORTS_PER_SOL, Keypair, ComputeBudgetProgram } = require('@solana/web3.js');
const { createMint, mintTo, TOKEN_PROGRAM_ID } = require('@solana/spl-token');

const app = express();
app.use(cors());
app.use(express.json());

const SOLANA_RPC = "https://solana-mainnet.g.alchemy.com/v2/Y5lBPx2CUbYj1mlvV2yt6rzAkk5Hcxj-";
const connection = new Connection(SOLANA_RPC, "confirmed");

const payerJson = process.env.PAYER_JSON;
if (!payerJson) throw new Error("PAYER_JSON not set in environment variables");

let payerSecretKey;
try {
  payerSecretKey = new Uint8Array(JSON.parse(payerJson));
} catch (error) {
  throw new Error("Invalid PAYER_JSON format: must be a JSON array of numbers (e.g., [129, 152, ...])");
}
const payer = Keypair.fromSecretKey(payerSecretKey);

const BASE_FEE = 0.08;
const ADDON_FEE = 0.03;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
  try {
    const userPublicKey = new PublicKey(userWallet);
    const feeLamports = Math.round(totalFee * LAMPORTS_PER_SOL);

    // Add high priority fee instruction (~0.006 SOL)
    const priorityFeeInstruction = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 20000, // 20,000 micro-lamports × ~300k CU = 0.006 SOL
    });

    const paymentInstruction = SystemProgram.transfer({
      fromPubkey: userPublicKey,
      toPubkey: payer.publicKey,
      lamports: feeLamports,
    });

    const { blockhash } = await connection.getLatestBlockhash('confirmed');

    res.json({
      instructions: [
        {
          programId: priorityFeeInstruction.programId.toBase58(),
          keys: priorityFeeInstruction.keys.map(k => ({
            pubkey: k.pubkey.toBase58(),
            isSigner: k.isSigner,
            isWritable: k.isWritable,
          })),
          data: Array.from(priorityFeeInstruction.data),
        },
        {
          programId: paymentInstruction.programId.toBase58(),
          keys: paymentInstruction.keys.map(k => ({
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
    console.error("Generate payment error:", error.message);
    res.status(500).json({ error: "Failed to generate payment" });
  }
});

app.post('/create-token', async (req, res) => {
  console.log("⚙️ /create-token called with:", req.body);
  const { name, symbol, decimals, supply, options, metadataURI, userWallet, paymentSignature, expectedFee } = req.body;

  try {
    const userPublicKey = new PublicKey(userWallet);
    const expectedLamports = Math.round(expectedFee * LAMPORTS_PER_SOL);

    const payerBalance = await connection.getBalance(payer.publicKey);
    console.log(`Payer balance: ${payerBalance / LAMPORTS_PER_SOL} SOL`);
    if (payerBalance < 0.01) throw new Error("Payer wallet has insufficient funds for rent fees (needs ~0.01 SOL)");

    console.log(`🔍 Verifying payment signature: ${paymentSignature}...`);
    let tx;
    for (let attempt = 1; attempt <= 30; attempt++) {
      try {
        tx = await connection.getParsedTransaction(paymentSignature, { 
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed"
        });
        if (tx && !tx.meta.err) break;
        console.log(`⚠️ Attempt ${attempt}: Transaction not found or failed. Retrying in 2s...`);
        await delay(2000);
      } catch (error) {
        console.error(`⚠️ Attempt ${attempt} error:`, error.message);
        if (error.response?.status === 429) {
          console.log("Rate limit hit. Waiting longer...");
          await delay(2000);
        }
        await delay(2000);
      }
    }

    if (!tx) throw new Error("Transaction not found after 60 seconds");
    if (tx.meta.err) throw new Error(`Transaction failed: ${JSON.stringify(tx.meta.err)}`);

    const transfer = tx.transaction.message.instructions.find(
      (i) => i.programId.equals(SystemProgram.programId) &&
             i.parsed?.type === 'transfer' &&
             i.parsed.info.destination === payer.publicKey.toBase58() &&
             i.parsed.info.source === userPublicKey.toBase58() &&
             i.parsed.info.lamports === expectedLamports
    );
    if (!transfer) throw new Error("Payment not verified: no matching transfer");
    console.log("✅ Payment verified");

    const mint = await createMint(
      connection,
      payer,
      options.revokeMint ? null : payer.publicKey,
      options.revokeFreeze ? null : payer.publicKey,
      decimals
    );
    console.log("✅ Mint created:", mint.toBase58());

    const tokenAccount = await mintTo(
      connection,
      payer,
      mint,
      userPublicKey,
      payer.publicKey,
      BigInt(supply) * BigInt(10 ** decimals)
    );
    console.log("✅ Supply minted to:", userPublicKey.toBase58());

    res.json({ mint: mint.toBase58() });
  } catch (error) {
    console.error("❌ Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});