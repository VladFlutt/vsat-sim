// Собирает базу знаний ИИ-инструктора (api/_kb.js) из теории и порядков работ index.html.
// Запуск: node scripts/build-kb.cjs   (нужен Playwright с Chromium)
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

(async () => {
  const root = path.resolve(__dirname, "..");
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto("file://" + path.join(root, "index.html"));
  await p.click('button[data-tab="th"]');
  const n = await p.$$eval("#th-list a", (a) => a.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    await p.click(`#th-list li:nth-child(${i + 1}) a`);
    const t = await p.$eval("#th-body", (el) => el.querySelector("h2").innerText + "\n" + el.querySelector(".thtext").innerText);
    out.push("## Модуль " + (i + 1) + ". " + t.trim());
  }
  const tabs = [["p3", "П3. Сборка антенны", "p3-steps"], ["p4", "П4. Разделка кабеля и F-разъём", "p4-steps"],
    ["p5", "П5. Заземление и питание", "p5-steps"], ["p6", "П1 + П6. Расчёт и грубое наведение", "p6-steps"],
    ["p8", "П8 + П9. Точная настройка и поляризация с ЦУС", "steps"]];
  for (const [t, name, sid] of tabs) {
    await p.click(`button[data-tab="${t}"]`);
    const s = await p.$eval("#" + sid, (el) => el.innerText).catch(() => "");
    out.push("## Порядок работ в практике " + name + "\n" + s.trim());
  }
  await b.close();
  fs.writeFileSync(path.join(root, "api/_kb.js"),
    "// Сгенерировано из теории и порядков работ тренажёра (index.html). Не редактировать вручную.\nexport const KB = " +
    JSON.stringify(out.join("\n\n")) + ";\n");
})();
