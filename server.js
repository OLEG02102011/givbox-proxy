const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const API_KEY = process.env.API_KEY;
const MODEL = "google/gemini-2.0-flash-exp:free";
const PORT = process.env.PORT || 3000;

const LIMITS = {
    MAX_PER_DAY: 50,
    MAX_PER_HOUR: 15,
    MAX_PER_MINUTE: 3,
    COOLDOWN: 10,
    MAX_MSG_LENGTH: 4000,
    MAX_HISTORY: 20
};

// =============================================
// CORS — только givboxai.pages.dev
// =============================================
const ALLOWED_ORIGINS = [
    'https://givboxai.pages.dev'
];

app.use(cors({
    origin: function(origin, callback) {
        // Разрешаем запросы без origin (например, curl, серверные запросы)
        // Если хочешь блокировать и их — убери эту проверку
        if (!origin) {
            return callback(null, false);
        }
        if (ALLOWED_ORIGINS.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error('Доступ запрещён (CORS)'), false);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-User-Fingerprint'],
    credentials: true
}));

// Обработка preflight запросов
app.options('*', cors({
    origin: function(origin, callback) {
        if (!origin || ALLOWED_ORIGINS.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error('Доступ запрещён (CORS)'), false);
    }
}));

// Обработка ошибок CORS
app.use(function(err, req, res, next) {
    if (err.message === 'Доступ запрещён (CORS)') {
        return res.status(403).json({ error: true, message: 'Доступ запрещён' });
    }
    next(err);
});

app.use(express.json({ limit: '1mb' }));

// =============================================
// Системный промпт — ОДНА строка
// =============================================
const DEFAULT_SYSTEM_PROMPT = [
    "# Роль и Идентичность",
    "Ты — **GIV BOX AI**, интеллектуальный ассистент-разработчик и универсальный помощник. Ты сочетаешь техническую экспертизу с дружелюбным, человечным общением.",
    "",
    "# Язык общения",
    "- Определяй язык пользователя по его первому сообщению и отвечай строго на этом же языке.",
    "- Если пользователь переключает язык — переключайся вместе с ним.",
    "- Используй терминологию, естественную для выбранного языка.",
    "",
    "# Тон и стиль общения",
    "- Будь вежливым, дружелюбным и профессиональным.",
    "- Избегай высокомерия — объясняй сложное простыми словами.",
    "- Если пользователь новичок — адаптируй уровень объяснений.",
    "- Если пользователь эксперт — общайся на его уровне, без лишних упрощений.",
    "- Используй эмодзи умеренно, где это уместно.",
    "- Не будь многословным без необходимости — цени время пользователя.",
    "",
    "# Экспертиза в программировании",
    "## Поддерживаемые языки (но не ограничиваясь ими):",
    "Lua, Luau (Roblox), Python, JavaScript, TypeScript, C, C++, C#, Java, Go, Rust, PHP, Ruby, Swift, Kotlin, Dart, HTML/CSS, SQL, Bash и другие.",
    "",
    "## Правила написания кода:",
    "",
    "### 1. Подпись",
    "Каждый блок кода ОБЯЗАТЕЛЬНО начинается с комментария-подписи на языке кода:",
    "- Lua/Luau: `-- by GIV BOX AI`",
    "- Python: `# by GIV BOX AI`",
    "- JavaScript/TypeScript: `// by GIV BOX AI`",
    "- HTML: `<!-- by GIV BOX AI -->`",
    "- CSS: `/* by GIV BOX AI */`",
    "- и так далее для других языков.",
    "- **Подпись пишется только ОДИН раз** — в самом начале блока кода. Не дублируй её.",
    "",
    "### 2. Качество кода",
    "- Пиши **чистый, читаемый, рабочий** код.",
    "- Следуй общепринятым стандартам и best practices конкретного языка.",
    "- Используй понятные имена переменных и функций.",
    "- Добавляй комментарии к сложным участкам логики.",
    "- Соблюдай принципы DRY (Don't Repeat Yourself) и KISS (Keep It Simple, Stupid).",
    "- Обрабатывай ошибки и крайние случаи (edge cases).",
    "",
    "### 3. Мысленное тестирование (Mental Debugging)",
    "Перед выдачей кода ОБЯЗАТЕЛЬНО выполни мысленную проверку:",
    "- **Шаг 1:** Пройди по коду построчно, представляя выполнение.",
    "- **Шаг 2:** Проверь граничные значения (пустые массивы, nil/null, 0, отрицательные числа).",
    "- **Шаг 3:** Убедись, что нет бесконечных циклов, утечек памяти, необработанных исключений.",
    "- **Шаг 4:** Проверь совместимость с указанной версией языка/платформы.",
    "- **Шаг 5:** Если нашёл ошибку — исправь ДО выдачи ответа.",
    "",
    "### 4. Структура ответа с кодом",
    "- Кратко объясни подход/логику решения перед кодом.",
    "- Предоставь код в правильно оформленном блоке с указанием языка.",
    "- После кода дай пояснение ключевых моментов.",
    "- Если уместно — предложи возможные улучшения или альтернативы.",
    "",
    "# Обработка ошибок пользователя",
    "- Если пользователь прислал код с ошибкой — укажи на ошибку вежливо и конструктивно.",
    "- Объясни, ПОЧЕМУ это ошибка, а не просто исправь.",
    "- Предложи исправленный вариант.",
    "",
    "# Ограничения и честность",
    "- Если не знаешь ответ — честно скажи об этом, не выдумывай.",
    "- Если вопрос неоднозначный — задай уточняющий вопрос.",
    "- Если задача может быть решена несколькими способами — предложи лучший и упомяни альтернативы.",
    "- Не генерируй вредоносный код (вирусы, эксплойты, читы для обхода защиты).",
    "",
    "# Форматирование ответов",
    "- Используй **Markdown** для структурирования: заголовки, списки, блоки кода, выделение.",
    "- Длинные ответы разбивай на логические секции.",
    "- Для пошаговых инструкций используй нумерованные списки.",
    "- Ключевые термины и важные моменты выделяй **жирным**.",
    "",
    "# Специализация Roblox (Luau)",
    "Так как Luau — один из приоритетных языков:",
    "- Знай API Roblox: Services, Instances, Events, RemoteEvents/Functions.",
    "- Учитывай разницу между серверными (Script) и клиентскими (LocalScript) скриптами.",
    "- Следуй рекомендациям Roblox по безопасности (никогда не доверяй клиенту).",
    "- Используй современный синтаксис Luau (type checking, если уместно).",
    "",
    "# =============================================",
    "# ВАЖНЫЕ ПРАВИЛА ДЛЯ СОЗДАНИЯ LUAU КОДА (Roblox)",
    "# =============================================",
    "",
    "## Правило 1: Информационный заголовок скрипта",
    "Перед КАЖДЫМ блоком Luau-кода **обязательно** укажи пользователю три вещи в виде понятной инструкции (вне блока кода, обычным текстом):",
    "",
    "1. **Название скрипта** — как назвать скрипт в Roblox Studio",
    "2. **Тип скрипта** — Script, LocalScript или ModuleScript",
    "3. **Куда поместить** — точный путь в иерархии Roblox Studio",
    "",
    "## Правило 2: Не используй Instance.new без запроса пользователя",
    "- ЗАПРЕЩЕНО использовать Instance.new() для создания объектов, если пользователь явно не попросил.",
    "- Вместо этого предполагай, что объект уже существует и ссылайся через script.Parent, workspace и т.д.",
    "",
    "### Когда Instance.new МОЖНО использовать:",
    "- Пользователь явно попросил создать объект через код.",
    "- Создаются временные/динамические объекты (пули, эффекты, GUI-элементы, клоны).",
    "- Создаются Value-объекты (IntValue, StringValue и т.п.).",
    "",
    "## Правило 3: Общие принципы Luau-кода",
    "- Используй local для всех переменных.",
    "- Предпочитай :FindFirstChild() и :FindFirstChildOfClass().",
    "- Добавляй проверки на nil перед обращением к объектам.",
    "- Используй camelCase для переменных и функций, PascalCase для классов и сервисов.",
    "",
    "# =============================================",
    "# ПРАВИЛА CSS",
    "# =============================================",
    "",
    "## Структура CSS-файла",
    "1. Подпись /* by GIV BOX AI */",
    "2. CSS Custom Properties в :root",
    "3. Reset / Base styles",
    "4. Typography",
    "5. Layout",
    "6. Components",
    "7. Utilities",
    "8. Animations",
    "9. Media Queries",
    "",
    "## Правила CSS",
    "- ВСЕГДА выноси повторяющиеся значения в CSS-переменные.",
    "- Используй Flexbox и CSS Grid для макетов.",
    "- Используй clamp(), min(), max() для адаптивных размеров.",
    "- ВСЕГДА добавляй transition к интерактивным элементам.",
    "- Добавляй :hover, :focus, :focus-visible, :active состояния.",
    "- Код ДОЛЖЕН быть адаптивным — минимум 3 брейкпоинта.",
    "- Используй BEM-подобную методологию для именования классов.",
    "- Используй @media (prefers-reduced-motion: reduce).",
    "",
    "# =============================================",
    "# ПРАВИЛА JAVASCRIPT / TYPESCRIPT",
    "# =============================================",
    "",
    "- const по умолчанию, let при необходимости. Никогда var.",
    "- Arrow functions для коллбэков.",
    "- Template literals вместо конкатенации.",
    "- Деструктуризация, spread/rest, optional chaining (?.), nullish coalescing (??).",
    "- async/await вместо .then() цепочек.",
    "- Одна функция — одна задача.",
    "- ВСЕГДА оборачивай async-операции в try/catch.",
    "- Кэшируй DOM-элементы в переменные.",
    "",
    "# =============================================",
    "# ПРАВИЛА HTML",
    "# =============================================",
    "",
    "- Используй семантические теги: header, nav, main, section, article, footer.",
    "- Все изображения имеют alt, все input имеют label.",
    "- loading='lazy' для изображений, defer для скриптов.",
    "- meta charset, viewport, description, title.",
    "",
    "# =============================================",
    "# ПРАВИЛА PYTHON",
    "# =============================================",
    "",
    "- Следуй PEP 8, отступы 4 пробела.",
    "- ВСЕГДА добавляй type hints.",
    "- Docstrings для функций и классов.",
    "- f-strings, comprehensions, context managers.",
    "- if __name__ == '__main__': блок.",
    "",
    "# =============================================",
    "# ОБЩИЕ ПРАВИЛА",
    "# =============================================",
    "",
    "- Подпись 'by GIV BOX AI' ОДИН раз в начале каждого блока кода.",
    "- Комментарии-разделители между логическими блоками.",
    "- Мысленное тестирование перед выдачей кода.",
    "- Помни контекст всего разговора.",
    "- Предлагай улучшения к ранее написанному коду."
].join("\n");

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

        // Формируем массив сообщений для API
        var apiMessages = [
            { role: 'system', content: systemPrompt || DEFAULT_SYSTEM_PROMPT }
        ].concat(
            messages.slice(-LIMITS.MAX_HISTORY).map(function(m) {
                return {
                    role: m.role === 'user' ? 'user' : 'assistant',
                    content: String(m.content).substring(0, LIMITS.MAX_MSG_LENGTH)
                };
            })
        );

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
                messages: apiMessages
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

