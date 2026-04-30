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

// Start command
bot.start(async (ctx) => {
    const telegramId = ctx.from.id;
    const username = ctx.from.username || "player";
    const user = await ensureUser(telegramId, username);
    if (!user) {
        return ctx.reply("❌ Database error. Please try later.");
    }

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
    const telegramId = ctx.from.id;
    const { data, error } = await supabase
        .from('users')
        .select('balance')
        .eq('telegram_id', telegramId)
        .single();

    if (error || !data) {
        return ctx.reply("❌ Could not fetch balance.");
    }
    ctx.reply(`💰 Balance: ${data.balance}`);
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

// Handle amount input
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
        const { data, error } = await supabase
            .from('users')
            .select('balance')
            .eq('telegram_id', telegramId)
            .single();

        const balance = data?.balance || 0;
        if (balance < amount) {
            userStates.delete(ctx.from.id);
            return ctx.reply("❌ Not enough balance");
        }
    }

    // Create request in Supabase table "requests"
    const { error } = await supabase
        .from('requests')
        .insert({
            user_id: telegramId,
            type: action,
            amount: amount,
            status: 'pending'
        });

    if (error) {
        console.error("Insert request error:", error);
        return ctx.reply("❌ Could not create request. Please try again.");
    }

    ctx.reply(`✅ Request sent: ${action} ${amount}. Awaiting admin approval.`);
    userStates.delete(ctx.from.id);
});

// ----- Admin approval handlers (using direct balance updates) -----

// Approve handler
bot.action(/approve_(\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) {
        return ctx.answerCbQuery("Not allowed");
    }

    const requestId = parseInt(ctx.match[1]);
    console.log(`Admin approving request ${requestId}`);

    // Use a transaction-like approach with retry logic
    try {
        // 1. Fetch the pending request
        const { data: reqData, error: fetchError } = await supabase
            .from('requests')
            .select('*')
            .eq('id', requestId)
            .eq('status', 'pending')
            .single();

        if (fetchError || !reqData) {
            await ctx.answerCbQuery("Request not found or already processed");
            return;
        }

        const req = reqData;

        // 2. Update user balance directly
        let balanceUpdateError = null;
        if (req.type === 'deposit') {
            const { error } = await supabase
                .from('users')
                .update({ balance: supabase.raw('balance + ?', req.amount) })
                .eq('telegram_id', req.user_id);
            balanceUpdateError = error;
        } else if (req.type === 'withdraw') {
            // First check balance again
            const { data: userData } = await supabase
                .from('users')
                .select('balance')
                .eq('telegram_id', req.user_id)
                .single();
            if (!userData || userData.balance < req.amount) {
                await ctx.answerCbQuery("Insufficient balance");
                await ctx.editMessageText("❌ Insufficient balance for withdrawal");
                return;
            }
            const { error } = await supabase
                .from('users')
                .update({ balance: supabase.raw('balance - ?', req.amount) })
                .eq('telegram_id', req.user_id);
            balanceUpdateError = error;
        }

        if (balanceUpdateError) {
            console.error("Balance update error:", balanceUpdateError);
            await ctx.answerCbQuery("Error updating balance");
            await ctx.editMessageText("❌ Error processing request");
            return;
        }

        // 3. Mark request as approved
        await supabase
            .from('requests')
            .update({ status: 'approved' })
            .eq('id', requestId);

        // 4. Notify user
        await bot.telegram.sendMessage(req.user_id, `✅ Your ${req.type} of ${req.amount} has been approved.`);

        // 5. Update the admin message
        await ctx.editMessageText(`✅ Request #${requestId} approved.`);
        await ctx.answerCbQuery("Approved");
    } catch (err) {
        console.error("Approval error:", err);
        await ctx.answerCbQuery("Internal error");
        await ctx.editMessageText("❌ Something went wrong");
    }
});

// Reject handler
bot.action(/reject_(\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) {
        return ctx.answerCbQuery("Not allowed");
    }

    const requestId = parseInt(ctx.match[1]);

    // Update request status to rejected
    const { error } = await supabase
        .from('requests')
        .update({ status: 'rejected' })
        .eq('id', requestId);

    if (error) {
        console.error("Reject error:", error);
        await ctx.answerCbQuery("Error rejecting");
        await ctx.editMessageText("❌ Error rejecting request");
        return;
    }

    // Notify user
    const { data: reqData } = await supabase
        .from('requests')
        .select('user_id')
        .eq('id', requestId)
        .single();

    if (reqData) {
        await bot.telegram.sendMessage(reqData.user_id, `❌ Your request has been rejected.`);
    }

    await ctx.editMessageText(`❌ Request #${requestId} rejected.`);
    await ctx.answerCbQuery("Rejected");
});

// Admin command to show pending requests
bot.command('pending', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) {
        return ctx.reply("⛔ You are not authorized to use this command.");
    }

    const { data: requests, error } = await supabase
        .from('requests')
        .select('*')
        .eq('status', 'pending')
        .order('id', { ascending: true });

    if (error) {
        console.error("Pending query error:", error);
        return ctx.reply("❌ Database error");
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

// Launch bot
bot.launch().then(() => {
    console.log("🤖 Bot running...");
}).catch(err => {
    console.error("Bot launch error:", err);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));