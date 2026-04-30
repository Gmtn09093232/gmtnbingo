require('dotenv').config();

const express = require('express');
const http = require('http');
const session = require('express-session');
const crypto = require('crypto');
const { Server } = require('socket.io');
const path = require('path');

const supabase = require('./supabase'); // fixed import (ensure filename is supabase.js)

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Session middleware
const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || "bingo_secret_key",
    resave: false,
    saveUninitialized: false
});
app.use(sessionMiddleware);
app.use(express.json());
app.use(express.static(path.join(__dirname)));   // serves index.html

// ---------- Telegram Login Verification ----------
function verifyTelegram(initData) {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    params.delete("hash");
    const data = [...params.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
    const secret = crypto.createHash("sha256").update(process.env.BOT_TOKEN).digest();
    const hmac = crypto.createHmac("sha256", secret).update(data).digest("hex");
    return hmac === hash;
}

// ---------- Auth endpoint ----------
app.post("/api/auth", async (req, res) => {
    const { initData } = req.body;
    if (!initData || !verifyTelegram(initData)) {
        return res.status(403).json({ error: "Invalid auth" });
    }
    const params = new URLSearchParams(initData);
    const userData = JSON.parse(params.get("user"));
    const telegramId = userData.id;
    const username = userData.username || userData.first_name;

    // Upsert user into Supabase
    const { data, error } = await supabase
        .from('users')
        .upsert([
            { telegram_id: telegramId, username: username }
        ], {
            onConflict: 'telegram_id'
        })
        .select();

    if (error) {
        console.error("Auth upsert error:", error);
        return res.status(500).json({ error: error.message });
    }

    const user = data[0];
    req.session.userId = telegramId;
    res.json({
        success: true,
        userId: user.telegram_id,
        username: user.username,
        balance: user.balance || 0
    });
});

// ---------- Bingo Game State (in-memory + Supabase on win) ----------
let currentNumbers = Array.from({ length: 100 }, (_, i) => i + 1);   // 1..100
let availableNumbers = new Set(currentNumbers);
let userSelections = new Map();   // socketId -> { userId, selectedNumber }
let gameLocked = false;
let drawInterval = null;
let roundPool = 0;

async function updateUserBalance(telegramId, delta) {
    // Fetch current balance
    const { data: userData, error: fetchError } = await supabase
        .from('users')
        .select('balance')
        .eq('telegram_id', telegramId)
        .single();

    if (fetchError && fetchError.code !== 'PGRST116') { // PGRST116 = no rows
        console.error("Fetch balance error:", fetchError);
        return null;
    }

    const currentBalance = userData?.balance || 0;
    const newBalance = currentBalance + delta;

    const { data, error } = await supabase
        .from('users')
        .update({ balance: newBalance })
        .eq('telegram_id', telegramId)
        .select()
        .single();

    if (error) {
        console.error("Update balance error:", error);
        return null;
    }
    return data.balance;
}

function startNewRound() {
    // Reset round
    gameLocked = false;
    availableNumbers = new Set(currentNumbers);
    userSelections.clear();
    roundPool = 0;
    io.emit('gameState', { locked: false, available: Array.from(availableNumbers) });
    io.emit('statusMessage', { text: "New round started! Choose your number (1-100).", type: "info" });

    if (drawInterval) clearTimeout(drawInterval);
    drawInterval = setTimeout(async () => {
        gameLocked = true;
        io.emit('gameState', { locked: true, available: [] });
        io.emit('statusMessage', { text: "Betting closed! Drawing winner...", type: "warning" });

        const winningNumber = Math.floor(Math.random() * 100) + 1;
        io.emit('numberDrawn', { number: winningNumber });

        let winnerTelegramId = null;
        let winnerSocketId = null;
        for (let [sockId, data] of userSelections.entries()) {
            if (data.selectedNumber === winningNumber) {
                winnerTelegramId = data.userId;
                winnerSocketId = sockId;
                break;
            }
        }

        if (winnerTelegramId && roundPool > 0) {
            const newBalance = await updateUserBalance(winnerTelegramId, roundPool);
            if (newBalance !== null && winnerSocketId) {
                io.to(winnerSocketId).emit('balanceUpdate', newBalance);
                io.emit('statusMessage', { text: `🎉 Winner! User ${winnerTelegramId} won ${roundPool}!`, type: "success" });
            } else {
                io.emit('statusMessage', { text: `Error updating winner balance.`, type: "error" });
            }
        } else {
            io.emit('statusMessage', { text: `No winner this round. Winning number: ${winningNumber}`, type: "info" });
        }

        roundPool = 0;
        setTimeout(() => startNewRound(), 5000);
    }, 15000);
}

startNewRound();

// ---------- Socket.IO with session auth ----------
io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
});

io.on('connection', async (socket) => {
    const userId = socket.request.session.userId;
    if (!userId) {
        socket.disconnect();
        return;
    }

    const { data: userData, error } = await supabase
        .from('users')
        .select('balance')
        .eq('telegram_id', userId)
        .single();

    let balance = (userData?.balance || 0);
    if (error && error.code !== 'PGRST116') console.error("Balance fetch error:", error);

    socket.emit('gameState', { locked: gameLocked, available: Array.from(availableNumbers) });

    socket.on('selectCard', async ({ cardNumber, name }) => {
        if (gameLocked) {
            socket.emit('error', { message: "Round locked, cannot pick now." });
            return;
        }
        if (!availableNumbers.has(cardNumber)) {
            socket.emit('error', { message: "Number already taken." });
            return;
        }
        if (userSelections.has(socket.id)) {
            socket.emit('error', { message: "You already picked a number this round." });
            return;
        }

        const cost = 10;
        if (balance < cost) {
            socket.emit('error', { message: "Insufficient balance." });
            return;
        }

        const newBalance = await updateUserBalance(userId, -cost);
        if (newBalance === null) {
            socket.emit('error', { message: "Transaction failed. Try again." });
            return;
        }
        balance = newBalance;
        socket.emit('balanceUpdate', balance);

        availableNumbers.delete(cardNumber);
        userSelections.set(socket.id, { userId, selectedNumber: cardNumber });
        roundPool += cost;

        socket.emit('cardAssigned', { cardNumber, balance: newBalance });
        io.emit('gameState', { locked: gameLocked, available: Array.from(availableNumbers) });
        io.emit('statusMessage', { text: `${name} picked number ${cardNumber}`, type: "action" });
    });

    socket.on('disconnect', () => {
        userSelections.delete(socket.id);
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));