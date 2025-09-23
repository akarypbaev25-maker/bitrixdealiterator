import dotenv from "dotenv";
dotenv.config();

import { BitrixClient } from "./bitrixClient";
import { DealService, UserField } from "./dealService";
import { chooseFrom, question, close } from "./cli";
import { info } from "./logger";
import fs from "fs";
import path from "path";

const TOKENS_FILE = path.join(process.cwd(), "tokens.json");

async function ensureTokensInteractive() {
  // If tokens.json exists, nothing to do
  if (fs.existsSync(TOKENS_FILE)) return;
  console.log("Tokens not found (tokens.json). You can either:");
  console.log("  1) Install the app in Bitrix (Bitrix will call /install on your deployed URL).");
  console.log("  2) Paste access_token and domain manually.");
  const choice = (await question("Выберите 1 или 2 (manual):")) || "2";
  if (String(choice).trim() === "1") {
    console.log("Ок. Разверните приложение и установите локальное приложение в Bitrix (Install URL → /install).");
    return;
  }
  const domain = (await question("Введите domain (например yourportal.bitrix24.ru):")).trim();
  const access = (await question("Введите access_token:")).trim();
  const refresh = (await question("Введите refresh_token (или Enter):")).trim() || undefined;
  const tokens = {
    domain,
    access_token: access,
    refresh_token: refresh ?? null,
    expires_in: null,
    received_at: Date.now()
  };
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), "utf-8");
  console.log("tokens.json записан. Продолжаем.");
}

async function main() {
  try {
    // Проверяем токены или даём ввести вручную
    await ensureTokensInteractive();

    const dry = ((await question("Запускать в режиме теста (без сохранения)? (да/нет) [да]:")) || "да")
      .toLowerCase()
      .startsWith("д");
    const client = new BitrixClient(true);
    if (!client.isConfigured()) {
      console.error("Клиент не настроен. Завершение.");
      close();
      return;
    }
    const svc = new DealService(client);

    info("Загружаем список воронок...");
    const categories = await svc.getCategories();
    const category = await chooseFrom(categories, (c: any) => `${c.NAME} (ID=${c.ID})`, "Выберите воронку (номер или ID):");

    info("Загружаем стадии...");
    const stages = await svc.getStages(Number(category.ID));

    // Показать список стадий с индексами
    stages.forEach((s: any, i: number) => {
      console.log(`${i}: ${s.NAME} (STATUS_ID=${s.STATUS_ID})`);
    });

    // Позволяем выбрать несколько индексов или ID через запятую
    const stageInput = (await question("Введите номера стадий или STATUS_ID через запятую:")).trim();
    const selectedStages: any[] = [];

    stageInput.split(",").map(v => v.trim()).forEach(sel => {
      // Если число → считаем индексом
      if (/^\d+$/.test(sel)) {
        const idx = Number(sel);
        if (stages[idx]) selectedStages.push(stages[idx]);
      } else {
        // Иначе ищем по STATUS_ID
        const found = stages.find((s: any) => s.STATUS_ID === sel);
        if (found) selectedStages.push(found);
      }
    });

    if (!selectedStages.length) {
      console.error("Не выбрано ни одной стадии. Завершение.");
      close();
      return;
    }

    info("Загружаем пользовательские поля сделок...");
    const ufs = await svc.getDealUserFields();
    const enumFields = ufs.filter(f => {
      const ut = (f as any).USER_TYPE_ID ?? (f as any).TYPE;
      return ut === "enumeration" || (f.LIST && Array.isArray(f.LIST) && f.LIST.length > 0);
    });
    const stringFields = ufs.filter(f => {
      const ut = (f as any).USER_TYPE_ID ?? (f as any).TYPE;
      return ut === "string" || ut === "text" || (!ut && String(f.FIELD_NAME).startsWith("UF_"));
    });

    let field: UserField;
    let fieldType: "enum" | "string" = "enum";
    const typeChoice = (await question("Работать с enum или строковым полем? [enum]:")) || "enum";
    if (typeChoice.trim().toLowerCase() === "string") {
      fieldType = "string";
      if (stringFields.length === 0) {
        const manual = (await question("Строковых полей не найдено. Введите FIELD_NAME (UF_CRM_...):")).trim();
        field = { ID: manual, FIELD_NAME: manual } as UserField;
      } else {
        field = await chooseFrom(stringFields, (f: any) => `${f.FIELD_NAME} / ${f.NAME ?? f.ID}`, "Выберите строковое поле:");
      }
    } else {
      if (enumFields.length === 0) {
        info("Enum-поля не найдены, переключаемся на строковые");
        fieldType = "string";
        field = await chooseFrom(stringFields, (f: any) => `${f.FIELD_NAME} / ${f.NAME ?? f.ID}`, "Выберите строковое поле:");
      } else {
        field = await chooseFrom(enumFields, (f: any) => `${f.FIELD_NAME} / ${f.NAME ?? f.ID}`, "Выберите enum-поле:");
      }
    }

    let enumValues: Array<{ ID: string; VALUE?: string; NAME?: string }> = [];
    if (fieldType === "enum") {
      enumValues = await svc.getEnumValuesForField(field);
      if (!enumValues.length) {
        info("Enum-поле не содержит значений. Завершение.");
        close();
        return;
      }
      enumValues.forEach((v, i) => info(`${i}: ID=${v.ID} => ${v.VALUE ?? v.NAME}`));
    }

    const maxInput = await question("Максимальное количество сделок для обработки (Enter = все): ");
    const max = maxInput ? Number(maxInput) : Infinity;

    info("Загружаем сделки...");
    const filter: any = { CATEGORY_ID: Number(category.ID), STAGE_ID: selectedStages.map(s => s.STATUS_ID) };
    const deals = await svc.fetchDealsPaginated(filter, ["*", "UF_*"], { DATE_CREATE: "ASC" }, max);
    info(`Найдено сделок: ${deals.length}`);
    if (!deals.length) {
      info("Сделок не найдено.");
      close();
      return;
    }

    const confirm = (await question(`Перейти к обработке ${deals.length} сделок? (да/нет) [нет]:`)).toLowerCase();
    if (!["д","да","yes","y"].includes(confirm)) {
      info("Операция отменена пользователем.");
      close();
      return;
    }

    await svc.tagDealsByGroups(deals, field.FIELD_NAME, {
      fieldType: fieldType === "enum" ? "enum" : "string",
      enumValues: enumValues.map(ev => ev.ID),
      chunkSize: 150,
      dryRun: dry
    });

    info("Готово.");
    close();
  } catch (err) {
    console.error("Ошибка:", err);
    try { close(); } catch {}
  }
}


main();
