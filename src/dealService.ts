import { BitrixClient, BitrixResponse } from "./bitrixClient";
import { info, warn } from "./logger";

export type UserField = {
  ID: string;
  FIELD_NAME: string;
  USER_TYPE_ID?: string;
  TYPE?: string;
  MULTIPLE?: "Y" | "N" | boolean;
  LIST?: Array<{ ID: string; VALUE?: string; NAME?: string }>;
  NAME?: string;
};

export class DealService {
  constructor(private client: BitrixClient) {}

  async getCategories() {
    const res = await this.client.call<Array<{ ID: number; NAME: string }>>("crm.dealcategory.list");
    return res.result ?? [];
  }

  async getStages(categoryId: number) {
    const res = await this.client.call<Array<{ STATUS_ID: string; NAME: string }>>("crm.dealcategory.stage.list", { id: categoryId });
    return res.result ?? [];
  }

  async getDealUserFields(): Promise<UserField[]> {
    const res = await this.client.call<UserField[]>("crm.deal.userfield.list", {});
    return res.result ?? [];
  }

  async getEnumValuesForField(field: UserField) {
    if (field.LIST && Array.isArray(field.LIST) && field.LIST.length) return field.LIST;
    try {
      const res = await this.client.call<Array<{ ID: string; VALUE?: string; NAME?: string }>>(
        "crm.userfield.enumeration.fields",
        { FIELD_NAME: field.FIELD_NAME, FIELD_ID: field.ID }
      );
      return res.result ?? [];
    } catch (e) {
      warn("Failed to fetch enum values via crm.userfield.enumeration.fields", e);
      return [];
    }
  }

  async fetchDealsPaginated(
    filter: Record<string, any>,
    select: string[] = ["*", "UF_*"],
    order: Record<string, any> = { DATE_CREATE: "ASC" },
    max: number = Infinity
  ): Promise<any[]> {
    const all: any[] = [];
    let start = 0;
    while (true) {
      const params: any = { filter, select, order, start };
      const res = await this.client.call<any[]>("crm.deal.list", params);
      const items = res.result ?? [];
      if (!items || items.length === 0) break;
      all.push(...items);
      if (all.length >= max) break;
      if (typeof res.next === "number") start = res.next; else break;
    }
    return all.slice(0, max);
  }

  async getDeal(dealId: number) {
    const res = await this.client.call<any>("crm.deal.get", { id: dealId, select: ["*", "UF_*"] });
    return res.result;
  }

  async updateDealSingle(dealId: number, fieldName: string, value: any, dryRun = false): Promise<{ success: boolean; returned?: any }> {
    if (dryRun) {
      info(`Dry run: deal ${dealId} => ${fieldName} = ${JSON.stringify(value)}`);
      return { success: true };
    }
    const payload = { id: dealId, fields: { [fieldName]: value }, params: { REGISTER_SONET_EVENT: "N" } };
    const res = await this.client.call<boolean>("crm.deal.update", payload);
    return { success: !!res.result, returned: res };
  }

  async updateDealsByIds(fieldName: string, value: string | number, dealIds: number[], dryRun = false): Promise<void> {
    const batchSize = 50;
    const isMultiple = false; // if you want dynamic detection — pass metadata separately
    for (let i = 0; i < dealIds.length; i += batchSize) {
      const slice = dealIds.slice(i, i + batchSize);
      const cmd: Record<string, string> = {};
      slice.forEach((id, idx) => {
        const key = `u_${i + idx}`;
        const valForQuery = isMultiple ? JSON.stringify([value]) : String(value);
        // Build cmd: crm.deal.update?ID=123&FIELDS[UF_FIELD]=value
        cmd[key] = `crm.deal.update?ID=${encodeURIComponent(String(id))}&FIELDS[${encodeURIComponent(fieldName)}]=${encodeURIComponent(valForQuery)}`;
      });

      if (dryRun) {
        info(`Dry run: Batch ${i + 1}-${i + slice.length} -> ${fieldName}=${value}`);
        continue;
      }

      const res = await this.client.batch(cmd);
      if (res && res.result) {
        for (const [k, sub] of Object.entries(res.result)) {
          const subRes: any = sub;
          if (!(subRes && (subRes.result === true || subRes.result === "true"))) {
            warn(`Batch item ${k} failed:`, subRes);
          }
        }
      } else {
        warn("Batch unexpected response", res);
      }
    }
  }

  /**
   * Tag deals by groups (chunkSize default 150)
   * opts.fieldType: 'string' | 'enum'
   * opts.enumValues: IDs of enum values (used cyclically)
   */
  async tagDealsByGroups(
    deals: any[],
    fieldName: string,
    opts: { fieldType: "string" | "enum"; enumValues?: Array<string | number>; chunkSize?: number; dryRun?: boolean }
  ) {
    const chunkSize = opts.chunkSize ?? 150;
    const dryRun = !!opts.dryRun;
    const enumValues = opts.enumValues ?? [];
    let groupIndex = 0;

    for (let i = 0; i < deals.length; i += chunkSize) {
      groupIndex++;
      const subset = deals.slice(i, i + chunkSize);
      const ids = subset.map(d => Number(d.ID));
      if (opts.fieldType === "string") {
        const value = String(groupIndex);
        await this.updateDealsByIds(fieldName, value, ids, dryRun);
        info(`Group ${groupIndex}: set ${fieldName}="${value}" for ${ids.length} deals`);
      } else {
        if (enumValues.length === 0) {
          warn("enumValues empty – cannot tag enum groups");
          continue;
        }
        const enumId = enumValues[(groupIndex - 1) % enumValues.length];
        await this.updateDealsByIds(fieldName, enumId, ids, dryRun);
        info(`Group ${groupIndex}: set ${fieldName}=${enumId} for ${ids.length} deals`);
      }
    }
  }
}
