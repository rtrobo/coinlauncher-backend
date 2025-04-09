// === 🔧 Required Modules ===
const express = require("express");
const fs = require("fs");
const cors = require("cors");
const bodyParser = require("body-parser");
const {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  LAMPORTS_PER_SOL,
  SystemProgram,
  sendAndConfirmTransaction
} = require("@solana/web3.js");
const { Token, TOKEN_PROGRAM_ID } = require("@solana/spl-token");
const {
  createCreateMetadataAccountV3Instruction,
  DataV2,
} = require("@metaplex-foundation/mpl-token-metadata");
const {
  getAssociatedTokenAddress,
} = require("@solana/spl-token");

// === 🚀 App Initialization ===
const app = express();
app.use(cors({
  origin: "*", // Temporarily allow all origins for testing
  methods: ["GET", "POST"],
}));
app.use(express.json());

// === 🌐 Solana Setup ===
const SOLANA_RPC = "https://solana-mainnet.g.alchemy.com/v2/Y5lBPx2CUbYj1mlvV2yt6rzAkk5Hcxj-"; // Updated to Alchemy RPC
const connection = new Connection(SOLANA_RPC, "confirmed"); // Added commitment for consistency
const DEV_WALLET = new PublicKey("HLHZPThtJYe7CgzkauGbtr8xVNe9GR8G4LDgmEEbWUgi");
const BASE_FEE_SOL = 0.08;
const EXTRA_OPTION_FEE_SOL = 0.03;

// === 🔐 Load Payer Keypair ===
const payerJson = process.env.PAYER_JSON;
if (!payerJson) {
  throw new Error("Missing PAYER_JSON environment variable");
}
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(payerJson)));

// === 🧮 1. Calculate Total Fee ===
app.post("/calculate-fee", (req, res) => {
  const { revokeMint, revokeFreeze, revokeMetadata, customMetadata } = req.body;
  let totalFee = BASE_FEE_SOL;
  if (revokeMint) totalFee += EXTRA_OPTION_FEE_SOL;
  if (revokeFreeze) totalFee += EXTRA_OPTION_FEE_SOL;
  if (revokeMetadata) totalFee += EXTRA_OPTION_FEE_SOL;
  if (customMetadata) totalFee += EXTRA_OPTION_FEE_SOL;
  res.json({ totalFee });
});

// === 💰 2. Generate Payment Transaction ===
app.post("/generate-payment", async (req, res) => {
  const { userWallet, totalFee } = req.body;
  try {
    const instruction = SystemProgram.transfer({
      fromPubkey: new PublicKey(userWallet),
      toPubkey: DEV_WALLET,
      lamports: totalFee * LAMPORTS_PER_SOL,
    });
    res.json({ instruction });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate payment instruction." });
  }
});

// === ✅ 3. Verify Payment ===
app.post("/verify-payment", async (req, res) => {
  const { userWallet, expectedFee } = req.body;
  const signatures = await connection.getSignaturesForAddress(DEV_WALLET, {
    limit: 50,
  });

  for (let sig of signatures) {
    const txn = await connection.getTransaction(sig.signature, {
      commitment: "confirmed",
    });

    if (txn && txn.meta) {
      const sender = txn.transaction.message.accountKeys[0].toBase58();
      const lamports = txn.meta.preBalances[0] - txn.meta.postBalances[0];
      if (
        sender === userWallet &&
        lamports >= expectedFee * LAMPORTS_PER_SOL
      ) {
        return res.json({ paid: true });
      }
    }
  }
  res.json({ paid: false });
});

// === 🪙 4. Create Token ===
app.post("/create-token", async (req, res) => {
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
    console.log("⚙️ /create-token called with paymentSignature:", paymentSignature);

    // Wait for payment to finalize
    console.log("⏳ Waiting 5 seconds before verifying transaction...");
    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log("🔍 Verifying payment...");
    const txn = await connection.getTransaction(paymentSignature, {
      commitment: "confirmed",
    });

    if (!txn || !txn.meta) {
      console.log("❌ Invalid or unconfirmed transaction:", txn);
      return res.status(400).json({ error: "Invalid payment transaction." });
    }

    const sender = txn.transaction.message.accountKeys[0].toBase58();
    const receiver = txn.transaction.message.accountKeys[1].toBase58();
    const lamports = txn.meta.preBalances[0] - txn.meta.postBalances[0];

    console.log(`🔑 Sender: ${sender}`);
    console.log(`🎯 Receiver: ${receiver}`);
    console.log(`💸 Lamports sent: ${lamports}`);

    if (sender !== userWallet) {
      console.log("❌ Sender mismatch");
      return res.status(400).json({ error: "Payment sender does not match wallet." });
    }

    if (receiver !== DEV_WALLET.toBase58()) {
      console.log("❌ Receiver mismatch");
      return res.status(400).json({ error: "Payment receiver mismatch." });
    }

    if (lamports < expectedFee * LAMPORTS_PER_SOL) {
      console.log("❌ Insufficient payment");
      return res.status(400).json({ error: "Incorrect payment amount." });
    }

    console.log("✅ Payment verified. Proceeding to create token...");

    // Step 1: Create the token mint
    console.log("🏭 Creating token mint...");
    const mint = await Token.createMint(
      connection,
      payer,
      payer.publicKey,
      payer.publicKey,
      decimals,
      TOKEN_PROGRAM_ID
    );
    console.log("✅ Token mint created:", mint.publicKey.toBase58());

    // Step 2: Create token account and mint tokens
    console.log("📦 Creating token account...");
    const tokenAccount = await mint.getOrCreateAssociatedAccountInfo(payer.publicKey);
    console.log("✅ Token account created:", tokenAccount.address.toBase58());

    console.log("💰 Minting tokens...");
    await mint.mintTo(tokenAccount.address, payer.publicKey, [], supply);
    console.log(`✅ Minted ${supply} tokens`);

    // Step 3: Revoke authorities if requested
    if (options.revokeMint) {
      console.log("🚫 Revoking mint authority...");
      await mint.setAuthority(
        mint.publicKey,
        null,
        "MintTokens",
        payer.publicKey,
        []
      );
      console.log("✅ Mint authority revoked");
    }

    if (options.revokeFreeze) {
      console.log("🚫 Revoking freeze authority...");
      await mint.setAuthority(
        mint.publicKey,
        null,
        "FreezeAccount",
        payer.publicKey,
        []
      );
      console.log("✅ Freeze authority revoked");
    }

    // Step 4: Set up metadata
    console.log("📝 Setting up metadata...");
    const metadataPDA = (
      await PublicKey.findProgramAddressSync(
        [
          Buffer.from("metadata"),
          new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s").toBuffer(),
          mint.publicKey.toBuffer(),
        ],
        new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")
      )
    )[0];

    const metadataData = {
      name,
      symbol,
      uri: metadataURI?.creatorWebsite || "https://coinlauncher.site/metadata.json",
      sellerFeeBasisPoints: 0,
      creators: [
        {
          address: payer.publicKey,
          verified: true,
          share: 100,
        },
      ],
    };

    const metadataInstruction = createCreateMetadataAccountV3Instruction(
      {
        metadata: metadataPDA,
        mint: mint.publicKey,
        mintAuthority: payer.publicKey,
        payer: payer.publicKey,
        updateAuthority: payer.publicKey,
      },
      {
        createMetadataAccountArgsV3: {
          data: metadataData,
          isMutable: !options.revokeMetadata,
          collectionDetails: null,
        },
      }
    );

    // Build and send metadata transaction with retries
    const metadataTx = new Transaction().add(metadataInstruction);
    const latest = await connection.getLatestBlockhash("confirmed");
    metadataTx.recentBlockhash = latest.blockhash;
    metadataTx.feePayer = payer.publicKey;

    console.log("🚀 Sending metadata transaction with blockhash:", latest.blockhash);
    const sig = await sendAndConfirmTransaction(
      connection,
      metadataTx,
      [payer],
      {
        commitment: "confirmed",
        maxRetries: 5, // Retry up to 5 times if blockhash expires
      }
    );
    console.log("✅ Metadata confirmed with signature:", sig);

    // Step 5: Send success response
    console.log("🎉 Token creation completed!");
    res.json({
      mint: mint.publicKey.toBase58(),
      tokenAccount: tokenAccount.address.toBase58(),
      message: "Token created successfully!",
    });

  } catch (err) {
    console.error("❌ Token creation failed:", err);
    res.status(500).json({ error: `Token creation failed: ${err.message}` });
  }
});

// === 🚪 Start Server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Token Creator backend running on port ${PORT}`)
);