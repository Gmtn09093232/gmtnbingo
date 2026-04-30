require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const supabase = require('./supabase');   // consistent Supabase client


const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const FRONTEND_URL = process.env.FRONTEND_URL || "https://dast12.onrender.com";

const bot = new Telegraf(BOT_TOKEN);

// Helper: ensure user exists in Supabase
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

// Admin approval handlers
bot.action(/approve_(\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("Not allowed");

    const requestId = parseInt(ctx.match[1]);

    // Fetch request
    const { data: reqData, error: fetchError } = await supabase
        .from('requests')
        .select('*')
        .eq('id', requestId)
        .eq('status', 'pending')
        .single();

    if (fetchError || !reqData) {
        return ctx.answerCbQuery("Request not found or already processed");
    }

    const req = reqData;

    // Update user balance
    if (req.type === 'deposit') {
        const { error: updateError } = await supabase.rpc('increment_balance', {
            user_id_param: req.user_id,
            amount_param: req.amount
        });
        if (updateError) {
            console.error(updateError);
            return ctx.editMessageText("❌ Error approving deposit");
        }
    } else if (req.type === 'withdraw') {
        // Check balance first
        const { data: userData } = await supabase
            .from('users')
            .select('balance')
            .eq('telegram_id', req.user_id)
            .single();

        if (!userData || userData.balance < req.amount) {
            return ctx.editMessageText("❌ Insufficient balance for withdrawal");
        }

        const { error: updateError } = await supabase.rpc('decrement_balance', {
            user_id_param: req.user_id,
            amount_param: req.amount
        });
        if (updateError) {
            console.error(updateError);
            return ctx.editMessageText("❌ Error approving withdrawal");
        }
    }

    // Mark request as approved
    await supabase
        .from('requests')
        .update({ status: 'approved' })
        .eq('id', requestId);

    ctx.editMessageText("✅ Approved");
    bot.telegram.sendMessage(req.user_id, `✅ ${req.type} of ${req.amount} approved`);
});

bot.action(/reject_(\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("Not allowed");

    const requestId = parseInt(ctx.match[1]);
    await supabase
        .from('requests')
        .update({ status: 'rejected' })
        .eq('id', requestId);

    ctx.editMessageText("❌ Rejected");

    const { data: reqData } = await supabase
        .from('requests')
        .select('user_id')
        .eq('id', requestId)
        .single();

    if (reqData) {
        bot.telegram.sendMessage(reqData.user_id, `❌ Your request was rejected.`);
    }
});

// Admin command to show pending requests
bot.command('pending', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;

    const { data: requests, error } = await supabase
        .from('requests')
        .select('*')
        .eq('status', 'pending')
        .order('id', { ascending: true });

    if (error || !requests || requests.length === 0) {
        return ctx.reply("No pending requests.");
    }

    for (const req of requests) {
        ctx.reply(
            `Request #${req.id}\nUser: ${req.user_id}\nType: ${req.type}\nAmount: ${req.amount}`,
            Markup.inlineKeyboard([
                Markup.button.callback('✅ Approve', `approve_${req.id}`),
                Markup.button.callback('❌ Reject', `reject_${req.id}`)
            ])
        );
    }
});

bot.launch();
console.log("🤖 Bot running...");