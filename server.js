const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const API_KEY = process.env.API_KEY;
const MODEL = "mistralai/mistral-7b-instruct:free";
const PORT = process.env.PORT || 3000;

const LIMITS = {
    MAX_PER_DAY: 50,
    MAX_PER_HOUR: 15,
    MAX_PER_MINUTE: 3,
    COOLDOWN: 10,
    MAX_MSG_LENGTH: 4000,
    MAX_HISTORY: 20
};

// CORS - разрешаем ВСЕ домены
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-User-Fingerprint']
}));

// Обработка preflight запросов
app.options('*', cors());

app.use(express.json({ limit: '1mb' }));

const users = new Map();

function getUserId(req) {
    const ip = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').split(',')[0].trim();
    const fp = req.headers['x-user-fingerprint'] || '';
    const ua = req.headers['user-agent'] || '';
    return crypto.createHash('sha256').update(ip + '_' + fp + '_' + ua).digest('hex').substring(0, 16);
}

function checkLimits(userId) {
    if (!users.has(userId)) {
        users.set(userId, { requests: [], lastRequest: 0 });
    }
    var u = users.get(userId);
    var now = Date.now();

    var sinceLast = (now - u.lastRequest) / 1000;
    if (u.lastRequest > 0 && sinceLast < LIMITS.COOLDOWN) {
        return { allowed: false, reason: 'Подождите ' + Math.ceil(LIMITS.COOLDOWN - sinceLast) + ' сек.', retryAfter: Math.ceil(LIMITS.COOLDOWN - sinceLast) };
    }

    var min1 = now - 60000;
    var hr1 = now - 3600000;
    var day1 = now - 86400000;
    var perMin = u.requests.filter(function(t) { return t > min1; }).length;
    var perHour = u.requests.filter(function(t) { return t > hr1; }).length;
    var perDay = u.requests.filter(function(t) { return t > day1; }).length;

    if (perMin >= LIMITS.MAX_PER_MINUTE) return { allowed: false, reason: 'Макс. ' + LIMITS.MAX_PER_MINUTE + ' сообщ./мин.', retryAfter: 60 };
    if (perHour >= LIMITS.MAX_PER_HOUR) return { allowed: false, reason: 'Лимит ' + LIMITS.MAX_PER_HOUR + '/час исчерпан', retryAfter: 300 };
    if (perDay >= LIMITS.MAX_PER_DAY) return { allowed: false, reason: 'Дневной лимит ' + LIMITS.MAX_PER_DAY + ' исчерпан', retryAfter: 3600 };

    return {
        allowed: true,
        remaining: {
            minute: LIMITS.MAX_PER_MINUTE - perMin,
            hour: LIMITS.MAX_PER_HOUR - perHour,
            day: LIMITS.MAX_PER_DAY - perDay
        }
    };
}

function recordRequest(userId) {
    var u = users.get(userId);
    var now = Date.now();
    u.requests.push(now);
    u.lastRequest = now;
    u.requests = u.requests.filter(function(t) { return t > now - 90000000; });
}

app.get('/', function(req, res) {
    res.json({ status: 'ok', service: 'GIV BOX AI Proxy', activeUsers: users.size, uptime: Math.floor(process.uptime()) + 's' });
});

app.get('/api/limits', function(req, res) {
    var userId = getUserId(req);
    var check = checkLimits(userId);
    res.json({ allowed: check.allowed, remaining: check.remaining || null, message: check.reason || null });
});

app.post('/api/chat', async function(req, res) {
    if (!API_KEY) {
        return res.status(500).json({ error: true, message: 'API ключ не настроен на сервере' });
    }

    var userId = getUserId(req);
    var limit = checkLimits(userId);
    if (!limit.allowed) {
        return res.status(429).json({ error: true, message: limit.reason, retryAfter: limit.retryAfter });
    }

    var messages = req.body.messages;
    var systemPrompt = req.body.systemPrompt;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: true, message: 'Нет сообщений' });
    }

    recordRequest(userId);

    try {
        var controller = new AbortController();
        var timeout = setTimeout(function() { controller.abort(); }, 30000);

        var response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Authorization': 'Bearer ' + API_KEY,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://givboxai.pages.dev',
                'X-Title': 'GIV BOX AI'
            },
            body: JSON.stringify({
                model: MODEL,
                messages: [
                    { role: 'system', content: systemPrompt || 'Ты полезный ассистент.' }
                ].concat(
                    messages.slice(-LIMITS.MAX_HISTORY).map(function(m) {
                        return {
                            role: m.role === 'user' ? 'user' : 'assistant',
                            content: String(m.content).substring(0, LIMITS.MAX_MSG_LENGTH)
                        };
                    })
                )
            })
        });

        clearTimeout(timeout);

        if (response.status === 429) {
            return res.status(503).json({ error: true, message: 'Сервер перегружен. Попробуйте через 1-2 мин.', retryAfter: 120 });
        }
        if (!response.ok) {
            var errText = await response.text();
            console.error('OpenRouter error:', response.status, errText);
            return res.status(502).json({ error: true, message: 'Ошибка сервера ИИ' });
        }

        var data = await response.json();
        var aiText = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!aiText) {
            return res.status(502).json({ error: true, message: 'ИИ не вернул ответ' });
        }

        var updated = checkLimits(userId);
        res.json({ content: aiText, limits: updated.remaining || null });

    } catch (error) {
        if (error.name === 'AbortError') {
            return res.status(504).json({ error: true, message: 'Таймаут. Попробуйте ещё раз.' });
        }
        console.error('Server error:', error);
        res.status(500).json({ error: true, message: 'Внутренняя ошибка' });
    }
});

setInterval(function() {
    var cutoff = Date.now() - 90000000;
    for (var entry of users.entries()) {
        var id = entry[0];
        var data = entry[1];
        data.requests = data.requests.filter(function(t) { return t > cutoff; });
        if (data.requests.length === 0) users.delete(id);
    }
}, 3600000);

app.listen(PORT, function() {
    console.log('GIV BOX AI Proxy running on port ' + PORT);
    console.log('API Key: ' + (API_KEY ? 'SET' : 'MISSING!'));
});


