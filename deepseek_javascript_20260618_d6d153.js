// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const OpenAI = require('openai');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ============================================
// 1. Инициализация API-клиентов
// ============================================
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ODDS_API_KEY_OLD = process.env.ODDS_API_KEY_OLD;
const ODDS_API_KEY_IO = process.env.ODDS_API_KEY_IO;

console.log('🔑 API ключи загружены');

// ============================================
// 2. Модуль сбора коэффициентов
// ============================================
async function fetchOldOdds(sport = 'soccer_epl') {
    const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_API_KEY_OLD}&regions=eu&markets=h2h&oddsFormat=decimal`;
    const resp = await axios.get(url);
    return resp.data;
}

async function fetchIoOdds(sport = 'soccer_epl') {
    // Документация Odds-API.io: https://odds-api.io/docs
    // Пример эндпоинта (уточните по документации)
    const url = `https://odds-api.io/v1/events?sport=${sport}&apiKey=${ODDS_API_KEY_IO}`;
    const resp = await axios.get(url);
    return resp.data;
}

async function getAllOdds(sport) {
    const results = await Promise.allSettled([
        fetchOldOdds(sport),
        fetchIoOdds(sport)
    ]);
    const merged = [];
    results.forEach(result => {
        if (result.status === 'fulfilled') {
            merged.push(...result.value);
        }
    });
    return merged;
}

// ============================================
// 3. ИИ-ассистенты (только OpenAI, если нет Anthropic)
// ============================================
async function openAIAnalysis(match) {
    const prompt = `
        Ты — спортивный аналитик. 
        Матч: ${match.home_team} vs ${match.away_team}.
        Статистика (если есть): ${match.stats || 'нет данных'}.
        Оцени вероятности исходов: победа хозяев, ничья, победа гостей.
        Ответь строго в формате JSON: {"home": 0.xx, "draw": 0.xx, "away": 0.xx}
        Сумма вероятностей должна быть равна 1.
    `;
    const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',  // можно использовать 'gpt-4' если доступно
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
    });
    const content = response.choices[0].message.content;
    // Извлекаем JSON из ответа (может быть с пояснениями)
    const jsonMatch = content.match(/\{.*\}/s);
    if (!jsonMatch) throw new Error('Не удалось извлечь JSON');
    return JSON.parse(jsonMatch[0]);
}

// Второй агент пока пропускаем (можно добавить Anthropic позже)
// Для консенсуса используем только OpenAI (или можно дублировать с разными настройками)
async function getConsensus(match) {
    try {
        const result = await openAIAnalysis(match);
        return result;
    } catch (error) {
        console.error('Ошибка OpenAI:', error.message);
        // Запасной вариант: равные вероятности
        return { home: 0.33, draw: 0.34, away: 0.33 };
    }
}

// ============================================
// 4. Симуляция (Монте-Карло)
// ============================================
function poissonRandom(lambda) {
    let L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
        k++;
        p *= Math.random();
    } while (p > L);
    return k - 1;
}

function simulateMatch(homeExpectedGoals, awayExpectedGoals, numSims = 10000) {
    let homeWins = 0, draws = 0, awayWins = 0;
    for (let i = 0; i < numSims; i++) {
        const homeGoals = poissonRandom(homeExpectedGoals);
        const awayGoals = poissonRandom(awayExpectedGoals);
        if (homeGoals > awayGoals) homeWins++;
        else if (homeGoals === awayGoals) draws++;
        else awayWins++;
    }
    return {
        home: homeWins / numSims,
        draw: draws / numSims,
        away: awayWins / numSims,
    };
}

function getExpectedGoals(match) {
    // В реальности нужно запрашивать у ИИ или брать из статистики
    // Здесь просто условные значения для демонстрации
    return { home: 1.5, away: 1.2 };
}

// ============================================
// 5. Поиск валуйных ставок и вилок
// ============================================
function findValueBets(odds, probabilities, minExpectedValue = 0.02) {
    const valueBets = [];
    for (const outcome of ['home', 'draw', 'away']) {
        const oddsVal = odds[outcome];
        const prob = probabilities[outcome];
        if (!oddsVal || !prob) continue;
        const expectedValue = prob * oddsVal - 1;
        if (expectedValue > minExpectedValue) {
            valueBets.push({ outcome, odds: oddsVal, prob, expectedValue });
        }
    }
    return valueBets;
}

function findArbitrage(bookmakerOddsList, minProfit = 0.005) {
    if (!bookmakerOddsList || bookmakerOddsList.length === 0) return null;
    const best = { home: 0, draw: 0, away: 0 };
    for (const bm of bookmakerOddsList) {
        if (bm.odds.home && bm.odds.home > best.home) best.home = bm.odds.home;
        if (bm.odds.draw && bm.odds.draw > best.draw) best.draw = bm.odds.draw;
        if (bm.odds.away && bm.odds.away > best.away) best.away = bm.odds.away;
    }
    if (best.home === 0 || best.draw === 0 || best.away === 0) return null;
    const invSum = 1/best.home + 1/best.draw + 1/best.away;
    const profit = 1 / invSum - 1;
    if (profit > minProfit) {
        return { profit, bestOdds: best };
    }
    return null;
}

// ============================================
// 6. Express маршруты
// ============================================

// Проверка работоспособности
app.get('/ping', (req, res) => {
    res.json({ status: '🚀 Сервер работает', time: new Date().toISOString() });
});

// Получить список матчей (с коэффициентами)
app.get('/api/matches', async (req, res) => {
    try {
        const sport = req.query.sport || 'soccer_epl';
        const matches = await getAllOdds(sport);
        res.json({ count: matches.length, matches });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Ошибка получения матчей' });
    }
});

// Полный анализ конкретного матча (по id)
app.post('/api/analyze', async (req, res) => {
    const { matchId, sport = 'soccer_epl' } = req.body;
    if (!matchId) return res.status(400).json({ error: 'Не указан matchId' });

    try {
        // 1. Получаем все матчи
        const allMatches = await getAllOdds(sport);
        const match = allMatches.find(m => m.id === matchId || m.match_id === matchId);
        if (!match) return res.status(404).json({ error: 'Матч не найден' });

        // 2. Получаем вероятности от ИИ
        const consensus = await getConsensus(match);

        // 3. Симуляция
        const expectedGoals = getExpectedGoals(match);
        const simResults = simulateMatch(expectedGoals.home, expectedGoals.away, 10000);

        // 4. Собираем лучшие коэффициенты по исходам
        const allBookmakers = match.bookmakers || [];
        const bestOdds = { home: 0, draw: 0, away: 0 };
        const bookmakerOddsList = [];

        for (const bm of allBookmakers) {
            const market = bm.markets?.find(m => m.key === 'h2h');
            if (!market) continue;
            const odds = {};
            for (const outcome of market.outcomes) {
                const name = outcome.name;
                const price = outcome.price;
                if (name === match.home_team) {
                    odds.home = price;
                    if (price > bestOdds.home) bestOdds.home = price;
                } else if (name === 'Draw') {
                    odds.draw = price;
                    if (price > bestOdds.draw) bestOdds.draw = price;
                } else if (name === match.away_team) {
                    odds.away = price;
                    if (price > bestOdds.away) bestOdds.away = price;
                }
            }
            if (odds.home && odds.draw && odds.away) {
                bookmakerOddsList.push({ bookmaker: bm.title, odds });
            }
        }

        // 5. Поиск валуйных ставок
        const valueBets = findValueBets(bestOdds, consensus, 0.02);

        // 6. Поиск вилок
        const arbitrage = findArbitrage(bookmakerOddsList, 0.005);

        // 7. Ответ
        res.json({
            match: `${match.home_team} vs ${match.away_team}`,
            consensus,
            simulation: simResults,
            bestOdds,
            valueBets,
            arbitrage,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Ошибка анализа' });
    }
});

// ============================================
// 7. Запуск сервера
// ============================================
app.listen(PORT, () => {
    console.log(`✅ Сервер запущен на порту ${PORT}`);
});