const { Telegraf, Markup } = require("telegraf");
const { MongoClient } = require("mongodb");
require("dotenv").config();
// -------------------------------------------
// ❤️ CONFIG / ADMIN HELPERS
// -------------------------------------------
// Comma-separated list of Telegram user IDs that are allowed
// to use admin-only commands like /broadcast.
// Example (Railway / .env):
//   ADMIN_IDS=123456789,987654321
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean)
  .map((id) => parseInt(id, 10))
  .filter((id) => !isNaN(id));

function isAdmin(userId) {
  const idNum = parseInt(userId, 10);
  return ADMIN_IDS.includes(idNum);
}

// Small helper to sleep between batches while broadcasting
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -------------------------------------------
// ❤️ MONGODB DATABASE HANDLING
// -------------------------------------------
if (!process.env.MONGODB_URI) {
  console.error("❌ Error: MONGODB_URI is missing in .env file");
  console.error("Please add your MongoDB Atlas connection string to .env file");
  process.exit(1);
}

const client = new MongoClient(process.env.MONGODB_URI);
let db;
let usersCollection;
let reportsCollection;
let deletionReasonsCollection;

// Connect to MongoDB
async function connectDB() {
  try {
    await client.connect();
    db = client.db("datingbot");
    usersCollection = db.collection("users");
    reportsCollection = db.collection("reports");
    deletionReasonsCollection = db.collection("deletionReasons");
    console.log("✅ Connected to MongoDB Atlas");

    // Create indexes for better performance
    await usersCollection.createIndex({ id: 1 }, { unique: true });
    await reportsCollection.createIndex({ reporterId: 1, reportedId: 1 });
    await deletionReasonsCollection.createIndex({ userId: 1 });

    return true;
  } catch (error) {
    console.error("[DB ERROR] Failed to connect to MongoDB:", error.message);
    return false;
  }
}

// Load all users (returns object like { users: { userId: userData } })
async function loadDB() {
  try {
    const usersArray = await usersCollection.find({}).toArray();
    const users = {};
    usersArray.forEach(user => {
      users[user.id] = user;
    });

    // Get reports
    const reportsArray = await reportsCollection.find({}).toArray();

    return { users, reports: reportsArray };
  } catch (e) {
    console.error("[DB ERROR] Error loading DB:", e.message);
    return { users: {}, reports: [] };
  }
}

// Save user to database
async function saveUser(userId, userData) {
  try {
    await usersCollection.updateOne(
      { id: userId },
      { $set: { ...userData, id: userId } },
      { upsert: true }
    );
    return true;
  } catch (e) {
    console.error("[DB ERROR] Error saving user:", e.message);
    return false;
  }
}

// Delete user from database
async function deleteUser(userId) {
  try {
    await usersCollection.deleteOne({ id: userId });
    return true;
  } catch (e) {
    console.error("[DB ERROR] Error deleting user:", e.message);
    return false;
  }
}

// Save report to database
async function saveReport(reportData) {
  try {
    await reportsCollection.insertOne(reportData);
    return true;
  } catch (e) {
    console.error("[DB ERROR] Error saving report:", e.message);
    return false;
  }
}

// Save deletion reason to database
async function saveDeletionReason(reasonData) {
  try {
    await deletionReasonsCollection.insertOne(reasonData);
    return true;
  } catch (e) {
    console.error("[DB ERROR] Error saving deletion reason:", e.message);
    return false;
  }
}

// Update user's likes/matches arrays
async function updateUserArrays(userId, updates) {
  try {
    await usersCollection.updateOne(
      { id: userId },
      { $set: updates }
    );
    return true;
  } catch (e) {
    console.error("[DB ERROR] Error updating user arrays:", e.message);
    return false;
  }
}

// Check and reset daily swipe limit if needed (OPTIMIZED: Direct MongoDB query)
async function checkAndResetDailySwipes(userId) {
  try {
    // OPTIMIZED: Direct MongoDB query instead of loading all users
    const user = await usersCollection.findOne({ id: userId }, { projection: { dailySwipes: 1, lastSwipeReset: 1 } });

    if (!user) return 0;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const lastReset = user.lastSwipeReset ? new Date(user.lastSwipeReset) : null;
    const lastResetDate = lastReset ? new Date(lastReset.getFullYear(), lastReset.getMonth(), lastReset.getDate()) : null;

    // If last reset was not today, reset daily swipes
    if (!lastResetDate || lastResetDate.getTime() !== today.getTime()) {
      await usersCollection.updateOne(
        { id: userId },
        { $set: { dailySwipes: 0, lastSwipeReset: today.getTime() } }
      );
      return 0; // Return 0 as current daily swipes after reset
    }

    return user.dailySwipes || 0;
  } catch (e) {
    console.error("[DB ERROR] Error checking daily swipes:", e.message);
    return 0;
  }
}

// Increment daily swipe count (OPTIMIZED: Use MongoDB $inc for atomic operation)
async function incrementDailySwipes(userId) {
  try {
    // First ensure reset is done if needed
    await checkAndResetDailySwipes(userId);
    // OPTIMIZED: Use MongoDB $inc operator - atomic and faster than read-modify-write
    await usersCollection.updateOne(
      { id: userId },
      { $inc: { dailySwipes: 1 } }
    );
    // Get updated count
    const user = await usersCollection.findOne({ id: userId }, { projection: { dailySwipes: 1 } });
    return (user?.dailySwipes || 0);
  } catch (e) {
    console.error("[DB ERROR] Error incrementing daily swipes:", e.message);
    return 0;
  }
}

// Get available swipes (daily free + purchased) - OPTIMIZED: Direct MongoDB query
async function getAvailableSwipes(userId) {
  try {
    // OPTIMIZED: Direct MongoDB query with projection - only fetch needed fields
    const user = await usersCollection.findOne(
      { id: userId },
      { projection: { dailySwipes: 1, lastSwipeReset: 1, purchasedSwipes: 1 } }
    );

    if (!user) return { free: 0, purchased: 0, total: 0 };

    const dailySwipes = await checkAndResetDailySwipes(userId);
    const purchasedSwipes = user.purchasedSwipes || 0;
    const freeSwipesRemaining = Math.max(0, 20 - dailySwipes);

    return {
      free: freeSwipesRemaining,
      purchased: purchasedSwipes,
      total: freeSwipesRemaining + purchasedSwipes
    };
  } catch (e) {
    console.error("[DB ERROR] Error getting available swipes:", e.message);
    return { free: 0, purchased: 0, total: 0 };
  }
}

// Create Stars payment invoice link
async function createSwipePackageInvoice(userId, packageType) {
  try {
    const packages = {
      '40': {
        title: '40 More Swipes',
        description: 'Get 40 additional swipes to continue matching',
        amount: 4, // 4 Stars (Telegram Stars are whole units, not smallest units)
        swipes: 40
      },
      '80': {
        title: '80 More Swipes',
        description: 'Get 80 additional swipes to continue matching',
        amount: 10, // 10 Stars (Telegram Stars are whole units, not smallest units)
        swipes: 80
      }
    };

    const pkg = packages[packageType];
    if (!pkg) {
      throw new Error('Invalid package type');
    }

    const invoice = {
      title: pkg.title,
      description: pkg.description,
      payload: `swipes_${packageType}_${userId}_${Date.now()}`, // Unique payload
      currency: 'XTR', // Telegram Stars currency code
      prices: [{ label: pkg.title, amount: pkg.amount }],
      provider_token: '', // Empty for Telegram Stars
      max_tip_amount: 0,
      suggested_tip_amounts: []
    };

    const invoiceLink = await bot.telegram.createInvoiceLink(invoice);
    return { invoiceLink, package: pkg };
  } catch (e) {
    console.error("[ERROR] Error creating invoice link:", e.message);
    throw e;
  }
}

// Show swipe purchase options
function swipePurchaseButtons() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("40 Swipes - 4 ⭐", "buy_swipes_40"),
      Markup.button.callback("80 Swipes - 10 ⭐", "buy_swipes_80")
    ],
    [
      Markup.button.callback("❌ Cancel", "cancel_purchase")
    ]
  ]);
}

// -------------------------------------------
// ❤️ TELEGRAM BOT SETUP
// -------------------------------------------
if (!process.env.BOT_TOKEN) {
  console.error("❌ Error: BOT_TOKEN is missing in .env file");
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// temp memory to store users during setup (resets on restart)
const sessions = {};

function getSession(userId) {
  if (!sessions[userId]) {
    sessions[userId] = {
      shown: [], // Track which user IDs have been shown in current session
      lastPreference: null, // Track last preference to detect changes
      waitingForDeletionReason: false // Track if waiting for deletion reason
    };
  }
  return sessions[userId];
}

// -------------------------------------------
// ❤️ GLOBAL MIDDLEWARE (Clear state on commands)
// -------------------------------------------
bot.use(async (ctx, next) => {
  if (ctx.message && ctx.message.text && ctx.message.text.startsWith("/")) {
    const userId = ctx.from.id;
    const session = getSession(userId);

    // Clear any stuck reply keyboards if they abandoned a location prompt
    if (session.step === "ask_location" || session.step === "edit_location") {
      try {
        const msg = await ctx.reply("🔄 Closing prompt...", { reply_markup: { remove_keyboard: true } });
        setTimeout(() => { ctx.deleteMessage(msg.message_id).catch(() => { }); }, 1500);
      } catch (e) { }
    }

    session.step = null;
  }
  return next();
});

// -------------------------------------------
// ❤️ /start COMMAND
// -------------------------------------------
bot.start((ctx) => {
  ctx.reply(
    "Hey 😏\n\n" +
    "Use /create to make your profile ❤️\n" +
    "Use /profile to view your profile 👀\n" +
    "Use /edit to update your profile ✏️\n" +
    "Use /match to start finding people!\n" +
    "Use /help to see how we protect users for safe interaction 😎\n" +
    "Use /delete (or /delet) to remove your profile 🗑️"
  );
});

// -------------------------------------------
// ❤️ HELPER FUNCTIONS
// -------------------------------------------
// Escape Markdown special characters to prevent parsing errors
function escapeMarkdown(text) {
  if (!text) return text;
  // Escape special Markdown characters: _ * [ ] ( ) ~ ` > # + - = | { } . !
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

const INTEREST_OPTIONS = [
  { key: "gaming", label: "🎮 Gaming" },
  { key: "gym", label: "🏋️ Gym" },
  { key: "travel", label: "✈️ Travel" },
  { key: "cats", label: "🐈 Cats" },
  { key: "anime", label: "✨ Anime" },
  { key: "movies", label: "🎬 Movies" },
  { key: "music", label: "🎵 Music" },
  { key: "cooking", label: "🍳 Cooking" },
  { key: "books", label: "📚 Books" },
  { key: "art", label: "🎨 Art" },
  { key: "hiking", label: "🥾 Hiking" },
  { key: "tech", label: "💻 Tech" }
];

function formatInterests(keys) {
  const keySet = new Set((keys || []).filter(Boolean));
  const labels = INTEREST_OPTIONS.filter(opt => keySet.has(opt.key)).map(opt => opt.label);
  return labels.join(", ");
}

function escapeHtml(text) {
  if (text === null || text === undefined) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatInterestTagsHtml(keys) {
  const keySet = new Set((keys || []).filter(Boolean));
  const labels = INTEREST_OPTIONS.filter(opt => keySet.has(opt.key)).map(opt => opt.label);
  return labels.map(l => `<code>${escapeHtml(l)}</code>`).join(" ");
}

function formatListHuman(items) {
  const list = (items || []).filter(Boolean);
  if (list.length === 0) return "";
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} & ${list[1]}`;
  return `${list.slice(0, -1).join(", ")} & ${list[list.length - 1]}`;
}

// -------------------------------------------
// ❤️ GENDER COMPATIBILITY HELPER
// -------------------------------------------
/**
 * Mutual-compatibility check between two users.
 *
 * Rules (using this.bot's internal fields):
 * - user.gender:  "male" | "female"
 * - user.looking: "men"  | "women" | "any"
 *
 * A can see B only if:
 *  (A.looking === "any"  OR A.looking matches B.gender)
 *  AND
 *  (B.looking === "any"  OR B.looking matches A.gender)
 *
 * IMPORTANT: "any" does NOT override the other side.
 * If B.looking excludes A.gender, they must never be shown to A.
 */
function isCompatible(userA, userB) {
  if (!userA || !userB) return false;

  const genderA = userA.gender === "female" ? "female" : "male"; // default to male
  const genderB = userB.gender === "female" ? "female" : "male";

  const lookingA = userA.looking || "men";   // default to "men" for legacy profiles
  const lookingB = userB.looking || "men";

  const aAllowsB =
    lookingA === "any" ||
    (lookingA === "men" && genderB === "male") ||
    (lookingA === "women" && genderB === "female");

  const bAllowsA =
    lookingB === "any" ||
    (lookingB === "men" && genderA === "male") ||
    (lookingB === "women" && genderA === "female");

  return aAllowsB && bAllowsA;
}

function interestsKeyboard(selectedKeys) {
  const selected = new Set((selectedKeys || []).filter(Boolean));
  const rows = [];

  for (let i = 0; i < INTEREST_OPTIONS.length; i += 2) {
    const left = INTEREST_OPTIONS[i];
    const right = INTEREST_OPTIONS[i + 1];
    const row = [
      Markup.button.callback(
        `${selected.has(left.key) ? "✅ " : ""}${left.label}`,
        `interest_toggle_${left.key}`
      )
    ];
    if (right) {
      row.push(
        Markup.button.callback(
          `${selected.has(right.key) ? "✅ " : ""}${right.label}`,
          `interest_toggle_${right.key}`
        )
      );
    }
    rows.push(row);
  }

  const count = selected.size;
  rows.push([Markup.button.callback(`✅ Done (${count}/5)`, "interest_done")]);

  return Markup.inlineKeyboard(rows);
}

// -------------------------------------------
// ❤️ BUTTON HELPERS
// -------------------------------------------
function genderButtons() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("♂️ Male", "gender_male")],
    [Markup.button.callback("♀️ Female", "gender_female")]
  ]);
}

function lookingButtons() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("♂️ Men", "look_men")],
    [Markup.button.callback("♀️ Women", "look_women")],
    [Markup.button.callback("😴 Any", "look_any")]
  ]);
}

function swipeButtons(targetId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("❌ Skip", `skip_${targetId}`),
      Markup.button.callback("❤️ Like", `like_${targetId}`)
    ],
    [
      Markup.button.callback("💌 / 📹 Write or Record", `message_${targetId}`)
    ]
  ]);
}

// -------------------------------------------
// ❤️ /create — BEGIN PROFILE CREATION
// -------------------------------------------
bot.command("create", (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);

  session.step = "create_name_choice";
  session.interests = [];

  const telegramName = ctx.from.first_name || "your Telegram name";
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(`Use Telegram name (${telegramName})`, "create_name_telegram")],
    [Markup.button.callback("Set custom name", "create_name_custom_start")]
  ]);

  ctx.reply("Okay, let's create your profile.\n\nFirst, what name do you want to use?", keyboard);
});

// -------------------------------------------
// ❤️ CREATE FLOW — NAME CHOICES
// -------------------------------------------
bot.action("create_name_telegram", async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);

  session.name = ctx.from.first_name || "Unknown";
  session.step = "ask_age";

  await ctx.answerCbQuery();
  await ctx.reply("Great, I'll use your Telegram name.\n\nHow old are you? (e.g. 22)");
});

bot.action("create_name_custom_start", async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);

  session.step = "create_name_custom";

  await ctx.answerCbQuery();
  await ctx.reply("Send me the name you want to use.");
});

// -------------------------------------------
// ❤️ /profile — VIEW YOUR OWN PROFILE
// -------------------------------------------
bot.command("profile", async (ctx) => {
  const userId = ctx.from.id;
  const db = await loadDB();
  const user = db.users[userId];

  if (!user) {
    return ctx.reply("You don't have a profile yet.\nUse /create to make one.");
  }

  // Format intention text
  const intentionText = user.intention === "serious" ? "Serious relationship" :
    user.intention === "casual" ? "Casual dating" :
      user.intention === "friendship" ? "Friendship only" :
        user.intention === "exploring" ? "Just exploring 😏" :
          "Not set";

  // Reuse the same rich HTML formatting as candidate cards
  const safeName = escapeHtml(user.name || "Unknown");
  const safeAge = escapeHtml(user.age || "?");
  const safeLocation = escapeHtml(user.location || "Not set");
  const safeIntention = escapeHtml(intentionText);
  const safeGender = escapeHtml(user.gender || "Not set");
  const safeLooking = escapeHtml(user.looking || "Not set");
  const bioText = user.bio && String(user.bio).trim().length > 0 ? String(user.bio).trim() : "No bio";
  const safeBio = escapeHtml(bioText);
  const interestsTagsHtml = formatInterestTagsHtml(user.interests || []);
  const interestsLineHtml = interestsTagsHtml ? `🏷️ <b>Interests</b>: ${interestsTagsHtml}\n\n` : "";

  const profileText =
    `👤 <b>${safeName}, ${safeAge}</b>\n\n` +
    `📍 <b>Location</b>: ${safeLocation}\n\n` +
    `⚧️ <b>Gender</b>: ${safeGender}\n\n` +
    `❤️ <b>Looking for</b>: ${safeLooking}\n\n` +
    `${safeIntention ? `💘 <i>${safeIntention}</i>\n\n` : ""}` +
    `${interestsLineHtml}` +
    `📝 <b>Bio</b>\n<blockquote>${safeBio}</blockquote>`;

  try {
    // Prefer video profile if available
    if (user.profileVideo) {
      await Promise.race([
        ctx.replyWithVideo(user.profileVideo, {
          caption: profileText,
          parse_mode: 'HTML'
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Video send timeout')), 15000)
        )
      ]);
    } else {
      // Support multiple photos (2-3)
      const photos = user.photos || (user.photo ? [user.photo] : []);

      if (photos.length > 0) {
        if (photos.length === 1) {
          // Single photo
          await Promise.race([
            ctx.replyWithPhoto(photos[0], { caption: profileText, parse_mode: 'HTML' }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Photo send timeout')), 10000)
            )
          ]);
        } else {
          // Multiple photos - send as media group
          const media = photos.map((photo, index) => ({
            type: 'photo',
            media: photo,
            caption: index === 0 ? profileText : undefined, // Only caption on first photo
            parse_mode: index === 0 ? 'HTML' : undefined
          }));

          await Promise.race([
            ctx.replyWithMediaGroup(media),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Photo send timeout')), 10000)
            )
          ]);
        }
      } else {
        await ctx.reply(profileText, { parse_mode: 'HTML' });
      }
    }
  } catch (error) {
    console.error("[ERROR] Error sending profile media:", error.message);
    try {
      await ctx.reply(profileText + "\n\n(⚠️ Your media could not be loaded. Please update it.)");
    } catch (fallbackError) {
      console.error("[ERROR] Failed to send fallback profile message:", fallbackError.message);
    }
  }
});

// -------------------------------------------
// ❤️ /edit — EDIT YOUR PROFILE
// -------------------------------------------
bot.command("edit", async (ctx) => {
  const userId = ctx.from.id;
  const db = await loadDB();
  const user = db.users[userId];

  if (!user) {
    return ctx.reply("You don't have a profile yet.\nUse /create to make one first.");
  }

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback("👤 Name", "edit_name"),
      Markup.button.callback("🎂 Age", "edit_age")
    ],
    [
      Markup.button.callback("📍 Location", "edit_location"),
      Markup.button.callback("⚧ Gender", "edit_gender")
    ],
    [
      Markup.button.callback("📝 Bio", "edit_bio"),
      Markup.button.callback("💘 What I'm looking for", "edit_intention")
    ],
    [
      Markup.button.callback("❤️ Looking for", "edit_looking"),
      Markup.button.callback("🏷️ Interests", "edit_interests")
    ],
    [
      Markup.button.callback("📸 Photo/video", "edit_photo"),
      Markup.button.callback("✨ Edit everything", "edit_all_start")
    ]
  ]);

  ctx.reply("What would you like to edit? ✏️", keyboard);
});

bot.action("edit_interests", async (ctx) => {
  const userId = ctx.from.id;
  const db = await loadDB();
  const user = db.users[userId];

  if (!user) {
    return ctx.answerCbQuery("No profile found. Use /create first.", { show_alert: true });
  }

  const session = getSession(userId);
  session.step = "edit_interests";
  session.interests = Array.isArray(user.interests) ? user.interests : [];

  await ctx.answerCbQuery();
  await ctx.reply(
    `🏷️ Update your interests (pick 3-5):\n\nSelected: ${(session.interests || []).length}/5`,
    interestsKeyboard(session.interests)
  );
});

// -------------------------------------------
// ❤️ EDIT NAME
// -------------------------------------------
bot.action("edit_name", async (ctx) => {
  const userId = ctx.from.id;
  const db = await loadDB();
  const user = db.users[userId];

  if (!user) {
    return ctx.answerCbQuery("No profile found. Use /create first.", { show_alert: true });
  }

  const telegramName = ctx.from.first_name || "your Telegram name";

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(`Use Telegram name (${telegramName})`, "edit_name_telegram")],
    [Markup.button.callback("Set custom name", "edit_name_custom_start")]
  ]);

  await ctx.answerCbQuery();
  await ctx.reply("How do you want to set your name?", keyboard);
});

bot.action("edit_name_telegram", async (ctx) => {
  const userId = ctx.from.id;
  const db = await loadDB();

  if (!db.users[userId]) {
    return ctx.answerCbQuery("No profile found. Use /create first.", { show_alert: true });
  }

  const newName = ctx.from.first_name || db.users[userId].name;
  await saveUser(userId, { ...db.users[userId], name: newName });

  await ctx.answerCbQuery("Name updated ✅");
  await ctx.reply("👤 Your name has been updated to your Telegram name.");

  // Auto-start matching
  try {
    await showNext(userId, ctx);
  } catch (e) {
    console.error("Error auto-starting match after telegram name edit:", e);
  }
});

bot.action("edit_name_custom_start", async (ctx) => {
  const session = getSession(ctx.from.id);
  session.step = "edit_name_custom";

  await ctx.answerCbQuery();
  await ctx.reply("Send me the new name you want to use.");
});

// -------------------------------------------
// ❤️ EDIT PHOTO (ENTRY POINT)
// -------------------------------------------
bot.action("edit_photo", async (ctx) => {
  const userId = ctx.from.id;
  const db = await loadDB();

  if (!db.users[userId]) {
    return ctx.answerCbQuery("No profile found. Use /create first.", { show_alert: true });
  }

  const session = getSession(userId);
  session.step = "edit_photo";
  session.editPhotos = []; // Reset edit photos array

  await ctx.answerCbQuery();
  await ctx.reply("📸 Send me your new profile media.\n\nYou can upload a short video (up to 15 seconds) OR 2-3 photos. Send them one by one.");
});

// Handle finish photos buttons
bot.action("finish_photos", async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);

  if (!session.photos || session.photos.length < 2) {
    await ctx.answerCbQuery("Please upload at least 2 photos");
    return;
  }

  const db = await loadDB();
  const userData = {
    id: userId,
    name: session.name || ctx.from.first_name || "Unknown",
    username: ctx.from.username || null,
    age: session.age,
    location: session.location || "",
    bio: session.bio || "",
    gender: session.gender,
    looking: session.looking,
    intention: session.intention || "",
    interests: session.interests || [],
    photos: session.photos,
    photo: session.photos[0],
    likes: [],
    matches: [],
    dailySwipes: 0,
    lastSwipeReset: Date.now(),
    purchasedSwipes: 0
  };

  await saveUser(userId, userData);

  session.step = null;
  session.photos = null;
  session.shown = [];
  session.queue = null;
  session.lastPreference = null;

  await ctx.answerCbQuery();
  await ctx.reply("🔥 Profile complete! Your profile is now ready ❤️\n\nUse /match to start swiping!", { reply_markup: { remove_keyboard: true } });

  try {
    await showNext(userId, ctx);
  } catch (e) {
    console.error("Error auto-starting match:", e);
  }
});

bot.action("finish_edit_photos", async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);
  const db = await loadDB();
  const user = db.users[userId];

  if (!user) {
    await ctx.answerCbQuery("No profile found");
    return;
  }

  if (!session.editPhotos || session.editPhotos.length < 2) {
    await ctx.answerCbQuery("Please upload at least 2 photos");
    return;
  }

  const photosCount = session.editPhotos.length;

  await saveUser(userId, {
    ...user,
    photos: session.editPhotos,
    photo: session.editPhotos[0]
  });

  session.step = null;
  session.editPhotos = null;

  await ctx.answerCbQuery("Media updated ✅");
  await ctx.reply(`📸 Your ${photosCount} profile photo(s) have been updated!`);

  try {
    await showNext(userId, ctx);
  } catch (e) {
    console.error("Error auto-starting match:", e);
  }
});

bot.action("add_more_photo", async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);
  session.step = "ask_photo";
  await ctx.answerCbQuery();
  await ctx.reply("📸 Send your next photo (minimum 2 photos required, up to 3 total).");
});

bot.action("add_more_edit_photo", async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);
  session.step = "edit_photo";
  await ctx.answerCbQuery();
  await ctx.reply("📸 Send your next photo (minimum 2 photos required, up to 3 total).");
});

// -------------------------------------------
// ❤️ EDIT EVERYTHING (RE-RUN CREATE FLOW, KEEP MATCHES)
// -------------------------------------------
bot.action("edit_all_start", async (ctx) => {
  const userId = ctx.from.id;
  const db = await loadDB();
  const user = db.users[userId];

  if (!user) {
    return ctx.answerCbQuery("No profile found. Use /create first.", { show_alert: true });
  }

  const session = getSession(userId);
  session.step = "create_name_choice";
  session.interests = [];

  const telegramName = ctx.from.first_name || "your Telegram name";
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(`Use Telegram name (${telegramName})`, "create_name_telegram")],
    [Markup.button.callback("Set custom name", "create_name_custom_start")]
  ]);

  await ctx.answerCbQuery();
  await ctx.reply("Okay, let's refresh your whole profile.\n\nFirst, what name do you want to use?", keyboard);
});

// -------------------------------------------
// ❤️ EDIT AGE
// -------------------------------------------
bot.action("edit_age", async (ctx) => {
  const userId = ctx.from.id;
  const db = await loadDB();

  if (!db.users[userId]) {
    return ctx.answerCbQuery("No profile found. Use /create first.", { show_alert: true });
  }

  const session = getSession(userId);
  session.step = "edit_age";

  await ctx.answerCbQuery();
  await ctx.reply("Please send your new age (number).");
});

// -------------------------------------------
// ❤️ EDIT LOCATION
// -------------------------------------------
bot.action("edit_location", async (ctx) => {
  const userId = ctx.from.id;
  const db = await loadDB();

  if (!db.users[userId]) {
    return ctx.answerCbQuery("No profile found. Use /create first.", { show_alert: true });
  }

  const session = getSession(userId);
  session.step = "edit_location";

  await ctx.answerCbQuery();
  const keyboard = Markup.keyboard([
    [Markup.button.locationRequest("📍 Share my location")]
  ]).resize().oneTime();
  await ctx.reply("What is your new city/location?", keyboard);
});

// -------------------------------------------
// ❤️ EDIT BIO
// -------------------------------------------
bot.action("edit_bio", async (ctx) => {
  const userId = ctx.from.id;
  const db = await loadDB();

  if (!db.users[userId]) {
    return ctx.answerCbQuery("No profile found. Use /create first.", { show_alert: true });
  }

  const session = getSession(userId);
  session.step = "edit_bio";

  await ctx.answerCbQuery();
  await ctx.reply("Send me your new bio.");
});

// -------------------------------------------
// ❤️ EDIT GENDER
// -------------------------------------------
bot.action("edit_gender", async (ctx) => {
  const userId = ctx.from.id;
  const db = await loadDB();

  if (!db.users[userId]) {
    return ctx.answerCbQuery("No profile found. Use /create first.", { show_alert: true });
  }

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("♂️ Male", "edit_gender_male")],
    [Markup.button.callback("♀️ Female", "edit_gender_female")]
  ]);

  await ctx.answerCbQuery();
  await ctx.reply("Select your gender:", keyboard);
});

bot.action("edit_gender_male", async (ctx) => {
  const userId = ctx.from.id;
  const db = await loadDB();
  const user = db.users[userId];

  if (!user) {
    return ctx.answerCbQuery("No profile found. Use /create first.", { show_alert: true });
  }

  await saveUser(userId, { ...user, gender: "male" });

  await ctx.answerCbQuery("Gender updated ✅");
  await ctx.reply("⚧ Your gender is now set to male.");

  // Auto-start matching
  try {
    await showNext(userId, ctx);
  } catch (e) {
    console.error("Error auto-starting match after gender (male) edit:", e);
  }
});

bot.action("edit_gender_female", async (ctx) => {
  const userId = ctx.from.id;
  const db = await loadDB();
  const user = db.users[userId];

  if (!user) {
    return ctx.answerCbQuery("No profile found. Use /create first.", { show_alert: true });
  }

  await saveUser(userId, { ...user, gender: "female" });

  await ctx.answerCbQuery("Gender updated ✅");
  await ctx.reply("⚧ Your gender is now set to female.");

  // Auto-start matching
  try {
    await showNext(userId, ctx);
  } catch (e) {
    console.error("Error auto-starting match after gender (female) edit:", e);
  }
});

// -------------------------------------------
// ❤️ EDIT LOOKING FOR
// -------------------------------------------
bot.action("edit_intention", async (ctx) => {
  const userId = ctx.from.id;
  const db = await loadDB();

  if (!db.users[userId]) {
    return ctx.answerCbQuery("No profile found. Use /create first.", { show_alert: true });
  }

  await ctx.answerCbQuery();
  await ctx.reply("💘 What are you looking for on EthioMatch?", intentionButtons());
});

bot.action(/edit_intention_(.+)/, async (ctx) => {
  const userId = ctx.from.id;
  const db = await loadDB();

  if (!db.users[userId]) {
    return ctx.answerCbQuery("No profile found. Use /create first.", { show_alert: true });
  }

  const fullMatch = ctx.match[0] || ctx.match.input;
  const intention = fullMatch.replace("edit_intention_", "");

  await saveUser(userId, { ...db.users[userId], intention: intention });

  const intentionText = intention === "serious" ? "Serious relationship" :
    intention === "casual" ? "Casual dating" :
      intention === "friendship" ? "Friendship only" :
        intention === "exploring" ? "Just exploring 😏" : intention;

  await ctx.answerCbQuery("Intention updated ✅");
  await ctx.reply(`💘 Your intention has been updated to: ${intentionText}`);

  // Auto-start matching
  try {
    await showNext(userId, ctx);
  } catch (e) {
    console.error("Error auto-starting match after intention edit:", e);
  }
});

bot.action("edit_looking", async (ctx) => {
  const userId = ctx.from.id;
  const db = await loadDB();

  if (!db.users[userId]) {
    return ctx.answerCbQuery("No profile found. Use /create first.", { show_alert: true });
  }

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("♂️ Men", "edit_look_men")],
    [Markup.button.callback("♀️ Women", "edit_look_women")],
    [Markup.button.callback("⭐ Any", "edit_look_any")]
  ]);

  await ctx.answerCbQuery();
  await ctx.reply("Who are you looking for?", keyboard);
});

bot.action("edit_look_men", async (ctx) => {
  const userId = ctx.from.id;
  const db = await loadDB();
  const user = db.users[userId];

  if (!user) {
    return ctx.answerCbQuery("No profile found. Use /create first.", { show_alert: true });
  }

  await saveUser(userId, { ...user, looking: "men" });

  // Reset shown list when preference changes
  const session = getSession(userId);
  session.shown = [];
  session.lastPreference = "men";

  await ctx.answerCbQuery("Preference updated ✅");
  await ctx.reply("❤️ You are now looking for men.");

  // Auto-start matching
  try {
    await showNext(userId, ctx);
  } catch (e) {
    console.error("Error auto-starting match after looking (men) edit:", e);
  }
});

bot.action("edit_look_women", async (ctx) => {
  const userId = ctx.from.id;
  const db = await loadDB();
  const user = db.users[userId];

  if (!user) {
    return ctx.answerCbQuery("No profile found. Use /create first.", { show_alert: true });
  }

  await saveUser(userId, { ...user, looking: "women" });

  // Reset shown list when preference changes
  const session = getSession(userId);
  session.shown = [];
  session.lastPreference = "women";

  await ctx.answerCbQuery("Preference updated ✅");
  await ctx.reply("❤️ You are now looking for women.");

  // Auto-start matching
  try {
    await showNext(userId, ctx);
  } catch (e) {
    console.error("Error auto-starting match after looking (women) edit:", e);
  }
});

bot.action("edit_look_any", async (ctx) => {
  const userId = ctx.from.id;
  const db = await loadDB();
  const user = db.users[userId];

  if (!user) {
    return ctx.answerCbQuery("No profile found. Use /create first.", { show_alert: true });
  }

  // "any" means: I accept both genders, BUT we still respect the other person's preference.
  await saveUser(userId, { ...user, looking: "any" });

  // Reset shown list when preference changes
  const session = getSession(userId);
  session.shown = [];
  session.lastPreference = "any";

  await ctx.answerCbQuery("Preference updated ✅");
  await ctx.reply("❤️ You are now looking for any gender (we will still only show people who also allow your gender).");

  // Auto-start matching
  try {
    await showNext(userId, ctx);
  } catch (e) {
    console.error("Error auto-starting match after looking (any) edit:", e);
  }
});


// -------------------------------------------
// ❤️ TEXT HANDLING (NAME + AGE + BIO + EDIT FIELDS)
// -------------------------------------------
// -------------------------------------------
// ❤️ HANDLE VIDEO MESSAGES (First Move)
// -------------------------------------------
bot.on(["video", "video_note"], async (ctx, next) => {
  const userId = ctx.from.id;
  const session = getSession(userId);

  // Check if we are waiting for a message to a match
  if (session.step && session.step.startsWith("waiting_message_")) {
    const targetId = session.messageTargetId;
    if (!targetId) {
      session.step = null;
      return;
    }

    // 1. Get the File ID
    let fileId;
    let type;

    if (ctx.message.video_note) {
      fileId = ctx.message.video_note.file_id;
      type = "video_note"; // The circle video
    } else if (ctx.message.video) {
      fileId = ctx.message.video.file_id;
      type = "video"; // Normal square/rect video
    } else {
      return next();
    }

    // 2. Load DB (Standard checks)
    const db = await loadDB();
    const me = db.users[userId];
    const targetUser = db.users[targetId];

    if (!me) {
      session.step = null;
      return ctx.reply("❗ We lost your profile due to major upgrade to the bot. Please create it again: /create");
    }

    if (!targetUser) {
      session.step = null;
      await ctx.reply("❌ User not found. Continuing with matches...");
      try {
        await showCandidate(userId, ctx);
      } catch (e) {
        console.error("Error showing candidate after video message:", e);
      }
      return;
    }

    // 3. Logic: Add Like, Check Match (same as text handler)
    if (!me.likes) me.likes = [];
    me.likes = me.likes.map(id => parseInt(id)).filter(id => !isNaN(id));
    if (!me.likes.includes(targetId)) {
      me.likes.push(targetId);
    }

    let matchFound = false;
    if (!targetUser.likes) targetUser.likes = [];
    targetUser.likes = targetUser.likes.map(id => parseInt(id)).filter(id => !isNaN(id));

    if (targetUser.likes.includes(userId)) {
      matchFound = true;
      if (!me.matches) me.matches = [];
      if (!targetUser.matches) targetUser.matches = [];
      me.matches = me.matches.map(id => parseInt(id)).filter(id => !isNaN(id));
      targetUser.matches = targetUser.matches.map(id => parseInt(id)).filter(id => !isNaN(id));

      if (!me.matches.includes(targetId)) me.matches.push(targetId);
      if (!targetUser.matches.includes(userId)) targetUser.matches.push(userId);

      // Notify target user about match
      try {
        const matchMessage = `🎉❤️ IT'S A MATCH!\n\n${me.name} liked you back and sent you a video message!\n\nSend them a message: ${me.username || ctx.from.username ? `@${me.username || ctx.from.username}` : `[${me.name || "User"}](tg://user?id=${userId})`}`;
        await Promise.race([
          ctx.telegram.sendMessage(
            targetId,
            matchMessage,
            { parse_mode: 'Markdown' }
          ),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Message send timeout')), 10000)
          )
        ]);
      } catch (e) {
        console.error(`[ERROR] Could not notify target user about match (video):`, e.message);
      }
    } else {
      // Not a match - add to their recentLikes so they can see who liked them (most recent at the end)
      if (!targetUser.recentLikes) targetUser.recentLikes = [];
      targetUser.recentLikes = targetUser.recentLikes.map(id => parseInt(id)).filter(id => !isNaN(id));
      targetUser.recentLikes = targetUser.recentLikes.filter(id => id !== userId);
      targetUser.recentLikes.push(userId);

      // Send notification about the like
      try {
        await Promise.race([
          ctx.telegram.sendMessage(
            targetId,
            `❤️ Someone sent you a video message!\n\nSee who it is: /matches`
          ),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Message send timeout')), 10000)
          )
        ]);
      } catch (e) {
        console.error(`[ERROR] Could not notify target user about like (video):`, e.message);
      }
    }

    // 4. SEND THE VIDEO TO THE TARGET (same visual style as text messages)
    const senderName = me.name || "Someone";
    const senderUsername = me.username || ctx.from.username;
    const senderContact = senderUsername ? `@${senderUsername}` : `[${senderName}](tg://user?id=${userId})`;

    const intentionText = me.intention === "serious" ? "Serious relationship" :
      me.intention === "casual" ? "Casual dating" :
        me.intention === "friendship" ? "Friendship only" :
          me.intention === "exploring" ? "Just exploring 😏" :
            "";

    const caption =
      `💌 You received a video message from ${senderName}${senderUsername ? ` (@${senderUsername})` : ''}:\n\n` +
      `━━━━━━━━━━━━━━━━\n\n` +
      `👤 ${senderName}, ${me.age || "?"}\n\n` +
      `📍 Location: ${me.location || "Not set"}\n\n` +
      `⚧️ ${me.gender === "male" ? "♂️ Male" : "♀️ Female"}\n\n` +
      `${intentionText ? `💘 ${intentionText}\n\n` : ""}` +
      `📝 ${me.bio || "No bio"}\n\n` +
      `💬 ${senderContact}`;

    // Buttons for the target
    const messageButtons = Markup.inlineKeyboard([
      [
        Markup.button.callback("❌ Skip", `skip_${userId}`),
        Markup.button.callback("❤️ Like Back", `like_${userId}`)
      ],
      [Markup.button.callback("🚫 Report", `report_${userId}`)]
    ]);

    // Check swipe limit before sending confirmation (reuse logic from text handler)
    let availableSwipes = await getAvailableSwipes(userId);

    try {
      if (type === "video_note") {
        // Video notes (circles) can't have captions in the same bubble usually,
        // so we send text first, then the note.
        await ctx.telegram.sendMessage(targetId, caption, { parse_mode: 'Markdown' });
        await ctx.telegram.sendVideoNote(targetId, fileId, messageButtons);
      } else {
        // Standard video
        await ctx.telegram.sendVideo(
          targetId,
          fileId,
          {
            caption: caption,
            parse_mode: 'Markdown',
            ...messageButtons
          }
        );
      }

      if (matchFound) {
        await ctx.reply(`🔥 You MATCHED with ${targetUser.name || "user"}!\n✅ Video message sent!\n\nUse /matches to see list.`);
      } else {
        if (availableSwipes.total > 0) {
          await ctx.reply(`✅ Video message sent to ${targetUser.name || "user"}!\n\nContinuing with matches...`);
        } else {
          await ctx.reply(`✅ Video message sent to ${targetUser.name || "user"}!\n\n⏸️ You've reached your daily swipe limit. Purchase more swipes to continue matching!`);
        }
      }
    } catch (e) {
      console.error(`[ERROR] Could not send video to user ${targetId}:`, e.message);
      // Re-check swipe limit in case it changed
      availableSwipes = await getAvailableSwipes(userId);
      if (availableSwipes.total > 0) {
        await ctx.reply(`⚠️ Could not send video (user may have blocked bot).\n\nContinuing with matches...`);
      } else {
        await ctx.reply(`⚠️ Could not send video (user may have blocked bot).\n\n⏸️ You've reached your daily swipe limit. Purchase more swipes to continue matching!`);
      }
    }

    // 5. Cleanup + DB updates
    await updateUserArrays(userId, { likes: me.likes, matches: me.matches });
    if (matchFound) {
      await updateUserArrays(targetId, { likes: targetUser.likes, matches: targetUser.matches });
    } else {
      await updateUserArrays(targetId, { likes: targetUser.likes, recentLikes: targetUser.recentLikes });
    }

    session.step = null;
    session.messageTargetId = null;

    // Check swipe limit - if reached, don't continue showing profiles (reuse availableSwipes from above)
    if (availableSwipes.total <= 0) {
      return;
    }

    // Wait a bit if match found
    if (matchFound) {
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    // Continue showing profiles automatically (only if user has swipes remaining)
    try {
      await showCandidate(userId, ctx);
    } catch (e) {
      console.error("Error showing candidate after sending video message:", e);
    }
    return;
  }

  // If not waiting for a message, pass to next handler
  return next();
});

// -------------------------------------------
// ❤️ LOCATION HANDLING
// -------------------------------------------
const https = require('https');
bot.on("location", async (ctx, next) => {
  const userId = ctx.from.id;
  const session = getSession(userId);

  if (session.step !== "ask_location" && session.step !== "edit_location") {
    return ctx.reply("📍 Location dismissed.", { reply_markup: { remove_keyboard: true } });
  }

  if (session.step === "ask_location" || session.step === "edit_location") {
    const lat = ctx.message.location.latitude;
    const lon = ctx.message.location.longitude;
    const isEditing = session.step === "edit_location";

    const options = {
      hostname: 'nominatim.openstreetmap.org',
      path: `/reverse?format=json&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1`,
      method: 'GET',
      headers: { 'User-Agent': 'EthioMatchTelegramBot' }
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', async () => {
        let city = "Shared Location";
        try {
          const parsed = JSON.parse(data);
          city = parsed.address.city || parsed.address.town || parsed.address.village || parsed.address.county || parsed.address.state || "Shared Location";
        } catch (e) { }

        if (isEditing) {
          const db = await loadDB();
          const user = db.users[userId];
          if (user) await saveUser(userId, { ...user, location: city });
          session.step = null;
          ctx.reply(`📍 Got it! Location updated to: ${city}`, { reply_markup: { remove_keyboard: true } });
          try { await showNext(userId, ctx); } catch (e) { }
        } else {
          session.location = city;
          session.step = "ask_gender";
          await ctx.reply(`Got it! Location set to: ${city}`, { reply_markup: { remove_keyboard: true } });
          await new Promise(r => setTimeout(r, 50));
          await ctx.reply("What's your gender? ⚧", genderButtons());
        }
      });
    }).on('error', async () => {
      if (isEditing) {
        const db = await loadDB();
        const user = db.users[userId];
        if (user) await saveUser(userId, { ...user, location: "Shared Location" });
        session.step = null;
        ctx.reply("📍 Got it! Location updated!", { reply_markup: { remove_keyboard: true } });
        try { await showNext(userId, ctx); } catch (e) { }
      } else {
        session.location = "Shared Location";
        session.step = "ask_gender";
        await ctx.reply("Got it! 📍", { reply_markup: { remove_keyboard: true } });
        await new Promise(r => setTimeout(r, 50));
        await ctx.reply("What's your gender? ⚧", genderButtons());
      }
    });
    return;
  }

  return next();
});

// -------------------------------------------
// ❤️ TEXT HANDLING (NAME + AGE + BIO + EDIT FIELDS)
// -------------------------------------------
bot.on("text", async (ctx, next) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;
  const session = getSession(userId);

  // Let commands (messages starting with "/") pass through
  // to command handlers like /match, /delete, /matches, etc.
  if (text.startsWith("/")) {
    return next();
  }

  // Handle deletion reason input
  if (session.waitingForDeletionReason) {
    const userId = ctx.from.id;
    const db = await loadDB();
    const user = db.users[userId];

    if (!user) {
      session.waitingForDeletionReason = false;
      return ctx.reply("You don't have a profile to delete.");
    }

    // Save deletion reason
    const reasonData = {
      userId: userId,
      userName: user.name || ctx.from.first_name || "Unknown",
      username: user.username || ctx.from.username || null,
      reason: text.trim(),
      timestamp: Date.now()
    };

    await saveDeletionReason(reasonData);

    // Now proceed with deletion
    const userIdNum = parseInt(userId);

    // Clean up references from other users' likes and matches arrays
    const allUsers = await usersCollection.find({}).toArray();
    for (const otherUser of allUsers) {
      if (otherUser.id === userIdNum) continue; // Skip the user being deleted

      const updates = {};

      // Remove from likes array
      if (otherUser.likes && Array.isArray(otherUser.likes)) {
        updates.likes = otherUser.likes
          .map(id => parseInt(id))
          .filter(id => !isNaN(id) && id !== userIdNum);
      }

      // Remove from matches array
      if (otherUser.matches && Array.isArray(otherUser.matches)) {
        updates.matches = otherUser.matches
          .map(id => parseInt(id))
          .filter(id => !isNaN(id) && id !== userIdNum);
      }

      // Remove from recentLikes array
      if (otherUser.recentLikes && Array.isArray(otherUser.recentLikes)) {
        updates.recentLikes = otherUser.recentLikes
          .map(id => parseInt(id))
          .filter(id => !isNaN(id) && id !== userIdNum);
      }

      if (Object.keys(updates).length > 0) {
        await updateUserArrays(otherUser.id, updates);
      }
    }

    // Delete the user's profile from MongoDB
    await deleteUser(userId);

    // Clear their session completely (including shown list)
    session.queue = null;
    session.step = null;
    session.shown = [];
    session.lastPreference = null;
    session.waitingForDeletionReason = false;

    // Also remove from sessions object to fully reset
    delete sessions[userId];

    await ctx.reply("Your account is deleted now. Hope you met someone with my help!\n\nAlways happy to chat. If bored, text me /start - I'll find someone special for you.");
    return;
  }

  if (!session.step) return;

  // STEP 0 — Name (create, custom)
  if (session.step === "create_name_custom") {
    session.name = text.trim();
    session.step = "ask_age";
    await ctx.reply("Nice, got it.\n\nHow old are you? (e.g. 22)");
    return;
  }

  // STEP 1 — Age (create)
  if (session.step === "ask_age") {
    if (isNaN(text)) {
      return ctx.reply("Please enter a valid number for your age.");
    }
    session.age = text;
    session.step = "ask_location";
    const keyboard = Markup.keyboard([
      [Markup.button.locationRequest("📍 Share my location")]
    ]).resize().oneTime();
    ctx.reply("What city are you from?", keyboard);
    return;
  }

  // STEP 1.5 - Location (create)
  if (session.step === "ask_location") {
    session.location = text.trim();
    session.step = "ask_gender";
    await ctx.reply("Got it! 📍", { reply_markup: { remove_keyboard: true } });
    await new Promise(r => setTimeout(r, 50));
    await ctx.reply("What's your gender? ⚧", genderButtons());
    return;
  }

  // STEP 2 — Bio (create) - optional
  if (session.step === "ask_bio") {
    session.bio = text;
    session.step = "ask_photo";
    ctx.reply("📸 Perfect! Now send me your profile media.\n\nYou can upload a short video (up to 15 seconds) OR 2-3 photos. Send them one by one, and I'll let you know when you've reached the limit.");
    return;
  }

  // EDIT NAME (custom)
  if (session.step === "edit_name_custom") {
    const db = await loadDB();
    const user = db.users[userId];
    if (!user) {
      session.step = null;
      return ctx.reply("You don't have a profile yet. Use /create first.");
    }
    await saveUser(userId, { ...user, name: text.trim() });
    session.step = null;
    await ctx.reply("👤 Your name has been updated.");

    // Auto-start matching
    try {
      await showNext(userId, ctx);
    } catch (e) {
      console.error("Error auto-starting match after name edit:", e);
    }
    return;
  }

  // EDIT AGE
  if (session.step === "edit_age") {
    if (isNaN(text)) {
      return ctx.reply("Please enter a valid number for your age.");
    }
    const db = await loadDB();
    const user = db.users[userId];
    if (!user) {
      session.step = null;
      return ctx.reply("You don't have a profile yet. Use /create first.");
    }
    await saveUser(userId, { ...user, age: text });
    session.step = null;
    await ctx.reply("🎂 Your age has been updated.");

    // Auto-start matching
    try {
      await showNext(userId, ctx);
    } catch (e) {
      console.error("Error auto-starting match after age edit:", e);
    }
    return;
  }

  // EDIT LOCATION
  if (session.step === "edit_location") {
    const db = await loadDB();
    const user = db.users[userId];
    if (!user) {
      session.step = null;
      return ctx.reply("You don't have a profile yet. Use /create first.");
    }
    await saveUser(userId, { ...user, location: text.trim() });
    session.step = null;
    ctx.reply("📍 Your location has been updated.", { reply_markup: { remove_keyboard: true } });

    // Auto-start matching
    try {
      await showNext(userId, ctx);
    } catch (e) {
      console.error("Error auto-starting match after location edit:", e);
    }
    return;
  }

  // EDIT BIO
  if (session.step === "edit_bio") {
    const db = await loadDB();
    const user = db.users[userId];
    if (!user) {
      session.step = null;
      return ctx.reply("You don't have a profile yet. Use /create first.");
    }
    await saveUser(userId, { ...user, bio: text });
    session.step = null;
    await ctx.reply("📝 Your bio has been updated.");

    // Auto-start matching
    try {
      await showNext(userId, ctx);
    } catch (e) {
      console.error("Error auto-starting match after bio edit:", e);
    }
    return;
  }

  // MESSAGE HANDLING - Send message to liked user
  if (session.step && session.step.startsWith("waiting_message_")) {
    const targetId = session.messageTargetId;
    if (!targetId) {
      session.step = null;
      return;
    }

    const db = await loadDB();
    const me = db.users[userId];
    const targetUser = db.users[targetId];

    if (!me) {
      session.step = null;
      return ctx.reply("❗ We lost your profile due to major upgrade to the bot. Please create it again: /create");
    }

    if (!targetUser) {
      session.step = null;
      await ctx.reply("❌ User not found. Continuing with matches...");
      // Continue showing profiles
      try {
        await showCandidate(userId, ctx);
      } catch (e) {
        console.error("Error showing candidate after message:", e);
      }
      return;
    }

    // Add like when sending message (user likes the person they're messaging)
    if (!me.likes) me.likes = [];
    me.likes = me.likes.map(id => parseInt(id)).filter(id => !isNaN(id));
    if (!me.likes.includes(targetId)) {
      me.likes.push(targetId);
    }

    // Check for match
    let matchFound = false;
    if (!targetUser.likes) targetUser.likes = [];
    targetUser.likes = targetUser.likes.map(id => parseInt(id)).filter(id => !isNaN(id));

    if (targetUser.likes.includes(userId)) {
      matchFound = true;
      // Update match arrays
      if (!me.matches) me.matches = [];
      if (!targetUser.matches) targetUser.matches = [];
      me.matches = me.matches.map(id => parseInt(id)).filter(id => !isNaN(id));
      targetUser.matches = targetUser.matches.map(id => parseInt(id)).filter(id => !isNaN(id));

      if (!me.matches.includes(targetId)) me.matches.push(targetId);
      if (!targetUser.matches.includes(userId)) targetUser.matches.push(userId);

      // Notify target user about match
      try {
        const matchMessage = `🎉❤️ IT'S A MATCH!\n\n${me.name} liked you back and sent you a message!\n\nSend them a message: ${me.username || ctx.from.username ? `@${me.username || ctx.from.username}` : `[${me.name || "User"}](tg://user?id=${userId})`}`;
        await Promise.race([
          ctx.telegram.sendMessage(
            targetId,
            matchMessage,
            { parse_mode: 'Markdown' }
          ),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Message send timeout')), 10000)
          )
        ]);
      } catch (e) {
        console.error(`[ERROR] Could not notify target user about match:`, e.message);
      }
    } else {
      // Not a match - add to their recentLikes so they can see who liked them (most recent at the end)
      if (!targetUser.recentLikes) targetUser.recentLikes = [];
      targetUser.recentLikes = targetUser.recentLikes.map(id => parseInt(id)).filter(id => !isNaN(id));
      // Remove if already exists (to avoid duplicates), then add to end (most recent)
      targetUser.recentLikes = targetUser.recentLikes.filter(id => id !== userId);
      targetUser.recentLikes.push(userId); // Add to end = most recent

      // Send notification about the like
      try {
        await Promise.race([
          ctx.telegram.sendMessage(
            targetId,
            `❤️ Someone liked you!\n\nSee who it is: /matches`
          ),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Message send timeout')), 10000)
          )
        ]);
      } catch (e) {
        console.error(`[ERROR] Could not notify target user about like:`, e.message);
      }
    }

    // Send message to target user WITH PROFILE
    const senderName = me.name || ctx.from.first_name || "Someone";
    const senderUsername = me.username || ctx.from.username;
    const senderContact = senderUsername ? `@${senderUsername}` : `[${senderName}](tg://user?id=${userId})`;

    // Create profile text with message (better formatting)
    // Format intention text
    const intentionText = me.intention === "serious" ? "Serious relationship" :
      me.intention === "casual" ? "Casual dating" :
        me.intention === "friendship" ? "Friendship only" :
          me.intention === "exploring" ? "Just exploring 😏" :
            "";

    const profileText = `💌 You received a message from ${senderName}${senderUsername ? ` (@${senderUsername})` : ''}:\n\n"${text}"\n\n━━━━━━━━━━━━━━━━\n\n👤 ${senderName}, ${me.age || "?"}\n\n📍 Location: ${me.location || "Not set"}\n\n⚧️ ${me.gender === "male" ? "♂️ Male" : "♀️ Female"}\n\n${intentionText ? `💘 ${intentionText}\n\n` : ""}📝 ${me.bio || "No bio"}\n\n💬 ${senderContact}`;

    // Create buttons to like back or skip
    const messageButtons = Markup.inlineKeyboard([
      [
        Markup.button.callback("❌ Skip", `skip_${userId}`),
        Markup.button.callback("❤️ Like Back", `like_${userId}`)
      ],
      [
        Markup.button.callback("🚫 Report", `report_${userId}`)
      ]
    ]);

    // Check swipe limit before sending message (for message confirmation text)
    let availableSwipes = await getAvailableSwipes(userId);

    try {
      // Send profile with photos if available (support multiple photos)
      const photos = me.photos || (me.photo ? [me.photo] : []);

      if (photos.length > 0) {
        if (photos.length === 1) {
          // Single photo - can attach buttons directly
          await Promise.race([
            ctx.telegram.sendPhoto(targetId, photos[0], {
              caption: profileText,
              parse_mode: 'Markdown',
              ...messageButtons
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Photo send timeout')), 10000)
            )
          ]);
        } else {
          // Multiple photos - send ALL together in one media group
          const media = photos.map((photo, index) => ({
            type: 'photo',
            media: photo,
            caption: index === 0 ? profileText : undefined // Only caption on first photo
          }));

          await Promise.race([
            ctx.telegram.sendMediaGroup(targetId, media),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Photo send timeout')), 10000)
            )
          ]);

          // Send buttons separately after the media group
          await ctx.telegram.sendMessage(targetId, "🔥 Looks like a nice profile! Ready to make a move?", messageButtons);

          // Send profile text with contact info separately (since media group caption doesn't support markdown links well)
          await ctx.telegram.sendMessage(targetId, profileText, { parse_mode: 'Markdown' });
        }
      } else {
        await Promise.race([
          ctx.telegram.sendMessage(targetId, profileText, {
            parse_mode: 'Markdown',
            ...messageButtons
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Message send timeout')), 10000)
          )
        ]);
      }

      // Use availableSwipes already checked above
      if (matchFound) {
        await ctx.reply(`🔥 You MATCHED with ${targetUser.name || "user"}!\n✅ Message sent!\n\nUse /matches to see list.`);
      } else {
        if (availableSwipes.total > 0) {
          await ctx.reply(`✅ Message sent to ${targetUser.name || "user"}!\n\nContinuing with matches...`);
        } else {
          await ctx.reply(`✅ Message sent to ${targetUser.name || "user"}!\n\n⏸️ You've reached your daily swipe limit. Purchase more swipes to continue matching!`);
        }
      }
    } catch (e) {
      console.error(`[ERROR] Could not send message to user ${targetId}:`, e.message);
      // Re-check swipe limit in case it changed
      availableSwipes = await getAvailableSwipes(userId);
      if (availableSwipes.total > 0) {
        await ctx.reply(`⚠️ Could not send message (user may have blocked bot).\n\nContinuing with matches...`);
      } else {
        await ctx.reply(`⚠️ Could not send message (user may have blocked bot).\n\n⏸️ You've reached your daily swipe limit. Purchase more swipes to continue matching!`);
      }
    }

    // Save database
    await updateUserArrays(userId, { likes: me.likes, matches: me.matches });
    if (matchFound) {
      await updateUserArrays(targetId, { likes: targetUser.likes, matches: targetUser.matches });
    } else {
      await updateUserArrays(targetId, { likes: targetUser.likes, recentLikes: targetUser.recentLikes });
    }

    // Clear message step
    session.step = null;
    session.messageTargetId = null;

    // Check swipe limit - if reached, don't continue showing profiles (reuse availableSwipes from above)
    if (availableSwipes.total <= 0) {
      // User hit limit - don't continue swiping, but message was sent successfully
      return;
    }

    // Wait a bit if match found
    if (matchFound) {
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    // Continue showing profiles automatically (only if user has swipes remaining)
    try {
      await showCandidate(userId, ctx);
    } catch (e) {
      console.error("Error showing candidate after sending message:", e);
    }
    return;
  }

  // For any other plain text, we just ignore it
  return;
});

// -------------------------------------------
// ❤️ GENDER CALLBACK
// -------------------------------------------
bot.action(/gender_(.+)/, async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);

  const fullMatch = ctx.match[0] || ctx.match.input;
  const gender = fullMatch.replace("gender_", "");

  session.gender = gender;
  session.step = "ask_looking";

  await ctx.answerCbQuery();
  await ctx.reply("Who are you looking for? ❤️", lookingButtons());
});

// -------------------------------------------
// ❤️ LOOKING FOR CALLBACK
// -------------------------------------------
bot.action(/look_(.+)/, async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);

  const fullMatch = ctx.match[0] || ctx.match.input;
  const looking = fullMatch.replace("look_", "");

  // Store raw internal value: "men" | "women" | "any"
  session.looking = looking;
  session.step = "ask_intention";

  await ctx.answerCbQuery();
  await ctx.reply("💘 What are you looking for on EthioMatch?", intentionButtons());
});

// -------------------------------------------
// ❤️ SKIP BIO BUTTON
// -------------------------------------------
bot.action("skip_bio", async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);

  session.bio = ""; // Empty bio
  session.step = "ask_photo";

  await ctx.answerCbQuery();
  await ctx.reply("📸 Perfect! Now send me your profile media.\n\nYou can upload a short video (up to 15 seconds) OR 2-3 photos. Send them one by one, and I'll let you know when you've reached the limit.");
});

// -------------------------------------------
// ❤️ INTENTION BUTTONS
// -------------------------------------------
function intentionButtons() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔘 Serious relationship", "intention_serious")],
    [Markup.button.callback("🔘 Casual dating", "intention_casual")],
    [Markup.button.callback("🔘 Friendship only", "intention_friendship")],
    [Markup.button.callback("🔘 Just exploring 😏", "intention_exploring")]
  ]);
}

// -------------------------------------------
// ❤️ INTENTION CALLBACK
// -------------------------------------------
bot.action(/intention_(.+)/, async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);

  const fullMatch = ctx.match[0] || ctx.match.input;
  const intention = fullMatch.replace("intention_", "");

  session.intention = intention;
  session.step = "ask_interests";
  session.interests = [];

  await ctx.answerCbQuery();
  await ctx.reply(
    "🏷️ Pick 3-5 interests (tap to toggle):",
    interestsKeyboard(session.interests)
  );
});

bot.action("interest_done", async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);

  if (session.step !== "ask_interests" && session.step !== "edit_interests") {
    await ctx.answerCbQuery();
    return;
  }

  const count = (session.interests || []).length;
  if (count < 3) {
    await ctx.answerCbQuery("Pick at least 3 interests", { show_alert: true });
    return;
  }
  if (count > 5) {
    await ctx.answerCbQuery("Pick up to 5 interests", { show_alert: true });
    return;
  }

  if (session.step === "edit_interests") {
    const db = await loadDB();
    if (!db.users[userId]) {
      await ctx.answerCbQuery("No profile found", { show_alert: true });
      return;
    }

    await saveUser(userId, { ...db.users[userId], interests: session.interests || [] });
    session.step = null;

    try {
      await ctx.editMessageText("✅ Interests updated!", { reply_markup: { inline_keyboard: [] } });
    } catch (e) {
      // ignore
    }

    await ctx.answerCbQuery("Updated ✅");
    await ctx.reply("🏷️ Your interests have been updated.");

    try {
      await showNext(userId, ctx);
    } catch (e) {
      console.error("Error auto-starting match after interests edit:", e);
    }

    return;
  }

  session.step = "ask_bio";

  try {
    await ctx.editMessageText("✅ Interests saved!", { reply_markup: { inline_keyboard: [] } });
  } catch (e) {
    // ignore
  }

  await ctx.answerCbQuery();
  await ctx.reply(
    "📝 Now tell me a short bio about yourself (or click Skip to skip this step).",
    Markup.inlineKeyboard([[Markup.button.callback("⏭️ Skip Bio", "skip_bio")]])
  );
});

bot.action(/interest_toggle_(.+)/, async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);

  if (session.step !== "ask_interests" && session.step !== "edit_interests") {
    await ctx.answerCbQuery();
    return;
  }

  const fullMatch = ctx.match[0] || ctx.match.input;
  const key = fullMatch.replace("interest_toggle_", "");

  if (!session.interests) session.interests = [];
  const selected = new Set(session.interests);

  if (selected.has(key)) {
    selected.delete(key);
  } else {
    if (selected.size >= 5) {
      await ctx.answerCbQuery("Max 5 interests", { show_alert: true });
      return;
    }
    selected.add(key);
  }

  session.interests = [...selected].filter(Boolean);

  try {
    await ctx.editMessageText(
      `${session.step === "edit_interests" ? "🏷️ Update your interests (pick 3-5):" : "🏷️ Pick 3-5 interests (tap to toggle):"}\n\nSelected: ${session.interests.length}/5`,
      interestsKeyboard(session.interests)
    );
  } catch (e) {
    // ignore
  }

  await ctx.answerCbQuery();
});

// -------------------------------------------
// ❤️ MEDIA HANDLING (PHOTOS & PROFILE VIDEO)
// -------------------------------------------
bot.on(["photo", "video"], async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);

  // 1) PROFILE CREATION FLOW
  if (session.step === "ask_photo") {
    // --- HANDLE PROFILE VIDEO UPLOAD ---
    if (ctx.message.video) {
      const vid = ctx.message.video;

      // Check duration (15 seconds max)
      if (vid.duration && vid.duration > 15) {
        return ctx.reply("⚠️ Video is too long! Please keep it under 15 seconds.");
      }

      const userData = {
        id: userId,
        name: session.name || ctx.from.first_name || "Unknown",
        username: ctx.from.username || null,
        age: session.age,
        location: session.location || "",
        bio: session.bio || "",
        gender: session.gender,
        looking: session.looking,
        intention: session.intention || "",
        interests: session.interests || [],
        // NEW: save video as primary profile media
        profileVideo: vid.file_id,
        photos: [],
        photo: null,
        likes: [],
        matches: [],
        dailySwipes: 0,
        lastSwipeReset: Date.now(),
        purchasedSwipes: 0
      };

      await saveUser(userId, userData);

      // Reset session
      session.step = null;
      session.photos = null;
      session.shown = [];
      session.queue = null;
      session.lastPreference = null;

      await ctx.reply("🎥 Video Profile Saved! Your profile is alive! 🎬\n\nUse /match to start swiping.", { reply_markup: { remove_keyboard: true } });

      // Auto-start matching
      try {
        await showNext(userId, ctx);
      } catch (e) {
        console.error("Error auto-starting match after video profile creation:", e);
      }
      return;
    }

    // --- HANDLE PHOTO UPLOAD (Existing Logic) ---
    if (ctx.message.photo) {
      // highest resolution photo = last one
      const photoArray = ctx.message.photo;
      const fileId = photoArray[photoArray.length - 1].file_id;

      // CREATE FLOW - Multiple photos (2-3)
      // Initialize photos array if not exists
      if (!session.photos) session.photos = [];

      // Add this photo to the array
      session.photos.push(fileId);

      // Check if we have enough photos (2-3)
      if (session.photos.length >= 3) {
        // User has uploaded 3 photos, save profile
        const userData = {
          id: userId,
          name: session.name || ctx.from.first_name || "Unknown",
          username: ctx.from.username || null,
          age: session.age,
          location: session.location || "",
          bio: session.bio || "",
          gender: session.gender,
          looking: session.looking,
          intention: session.intention || "",
          interests: session.interests || [],
          photos: session.photos, // Store as array
          photo: session.photos[0], // Keep first photo for backward compatibility
          profileVideo: null, // Explicitly no video when using photos
          likes: [],
          matches: [],
          dailySwipes: 0,
          lastSwipeReset: Date.now(),
          purchasedSwipes: 0
        };

        await saveUser(userId, userData);

        // Reset session
        session.step = null;
        session.photos = null;
        session.shown = [];
        session.queue = null;
        session.lastPreference = null;

        await ctx.reply("🔥 All photos saved! Your profile is now complete ❤️\n\nUse /match to start swiping, or /profile to view your new profile.", { reply_markup: { remove_keyboard: true } });

        // Auto-start matching
        try {
          await showNext(userId, ctx);
        } catch (e) {
          console.error("Error auto-starting match after profile creation:", e);
        }
        return;
      } else if (session.photos.length >= 2) {
        // User has uploaded 2 photos, ask if they want to add one more or finish
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback("✅ Finish with 2 photos", "finish_photos")],
          [Markup.button.callback("📸 Add one more photo (3 total)", "add_more_photo")]
        ]);
        await ctx.reply(`📸 Great! You've uploaded ${session.photos.length} photo(s).\n\nYou can add one more (up to 3 total) or finish now.`, keyboard);
        return;
      } else {
        // User has uploaded 1 photo, ask for another one (minimum 2 required)
        await ctx.reply(`📸 Photo ${session.photos.length} saved! Send another photo (minimum 2 photos required, up to 3 total).`);
        return;
      }
    }
  }


  // 2) EDIT FLOW - Allow updating media (photos OR video)
  if (session.step === "edit_photo") {
    const db = await loadDB();
    const user = db.users[userId];

    if (!user) {
      session.step = null;
      return ctx.reply("You don't have a profile yet. Use /create first.");
    }

    // --- EDIT PROFILE VIDEO ---
    if (ctx.message.video) {
      const vid = ctx.message.video;

      // Check duration (15 seconds max)
      if (vid.duration && vid.duration > 15) {
        return ctx.reply("⚠️ Video is too long! Please keep it under 15 seconds.");
      }

      await saveUser(userId, {
        ...user,
        profileVideo: vid.file_id,
        photos: [],
        photo: null
      });

      session.step = null;
      session.editPhotos = null;

      await ctx.reply("🎥 Your profile video has been updated! 🎬");

      try {
        await showNext(userId, ctx);
      } catch (e) {
        console.error("Error auto-starting match after video edit:", e);
      }
      return;
    }

    // --- EDIT PROFILE PHOTOS (existing logic) ---
    if (ctx.message.photo) {
      // highest resolution photo = last one
      const photoArray = ctx.message.photo;
      const fileId = photoArray[photoArray.length - 1].file_id;

      // Initialize photos array if editing
      if (!session.editPhotos) {
        session.editPhotos = user.photos || (user.photo ? [user.photo] : []);
      }

      // Add new photo
      session.editPhotos.push(fileId);

      // Limit to 3 photos max
      if (session.editPhotos.length > 3) {
        session.editPhotos = session.editPhotos.slice(-3); // Keep last 3
      }

      // If user has 2+ photos, ask if done or want to add more
      if (session.editPhotos.length >= 2) {
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback("✅ Finish updating photos", "finish_edit_photos")],
          [Markup.button.callback("📸 Add one more (up to 3)", "add_more_edit_photo")]
        ]);
        await ctx.reply(`📸 You now have ${session.editPhotos.length} profile photo(s). Add one more or finish?`, keyboard);
        return;
      } else {
        await ctx.reply(`📸 Photo ${session.editPhotos.length} updated! Send another photo (minimum 2 photos required, up to 3 total) or click "Finish" when done.`);
        return;
      }
    }

    // If we got here with edit_photo but no supported media, just ignore
    return;
  }

  // If no active step, ignore the media
  return;
});

// -------------------------------------------
// ❤️ /match — START SWIPING (FIXED ASYNC WRAPPER)
// -------------------------------------------
bot.command("match", async (ctx) => {
  try {
    const session = getSession(ctx.from.id);
    session.step = null;

    // Explicitly remove any stuck reply keyboards (like the location request)
    try {
      const msg = await ctx.reply("🔍 Finding matches...", { reply_markup: { remove_keyboard: true } });
      setTimeout(() => {
        ctx.deleteMessage(msg.message_id).catch(() => { });
      }, 1500);
    } catch (e) { }

    // Await the entire function chain to catch deep errors
    await showNext(ctx.from.id, ctx);
  } catch (e) {
    // This catches critical errors that the inner functions failed to handle
    console.error("Critical error in /match command:", e);
    await ctx.reply("❌ An unexpected error occurred while loading profiles. Please try again.");
  }
});

// -------------------------------------------
// ❤️ /broadcast — ADMIN-ONLY GLOBAL MESSAGE
// -------------------------------------------
bot.command("broadcast", async (ctx) => {
  const userId = ctx.from.id;

  // Only allow configured admin accounts to trigger broadcasts
  if (!isAdmin(userId)) {
    return ctx.reply("❌ You are not allowed to use this command.");
  }

  // Remove the command part and keep the rest as the message body
  const text = ctx.message.text.replace(/^\/broadcast(@[^\s]+)?\s*/i, "").trim();
  if (!text) {
    return ctx.reply("Usage:\n/broadcast Your update message here");
  }

  await ctx.reply("📢 Starting broadcast… this may take a while.");

  // Stream all users from MongoDB; do not load all into memory at once
  const cursor = usersCollection.find({}, { projection: { id: 1 } });

  let sent = 0;
  while (await cursor.hasNext()) {
    const user = await cursor.next();
    const targetId = user.id;
    try {
      await ctx.telegram.sendMessage(
        targetId,
        text,
        { parse_mode: 'HTML' } // Allows you to send HTML tags in your broadcast message
      );
      sent++;
      // Basic rate limiting to avoid hitting Telegram flood limits
      if (sent % 25 === 0) {
        await sleep(1000);
      }
    } catch (e) {
      // User may have blocked the bot or chat no longer exists; just log and continue
      console.error(`Broadcast failed to ${targetId}:`, e.message);
    }
  }

  await ctx.reply(`✅ Broadcast finished. Message attempted for ~${sent} users.`);
});

// -------------------------------------------
// ❤️ GET NEXT CANDIDATE (OPTIMIZED: MongoDB Aggregation)
// -------------------------------------------
async function getNextCandidate(userId, excludeShown = true) {
  try {
    // Get current user's profile directly from MongoDB
    const me = await usersCollection.findOne({ id: userId });

    if (!me) {
      console.log(`[Match Queue] User ${userId} has no profile`);
      return null;
    }

    const userIdNum = parseInt(userId);
    const session = getSession(userId);

    // Get shown users (normalize to numbers) – used only to avoid immediate repeats
    const shownIds = excludeShown
      ? (session.shown || []).map(id => parseInt(id)).filter(id => !isNaN(id))
      : [];

    // -------------------------------------------
    // Build MongoDB query for mutual compatibility
    // -------------------------------------------
    // Internal fields:
    //  - me.gender:  "male" | "female"
    //  - me.looking: "men"  | "women" | "any"
    //
    // We translate the high-level rule:
    //  (me.looking === "any"  OR me.looking matches candidate.gender)
    //  AND
    //  (candidate.looking === "any" OR candidate.looking matches me.gender)
    //
    // into a single MongoDB $match.

    // Safety defaults for legacy users
    const myGender = me.gender === "female" ? "female" : "male";
    const myLooking = me.looking || "men";

    // Which genders do I allow?
    const gendersAllowedByMe =
      myLooking === "any"
        ? ["male", "female"]
        : myLooking === "women"
          ? ["female"]
          : ["male"]; // "men" or unknown -> male

    // Which looking values on the other side allow my gender?
    const lookingsThatAllowMe = ["any"];
    if (myGender === "male") {
      lookingsThatAllowMe.push("men");
    } else {
      lookingsThatAllowMe.push("women");
    }

    // ID-level conditions: not myself, optionally not already shown
    const idConditions = { $ne: userIdNum };
    if (excludeShown && shownIds.length > 0) {
      idConditions.$nin = shownIds.filter(id => id !== userIdNum);
    }

    const query = {
      id: idConditions,
      // They must be a gender I allow
      gender: { $in: gendersAllowedByMe },
      // They must also allow my gender (their "looking" must include me)
      looking: { $in: lookingsThatAllowMe }
    };

    // Try to get a random mutually compatible candidate
    const [candidate] = await usersCollection
      .aggregate([{ $match: query }, { $sample: { size: 1 } }])
      .toArray();

    if (candidate) {
      console.log(`[Match Queue] Found candidate for user ${userIdNum}`);
      return candidate;
    }

    console.log(
      `[Match Queue] No compatible candidates found for user ${userIdNum} (excludeShown=${excludeShown}, shown=${shownIds.length})`
    );
    return null;
  } catch (e) {
    console.error("[DB ERROR] Error getting next candidate:", e.message);
    return null;
  }
}

// -------------------------------------------
// ❤️ SHOW NEXT USER (OPTIMIZED: Direct MongoDB Query)
// -------------------------------------------
async function showNext(userId, ctx) {
  // OPTIMIZED: Check user exists directly from MongoDB
  const me = await usersCollection.findOne({ id: userId });
  if (!me) return ctx.reply("❗ Create a profile first: /create");

  const session = getSession(userId);

  // Check if preference changed - if so, reset shown list
  const currentPreference = me.looking || "men"; // Default to "men" if not set
  if (session.lastPreference !== currentPreference) {
    console.log(`[Match Queue] Preference changed from ${session.lastPreference} to ${currentPreference}, resetting shown list`);
    session.shown = [];
    session.lastPreference = currentPreference;
  }

  // OPTIMIZED: Quick count check instead of loading all users
  const totalUsersCount = await usersCollection.countDocuments({});
  if (totalUsersCount <= 1) {
    return ctx.reply("😢 No other people in the system yet. Share the bot with friends!");
  }

  // Check swipe limit before showing candidate
  const availableSwipes = await getAvailableSwipes(userId);
  if (availableSwipes.total <= 0) {
    // Show purchase options
    const purchaseText =
      `⏸️ Daily Swipe Limit Reached!\n\n` +
      `You've used all 20 free swipes today. 🎯\n\n` +
      `Get more swipes to continue matching:\n\n` +
      `• 40 Swipes - 4 ⭐\n` +
      `• 80 Swipes - 10 ⭐\n\n` +
      `Your daily swipes reset tomorrow! 🌅`;

    return ctx.reply(purchaseText, swipePurchaseButtons());
  }

  // Show candidate (fetched directly from MongoDB)
  return await showCandidate(userId, ctx);
}

// -------------------------------------------
// ❤️ SHOW 1 PROFILE (OPTIMIZED: Direct MongoDB Query)
// -------------------------------------------
async function showCandidate(userId, ctx) {
  // OPTIMIZED: Quick profile check with direct MongoDB query
  const userExists = await usersCollection.findOne({ id: userId }, { projection: { id: 1, interests: 1 } });
  if (!userExists) {
    return ctx.reply("❗  We lost your profile due to major upgrade to the bot. Please create it again: /create");
  }

  // Check swipe limit before showing candidate
  const availableSwipes = await getAvailableSwipes(userId);
  if (availableSwipes.total <= 0) {
    const purchaseText =
      `⏸️ Daily Swipe Limit Reached!\n\n` +
      `You've used all 20 free swipes today. 🎯\n\n` +
      `Get more swipes to continue matching:\n\n` +
      `• 40 Swipes - 4 ⭐\n` +
      `• 80 Swipes - 10 ⭐\n\n` +
      `Your daily swipes reset tomorrow! 🌅`;

    return ctx.reply(purchaseText, swipePurchaseButtons());
  }

  const session = getSession(userId);

  // OPTIMIZED: Get candidate directly from MongoDB (no queue needed)
  let target = await getNextCandidate(userId, true);

  // If still no candidate, reset shown list and try again
  if (!target) {
    console.log(`[Match Queue] No candidates found, resetting shown list and retrying...`);
    session.shown = [];
    target = await getNextCandidate(userId, true);
  }

  // Final check - if still no candidate, there are no users
  if (!target) {
    const totalUsersCount = await usersCollection.countDocuments({});
    if (totalUsersCount <= 1) {
      return ctx.reply("😢 No profiles found with your current preferences. Try adjusting them or check back later!");
    }
    return ctx.reply("😢No profiles found with your current preferences. Try adjusting them or check back later!");
  }

  // Mark this user as shown
  const targetId = typeof target.id === 'string' ? parseInt(target.id) : target.id;
  if (!isNaN(targetId) && !session.shown.includes(targetId)) {
    session.shown.push(targetId);
  }

  // Format intention text
  const intentionText = target.intention === "serious" ? "Serious relationship" :
    target.intention === "casual" ? "Casual dating" :
      target.intention === "friendship" ? "Friendship only" :
        target.intention === "exploring" ? "Just exploring 😏" :
          "";

  const myInterestKeys = Array.isArray(userExists.interests) ? userExists.interests : [];
  const theirInterestKeys = Array.isArray(target.interests) ? target.interests : [];
  const theirKeySet = new Set(theirInterestKeys);
  const commonInterestLabels = INTEREST_OPTIONS
    .filter(opt => myInterestKeys.includes(opt.key) && theirKeySet.has(opt.key))
    .map(opt => opt.label);
  const commonTagsHtml = commonInterestLabels.length > 0
    ? commonInterestLabels.map(l => `<code>${escapeHtml(l)}</code>`).join(" ")
    : "";
  const commonInterestLineHtml = commonTagsHtml
    ? `✨ <b>Common</b>: ${commonTagsHtml}\n\n`
    : "";
  const interestsTagsHtml = formatInterestTagsHtml(theirInterestKeys);
  const interestsLineHtml = interestsTagsHtml ? `🏷️ <b>Interests</b>: ${interestsTagsHtml}\n\n` : "";

  const safeName = escapeHtml(target.name || "Unknown");
  const safeAge = escapeHtml(target.age || "?");
  const safeLocation = escapeHtml(target.location || "Not set");
  const safeIntention = escapeHtml(intentionText);
  const bioText = target.bio && String(target.bio).trim().length > 0 ? String(target.bio).trim() : "No bio";
  const safeBio = escapeHtml(bioText);

  const candidateText =
    `👤 <b>${safeName}, ${safeAge}</b>\n\n` +
    `📍 <b>Location</b>: ${safeLocation}\n\n` +
    `${safeIntention ? `💘 <i>${safeIntention}</i>\n\n` : ""}` +
    `${commonInterestLineHtml}` +
    `${interestsLineHtml}` +
    `📝 <b>Bio</b>\n<blockquote>${safeBio}</blockquote>`;

  const buttons = swipeButtons(target.id);

  try {
    // 1) Prefer video profile if available
    if (target.profileVideo) {
      await Promise.race([
        ctx.replyWithVideo(target.profileVideo, {
          caption: candidateText,
          parse_mode: 'HTML',
          ...buttons
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Video send timeout')), 15000)
        )
      ]);
    } else {
      // 2) Fallback to photos (support multiple photos 2-3)
      const photos = target.photos || (target.photo ? [target.photo] : []);

      if (photos.length > 0) {
        if (photos.length === 1) {
          // Single photo - can attach buttons directly
          await Promise.race([
            ctx.replyWithPhoto(photos[0], {
              caption: candidateText,
              parse_mode: 'HTML',
              ...buttons
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Photo send timeout')), 10000)
            )
          ]);
        } else {
          // Multiple photos - send ALL together in one media group
          const media = photos.map((photo, index) => ({
            type: 'photo',
            media: photo,
            caption: index === 0 ? candidateText : undefined, // Only caption on first photo
            parse_mode: index === 0 ? 'HTML' : undefined
          }));

          await Promise.race([
            ctx.replyWithMediaGroup(media),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Photo send timeout')), 10000)
            )
          ]);

          // Send buttons separately after the media group (Telegram doesn't support buttons on media groups)
          await ctx.reply("🔥 <b>Looks like a nice profile!</b> Ready to make a move?", { parse_mode: 'HTML', ...buttons });
        }
      } else {
        // 3) Text-only fallback
        await ctx.reply(candidateText, { parse_mode: 'HTML', ...buttons });
      }
    }
  } catch (error) {
    console.error(`[ERROR] Error sending media for user ${target.id}:`, error.message);
    // Try to send text version as fallback
    try {
      await ctx.reply(`(⚠️ Media Unavailable)\n${candidateText}`, { parse_mode: 'HTML', ...buttons });
    } catch (fallbackError) {
      console.error(`[ERROR] Failed to send fallback message:`, fallbackError.message);
    }
  }
}

// -------------------------------------------
// ❤️ SKIP BUTTON
// -------------------------------------------
bot.action(/skip_(.+)/, async (ctx) => {
  const userId = ctx.from.id;
  await ctx.answerCbQuery("Skipped ❌");

  // OPTIMIZED: Quick profile check with direct MongoDB query
  const user = await usersCollection.findOne({ id: userId }, { projection: { purchasedSwipes: 1 } });
  if (!user) {
    return ctx.reply("❗ We lost your profile due to major upgrade to the bot. Please create it again: /create");
  }

  // Check swipe limit
  const availableSwipes = await getAvailableSwipes(userId);
  if (availableSwipes.total <= 0) {
    const purchaseText =
      `⏸️ Daily Swipe Limit Reached!\n\n` +
      `You've used all 20 free swipes today. 🎯\n\n` +
      `Get more swipes to continue matching:\n\n` +
      `• 40 Swipes - 4 ⭐\n` +
      `• 80 Swipes - 10 ⭐\n\n` +
      `Your daily swipes reset tomorrow! 🌅`;

    return ctx.reply(purchaseText, swipePurchaseButtons());
  }

  // Increment swipe count (use purchased swipes first, then free)
  const currentPurchased = user.purchasedSwipes || 0;
  if (currentPurchased > 0) {
    // OPTIMIZED: Use MongoDB $inc for atomic decrement
    await usersCollection.updateOne(
      { id: userId },
      { $inc: { purchasedSwipes: -1 } }
    );
  } else {
    // Use free daily swipe
    await incrementDailySwipes(userId);
  }

  // Clear message step if user was waiting to send a message
  const session = getSession(userId);
  if (session.step && session.step.startsWith("waiting_message_")) {
    session.step = null;
    session.messageTargetId = null;
  }

  // Show next person - queue will auto-rebuild if empty
  try {
    await showCandidate(userId, ctx);
  } catch (e) {
    console.error("Error on skip action:", e);
    // Retry showing candidate (will fetch from MongoDB directly)
    await showCandidate(userId, ctx);
  }
});

// -------------------------------------------
// ❤️ MESSAGE BUTTON - ASK USER TO WRITE MESSAGE
// -------------------------------------------
bot.action(/message_(.+)/, async (ctx) => {
  const userId = ctx.from.id;

  // OPTIMIZED: Quick profile check with direct MongoDB query
  const userExists = await usersCollection.findOne({ id: userId }, { projection: { id: 1 } });
  if (!userExists) {
    await ctx.answerCbQuery("Please create your profile first.");
    return ctx.reply("❗ We lost your profile due to major upgrade to the bot. Please create it again: /create");
  }

  // Check swipe limit - if reached, show purchase options instead
  const availableSwipes = await getAvailableSwipes(userId);
  if (availableSwipes.total <= 0) {
    await ctx.answerCbQuery("Daily swipe limit reached");
    const purchaseText =
      `⏸️ Daily Swipe Limit Reached!\n\n` +
      `You've used all 20 free swipes today. 🎯\n\n` +
      `Get more swipes to continue matching:\n\n` +
      `• 40 Swipes - 4 ⭐\n` +
      `• 80 Swipes - 10 ⭐\n\n` +
      `Your daily swipes reset tomorrow! 🌅`;

    return ctx.reply(purchaseText, swipePurchaseButtons());
  }

  const fullMatch = ctx.match[0] || ctx.match.input;
  const targetIdStr = fullMatch.replace("message_", "");
  const targetId = parseInt(targetIdStr);

  // OPTIMIZED: Direct MongoDB query for target user
  const targetUser = await usersCollection.findOne({ id: targetId });
  if (!targetUser) {
    await ctx.answerCbQuery("User not found");
    return showCandidate(userId, ctx);
  }

  // Set session to wait for message
  const session = getSession(userId);
  session.step = `waiting_message_${targetId}`;
  session.messageTargetId = targetId;

  await ctx.answerCbQuery();
  await ctx.reply(`💌 Write or record a message for ${targetUser.name || "this user"}:\n\nYou can send a text, a video, or a circle video note now — or continue browsing by clicking Skip/Like.`);

  // DON'T auto-continue here - wait for user to send message or click skip/like
  // The text handler will process the message and continue
  // Skip/like handlers will clear the message step and continue
});

// -------------------------------------------
// ❤️ REPORT BUTTON
// -------------------------------------------
bot.action(/report_(.+)/, async (ctx) => {
  try {
    const userId = ctx.from.id;
    const db = await loadDB();

    // Ensure profile exists
    if (!db.users[userId]) {
      await ctx.answerCbQuery("Please create your profile first.");
      return ctx.reply("❗ We lost your profile due to major upgrade to the bot. Please create it again: /create");
    }

    const fullMatch = ctx.match[0] || ctx.match.input;
    const targetIdStr = fullMatch.replace("report_", "");
    const targetId = parseInt(targetIdStr);

    const targetUser = db.users[targetId];
    const me = db.users[userId];

    if (!targetUser) {
      await ctx.answerCbQuery("User not found");
      return;
    }

    // Check if already reported
    const existingReport = await reportsCollection.findOne({
      reporterId: userId,
      reportedId: targetId
    });

    if (existingReport) {
      await ctx.answerCbQuery("You already reported this user", { show_alert: true });
      return;
    }

    // Add report
    const reportData = {
      reporterId: userId,
      reporterName: me.name || ctx.from.first_name || "Unknown",
      reportedId: targetId,
      reportedName: targetUser.name || "Unknown",
      timestamp: Date.now()
    };

    await saveReport(reportData);

    await ctx.answerCbQuery("🚫 User reported", { show_alert: true });
    await ctx.reply("✅ Thank you for reporting. We'll review this user.\n\nContinuing with matches...");

    // Continue showing profiles
    try {
      await showCandidate(userId, ctx);
    } catch (e) {
      console.error("Error showing candidate after report:", e);
    }
  } catch (error) {
    console.error("Error in report action:", error);
    try {
      await ctx.answerCbQuery("An error occurred. Please try again.");
    } catch (e) {
      console.error("Error sending error message:", e);
    }
  }
});

// -------------------------------------------
// ❤️ LIKE BUTTON + MATCH SYSTEM
// -------------------------------------------
bot.action(/like_(.+)/, async (ctx) => {
  try {
    const userId = ctx.from.id;

    const fullMatch = ctx.match[0] || ctx.match.input;
    const targetIdStr = fullMatch.replace("like_", "");
    const targetId = parseInt(targetIdStr); // Telegram IDs are numbers
    const userIdNum = parseInt(userId);

    const db = await loadDB();
    const me = db.users[userId];
    const them = db.users[targetId];

    try {
      await ctx.answerCbQuery("❤️");
    } catch (e) {
      // ignore
    }

    // If the current user's profile is missing (e.g., deleted), ask to recreate
    if (!me) {
      await ctx.answerCbQuery("Please recreate your profile.");
      return ctx.reply("❗ We lost your profile due to major upgrade to the bot. Please create it again: /create");
    }

    if (!them || !me) {
      await ctx.answerCbQuery("User or your profile not found 😢");
      // Show next candidate (will fetch from MongoDB directly)
      const session = getSession(userId);
      return showCandidate(userId, ctx);
    }

    // Ensure arrays exist
    if (!me.likes) me.likes = [];
    if (!me.matches) me.matches = [];
    if (!them.likes) them.likes = [];
    if (!them.matches) them.matches = [];

    // Check swipe limit before processing like
    const availableSwipes = await getAvailableSwipes(userId);
    if (availableSwipes.total <= 0) {
      await ctx.answerCbQuery("Daily swipe limit reached");
      const purchaseText =
        `⏸️ Daily Swipe Limit Reached!\n\n` +
        `You've used all 20 free swipes today. 🎯\n\n` +
        `Get more swipes to continue matching:\n\n` +
        `• 40 Swipes - 4 ⭐\n` +
        `• 80 Swipes - 10 ⭐\n\n` +
        `Your daily swipes reset tomorrow! 🌅`;

      return ctx.reply(purchaseText, swipePurchaseButtons());
    }

    // Normalize existing IDs in arrays to numbers
    me.likes = me.likes.map(id => parseInt(id)).filter(id => !isNaN(id));
    me.matches = me.matches.map(id => parseInt(id)).filter(id => !isNaN(id));
    them.likes = them.likes.map(id => parseInt(id)).filter(id => !isNaN(id));
    them.matches = them.matches.map(id => parseInt(id)).filter(id => !isNaN(id));

    // Add like to current user's profile (store as number)
    if (!me.likes.includes(targetId)) {
      me.likes.push(targetId);
    }

    // Increment swipe count (use purchased swipes first, then free)
    let updatedPurchasedSwipes = me.purchasedSwipes || 0;
    if (updatedPurchasedSwipes > 0) {
      // Use purchased swipe
      updatedPurchasedSwipes = updatedPurchasedSwipes - 1;
    } else {
      // Use free daily swipe
      await incrementDailySwipes(userId);
    }

    let matchFound = false;

    // Check if THEY like YOU (compare as numbers)
    if (them.likes.includes(userIdNum)) {
      matchFound = true;

      // Update match arrays (store as numbers)
      if (!me.matches.includes(targetId)) me.matches.push(targetId);
      if (!them.matches.includes(userIdNum)) them.matches.push(userIdNum);

      // Notify BOTH users about the match
      try {
        const matchMessage = `🎉❤️ IT'S A MATCH!\n\n${me.name} liked you back!\n\nSend them a message: ${me.username || ctx.from.username ? `@${me.username || ctx.from.username}` : `[${me.name || "User"}](tg://user?id=${userId})`}`;
        await Promise.race([
          ctx.telegram.sendMessage(
            targetId,
            matchMessage,
            { parse_mode: 'Markdown' }
          ),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Message send timeout')), 10000)
          )
        ]);
      } catch (e) {
        console.error(`[ERROR] Could not message target user ${targetId} (blocked bot?):`, e.message);
      }

      await ctx.reply(`🔥 You MATCHED with ${them.name}!\nUse /matches to see list.`);
    } else {
      // They don't like you yet - notify them that someone liked them

      // Add to their recentLikes array (most recent at the end, so we can reverse to show newest first)
      if (!them.recentLikes) them.recentLikes = [];
      them.recentLikes = them.recentLikes.map(id => parseInt(id)).filter(id => !isNaN(id));
      // Remove if already exists (to avoid duplicates), then add to end (most recent)
      them.recentLikes = them.recentLikes.filter(id => id !== userIdNum);
      them.recentLikes.push(userIdNum); // Add to end = most recent

      // Send notification to the person you liked
      try {
        await Promise.race([
          ctx.telegram.sendMessage(
            targetId,
            `❤️ Someone liked you!\n\nSee who it is: /matches`
          ),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Message send timeout')), 10000)
          )
        ]);
      } catch (e) {
        console.error(`[ERROR] Could not message target user ${targetId} (blocked bot?):`, e.message);
      }
    }

    // IMPORTANT: Save database FIRST, then rebuild queue
    await updateUserArrays(userId, { likes: me.likes, matches: me.matches, purchasedSwipes: updatedPurchasedSwipes });
    await updateUserArrays(targetId, { likes: them.likes, matches: them.matches, recentLikes: them.recentLikes });

    // Rebuild queue fresh after like/match (excludes the person just liked/matched)
    const session = getSession(userId);

    // Clear message step if user was waiting to send a message
    if (session.step && session.step.startsWith("waiting_message_")) {
      session.step = null;
      session.messageTargetId = null;
    }

    // Disable buttons to prevent double taps, but don't edit visible text/caption
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    } catch (e) {
      // ignore
    }

    if (matchFound) {
      await new Promise(resolve => setTimeout(resolve, 1500));
    } else {
      await new Promise(resolve => setTimeout(resolve, 350));
    }

    // Show next candidate (will fetch from MongoDB directly)
    try {
      await showCandidate(userId, ctx);
    } catch (e) {
      console.error("Error after like action:", e);
    }
  } catch (error) {
    console.error("Error in like action:", error);
    try {
      await ctx.answerCbQuery("An error occurred. Please try again.");
    } catch (e) {
      console.error("Error sending error message:", e);
    }
  }
});

// -------------------------------------------
// ❤️ /delete & /delet — DELETE YOUR PROFILE
// -------------------------------------------
bot.command(["delete", "delet"], async (ctx) => {
  try {
    const userId = ctx.from.id;
    const db = await loadDB();

    if (!db.users[userId]) {
      return ctx.reply("You don't have a profile to delete.");
    }

    // Set session to wait for deletion reason
    const session = getSession(userId);
    session.waitingForDeletionReason = true;

    await ctx.reply("Before we delete your account, could you please tell us why you're leaving? This helps us improve the bot. Just send your reason as a message.");
  } catch (error) {
    console.error("Error in delete command:", error);
    try {
      await ctx.reply("⚠️ An error occurred. Please try again.");
    } catch (e) {
      console.error("Error sending error message:", e);
    }
  }
});

// -------------------------------------------
// ❤️ /matches — SHOW MY MATCHES AND PEOPLE WHO LIKED YOU
// -------------------------------------------
bot.command("matches", async (ctx) => {
  try {
    const db = await loadDB();
    const me = db.users[ctx.from.id];

    if (!me) return ctx.reply("❗ No profile.\nUse /create");

    const userIdNum = parseInt(ctx.from.id);
    const myMatches = (me.matches || []).map(id => parseInt(id)).filter(id => !isNaN(id));

    // Get recentLikes in reverse order (most recent first)
    const recentLikes = (me.recentLikes || []).map(id => parseInt(id)).filter(id => !isNaN(id));
    const recentLikesReversed = [...recentLikes].reverse();

    // Find people who liked you
    const peopleWhoLikedYou = [];
    const recentLikesSet = new Set(recentLikesReversed);

    for (const [otherId, otherUser] of Object.entries(db.users)) {
      if (!otherUser || !otherUser.id) continue;

      const otherIdNum = parseInt(otherId);
      if (isNaN(otherIdNum) || otherIdNum === userIdNum) continue;

      // Only show people who are mutually compatible with me w.r.t gender preferences.
      // "any" means "I accept both", but we STILL require that they also accept my gender.
      if (!isCompatible(me, otherUser)) continue;

      const theirLikes = (otherUser.likes || []).map(id => parseInt(id)).filter(id => !isNaN(id));

      // If they liked you AND you haven't matched with them
      if (theirLikes.includes(userIdNum) && !myMatches.includes(otherIdNum)) {
        peopleWhoLikedYou.push({
          user: otherUser,
          isRecent: recentLikesSet.has(otherIdNum)
        });
      }
    }

    const recentLikesProfiles = [];
    const olderLikesProfiles = [];

    for (const { user, isRecent } of peopleWhoLikedYou) {
      if (isRecent) {
        recentLikesProfiles.push(user);
      } else {
        olderLikesProfiles.push(user);
      }
    }

    // Sort recent likes
    recentLikesProfiles.sort((a, b) => {
      const aIndex = recentLikesReversed.indexOf(parseInt(a.id));
      const bIndex = recentLikesReversed.indexOf(parseInt(b.id));
      return aIndex - bIndex;
    });

    // If no matches and no likes
    if (myMatches.length === 0 && peopleWhoLikedYou.length === 0) {
      return ctx.reply("😢 No matches or likes yet. Keep swiping!");
    }

    // ----------------------------
    // 1. SHOW RECENT LIKES
    // ----------------------------
    if (recentLikesProfiles.length > 0) {
      await ctx.reply(`🔥 ${recentLikesProfiles.length} recent like${recentLikesProfiles.length > 1 ? 's' : ''} (newest first):`);

      for (const person of recentLikesProfiles) {
        // Format intention
        const intentionText = person.intention === "serious" ? "Serious relationship" :
          person.intention === "casual" ? "Casual dating" :
            person.intention === "friendship" ? "Friendship only" :
              person.intention === "exploring" ? "Just exploring 😏" :
                "";

        // FIX 1: Escape the username for MarkdownV2
        const personContact = person.username
          ? `@${escapeMarkdown(person.username)}`
          : `[${escapeMarkdown(person.name || "User")}](tg://user?id=${person.id})`;

        const interestsText = formatInterests(person.interests);
        const safeLocation = escapeMarkdown(person.location || "Not set");
        const profileText =
          `👤 ${escapeMarkdown(person.name || "Unknown")}, ${escapeMarkdown(String(person.age || "?"))}\n\n` +
          `📍 Location: ${safeLocation}\n\n` +
          `⚧️ ${person.gender === "male" ? "♂️ Male" : "♀️ Female"}\n\n` +
          `${intentionText ? `💘 ${escapeMarkdown(intentionText)}\n\n` : ""}` +
          `${interestsText ? `🏷️ ${escapeMarkdown(interestsText)}\n\n` : ""}` +
          `📝 ${escapeMarkdown(person.bio || "No bio")}\n\n` +
          `💬 ${personContact}`;

        const likeBackButtons = Markup.inlineKeyboard([
          [
            Markup.button.callback("❌ Skip", `skip_${person.id}`),
            Markup.button.callback("❤️ Like Back", `like_${person.id}`)
          ],
          [
            Markup.button.callback("🚫 Report", `report_${person.id}`)
          ]
        ]);

        // Prefer video profile if available
        if (person.profileVideo) {
          try {
            await ctx.replyWithVideo(person.profileVideo, {
              caption: profileText,
              parse_mode: 'MarkdownV2',
              ...likeBackButtons
            });
          } catch (videoError) {
            console.error(`[ERROR] Video error (recent like):`, videoError.message);
            await ctx.reply(profileText, { parse_mode: 'MarkdownV2', ...likeBackButtons });
          }
        } else {
          const photos = person.photos || (person.photo ? [person.photo] : []);

          if (photos.length > 0) {
            if (photos.length === 1) {
              // Single photo
              try {
                await ctx.replyWithPhoto(photos[0], {
                  caption: profileText,
                  parse_mode: 'MarkdownV2', // FIX 2: Use MarkdownV2
                  ...likeBackButtons
                });
              } catch (photoError) {
                console.error(`[ERROR] Photo error:`, photoError.message);
                await ctx.reply(profileText, { parse_mode: 'MarkdownV2', ...likeBackButtons });
              }
            } else {
              // Multiple photos
              try {
                const media = photos.map((photo, index) => ({
                  type: 'photo',
                  media: photo,
                  caption: index === 0 ? profileText : undefined,
                  parse_mode: 'MarkdownV2' // FIX 3: Add parse_mode to media group
                }));

                await ctx.replyWithMediaGroup(media);
                await ctx.reply("🔥 Looks like a nice profile! Ready to make a move?", likeBackButtons);
              } catch (mediaError) {
                console.error(`[ERROR] Media error:`, mediaError.message);
                await ctx.reply(profileText, { parse_mode: 'MarkdownV2', ...likeBackButtons });
              }
            }
          } else {
            // No photos
            await ctx.reply(profileText, {
              parse_mode: 'MarkdownV2', // FIX 4: Use MarkdownV2
              ...likeBackButtons
            });
          }
        }
      }

      // Clear recentLikes
      await updateUserArrays(ctx.from.id, { recentLikes: [] });
    }

    // ----------------------------
    // 2. SHOW OLDER LIKES
    // ----------------------------
    if (olderLikesProfiles.length > 0) {
      await ctx.reply(`\n❤️ ${olderLikesProfiles.length} other person${olderLikesProfiles.length > 1 ? 's' : ''} liked you:`);

      for (const person of olderLikesProfiles) {
        const intentionText = person.intention === "serious" ? "Serious relationship" :
          person.intention === "casual" ? "Casual dating" :
            person.intention === "friendship" ? "Friendship only" :
              person.intention === "exploring" ? "Just exploring 😏" :
                "";

        // FIX 5: Escape username here too
        const personContact = person.username
          ? `@${escapeMarkdown(person.username)}`
          : `[${escapeMarkdown(person.name || "User")}](tg://user?id=${person.id})`;

        const interestsText = formatInterests(person.interests);
        const safeLocation = escapeMarkdown(person.location || "Not set");
        const profileText =
          `👤 ${escapeMarkdown(person.name || "Unknown")}, ${escapeMarkdown(String(person.age || "?"))}\n\n` +
          `📍 Location: ${safeLocation}\n\n` +
          `⚧️ ${person.gender === "male" ? "♂️ Male" : "♀️ Female"}\n\n` +
          `${intentionText ? `💘 ${escapeMarkdown(intentionText)}\n\n` : ""}` +
          `${interestsText ? `🏷️ ${escapeMarkdown(interestsText)}\n\n` : ""}` +
          `📝 ${escapeMarkdown(person.bio || "No bio")}\n\n` +
          `💬 ${personContact}`;

        const likeBackButtons = Markup.inlineKeyboard([
          [
            Markup.button.callback("❌ Skip", `skip_${person.id}`),
            Markup.button.callback("❤️ Like Back", `like_${person.id}`)
          ],
          [
            Markup.button.callback("🚫 Report", `report_${person.id}`)
          ]
        ]);

        // Prefer video profile if available
        if (person.profileVideo) {
          try {
            await ctx.replyWithVideo(person.profileVideo, {
              caption: profileText,
              parse_mode: 'MarkdownV2',
              ...likeBackButtons
            });
          } catch (e) {
            console.error(`[ERROR] Video error (older like):`, e.message);
            await ctx.reply(profileText, { parse_mode: 'MarkdownV2', ...likeBackButtons });
          }
        } else {
          const photos = person.photos || (person.photo ? [person.photo] : []);

          if (photos.length > 0) {
            if (photos.length === 1) {
              try {
                await ctx.replyWithPhoto(photos[0], {
                  caption: profileText,
                  parse_mode: 'MarkdownV2', // FIX 6: Use MarkdownV2
                  ...likeBackButtons
                });
              } catch (e) {
                await ctx.reply(profileText, { parse_mode: 'MarkdownV2', ...likeBackButtons });
              }
            } else {
              try {
                const media = photos.map((photo, index) => ({
                  type: 'photo',
                  media: photo,
                  caption: index === 0 ? profileText : undefined,
                  parse_mode: 'MarkdownV2' // FIX 7: Add parse_mode
                }));
                await ctx.replyWithMediaGroup(media);
                await ctx.reply("🔥 Looks like a nice profile! Ready to make a move?", likeBackButtons);
              } catch (e) {
                await ctx.reply(profileText, { parse_mode: 'MarkdownV2', ...likeBackButtons });
              }
            }
          } else {
            await ctx.reply(profileText, {
              parse_mode: 'MarkdownV2', // FIX 8: Use MarkdownV2
              ...likeBackButtons
            });
          }
        }
      }
    }

    // ----------------------------
    // 3. SHOW MATCHES
    // ----------------------------
    if (myMatches.length > 0) {
      let matchesText = `\n💘 Your Matches (${myMatches.length}):\n\n`;

      for (const id of myMatches) {
        const idNum = parseInt(id);
        const u = db.users[idNum] || db.users[id] || db.users[String(id)];
        if (u && u.id) {
          const contact = u.username
            ? `@${escapeMarkdown(u.username)}` // FIX 9: Escape username
            : `[${escapeMarkdown(u.name || "User")}](tg://user?id=${idNum})`;

          matchesText += `• ${escapeMarkdown(u.name || "Unknown")} (${escapeMarkdown(String(u.age || "?"))}) — ${contact}\n`;
        }
      }

      await ctx.reply(matchesText, { parse_mode: 'MarkdownV2' }); // FIX 10: Use MarkdownV2
    }
  } catch (error) {
    console.error("Error in matches command:", error);
    // Message removed so the bot stays silent on error
  }
});

// -------------------------------------------
// ❤️ /help — SHOW SAFETY FEATURES
// -------------------------------------------
bot.command("help", async (ctx) => {
  const helpText =
    "🛡️ How We Protect Users for Safe Interaction 😎\n\n" +
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
    "1️⃣ **Privacy Protection** 👀\n" +
    "When someone likes you, you have the opportunity to see who they are BEFORE you like them back.\n" +
    "They will NOT see your username unless you click \"❤️ Like Back\".\n" +
    "This gives you full control over who can contact you.\n\n" +
    "2️⃣ **Report Inappropriate Users** 🚫\n" +
    "If a user seems inappropriate or makes you uncomfortable, you can click the \"🚫 Report\" button BEFORE clicking \"Like Back\".\n" +
    "We will review the report and ban the user if necessary.\n" +
    "Your safety is our priority! ❤️\n\n" +
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
    "Stay safe and have fun! 😊";

  await ctx.reply(helpText, { parse_mode: 'Markdown' });
});

// -------------------------------------------
// ❤️ STARS PAYMENT HANDLERS
// -------------------------------------------
// Handle purchase button clicks
bot.action(/buy_swipes_(.+)/, async (ctx) => {
  try {
    const userId = ctx.from.id;
    const packageType = ctx.match[1]; // '40' or '80'

    await ctx.answerCbQuery("Creating payment link...");

    const { invoiceLink, package: pkg } = await createSwipePackageInvoice(userId, packageType);

    // Send invoice link to user
    await ctx.reply(
      `💳 Purchase ${pkg.title}\n\n` +
      `You'll get ${pkg.swipes} swipes for ${pkg.amount} ⭐\n\n` +
      `Click the button below to complete your purchase:`,
      Markup.inlineKeyboard([
        [Markup.button.url(`Pay ${pkg.amount} ⭐`, invoiceLink)]
      ])
    );
  } catch (error) {
    console.error("Error creating invoice:", error);
    await ctx.answerCbQuery("Error creating payment. Please try again.", { show_alert: true });
  }
});

// Handle cancel purchase
bot.action("cancel_purchase", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("Purchase cancelled. Use /match to continue swiping when you're ready!");
});

// Handle successful payment (pre-checkout query)
bot.on('pre_checkout_query', async (ctx) => {
  try {
    const query = ctx.preCheckoutQuery;
    const payload = query.invoice_payload;

    // Verify payload format: swipes_40_userId_timestamp or swipes_80_userId_timestamp
    if (!payload.startsWith('swipes_')) {
      await ctx.answerPreCheckoutQuery(false, { error_message: "Invalid payment payload" });
      return;
    }

    const parts = payload.split('_');
    if (parts.length < 3) {
      await ctx.answerPreCheckoutQuery(false, { error_message: "Invalid payment format" });
      return;
    }

    // Approve the payment
    await ctx.answerPreCheckoutQuery(true);
  } catch (error) {
    console.error("Error in pre-checkout:", error);
    await ctx.answerPreCheckoutQuery(false, { error_message: "Payment processing error" });
  }
});

// Handle successful payment (successful payment)
bot.on('successful_payment', async (ctx) => {
  try {
    const payment = ctx.message.successful_payment;
    const payload = payment.invoice_payload;
    const userId = ctx.from.id;

    // Parse payload: swipes_40_userId_timestamp or swipes_80_userId_timestamp
    const parts = payload.split('_');
    if (parts.length < 3 || parts[0] !== 'swipes') {
      console.error("Invalid payment payload:", payload);
      return;
    }

    const packageType = parts[1]; // '40' or '80'
    const swipesToAdd = parseInt(packageType);

    if (isNaN(swipesToAdd) || (swipesToAdd !== 40 && swipesToAdd !== 80)) {
      console.error("Invalid swipe package:", packageType);
      return;
    }

    // Get current user data
    const db = await loadDB();
    const user = db.users[userId];

    if (!user) {
      await ctx.reply("❌ User profile not found. Please create a profile first: /create");
      return;
    }

    // Add purchased swipes to user account
    const currentPurchased = user.purchasedSwipes || 0;
    const newPurchased = currentPurchased + swipesToAdd;

    await updateUserArrays(userId, {
      purchasedSwipes: newPurchased
    });

    // Get updated swipe info
    const availableSwipes = await getAvailableSwipes(userId);

    // Confirm payment and show updated swipe count
    await ctx.reply(
      `✅ Payment Successful! 🎉\n\n` +
      `You've received ${swipesToAdd} swipes!\n\n` +
      `📊 Your Swipe Status:\n` +
      `• Free swipes remaining today: ${availableSwipes.free}/20\n` +
      `• Purchased swipes: ${availableSwipes.purchased}\n` +
      `• Total available: ${availableSwipes.total}\n\n` +
      `Use /match to continue swiping! 🚀`
    );

    // If user was waiting to swipe, continue showing profiles
    const session = getSession(userId);
    try {
      await showCandidate(userId, ctx);
    } catch (e) {
      console.error("Error showing candidate after payment:", e);
    }
  } catch (error) {
    console.error("Error processing successful payment:", error);
    await ctx.reply("⚠️ Payment received but there was an error crediting your account. Please contact support.");
  }
});

// -------------------------------------------
// ❤️ ERROR HANDLING & LAUNCH
// -------------------------------------------
bot.catch((err, ctx) => {
  // Log full error details for debugging
  console.error(`[ERROR] Update type: ${ctx?.updateType || 'unknown'}`);
  console.error(`[ERROR] Error message:`, err.message);
  console.error(`[ERROR] Error stack:`, err.stack);
  console.error(`[ERROR] Full error:`, err);

  // Only send error message if we have a valid context with reply method
  if (ctx && typeof ctx.reply === 'function') {
    try {
      // Use a timeout to prevent hanging
      Promise.race([
        ctx.reply("⚠️ Sorry, something went wrong. Please try again in a moment."),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
      ]).catch(e => {
        console.error(`[ERROR] Failed to send error message to user:`, e.message);
      });
    } catch (e) {
      console.error(`[ERROR] Exception while sending error message:`, e.message);
    }
  }
});

// Add health check and keep-alive
let lastHealthCheck = Date.now();

// Health check every 5 minutes
setInterval(() => {
  const now = Date.now();
  const timeSinceLastCheck = now - lastHealthCheck;

  if (timeSinceLastCheck > 600000) { // 10 minutes
    console.warn("[HEALTH] Warning: No activity detected for 10+ minutes");
  }

  lastHealthCheck = now;
  console.log("[HEALTH] Bot is alive and running");
}, 300000); // Every 5 minutes

// Connect to MongoDB first, then launch bot
connectDB().then((connected) => {
  if (!connected) {
    console.error("[FATAL] Failed to connect to MongoDB. Exiting...");
    process.exit(1);
  }

  return bot.launch();
}).then(async () => {
  console.log("❤️ EthioMatch is running...");
  lastHealthCheck = Date.now();

  // Set bot commands menu
  try {
    await bot.telegram.setMyCommands([
      { command: "start", description: "Start the bot" },
      { command: "create", description: "Create your profile" },
      { command: "profile", description: "View your profile" },
      { command: "edit", description: "Edit your profile" },
      { command: "match", description: "Start matching" },
      { command: "matches", description: "View your matches" },
      { command: "help", description: "See how we protect users for safe interaction 😎" },
      { command: "delete", description: "Delete your profile" },
    ]);
    console.log("✅ Bot commands menu set.");
  } catch (err) {
    console.error("[ERROR] Failed to set bot commands:", err.message);
  }
}).catch((err) => {
  console.error("[FATAL] Failed to launch bot:", err);
  process.exit(1);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
