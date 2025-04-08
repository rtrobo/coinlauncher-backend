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
} = require("@solana/web3.js");
const { Token, TOKEN_PROGRAM_ID } = require("@solana/spl-token");
const {
  createCreateMetadataAccountV3Instruction,
  DataV2,
} = require("@metaplex-foundation/mpl-token-metadata");
const {
  getAssociatedTokenAddress,
} = require("@solana/spl-token");

const app = express();
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origin.endsWith(".vercel.app")) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST"]
}));
app.use(express.json());

// 📡 Solana setup
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const connection = new Connection(SOLANA_RPC);
const DEV_WALLET = new PublicKey("HLHZPThtJYe7CgzkauGbtr8xVNe9GR8G4LDgmEEbWUgi");
const BASE_FEE_SOL = 0.08;
const EXTRA_OPTION_FEE_SOL = 0.03;

// 🔐 Load payer keypair from environment variable
const payerJson = process.env.PAYER_JSON;
if (!payerJson) {
  throw new Error("Missing PAYER_JSON environment variable");
}
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(payerJson)));


// 🧮 1. Calculate total fee
app.post("/calculate-fee", (req, res) => {
  const { revokeMint, revokeFreeze, revokeMetadata, customMetadata } = req.body;
  let totalFee = BASE_FEE_SOL;
  if (revokeMint) totalFee += EXTRA_OPTION_FEE_SOL;
  if (revokeFreeze) totalFee += EXTRA_OPTION_FEE_SOL;
  if (revokeMetadata) totalFee += EXTRA_OPTION_FEE_SOL;
  if (customMetadata) totalFee += EXTRA_OPTION_FEE_SOL;
  res.json({ totalFee });
});

// 💰 2. Generate payment transaction
app.post("/generate-payment", async (req, res) => {
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

    const serializedTx = transaction.serialize({
      requireAllSignatures: false,
    }).toString("base64");

    res.json({ transaction: serializedTx });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate payment transaction." });
  }
});

// ✅ 3. Verify payment
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

// 🪙 4. Create token
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
    // ✅ Verify payment
    const txn = await connection.getTransaction(paymentSignature, {
      commitment: "confirmed",
    });

    if (!txn || !txn.meta) {
      return res.status(400).json({ error: "Invalid payment transaction." });
    }

    const sender = txn.transaction.message.accountKeys[0].toBase58();
    const receiver = txn.transaction.message.accountKeys[1].toBase58();
    const lamports = txn.meta.preBalances[0] - txn.meta.postBalances[0];

    if (sender !== userWallet)
      return res.status(400).json({ error: "Payment sender does not match wallet." });

    if (receiver !== DEV_WALLET.toBase58())
      return res.status(400).json({ error: "Payment receiver mismatch." });

    if (lamports < expectedFee * LAMPORTS_PER_SOL)
      return res.status(400).json({ error: "Incorrect payment amount." });

    // 🧱 Create token mint
    const mint = await Token.createMint(
      connection,
      payer,
      payer.publicKey,
      payer.publicKey,
      decimals,
      TOKEN_PROGRAM_ID
    );

    // 🧾 Create associated token account
    const tokenAccount = await mint.getOrCreateAssociatedAccountInfo(payer.publicKey);

    // 🪙 Mint tokens
    await mint.mintTo(tokenAccount.address, payer.publicKey, [], supply);

    // 🚫 Revoke authorities
    if (options.revokeMint) {
      await mint.setAuthority(
        mint.publicKey,
        null,
        "MintTokens",
        payer.publicKey,
        []
      );
    }
    if (options.revokeFreeze) {
      await mint.setAuthority(
        mint.publicKey,
        null,
        "FreezeAccount",
        payer.publicKey,
        []
      );
    }

    // 🏷️ Attach metadata (default or custom)
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
      uri: "https://coinlauncher.site/metadata.json",
      sellerFeeBasisPoints: 0,
      creators: [
        {
          address: payer.publicKey,
          verified: true,
          share: 100,
        },
      ],
      ...(metadataURI && {
        uri: metadataURI.creatorWebsite || "https://coinlauncher.site/metadata.json",
        creators: [
          {
            address: payer.publicKey,
            verified: true,
            share: 100,
          },
        ],
      }),
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

    const metadataTx = new Transaction().add(metadataInstruction);
    await connection.sendTransaction(metadataTx, [payer]);

    // ✅ Done
    res.json({
      mint: mint.publicKey.toBase58(),
      tokenAccount: tokenAccount.address.toBase58(),
      message: "Token created successfully!",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Token creation failed." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Token Creator backend running on port ${PORT}`)
);
