import { Type } from "typebox";
import { Value } from "typebox/value";

const Rows = Type.Object({ rows: Type.Array(Type.Unknown()) });
const LIMIT = 12000;

/** Keep list metadata (especially total) readable when a herd listing exceeds the voice budget. */
export function voiceResult(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized.length <= LIMIT) return serialized;
  if (Value.Check(Rows, value)) {
    const rows = [...value.rows];
    const shortened = () =>
      JSON.stringify({
        ...value,
        rows,
        note: "Result shortened; request fewer records or a narrower query for more.",
      });
    while (rows.length && shortened().length > LIMIT) rows.pop();
    const result = shortened();
    if (result.length <= LIMIT) return result;
  }
  return `${serialized.slice(0, LIMIT)}\n[Result shortened to 12000 characters.]`;
}
