require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const supabase = require('./supabase');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const FRONTEND_URL = process.env.FRONTEND_URL || "https://gmtnbingo.onrender.com";

const bot = new Telegraf(BOT_TOKEN);

// Helper: ensure user exists
async function ensureUser(telegramId, username) {
    const { data, error } = await supabase
        .from('users')
        .upsert(
            { telegram_id: telegramId, username: username, balance: 0 },
            { onConflict: 'telegram_id' }
        )
        .select()
        .single();
    if (error) {
        console.error("ensureUser error:", error);
        return null;
    }
    return data;
}

bot.start(async (ctx) => {
    const telegramId = ctx.from.id;
    const username = ctx.from.username || "player";
    const user = await ensureUser(telegramId, username);
    if (!user) return ctx.reply("❌ Database error.");
    ctx.reply(
        `Welcome ${username}\nBalance: ${user.balance}`,
        {
            reply_markup: {
                keyboard: [
                    ["🎮 Play"],
                    ["💰 Balance"],
                    ["➕ Deposit", "➖ Withdraw"]
                ],
                resize_keyboard: true
            }
        }
    );
});

bot.hears("🎮 Play", (ctx) => {
    ctx.reply("🚀 Open Bingo Game:", {
        reply_markup: {
            inline_keyboard: [[
                { text: "▶️ Play Now", web_app: { url: FRONTEND_URL } }
            ]]
        }
    });
});

bot.hears("💰 Balance", async (ctx) => {
    const { data } = await supabase
        .from('users')
        .select('balance')
        .eq('telegram_id', ctx.from.id)
        .single();
    ctx.reply(`💰 Balance: ${data?.balance || 0}`);
});

// Deposit / Withdraw state
const userStates = new Map();

bot.hears("➕ Deposit", (ctx) => {
    userStates.set(ctx.from.id, "deposit");
    ctx.reply("Enter deposit amount:");
});

bot.hears("➖ Withdraw", (ctx) => {
    userStates.set(ctx.from.id, "withdraw");
    ctx.reply("Enter withdraw amount:");
});

bot.on("text", async (ctx) => {
    const action = userStates.get(ctx.from.id);
    if (!action) return;

    const amount = Number(ctx.message.text);
    if (!Number.isFinite(amount) || amount <= 0) {
        userStates.delete(ctx.from.id);
        return ctx.reply("❌ Invalid amount");
    }

    const telegramId = ctx.from.id;

    if (action === "withdraw") {
        const { data } = await supabase
            .from('users')
            .select('balance')
            .eq('telegram_id', telegramId)
            .single();
        if ((data?.balance || 0) < amount) {
            userStates.delete(ctx.from.id);
            return ctx.reply("❌ Not enough balance");
        }
    }

    const { error } = await supabase.from('requests').insert({
        user_id: telegramId,
        type: action,
        amount: amount,
        status: 'pending'
    });

    if (error) {
        console.error("Insert error:", error);
        return ctx.reply("❌ Could not create request.");
    }

    ctx.reply(`✅ Request sent: ${action} ${amount}. Awaiting admin approval.`);
    userStates.delete(ctx.from.id);
});

// ---------- ADMIN: Show pending requests ----------
bot.command('pending', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) {
        return ctx.reply("⛔ You are not the admin.");
    }

    const { data: requests, error } = await supabase
        .from('requests')
        .select('*')
        .eq('status', 'pending')
        .order('id', { ascending: true });

    if (error) {
        console.error("Pending error:", error);
        return ctx.reply("❌ Database error.");
    }

    if (!requests || requests.length === 0) {
        return ctx.reply("No pending requests.");
    }

    for (const req of requests) {
        await ctx.reply(
            `📋 Request #${req.id}\n👤 User: ${req.user_id}\n💳 Type: ${req.type}\n💰 Amount: ${req.amount}`,
            Markup.inlineKeyboard([
                Markup.button.callback('✅ Approve', `approve_${req.id}`),
                Markup.button.callback('❌ Reject', `reject_${req.id}`)
            ])
        );
    }
});

// ---------- ADMIN: Approve ----------
bot.action(/approve_(\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) {
        return ctx.answerCbQuery("Not admin");
    }

    const requestId = parseInt(ctx.match[1]);
    console.log(`Admin approving request ${requestId}`);

    // Fetch request
    const { data: req, error: fetchErr } = await supabase
        .from('requests')
        .select('*')
        .eq('id', requestId)
        .eq('status', 'pending')
        .single();

    if (fetchErr || !req) {
        await ctx.answerCbQuery("Request not found");
        return;
    }

    // Get current user balance
    const { data: user, error: userErr } = await supabase
        .from('users')
        .select('balance')
        .eq('telegram_id', req.user_id)
        .single();

    if (userErr) {
        console.error("User fetch error:", userErr);
        await ctx.answerCbQuery("User not found");
        return;
    }

    let newBalance = user.balance;
    if (req.type === 'deposit') {
        newBalance += req.amount;
    } else if (req.type === 'withdraw') {
        if (user.balance < req.amount) {
            await ctx.answerCbQuery("Insufficient balance");
            await ctx.editMessageText("❌ Insufficient balance for withdrawal");
            return;
        }
        newBalance -= req.amount;
    }

    // Update balance
    const { error: updateErr } = await supabase
        .from('users')
        .update({ balance: newBalance })
        .eq('telegram_id', req.user_id);

    if (updateErr) {
        console.error("Balance update error:", updateErr);
        await ctx.answerCbQuery("Error updating balance");
        return;
    }

    // Mark request as approved
    await supabase
        .from('requests')
        .update({ status: 'approved' })
        .eq('id', requestId);

    // Notify user
    await bot.telegram.sendMessage(
        req.user_id,
        `✅ Your ${req.type} of ${req.amount} has been approved. New balance: ${newBalance}`
    );

    await ctx.editMessageText(`✅ Request #${requestId} approved.`);
    await ctx.answerCbQuery("Approved");
});

// ---------- ADMIN: Reject ----------
bot.action(/reject_(\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) {
        return ctx.answerCbQuery("Not admin");
    }

    const requestId = parseInt(ctx.match[1]);

    const { error } = await supabase
        .from('requests')
        .update({ status: 'rejected' })
        .eq('id', requestId);

    if (error) {
        console.error("Reject error:", error);
        await ctx.answerCbQuery("Error");
        return;
    }

    // Get user_id to notify
    const { data: req } = await supabase
        .from('requests')
        .select('user_id')
        .eq('id', requestId)
        .single();

    if (req) {
        await bot.telegram.sendMessage(req.user_id, `❌ Your request has been rejected.`);
    }

    await ctx.editMessageText(`❌ Request #${requestId} rejected.`);
    await ctx.answerCbQuery("Rejected");
});

bot.launch();
console.log("🤖 Bot running...");