// ИИ-функции тренажёра: консультант, разбор наряда, проверка фото, персональный план.
// Работает на Vercel как serverless-функция. Ключ Claude API берётся из переменной ANTHROPIC_API_KEY.
import Anthropic from "@anthropic-ai/sdk";
import { KB } from "./_kb.js";

const MODEL = "claude-opus-5-5";
const MAX_TEXT = 4000;      // символов в одном поле
const MAX_TURNS = 12;       // реплик в истории чата
const MAX_IMAGE = 3_000_000; // символов base64 (~2,2 МБ)
const RATE = { win: 10 * 60_000, max: 40 };
const hits = new Map();

const BASE = `Ты ИИ-инструктор учебного тренажёра VSAT компании YCCU. Обучаешь монтажников установке и настройке терминала Gilat SkyEdge II с антенной Prodelin 1122 (1,2 м, Ku) и работе с ЦУС.
Правила:
- Отвечай по-русски, коротко и по делу, обычным текстом без Markdown-таблиц. Списки можно через «- ».
- Опирайся на материалы курса ниже. Ссылайся на модуль или пункт порядка работ, откуда взято правило.
- Если в материалах ответа нет, скажи об этом прямо и посоветуй уточнить у ЦУС или инструктора. Ничего не выдумывай: моменты затяжки, частоты, пороги и пароли называй только если они есть в материалах.
- Где нормы расходятся, приоритет у российских (ПУЭ, ГОСТ).
- Никогда не советуй включать передачу (CW) без разрешения ЦУС и двигать антенну при включённой передаче.
- Тренажёр учебный; числовые параметры модели сигнала условные и калибруются с ЦУС.

<материалы_курса>
${KB}
</материалы_курса>`;

const TASKS = {
  chat: { effort: "low", note: "Режим: консультант. Ученик задаёт вопросы по теории и практике." },
  debrief: { effort: "low", note: `Режим: разбор наряда. Тебе дают журнал действий ученика в практике и итог. Ответ строго в три коротких раздела:
Что сделано верно
Ошибки и почему они опасны на реальном объекте
Что повторить (модуль теории или пункт порядка работ)
Не больше 180 слов. Если ошибок нет, похвали коротко и назови один риск, о котором стоит помнить на объекте.` },
  plan: { effort: "low", note: `Режим: персональный план. Тебе дают результаты тестов по модулям и зачёты практик. Составь план из 3–5 шагов: что повторить, какие практики пройти в каком порядке, готов ли ученик к экзамену (тест ≥80% и все шесть практик в режиме «Экзамен»). Не больше 150 слов.` },
  photo: { effort: "medium", note: `Режим: проверка монтажа по фото. Оцени фото по чек-листу из материалов курса для указанного узла. Формат:
Что видно на фото (1–2 строки)
Соответствует (пункты)
Вызывает сомнение или нарушено (пункты, с пояснением риска)
Что сфотографировать дополнительно
В конце одной строкой: это предварительная оценка по фото, окончательную приёмку делает ЦУС или инструктор. Если на фото не узел VSAT, скажи об этом и ничего не оценивай.` },
};

const KINDS = {
  antenna: "антенна, опора и крепёж",
  cable: "разделка кабеля и F-разъём",
  ground: "заземление и питание",
  modem: "индикаторы и экран модема",
};

const clip = (s, n = MAX_TEXT) => String(s ?? "").slice(0, n);

function limited(ip) {
  const now = Date.now();
  const h = (hits.get(ip) || []).filter((t) => now - t < RATE.win);
  h.push(now);
  hits.set(ip, h);
  return h.length > RATE.max;
}

function buildMessages(task, b) {
  if (task === "chat") {
    const hist = Array.isArray(b.messages) ? b.messages.slice(-MAX_TURNS) : [];
    const msgs = hist
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
      .map((m) => ({ role: m.role, content: clip(m.content) }));
    while (msgs.length && msgs[0].role !== "user") msgs.shift();
    return msgs.length && msgs.at(-1).role === "user" ? msgs : null;
  }
  if (task === "debrief") {
    const log = (Array.isArray(b.log) ? b.log : []).slice(0, 80).map((x) => "- " + clip(x, 300)).join("\n");
    const steps = (Array.isArray(b.steps) ? b.steps : []).slice(0, 30).map((x) => "- " + clip(x, 200)).join("\n");
    return [{ role: "user", content:
`Практика: ${clip(b.practice, 100)}
Режим: ${b.exam ? "экзамен" : "обучение"}
Итог: ${b.pass ? "зачёт" : "незачёт"}
Итоговая таблица и замечания тренажёра:
${clip(b.result)}
Выполненные пункты порядка работ:
${steps || "(нет данных)"}
Журнал (сначала последние события):
${log || "(пусто)"}` }];
  }
  if (task === "plan") {
    return [{ role: "user", content: `Результаты ученика (JSON):\n${clip(JSON.stringify(b.progress ?? {}), 3000)}` }];
  }
  if (task === "photo") {
    const mt = ["image/jpeg", "image/png", "image/webp"].includes(b.media_type) ? b.media_type : null;
    const data = typeof b.image === "string" ? b.image : "";
    if (!mt || !data || data.length > MAX_IMAGE) return null;
    return [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: mt, data } },
      { type: "text", text: `Узел на фото: ${KINDS[b.kind] || "не указан"}.${b.comment ? " Комментарий монтажника: " + clip(b.comment, 500) : ""}` },
    ] }];
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Только POST" });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "ИИ-функции не подключены: администратору нужно задать ключ ANTHROPIC_API_KEY в настройках Vercel." });
  }
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "local";
  if (limited(ip)) return res.status(429).json({ error: "Слишком много запросов. Подождите несколько минут." });

  const b = req.body && typeof req.body === "object" ? req.body : {};
  const t = TASKS[b.task];
  const messages = t && buildMessages(b.task, b);
  if (!messages) return res.status(400).json({ error: "Некорректный запрос." });

  const client = new Anthropic();
  try {
    const r = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: t.effort },
      system: [
        { type: "text", text: BASE, cache_control: { type: "ephemeral" } },
        { type: "text", text: t.note },
      ],
      messages,
    });
    if (r.stop_reason === "refusal") {
      return res.status(200).json({ text: "ИИ-инструктор не может ответить на этот запрос. Переформулируйте вопрос по теме монтажа VSAT." });
    }
    const text = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
    return res.status(200).json({ text: text || "Пустой ответ. Попробуйте ещё раз." });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return res.status(429).json({ error: "ИИ перегружен, повторите через минуту." });
    if (e instanceof Anthropic.AuthenticationError) return res.status(503).json({ error: "Неверный ключ ANTHROPIC_API_KEY." });
    if (e instanceof Anthropic.APIError) return res.status(502).json({ error: "Ошибка сервиса ИИ (" + (e.status ?? "сеть") + ")." });
    console.error(e);
    return res.status(500).json({ error: "Внутренняя ошибка." });
  }
}
