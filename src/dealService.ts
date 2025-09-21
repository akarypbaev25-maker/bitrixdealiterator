import { BitrixClient } from "./bitrixClient";

export interface UserField {
  ID: string;
  FIELD_NAME: string;
  USER_TYPE_ID: string;
  LIST?: { ID: string; VALUE: string }[];
}

export class DealService {
  constructor(private client: BitrixClient) {}

  async getCategories() {
    const res = await this.client.call<{ result: any[] }>("crm.dealcategory.list");
    return res.result;
  }

  async getStages(categoryId: number) {
    const res = await this.client.call<{ result: any[] }>("crm.dealcategory.stage.list", {
      id: categoryId,
    });
    return res.result;
  }

  async getDealUserFields() {
    const res = await this.client.call<{ result: UserField[] }>("crm.deal.userfield.list");
    return res.result;
  }

  async getEnumValuesForField(field: UserField) {
    return field.LIST ?? [];
  }

  async fetchDealsPaginated(
    filter: any,
    select: string[] = ["*"],
    order: Record<string, "ASC" | "DESC"> = { ID: "ASC" },
    limit = Infinity
  ) {
    const deals: any[] = [];
    let start = 0;

    while (deals.length < limit) {
      const res = await this.client.call<{ result: any[]; next?: number }>("crm.deal.list", {
        filter,
        select,
        order,
        start,
      });

      if (!res.result || res.result.length === 0) break;

      deals.push(...res.result);
      if (!("next" in res)) break;
      start = res.next!;
    }

    return deals.slice(0, limit);
  }

  async updateDealSingle(dealId: number, fieldName: string, value: string | number, dryRun = false) {
    if (dryRun) {
      return { success: false, returned: null };
    }

    const payload = { id: dealId, fields: { [fieldName]: value } };
    const res = await this.client.call<{ result: boolean }>("crm.deal.update", payload);

    return { success: res.result === true, returned: res };
  }

  async updateDealsByIds(field: UserField, value: string | number, ids: number[], dryRun = false) {
    for (const id of ids) {
      await this.updateDealSingle(id, field.FIELD_NAME, value, dryRun);
    }
  }
}
