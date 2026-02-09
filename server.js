const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();

// ============================================================
// КОНФИГУРАЦИЯ
// ============================================================
const API_KEY = process.env.API_KEY || "СЮДА_НЕ_ВСТАВЛЯЙ_КЛЮЧ";
const MODEL = "nousresearch/hermes-3-llama-3.1-405b:free";
const PORT = process.env.PORT || 3000;

// Разрешённые домены (замени на свой)
const ALLOWED_ORIGINS = [
    "https://givboxai.pages.dev/",
    "null" // для локальных файлов
];

// Лимиты на одного пользователя
const LIMITS = {
    MAX_REQUESTS_PER_DAY: 50,
    MAX_REQUESTS_PER_HOUR: 15,
    MAX_REQUESTS_PER_MINUTE: 3,
    COOLDOWN_SECONDS: 10,
    MAX_MESSAGE_LENGTH: 4000,
    MAX_HISTORY_MESSAGES: 20
};

// ============================================================
// CORS
// ============================================================
app.use(cors({
    origin: [
        'https://givboxai.pages.dev',
        'https://www.givboxai.pages.dev',
        'http://localhost:3000',
        'http://localhost:5500',
        'http://127.0.0.1:5500'
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-User-Fingerprint'],
    credentials: true
}));

app.use(express.json({ limit: '1mb' }));

// ============================================================
// ЛОГИРОВАНИЕ
// ============================================================
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.path}`);
    next();
});

// ============================================================
// ХРАНИЛИЩЕ ПОЛЬЗОВАТЕЛЕЙ (в памяти)
// ============================================================
const userLimits = new Map();

function createUserData() {
    return {
        requests: [],
        lastRequest: 0,
        totalRequests: 0,
        blocked: false,
        createdAt: Date.now()
    };
}

// ============================================================
// ИДЕНТИФИКАЦИЯ ПОЛЬЗОВАТЕЛЯ
// ============================================================
function getUserId(req) {
    const ip = req.headers['x-forwarded-for']
        || req.headers['x-real-ip']
        || req.connection.remoteAddress
        || 'unknown';

    // Берём только первый IP если их несколько
    const cleanIp = ip.split(',')[0].trim();
    const fingerprint = req.headers['x-user-fingerprint'] || '';
    const userAgent = req.headers['user-agent'] || '';

    const raw = `${cleanIp}_${fingerprint}_${userAgent}`;
    return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 16);
}

// ============================================================
// ПРОВЕРКА ЛИМИТОВ
// ============================================================
function checkLimits(userId) {
    if (!userLimits.has(userId)) {
        userLimits.set(userId, createUserData());
    }

    const userData = userLimits.get(userId);
    const now = Date.now();

    // Блокировка
    if (userData.blocked) {
        return {
            allowed: false,
            reason: "Аккаунт временно заблокирован",
            retryAfter: null
        };
    }

    // Кулдаун между сообщениями
    const timeSinceLast = (now - userData.lastRequest) / 1000;
    if (userData.lastRequest > 0 && timeSinceLast < LIMITS.COOLDOWN_SECONDS) {
        const wait = Math.ceil(LIMITS.COOLDOWN_SECONDS - timeSinceLast);
        return {
            allowed: false,
            reason: `Подождите ${wait} сек. между сообщениями`,
            retryAfter: wait
        };
    }

    // Временные границы
    const oneMinuteAgo = now - 60 * 1000;
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    // Подсчёт запросов
    const perMinute = userData.requests.filter(t => t > oneMinuteAgo).length;
    const perHour = userData.requests.filter(t => t > oneHourAgo).length;
    const perDay = userData.requests.filter(t => t > oneDayAgo).length;

    // Лимит в минуту
    if (perMinute >= LIMITS.MAX_REQUESTS_PER_MINUTE) {
        return {
            allowed: false,
            reason: `Максимум ${LIMITS.MAX_REQUESTS_PER_MINUTE} сообщения в минуту`,
            retryAfter: 60
        };
    }

    // Лимит в час
    if (perHour >= LIMITS.MAX_REQUESTS_PER_HOUR) {
        const oldestInHour = userData.requests.filter(t => t > oneHourAgo).sort()[0];
        const resetIn = Math.ceil((oldestInHour + 3600000 - now) / 60000);
        return {
            allowed: false,
            reason: `Лимит ${LIMITS.MAX_REQUESTS_PER_HOUR} сообщ./час исчерпан. Сброс через ~${resetIn} мин.`,
            retryAfter: resetIn * 60
        };
    }

    // Дневной лимит
    if (perDay >= LIMITS.MAX_REQUESTS_PER_DAY) {
        const resetTime = new Date();
        resetTime.setHours(24, 0, 0, 0);
        const hoursLeft = Math.ceil((resetTime.getTime() - now) / 3600000);
        return {
            allowed: false,
            reason: `Дневной лимит ${LIMITS.MAX_REQUESTS_PER_DAY} сообщений исчерпан. Сброс через ~${hoursLeft} ч.`,
            retryAfter: hoursLeft * 3600
        };
    }

    // Всё ок
    return {
        allowed: true,
        remaining: {
            minute: LIMITS.MAX_REQUESTS_PER_MINUTE - perMinute,
            hour: LIMITS.MAX_REQUESTS_PER_HOUR - perHour,
            day: LIMITS.MAX_REQUESTS_PER_DAY - perDay
        }
    };
}

// ============================================================
// ЗАПИСЬ ЗАПРОСА
// ============================================================
function recordRequest(userId) {
    const userData = userLimits.get(userId);
    const now = Date.now();

    userData.requests.push(now);
    userData.lastRequest = now;
    userData.totalRequests++;

    // Чистим записи старше 25 часов
    const cutoff = now - 25 * 60 * 60 * 1000;
    userData.requests = userData.requests.filter(t => t > cutoff);
}

// ============================================================
// МАРШРУТЫ
// ============================================================

// Статус сервера
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'GIV BOX AI Proxy',
        activeUsers: userLimits.size,
        uptime: Math.floor(process.uptime()) + 's'
    });
});

// Проверка лимитов пользователя
app.get('/api/limits', (req, res) => {
    const userId = getUserId(req);
    const check = checkLimits(userId);

    res.json({
        userId: userId.substring(0, 8) + '...',
        allowed: check.allowed,
        remaining: check.remaining || null,
        message: check.reason || null,
        config: {
            perDay: LIMITS.MAX_REQUESTS_PER_DAY,
            perHour: LIMITS.MAX_REQUESTS_PER_HOUR,
            perMinute: LIMITS.MAX_REQUESTS_PER_MINUTE,
            cooldown: LIMITS.COOLDOWN_SECONDS
        }
    });
});

// Основной эндпоинт чата
app.post('/api/chat', async (req, res) => {
    const userId = getUserId(req);

    // 1. Проверяем лимиты
    const limitCheck = checkLimits(userId);
    if (!limitCheck.allowed) {
        console.log(`[LIMIT] User ${userId.substring(0, 8)}: ${limitCheck.reason}`);
        return res.status(429).json({
            error: true,
            message: limitCheck.reason,
            retryAfter: limitCheck.retryAfter
        });
    }

    // 2. Валидация тела запроса
    const { messages, systemPrompt } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({
            error: true,
            message: "Отправьте хотя бы одно сообщение"
        });
    }

    // 3. Проверяем длину последнего сообщения
    const lastMessage = messages[messages.length - 1];
    if (lastMessage && lastMessage.content && lastMessage.content.length > LIMITS.MAX_MESSAGE_LENGTH) {
        return res.status(400).json({
            error: true,
            message: `Сообщение слишком длинное. Максимум ${LIMITS.MAX_MESSAGE_LENGTH} символов`
        });
    }

    // 4. Обрезаем историю
    const limitedMessages = messages.slice(-LIMITS.MAX_HISTORY_MESSAGES);

    // 5. Записываем запрос
    recordRequest(userId);

    // 6. Отправляем в OpenRouter
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000); // 30 сек таймаут

        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            signal: controller.signal,
            headers: {
                "Authorization": `Bearer ${API_KEY}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://givbox.ai",
                "X-Title": "GIV BOX AI"
            },
            body: JSON.stringify({
                model: MODEL,
                messages: [
                    {
                        role: "system",
                        content: systemPrompt || "Ты полезный ассистент. Отвечай на русском языке."
                    },
                    ...limitedMessages.map(m => ({
                        role: m.role === 'user' ? 'user' : 'assistant',
                        content: String(m.content).substring(0, LIMITS.MAX_MESSAGE_LENGTH)
                    }))
                ]
            })
        });

        clearTimeout(timeout);

        // Глобальный лимит OpenRouter
        if (response.status === 429) {
            console.log(`[OPENROUTER 429] Rate limited`);
            return res.status(503).json({
                error: true,
                message: "Сервер временно перегружен. Попробуйте через 1-2 минуты.",
                retryAfter: 120
            });
        }

        // Другие ошибки OpenRouter
        if (!response.ok) {
            console.error(`[OPENROUTER ERROR] Status: ${response.status}`);
            const errText = await response.text();
            console.error(`[OPENROUTER ERROR] Body: ${errText}`);
            return res.status(502).json({
                error: true,
                message: "Ошибка сервера ИИ. Попробуйте позже."
            });
        }

        // Успех
        const data = await response.json();
        const aiText = data.choices?.[0]?.message?.content;

        if (!aiText) {
            return res.status(502).json({
                error: true,
                message: "ИИ не вернул ответ. Попробуйте переформулировать."
            });
        }

        // Обновлённые лимиты
        const updatedLimits = checkLimits(userId);

        console.log(`[OK] User ${userId.substring(0, 8)} | Remaining: ${updatedLimits.remaining?.day || '?'}/day`);

        res.json({
            content: aiText,
            limits: updatedLimits.remaining || null
        });

    } catch (error) {
        if (error.name === 'AbortError') {
            console.error(`[TIMEOUT] User ${userId.substring(0, 8)}`);
            return res.status(504).json({
                error: true,
                message: "Время ожидания ответа истекло. Попробуйте ещё раз."
            });
        }

        console.error(`[ERROR] ${error.message}`);
        res.status(500).json({
            error: true,
            message: "Внутренняя ошибка сервера"
        });
    }
});

// ============================================================
// ОЧИСТКА ПАМЯТИ КАЖДЫЙ ЧАС
// ============================================================
setInterval(() => {
    const now = Date.now();
    const cutoff = now - 25 * 60 * 60 * 1000;
    let cleaned = 0;

    for (const [userId, data] of userLimits.entries()) {
        data.requests = data.requests.filter(t => t > cutoff);
        if (data.requests.length === 0 && now - data.lastRequest > 86400000) {
            userLimits.delete(userId);
            cleaned++;
        }
    }

    console.log(`[CLEANUP] Removed ${cleaned} inactive users. Active: ${userLimits.size}`);
}, 3600000);

// ============================================================
// ЗАПУСК СЕРВЕРА
// ============================================================
app.listen(PORT, () => {
    console.log('========================================');
    console.log('   GIV BOX AI Proxy Server');
    console.log(`   Port: ${PORT}`);
    console.log(`   Model: ${MODEL}`);
    console.log(`   API Key: ${API_KEY ? 'SET' : 'MISSING!'}`);
    console.log(`   Limits: ${LIMITS.MAX_REQUESTS_PER_DAY}/day, ${LIMITS.MAX_REQUESTS_PER_HOUR}/hour`);
    console.log('========================================');

});
