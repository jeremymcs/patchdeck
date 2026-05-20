import assert from "node:assert/strict";
import test from "node:test";
import { getSafePRWorkContract } from "./prWorkContractView";

test("PR work contract view helper tolerates older PR payloads", () => {
  const contract = getSafePRWorkContract(undefined);

  assert.equal(contract.intent, "make_merge_ready");
  assert.equal(contract.phase, "monitoring");
  assert.equal(contract.blocker, null);
});
