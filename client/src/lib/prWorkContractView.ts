import { normalizePRWorkContract } from "@shared/prWorkContract";
import type { PRWorkContract } from "@shared/schema";

export function getSafePRWorkContract(contract?: PRWorkContract | null): PRWorkContract {
  return normalizePRWorkContract(contract);
}
