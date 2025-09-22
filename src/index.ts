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
    // Ensure tokens exist or allow manual set
    await ensureTokensInteractive();

    const dry = ((await question("Dry run? (yes/no) [yes]:")) || "yes").toLowerCase().startsWith("y");
    const client = new BitrixClient(true);
    if (!client.isConfigured()) {
      console.error("Client still not configured. Exiting.");
      close();
      return;
    }
    const svc = new DealService(client);

    info("Fetching deal categories...");
    const categories = await svc.getCategories();
    const category = await chooseFrom(categories, (c: any) => `${c.NAME} (ID=${c.ID})`, "Выберите воронку (номер or ID):");

    info("Fetching stages...");
    const stages = await svc.getStages(Number(category.ID));
    const stage = await chooseFrom(stages, (s: any) => `${s.NAME} (STATUS_ID=${s.STATUS_ID})`, "Выберите стадию:");

    info("Fetching user fields...");
    const ufs = await svc.getDealUserFields();
    // split into enum and string candidates
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
    const typeChoice = (await question("Work with enum or string field? [enum]:")) || "enum";
    if (typeChoice.trim().toLowerCase() === "string") {
      fieldType = "string";
      if (stringFields.length === 0) {
        const manual = (await question("No string fields found. Enter FIELD_NAME (UF_CRM_...):")).trim();
        field = { ID: manual, FIELD_NAME: manual } as UserField;
      } else {
        field = await chooseFrom(stringFields, (f: any) => `${f.FIELD_NAME} / ${f.NAME ?? f.ID}`, "Выберите строковое поле:");
      }
    } else {
      if (enumFields.length === 0) {
        info("No enum fields found, switching to string");
        fieldType = "string";
        field = await chooseFrom(stringFields, (f: any) => `${f.FIELD_NAME} / ${f.NAME ?? f.ID}`, "Выберите строковое поле:");
      } else {
        field = await chooseFrom(enumFields, (f: any) => `${f.FIELD_NAME} / ${f.NAME ?? f.ID}`, "Выберите enum поле:");
      }
    }

    let enumValues: Array<{ ID: string; VALUE?: string; NAME?: string }> = [];
    if (fieldType === "enum") {
      enumValues = await svc.getEnumValuesForField(field);
      if (!enumValues.length) {
        info("Enum field has no values. Exiting.");
        close();
        return;
      }
      enumValues.forEach((v, i) => info(`${i}: ID=${v.ID} => ${v.VALUE ?? v.NAME}`));
    }

    const maxInput = await question("Max deals to process (Enter = all): ");
    const max = maxInput ? Number(maxInput) : Infinity;

    info("Fetching deals...");
    const filter: any = { CATEGORY_ID: Number(category.ID), STAGE_ID: stage.STATUS_ID };
    const deals = await svc.fetchDealsPaginated(filter, ["*", "UF_*"], { DATE_CREATE: "ASC" }, max);
    info(`Found deals: ${deals.length}`);
    if (!deals.length) {
      info("No deals found.");
      close();
      return;
    }

    const confirm = (await question(`Proceed to mark ${deals.length} deals? (yes/no) [no]:`)).toLowerCase();
    if (!["y","yes"].includes(confirm)) {
      info("Aborted by user.");
      close();
      return;
    }

    await svc.tagDealsByGroups(deals, field.FIELD_NAME, {
      fieldType: fieldType === "enum" ? "enum" : "string",
      enumValues: enumValues.map(ev => ev.ID),
      chunkSize: 150,
      dryRun: dry
    });

    info("Done.");
    close();
  } catch (err) {
    console.error("Error:", err);
    try { close(); } catch {}
  }
}

main();
