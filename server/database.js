import { queryDatabase } from "../lib/festo/database.ts";

export function query(text, values) {
  return queryDatabase(text, values);
}
