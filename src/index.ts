import { BitrixClient } from "./bitrixClient";
import { DealService, UserField } from "./dealService";
import { chooseFrom, question, close } from "./cli";
import { info } from "./logger";

async function main() {
  try {
    const dryRunInput = (await question("Dry run mode? (yes/no): ")).toLowerCase();
    const dryRun = dryRunInput === "yes" || dryRunInput === "y";

    const client = new BitrixClient();
    const svc = new DealService(client);

    info("Получаем воронки...");
    const categories = await svc.getCategories();
    const category = await chooseFrom(categories, (c: any) => `${c.NAME} (ID=${c.ID})`);

    info("Получаем стадии...");
    const stages = await svc.getStages(Number(category.ID));
    const stage = await chooseFrom(stages, (s: any) => `${s.NAME} (STATUS_ID=${s.STATUS_ID})`);

    info("Получаем пользовательские поля сделок...");
    const fields = await svc.getDealUserFields();

    const field = await chooseFrom(fields, (f: any) => `${f.FIELD_NAME} (${f.USER_TYPE_ID})`);

    let chosenValue: string | number = "";

    if (field.USER_TYPE_ID === "enumeration") {
      const enumValues = await svc.getEnumValuesForField(field);
      enumValues.forEach((v, i) => info(`${i}: ID=${v.ID} => ${v.VALUE}`));

      const idxStr = await question(`Введите индекс варианта (0..${enumValues.length - 1}): `);
      const idx = Number(idxStr);
      chosenValue = enumValues[idx].ID;
    } else {
      chosenValue = await question("Введите строковое значение: ");
    }

    const maxInput = await question("Максимум сделок для изменения (Enter = все): ");
    const max = maxInput ? Number(maxInput) : Infinity;

    info("Загружаем сделки...");
    const filter: any = { CATEGORY_ID: Number(category.ID), STAGE_ID: stage.STATUS_ID };
    const deals = await svc.fetchDealsPaginated(filter, ["*","UF_*"], { DATE_CREATE: "ASC" }, max);
    info(`Найдено сделок: ${deals.length}`);

    const chunkSize = 150;
    for (let i = 0; i < deals.length; i += chunkSize) {
      const subset = deals.slice(i, i + chunkSize);
      const ids = subset.map((d) => Number(d.ID));
      await svc.updateDealsByIds(field, chosenValue, ids, dryRun);
      info(`Блок ${i / chunkSize + 1} обработан`);
    }

    info("Обработка завершена.");
    close();
  } catch (err) {
    console.error("Ошибка:", err);
    close();
  }
}

main();
