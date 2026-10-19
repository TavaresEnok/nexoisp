import test from "node:test";
import assert from "node:assert/strict";
import { decimalToCents } from "../features/contracts/models";

test("converte valores comerciais em centavos sem arredondar frações ocultas", () => {
 for (const [input, expected] of [["0",0],["0,01",1],["123,45",12345],["1.234,56",123456],[" 12.30 ",1230],["12,3",1230]] as const) assert.equal(decimalToCents(input),expected);
 for (const input of ["1.234", "1..234,56", "1.23,45", "12,345", "-1", "NaN", "", "1e3", "Infinity", "9007199254740992"]) assert.throws(() => decimalToCents(input), undefined, input);
});
