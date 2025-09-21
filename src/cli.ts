import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";

const rl = readline.createInterface({ input, output });

export async function question(prompt: string): Promise<string> {
  const ans = await rl.question(`${prompt} `);
  return (ans ?? "").trim();
}

export async function chooseFrom<T>(items: T[], labelFn: (t: T) => string, prompt = "Выберите:"): Promise<T> {
  if (!items || items.length === 0) throw new Error("Нет элементов для выбора");
  items.forEach((it, i) => console.log(`${i}: ${labelFn(it)}`));
  while (true) {
    const ans = await question(prompt);
    const idx = Number(ans);
    if (!Number.isNaN(idx) && idx >= 0 && idx < items.length) return items[idx];
    const found = (items as any[]).find(it => {
      const maybe = (it as any).ID ?? (it as any).id ?? (it as any).FIELD_NAME ?? (it as any).NAME;
      return String(maybe) === ans;
    });
    if (found) return found;
    console.log("Неверный ввод. Введите индекс или ID.");
  }
}

export function close() {
  rl.close();
}
