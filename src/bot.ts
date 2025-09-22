import { Telegraf, Markup } from "telegraf";
import dotenv from "dotenv";
import { BitrixClient } from "./bitrixClient";
import { DealService, UserField } from "./dealService";
import { info, warn, error } from "./logger";
import fs from "fs";
import path from "path";

dotenv.config();

const BOT_TOKEN = process.env.TG_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("TG_BOT_TOKEN is not set in env");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// session store in memory per chat id
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
  useEnumMode?: "cycle" | "single";
  chosenEnumId?: string | null;
  stringPattern?: string | null;
  maxDeals?: number | null;
  dryRun?: boolean | null;
};
const sessions = new Map<number, Session>();

const TOKENS_FILE = path.join(process.cwd(), "tokens.json");

function getSession(ctx: any): Session {
  const id = ctx.chat.id;
  if (!sessions.has(id)) sessions.set(id, {});
  return sessions.get(id)!;
}

// Helpers
async function createClientIfConfigured(): Promise<BitrixClient> {
  const client = new BitrixClient(true);
  if (!client.isConfigured()) throw new Error("Bitrix tokens not found. Use /set_tokens or install the app in Bitrix.");
  return client;
}

// start
bot.start(async (ctx) => {
  sessions.set(ctx.chat.id, {});
  await ctx.reply("Привет! Я бот-интерфейс для массовой разметки сделок (по 150).", Markup.keyboard([
    ["🚀 Запустить обработку сделок"],
    ["⚙️ Установить токены (ручной)"],
    ["ℹ️ Статус"],
  ]).resize());
});

// status
bot.hears(["ℹ️ Статус", "/status"], async (ctx) => {
  const session = getSession(ctx);
  const tokensExist = fs.existsSync(TOKENS_FILE);
  const parts = [
    `Tokens present: ${tokensExist ? "✅" : "❌"}`,
    `Selected category: ${session.category?.NAME ?? "—"}`,
    `Selected stage: ${session.stage?.NAME ?? "—"}`,
    `Selected field: ${session.field?.FIELD_NAME ?? "—"}`,
    `Field type: ${session.fieldType ?? "—"}`,
  ];
  await ctx.reply(parts.join("\n"));
});

// set tokens manual
bot.hears(["⚙️ Установить токены (ручной)", "/set_tokens"], async (ctx) => {
  const chatId = ctx.chat.id;
  const session = getSession(ctx);
  session.step = "awaiting_tokens_domain";
  await ctx.reply("Введите domain (например yourportal.bitrix24.ru):");
});

// token entry flow
bot.on("text", async (ctx) => {
  const session = getSession(ctx);
  const text = (ctx.message && (ctx.message as any).text) || "";

  try {
    // token manual flow
    if (session.step === "awaiting_tokens_domain") {
      session.step = "awaiting_tokens_access";
      session as any; // eslint
      (session as any).tmpDomain = text.trim();
      await ctx.reply("Введите access_token:");
      return;
    }
    if (session.step === "awaiting_tokens_access") {
      const domain = (session as any).tmpDomain;
      const access = text.trim();
      session.step = undefined;
      // optional: ask for refresh
      await ctx.reply("Если есть refresh_token, введите его сейчас (или отправьте пустое сообщение Enter):");
      session.step = "awaiting_tokens_refresh";
      (session as any).tmpAccess = access;
      return;
    }
    if (session.step === "awaiting_tokens_refresh") {
      const domain = (session as any).tmpDomain;
      const access = (session as any).tmpAccess;
      const refresh = text.trim() || null;
      const tokens = {
        domain,
        access_token: access,
        refresh_token: refresh,
        received_at: Date.now()
      };
      fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), "utf-8");
      session.step = undefined;
      await ctx.reply("Токены сохранены в tokens.json ✅");
      return;
    }

    // field index flow (when we sent numbered list and asked to reply with index)
    if (session.step === "awaiting_field_index") {
      const idx = Number(text.trim());
      if (Number.isNaN(idx) || !session.fields || idx < 0 || idx >= session.fields.length) {
        await ctx.reply("Неверный индекс поля. Введите корректный индекс из списка.");
        return;
      }
      session.field = session.fields[idx];
      // determine type
      const ut = (session.field as any).USER_TYPE_ID ?? (session.field as any).TYPE;
      if (ut === "enumeration" || ((session.field as any).LIST && Array.isArray((session.field as any).LIST) && (session.field as any).LIST.length > 0)) {
        session.fieldType = "enum";
        // fetch enum values
        try {
          const clientTmp = await createClientIfConfigured();
          const svcTmp = new DealService(clientTmp);
          const enums = await svcTmp.getEnumValuesForField(session.field!);
          session.enumValues = enums;
        } catch (err) {
          session.enumValues = (session.field as any).LIST ?? [];
        }

        if (!session.enumValues || session.enumValues.length === 0) {
          await ctx.reply("Поле enum не содержит вариантов. Выберите другое поле или используйте строковое поле.");
          session.step = undefined;
          return;
        }

        // ask mode: cycle or single value
        session.step = "awaiting_enum_mode";
        await ctx.reply("Выберите режим для enum поля:\n1 — Циклически использовать варианты (рекомендовано)\n2 — Выбрать один вариант для всех групп\nОтправьте 1 или 2.");
        return;
      } else {
        // string field
        session.fieldType = "string";
        session.step = "awaiting_string_pattern";
        await ctx.reply("Введите строковый шаблон для групп. Используйте {n} как placeholder для номера группы.\nПример: 'Group {n}' или просто '{n}' (по умолчанию).");
        return;
      }
    }

    if (session.step === "awaiting_enum_mode") {
      const v = text.trim();
      if (v !== "1" && v !== "2") {
        await ctx.reply("Отправьте 1 или 2.");
        return;
      }
      if (v === "1") {
        session.useEnumMode = "cycle";
        session.step = "awaiting_max";
        await ctx.reply("Режим: циклический. Введите максимум сделок для обработки (Enter = все):");
        return;
      } else {
        session.useEnumMode = "single";
        // present enum values numbered for selection
        const lines = session.enumValues!.map((ev, i) => `${i}: ID=${ev.ID} -> ${ev.VALUE ?? ev.NAME}`);
        await ctx.reply("Варианты enum:\n" + lines.join("\n"));
        session.step = "awaiting_enum_index";
        await ctx.reply(`Введите индекс варианта (0..${session.enumValues!.length - 1}):`);
        return;
      }
    }

    if (session.step === "awaiting_enum_index") {
      const idx = Number(text.trim());
      if (Number.isNaN(idx) || !session.enumValues || idx < 0 || idx >= session.enumValues.length) {
        await ctx.reply("Неверный индекс. Попробуйте снова.");
        return;
      }
      session.chosenEnumId = session.enumValues[idx].ID;
      session.step = "awaiting_max";
      await ctx.reply("Введите максимум сделок для обработки (Enter = все):");
      return;
    }

    if (session.step === "awaiting_string_pattern") {
      const pattern = text.trim() || "{n}";
      session.stringPattern = pattern;
      session.step = "awaiting_max";
      await ctx.reply("Введите максимум сделок для обработки (Enter = все):");
      return;
    }

    if (session.step === "awaiting_max") {
      const max = text.trim() ? Number(text.trim()) : Infinity;
      session.maxDeals = max;
      session.step = "awaiting_dry";
      await ctx.reply("Dry run? Отправьте yes (по умолчанию) или no:");
      return;
    }

    if (session.step === "awaiting_dry") {
      const dry = !text.trim() ? true : (String(text.trim()).toLowerCase().startsWith("y"));
      session.dryRun = dry;
      session.step = "confirm_run";
      // show summary
      const summary = [
        `Сводка перед запуском:`,
        `Воронка: ${session.category?.NAME ?? "—"}`,
        `Стадия: ${session.stage?.NAME ?? "—"}`,
        `Поле: ${session.field?.FIELD_NAME ?? "—"}`,
        `Тип поля: ${session.fieldType}`,
        session.fieldType === "string" ? `Шаблон: ${session.stringPattern}` : session.useEnumMode === "cycle" ? `Enum: cycling ${session.enumValues!.length} values` : `Enum: single ID=${session.chosenEnumId}`,
        `Max deals: ${session.maxDeals === Infinity ? "all" : session.maxDeals}`,
        `Dry run: ${session.dryRun ? "yes" : "no"}`
      ].join("\n");
      await ctx.reply(summary);
      await ctx.reply("Подтвердить запуск? Отправьте 'yes' или 'no'.");
      return;
    }

    if (session.step === "confirm_run") {
      const yes = String(text.trim()).toLowerCase().startsWith("y");
      if (!yes) {
        session.step = undefined;
        await ctx.reply("Операция отменена.");
        return;
      }
      // proceed to run: must have client configured
      try {
        const client = new BitrixClient(true);
        if (!client.isConfigured()) {
          await ctx.reply("Bitrix не настроен (нет токенов). Установите токены через /set_tokens или установите локальное приложение в Bitrix.");
          session.step = undefined;
          return;
        }
        const svc = new DealService(client);
        // fetch deals with filter
        const filter: any = { CATEGORY_ID: Number(session.category.ID), STAGE_ID: session.stage.STATUS_ID ?? session.stage.ID };
        await ctx.reply("Загружаем сделки (это может занять время)...");
        const deals = await svc.fetchDealsPaginated(filter, ["*", "UF_*"], { DATE_CREATE: "ASC" }, session.maxDeals ?? Infinity);
        await ctx.reply(`Найдено сделок: ${deals.length}`);
        if (!deals.length) {
          session.step = undefined;
          return;
        }

        // progress callback sends messages after each group
        let lastGroupTime = Date.now();
        await svc.tagDealsByGroups(deals, session.field!.FIELD_NAME, {
          fieldType: session.fieldType === "string" ? "string" : "enum",
          enumValues: session.fieldType === "enum" ? (session.useEnumMode === "cycle" ? session.enumValues!.map(ev => ev.ID) : [session.chosenEnumId!]) : undefined,
          chunkSize: 150,
          dryRun: !!session.dryRun,
          stringPattern: session.stringPattern ?? "{n}",
          progressCb: async (info) => {
            // throttle updates to not spam the chat too often
            const now = Date.now();
            if (now - lastGroupTime < 2000) return;
            lastGroupTime = now;
            await ctx.reply(`Группа ${info.groupIndex}/${info.totalGroups} обработана — обработано ${info.processed} из ${deals.length}`);
          }
        });

        await ctx.reply(`✅ Обработка завершена. (dry=${session.dryRun ? "yes" : "no"})`);
        session.step = undefined;
        return;
      } catch (err: any) {
        error("Processing error:", err);
        await ctx.reply(`Ошибка при обработке: ${String(err.message || err)}`);
        session.step = undefined;
        return;
      }
    }

    // If no session step matched: ignore or help
  } catch (err: any) {
    console.error("Bot handler error:", err);
    await ctx.reply("Произошла внутренняя ошибка. Смотрите логи.");
  }
});

// Run flow start via button
bot.hears(["🚀 Запустить обработку сделок", "/run"], async (ctx) => {
  const session = getSession(ctx);
  // Ensure client configured
  const client = new BitrixClient(true);
  if (!client.isConfigured()) {
    await ctx.reply("Bitrix не настроен. Установите токены через /set_tokens или используйте /install (при установке в Bitrix).");
    return;
  }
  const svc = new DealService(client);
  // fetch categories
  const cats = await svc.getCategories();
  session.categories = cats;
  if (!cats.length) {
    await ctx.reply("Воронки не найдены.");
    return;
  }
  // build inline keyboard
  const buttons = cats.map(c => Markup.button.callback(c.NAME, `cat_${c.ID}`));
  // chunk into rows of 2
  const rows: any[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  await ctx.reply("Выберите воронку:", Markup.inlineKeyboard(rows));
});

// callback handlers for category & stage selection
bot.action(/cat_(.+)/, async (ctx) => {
  const id = ctx.match[1];
  const session = getSession(ctx);
  const client = new BitrixClient(true);
  const svc = new DealService(client);
  const category = session.categories?.find((c: any) => String(c.ID) === String(id));
  session.category = category;
  // fetch stages
  const stages = await svc.getStages(Number(category.ID));
  session.stages = stages;
  if (!stages.length) {
    await ctx.reply("Стадии не найдены для этой воронки.");
    return;
  }
  const buttons = stages.map(s => Markup.button.callback(s.NAME, `stage_${s.STATUS_ID}`));
  const rows: any[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  await ctx.answerCbQuery();
  await ctx.reply(`Выбрана воронка: ${category.NAME}\nВыберите стадию:`, Markup.inlineKeyboard(rows));
});

bot.action(/stage_(.+)/, async (ctx) => {
  const id = ctx.match[1];
  const session = getSession(ctx);
  const client = new BitrixClient(true);
  const svc = new DealService(client);
  const stage = session.stages?.find((s: any) => String(s.STATUS_ID) === String(id));
  session.stage = stage;
  // fetch fields
  const fields = await svc.getDealUserFields();
  session.fields = fields;
  // present numbered list and ask for index
  const lines = fields.map((f, i) => `${i}: ${f.FIELD_NAME} (${f.USER_TYPE_ID ?? f.TYPE ?? "?"}) ${f.NAME ? "- " + f.NAME : ""}`);
  const preview = lines.slice(0, 200).join("\n"); // but send full list
  await ctx.answerCbQuery();
  await ctx.reply("Выберите поле (отправьте индекс поля):\n" + lines.join("\n"));
  session.step = "awaiting_field_index";
});

bot.launch().then(() => info("Telegram bot launched"));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
