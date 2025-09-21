import readline from "readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

export async function question(q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, resolve));
}

export async function chooseFrom<T>(arr: T[], label: (x: T) => string): Promise<T> {
  arr.forEach((item, idx) => {
    console.log(`${idx}: ${label(item)}`);
  });
  const idxStr = await question("Выберите индекс: ");
  const idx = Number(idxStr);
  if (Number.isNaN(idx) || idx < 0 || idx >= arr.length) {
    throw new Error("Неверный индекс");
  }
  return arr[idx];
}

export function close() {
  rl.close();
}
