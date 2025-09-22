// bot.ts — corrected and completed version
import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import { Telegraf, Markup } from "telegraf";
import { BitrixClient } from "./bitrixClient";
import { DealService, UserField } from "./dealService";
import { info, error } from "./logger";

const BOT_TOKEN = process.env.TG_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("TG_BOT_TOKEN / TELEGRAM_BOT_TOKEN is required in env");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const TOKENS_FILE = path.join(process.cwd(), "tokens.json");

// ----- session type -----
type Session = {
  step?: string;
  categories?: Array<any>;
  category?: any;
  stages?: Array<any>;
  stage?: any;
  fields?: UserField[];
  field?: UserField | null;
  fieldType?: "enum" | "string";
  enumValues?: Array<{ ID: string; VALUE?: string; NAME?: string }>;
  enumMode?: "cycle" | "single";
  chosenEnumId?: string | null;
  stringPattern?: string | null;
  maxDeals?: number | null;
  dryRun?: boolean | null;
};
const sessions = new Map<number, Session>();
function getSession(chatId: number): Session {
  if (!sessions.has(chatId)) sessions.set(chatId, {});
  return sessions.get(chatId)!;
}

function clientConfigured(): boolean {
  if (fs.existsSync(TOKENS_FILE)) return true;
  if (process.env.BITRIX_DOMAIN && process.env.BITRIX_ACCESS_TOKEN) return true;
  return false;
}

// ----- START -----
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  sessions.set(chatId, {});
  await ctx.reply(
    "Привет! Я бот-интерфейс для массовой разметки сделок (по 150).",
    Markup.keyboard([
      ["🚀 Запустить обработку"],
      ["⚙️ Установить токены (ручной)"],
      ["ℹ️ Статус"]
    ]).resize()
  );
});

// ----- STATUS -----
bot.hears(["ℹ️ Статус", "/status"], async (ctx) => {
  const chatId = ctx.chat.id;
  const s = getSession(chatId);
  const tokensPresent = clientConfigured();
  const lines = [
    `Tokens present: ${tokensPresent ? "✅" : "❌"}`,
    `Category: ${s.category?.NAME ?? "—"}`,
    `Stage: ${s.stage?.NAME ?? "—"}`,
    `Field: ${s.field?.FIELD_NAME ?? "—"}`,
    `Field type: ${s.fieldType ?? "—"}`,
  ];
  await ctx.reply(lines.join("\n"));
});

// ----- TOKENS MANUAL -----
bot.hears(["⚙️ Установить токены (ручной)", "/set_tokens"], async (ctx) => {
  const s = getSession(ctx.chat.id);
  s.step = "awaiting_tokens_domain";
  await ctx.reply("Введите domain (например yourportal.bitrix24.ru):");
});

// обработка текстовых шагов (domain, token и т.д. + вся логика выбора полей/стадий)
bot.on("text", async (ctx) => {
 const chatId = ctx.chat.id;
 const s = getSession(chatId);
 const text = (ctx.message as any).text?.trim() ?? "";


 try {
   // --- token manual flow ---
   if (s.step === "awaiting_tokens_domain") {
     (s as any).tmpDomain = text;
     s.step = "awaiting_tokens_access";
     await ctx.reply("Введите access_token:");
     return;
   }
   if (s.step === "awaiting_tokens_access") {
     (s as any).tmpAccess = text;
     s.step = "awaiting_tokens_refresh";
     await ctx.reply("Если есть refresh_token, отправьте его сейчас (или просто Enter):");
     return;
   }
   if (s.step === "awaiting_tokens_refresh") {
     const domain = (s as any).tmpDomain;
     const access = (s as any).tmpAccess;
     const refresh = text || null;
     const tokens = {
       domain,
       access_token: access,
       refresh_token: refresh,
       received_at: Date.now(),
     };
     fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), "utf-8");
     s.step = undefined;
     await ctx.reply("Токены сохранены в tokens.json ✅");
     return;
   }


   // --- awaiting field index (user types index after seeing numbered list) ---
   if (s.step === "awaiting_field_index") {
     const idx = Number(text);
     if (Number.isNaN(idx) || !s.fields || idx < 0 || idx >= s.fields.length) {
       await ctx.reply("Неверный индекс поля. Введите корректный индекс из списка.");
       return;
     }
     s.field = s.fields[idx];
     // detect type
     const ut = s.field.USER_TYPE_ID ?? s.field.TYPE;
     if (ut === "enumeration") {
       s.fieldType = "enum";
       // fetch enum values via DealService if possible
       try {
         const client = new BitrixClient(true);
         const svc = new DealService(client);
         s.enumValues = await svc.getEnumValuesForField(s.field!);
       } catch (err) {
         // fallback to field.LIST
         s.enumValues = s.field.LIST ?? [];
       }


       if (!s.enumValues || s.enumValues.length === 0) {
         await ctx.reply("Enum поле не содержит вариантов. Попробуйте другое поле или используйте строковое поле.");
         s.step = undefined;
         return;
       }


       // Ask enum mode
       s.step = "awaiting_enum_mode";
       await ctx.reply(
         "Enum поле выбрано. Выберите режим:\n1 — Циклически (каждой группе своё значение циклично)\n2 — Один вариант для всех групп\nОтправьте 1 или 2."
       );
       return;
     } else if (ut === "string") {
       // string field
       s.fieldType = "string";
       s.step = "awaiting_string_pattern";
       await ctx.reply("Введите строковый шаблон (используйте {n} как placeholder для номера группы). Пример: 'Group {n}' или просто '{n}':");
       return;
     } else {
       await ctx.reply(`Тип поля '${ut}' не поддерживается (только enumeration или string). Выберите другое.`);
       s.step = undefined;
       return;
     }
   }


   // --- enum mode choice ---
   if (s.step === "awaiting_enum_mode") {
     if (text !== "1" && text !== "2") {
       await ctx.reply("Отправьте 1 или 2.");
       return;
     }
     if (text === "1") {
       s.enumMode = "cycle";
       s.step = "awaiting_max";
       await ctx.reply("Режим: cycling. Введите максимум сделок для обработки (Enter = все):");
       return;
     } else {
       s.enumMode = "single";
       // present enum values and ask index
       const lines = s.enumValues!.map((ev, i) => `${i}: ID=${ev.ID} -> ${ev.VALUE ?? ev.NAME}`);
       await ctx.reply("Варианты enum:\n" + lines.join("\n"));
       s.step = "awaiting_enum_index";
       await ctx.reply(`Введите индекс варианта (0..${s.enumValues!.length - 1}):`);
       return;
     }
   }


   if (s.step === "awaiting_enum_index") {
     const idx = Number(text);
     if (Number.isNaN(idx) || !s.enumValues || idx < 0 || idx >= s.enumValues.length) {
       await ctx.reply("Неверный индекс enum-значения. Попробуйте снова.");
       return;
     }
     s.chosenEnumId = s.enumValues[idx].ID;
     s.step = "awaiting_max";
     await ctx.reply("Введите максимум сделок для обработки (Enter = все):");
     return;
   }


   // --- string pattern provided ---
   if (s.step === "awaiting_string_pattern") {
     s.stringPattern = text || "{n}";
     s.step = "awaiting_max";
     await ctx.reply("Введите максимум сделок для обработки (Enter = все):");
     return;
   }


   // --- max deals ---
   if (s.step === "awaiting_max") {
     s.maxDeals = text ? Number(text) : Infinity;
     if (Number.isNaN(s.maxDeals) || s.maxDeals <= 0) {
       await ctx.reply("Неверное число. Повторите.");
       return;
     }
     s.step = "awaiting_dry";
     await ctx.reply("Dry run? Отправьте yes (по умолчанию) или no:");
     return;
   }


   // --- dry run ---
   if (s.step === "awaiting_dry") {
     s.dryRun = !text ? true : String(text).toLowerCase().startsWith("y");
     s.step = "confirm_run";
     // summary
     const summary = [
       `Сводка:`,
       `Воронка: ${s.category?.NAME ?? "—"}`,
       `Стадия: ${s.stage?.NAME ?? "—"}`,
       `Поле: ${s.field?.FIELD_NAME ?? "—"}`,
       `Тип: ${s.fieldType}`,
       s.fieldType === "string" ? `Шаблон: ${s.stringPattern}` : s.enumMode === "cycle" ? `Enum: cycle (${s.enumValues!.length} values)` : `Enum single: ${s.chosenEnumId}`,
       `Max deals: ${s.maxDeals === Infinity ? "all" : s.maxDeals}`,
       `Dry run: ${s.dryRun ? "yes" : "no"}`,
     ].join("\n");
     await ctx.reply(summary);
     await ctx.reply("Подтвердить запуск? yes / no");
     return;
   }


   // --- confirmation ---
   if (s.step === "confirm_run") {
     const yes = String(text).toLowerCase().startsWith("y");
     if (!yes) {
       s.step = undefined;
       await ctx.reply("Операция отменена.");
       return;
     }


     // final run
     if (!clientConfigured()) {
       await ctx.reply("Bitrix не настроен (нет токенов). Установите токены через /set_tokens или установите приложение в Bitrix для автоматической передачи токенов в /install.");
       s.step = undefined;
       return;
     }


     await ctx.reply("Загружаю сделки (это может занять время)...");
     try {
       const client = new BitrixClient(true);
       const svc = new DealService(client);
       const filter: any = { CATEGORY_ID: Number(s.category.ID), STAGE_ID: s.stage.STATUS_ID ?? s.stage.ID };


       const deals = await svc.fetchDealsPaginated(filter, ["*", "UF_*"], { DATE_CREATE: "ASC" }, s.maxDeals ?? Infinity);
       await ctx.reply(`Найдено сделок: ${deals.length}`);
       if (deals.length === 0) {
         s.step = undefined;
         return;
       }


       let lastUpdate = 0;
       await svc.tagDealsByGroups(deals, s.field!.FIELD_NAME, {
         fieldType: s.fieldType === "string" ? "string" : "enum",
         enumValues: s.fieldType === "enum" ? (s.enumMode === "cycle" ? s.enumValues!.map(e => e.ID) : [s.chosenEnumId!]) : undefined,
         chunkSize: 150,
         dryRun: !!s.dryRun,
         stringPattern: s.stringPattern ?? "{n}",
         progressCb: async (info) => {
           const now = Date.now();
           if (now - lastUpdate < 1500) return; // throttle to ~1.5s
           lastUpdate = now;
           await ctx.reply(`Processed group ${info.groupIndex}/${info.totalGroups} — processed: ${info.processed}/${deals.length}`);
         }
       });


       await ctx.reply(`✅ Обработка завершена (dry=${s.dryRun ? "yes" : "no"}).`);
     } catch (err: any) {
       error("Processing error:", err);
       await ctx.reply(`Ошибка: ${String(err.message || err)}`);
     } finally {
       s.step = undefined;
     }
     return;
   }


   // If none of the above matched, show help or ignore
   // Do nothing special for other arbitrary text
 } catch (err: any) {
   error("Bot text handler error:", err);
   await ctx.reply("Произошла внутренняя ошибка. Смотрите логи.");
   s.step = undefined;
 }
});

// ----- RUN FLOW -----
async function startRunFlow(ctx: any) {
  const chatId = ctx.chat.id;
  const s = getSession(chatId);

  if (!clientConfigured()) {
    await ctx.reply("Bitrix не настроен. Установите токены через /set_tokens или установите локальное приложение в Bitrix.");
    return;
  }

  try {
    const client = new BitrixClient(true);
    const svc = new DealService(client);

    const cats = await svc.getCategories();
    s.categories = cats;

    if (!cats.length) {
      await ctx.reply("Воронки не найдены.");
      return;
    }

    const buttons = cats.map((c: any) => Markup.button.callback(c.NAME, `cat_${c.ID}`));
    const rows: any[][] = [];
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
    await ctx.reply("Выберите воронку:", Markup.inlineKeyboard(rows));
  } catch (err: any) {
    error(err);
    await ctx.reply("Ошибка при получении воронок: " + String(err.message || err));
  }
}

// запускаем run и через команду, и через кнопку
bot.command("run", startRunFlow);
bot.hears(["🚀 Запустить обработку"], startRunFlow);

// ----- INLINE CALLBACKS -----
bot.action(/cat_(.+)/, async (ctx) => {
  const id = ctx.match![1];
  const chatId = ctx.chat!.id;
  const s = getSession(chatId);
  if (!s.categories) return;
  const cat = s.categories.find((c: any) => String(c.ID) === String(id));
  if (!cat) {
    await ctx.answerCbQuery("Категория не найдена");
    return;
  }
  s.category = cat;
  await ctx.answerCbQuery();
  await ctx.reply(`Категория выбрана: ${cat.NAME}`);

  try {
    const client = new BitrixClient(true);
    const svc = new DealService(client);
    const stages = await svc.getStages(Number(cat.ID));
    s.stages = stages;
    if (!stages.length) {
      await ctx.reply("Стадии не найдены для этой воронки.");
      return;
    }
    const buttons = stages.map((st: any) => Markup.button.callback(st.NAME, `stage_${st.STATUS_ID}`));
    const rows: any[][] = [];
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
    await ctx.reply("Выберите стадию:", Markup.inlineKeyboard(rows));
  } catch (err: any) {
    error(err);
    await ctx.reply("Ошибка при получении стадий: " + String(err.message || err));
  }
});

bot.action(/stage_(.+)/, async (ctx) => {
  const id = ctx.match![1];
  const chatId = ctx.chat!.id;
  const s = getSession(chatId);
  if (!s.stages) return;
  const st = s.stages.find((x: any) => String(x.STATUS_ID) === String(id));
  if (!st) {
    await ctx.answerCbQuery("Стадия не найдена");
    return;
  }
  s.stage = st;
  await ctx.answerCbQuery();
  await ctx.reply(`Стадия выбрана: ${st.NAME}`);

  try {
    const client = new BitrixClient(true);
    const svc = new DealService(client);
    const fields = await svc.getDealUserFields();
    s.fields = fields.filter(f => (f.USER_TYPE_ID === "enumeration" || f.USER_TYPE_ID === "string") && f.MULTIPLE !== "Y"); // filter supported types, exclude multiple for simplicity

    if (!s.fields || s.fields.length === 0) {
      await ctx.reply("Подходящие пользовательские поля не найдены (только string/enumeration, не множественные).");
      return;
    }

    const lines = s.fields.map((f, i) => `${i}: ${f.FIELD_NAME} ${f.NAME ? "- " + f.NAME : ""} (${f.USER_TYPE_ID ?? f.TYPE ?? "?"})`);
    const CHUNK = 1800;
    let buf = "";
    for (const line of lines) {
      if (buf.length + line.length + 1 > CHUNK) {
        await ctx.reply(buf);
        buf = "";
      }
      buf += line + "\n";
    }
    if (buf.length) await ctx.reply(buf);

    s.step = "awaiting_field_index";
    await ctx.reply(`Отправьте индекс поля (0..${s.fields.length - 1}):`);
  } catch (err: any) {
    error(err);
    await ctx.reply("Ошибка при получении полей: " + String(err.message || err));
  }
});

// ----- START BOT -----
bot.launch().then(() => info("Bot launched")).catch(err => {
  console.error("Failed to launch bot:", err);
});
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));