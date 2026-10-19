import { createInterface } from "node:readline/promises";
export type Ask = (
  question: string,
  choices: string[],
  signal: AbortSignal,
) => Promise<string>;
export const askHuman: Ask = async (question, choices, signal) => {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    while (true) {
      const answer = (
        await terminal.question(`${question} [${choices.join("/")}]: `, {
          signal,
        })
      ).trim();
      if (
        (choices.length === 0 && answer.length > 0) ||
        choices.includes(answer)
      )
        return answer;
    }
  } finally {
    terminal.close();
  }
};
